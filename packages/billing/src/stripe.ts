import { createHmac, timingSafeEqual } from 'node:crypto';
import { AdericelError } from '@adericel/shared';
import type {
  BillingEvent,
  CheckoutRequest,
  CheckoutSession,
  PaymentProvider,
} from './provider.js';

/**
 * Stripe, over its REST API.
 *
 * No SDK. The three calls Adericel makes are form-encoded POSTs, and the one
 * part that has to be exactly right — webhook signature verification — is
 * twenty lines that should be visible rather than a library default.
 *
 * The signature scheme is Stripe's: a `Stripe-Signature` header of
 * `t=<unix>,v1=<hex>,v1=<hex>` where each v1 is HMAC-SHA256 over
 * `<t>.<raw body>`. There can be several v1 values during a secret rotation,
 * and any one matching is sufficient.
 */

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSigningSecret: string;
  readonly apiBaseUrl?: string;
  /**
   * How far out of date a delivery may be. Stripe's own guidance is five
   * minutes; the point is that a captured delivery is not replayable forever.
   */
  readonly toleranceSeconds?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

interface StripeEventEnvelope {
  id?: string;
  type?: string;
  created?: number;
  data?: {
    object?: {
      id?: string;
      customer?: string | null;
      subscription?: string | null;
      status?: string;
      current_period_end?: number;
      metadata?: Record<string, string>;
      subscription_details?: { metadata?: Record<string, string> };
    };
  };
}

/**
 * Verify a Stripe signature header against the raw body.
 *
 * Exported because it is the security boundary of the webhook and deserves its
 * own tests rather than only being exercised through a happy path.
 */
export function verifyStripeSignature(options: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  nowEpochMs: number;
  toleranceSeconds?: number;
}): { timestamp: number } {
  const parts = options.signatureHeader.split(',').map((part) => part.trim());
  let timestamp: number | null = null;
  const candidates: string[] = [];

  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') candidates.push(value);
  }

  if (timestamp === null || !Number.isFinite(timestamp)) {
    throw new AdericelError('UNAUTHENTICATED', 'Webhook signature has no usable timestamp');
  }
  if (candidates.length === 0) {
    throw new AdericelError('UNAUTHENTICATED', 'Webhook signature has no v1 signature');
  }

  const ageSeconds = Math.abs(options.nowEpochMs / 1000 - timestamp);
  if (ageSeconds > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    throw new AdericelError('UNAUTHENTICATED', 'Webhook timestamp is outside the accepted window');
  }

  const expected = createHmac('sha256', options.secret)
    .update(`${timestamp}.${options.rawBody}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  // Every candidate is compared, and comparison is constant time. During a
  // secret rotation Stripe sends two, and short-circuiting on the first match
  // would leak which one matched through timing.
  let matched = false;
  for (const candidate of candidates) {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    ) {
      matched = true;
    }
  }
  if (!matched) throw new AdericelError('UNAUTHENTICATED', 'Webhook signature does not match');

  return { timestamp };
}

export function createStripeProvider(config: StripeConfig): PaymentProvider {
  const baseUrl = config.apiBaseUrl ?? 'https://api.stripe.com/v1';
  const doFetch = config.fetchImpl ?? fetch;

  async function post(
    path: string,
    form: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        // Stripe's own idempotency, on top of Adericel's. A retried checkout
        // returns the original session rather than creating a second one.
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });

    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;

    if (!response.ok) {
      throw new AdericelError(
        'INTEGRATION_ERROR',
        `Stripe rejected the request: ${body?.error?.message ?? response.statusText}`,
        {
          safeDetails: { status: response.status, code: body?.error?.code ?? null },
          // 5xx and rate limits are worth retrying; a rejected card or a bad
          // parameter is not, and retrying it just delays the real message.
          retryable: response.status >= 500 || response.status === 429,
        },
      );
    }
    return body as unknown as Record<string, unknown>;
  }

  return {
    key: 'stripe',

    async createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession> {
      const session = await post(
        '/checkout/sessions',
        {
          mode: 'subscription',
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          customer_email: request.customerEmail,
          'line_items[0][quantity]': String(request.quantity),
          'line_items[0][price_data][currency]': request.currency.toLowerCase(),
          'line_items[0][price_data][unit_amount]': String(request.unitAmountMinor),
          'line_items[0][price_data][recurring][interval]': 'month',
          'line_items[0][price_data][product_data][name]': `Adericel — ${request.planKey} (per organisation, per month)`,
          // Adericel's own identifiers travel with the subscription so a
          // webhook can be attributed without a lookup table that could drift.
          'subscription_data[metadata][adericel_subscription_id]': request.subscriptionId,
          'subscription_data[metadata][adericel_msp_id]': request.mspId,
          'metadata[adericel_subscription_id]': request.subscriptionId,
          'metadata[adericel_msp_id]': request.mspId,
        },
        request.idempotencyKey,
      );

      const sessionId = typeof session.id === 'string' ? session.id : null;
      const url = typeof session.url === 'string' ? session.url : null;
      if (!sessionId || !url) {
        throw new AdericelError('INTEGRATION_ERROR', 'Stripe returned no checkout URL');
      }
      return { sessionId, url };
    },

    verifyAndParse(rawBody, signatureHeader, nowEpochMs): BillingEvent {
      verifyStripeSignature({
        rawBody,
        signatureHeader,
        secret: config.webhookSigningSecret,
        nowEpochMs,
        ...(config.toleranceSeconds === undefined
          ? {}
          : { toleranceSeconds: config.toleranceSeconds }),
      });

      let envelope: StripeEventEnvelope;
      try {
        envelope = JSON.parse(rawBody) as StripeEventEnvelope;
      } catch {
        throw new AdericelError('VALIDATION_FAILED', 'Webhook body is not valid JSON');
      }

      const object = envelope.data?.object ?? {};
      const metadata = object.metadata ?? object.subscription_details?.metadata ?? {};

      // Only the event types that change entitlement are translated. Everything
      // else becomes IGNORED and is recorded, so a Stripe configuration sending
      // more than Adericel needs is visible rather than silently discarded.
      const type: BillingEvent['type'] = (() => {
        switch (envelope.type) {
          case 'checkout.session.completed':
          case 'customer.subscription.created':
            return 'SUBSCRIPTION_ACTIVATED';
          case 'invoice.paid':
          case 'invoice.payment_succeeded':
            return 'SUBSCRIPTION_RENEWED';
          case 'invoice.payment_failed':
            return 'PAYMENT_FAILED';
          case 'customer.subscription.deleted':
            return 'SUBSCRIPTION_CANCELLED';
          case 'customer.subscription.updated':
            // Only a cancellation matters here. Every other update — a quantity
            // change, a trial ending — is either already covered by an invoice
            // event or is not Adericel's business.
            return object.status === 'canceled' ? 'SUBSCRIPTION_CANCELLED' : 'IGNORED';
          default:
            return 'IGNORED';
        }
      })();

      if (!envelope.id) {
        throw new AdericelError('VALIDATION_FAILED', 'Webhook event has no id');
      }

      return {
        id: envelope.id,
        type,
        occurredAtIso: new Date(
          (envelope.created ?? Math.floor(nowEpochMs / 1000)) * 1000,
        ).toISOString(),
        externalCustomerRef: object.customer ?? null,
        externalSubscriptionRef: object.subscription ?? object.id ?? null,
        subscriptionId: metadata.adericel_subscription_id ?? null,
        currentPeriodEndIso: object.current_period_end
          ? new Date(object.current_period_end * 1000).toISOString()
          : null,
        rawType: envelope.type ?? 'unknown',
      };
    },

    async cancelSubscription(externalSubscriptionRef: string): Promise<void> {
      // Cancel at period end rather than immediately. The MSP has paid for the
      // month; taking their portfolio away on the day they cancel would be both
      // wrong and a very memorable last impression.
      await post(`/subscriptions/${externalSubscriptionRef}`, {
        cancel_at_period_end: 'true',
      });
    },
  };
}
