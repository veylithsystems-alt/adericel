import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStripeProvider, verifyStripeSignature } from './stripe.js';
import { statusForEvent } from './provider.js';

/**
 * Stripe webhook handling.
 *
 * The signature check is the boundary: anyone on the internet can POST to the
 * webhook endpoint, and what they get to do if it passes is change what an MSP
 * is entitled to. It is tested directly rather than only through a happy path.
 */

const SECRET = 'whsec_test_secret_value';
const NOW_MS = Date.parse('2026-09-10T12:00:00.000Z');

function sign(body: string, options: { secret?: string; timestamp?: number } = {}): string {
  const timestamp = options.timestamp ?? Math.floor(NOW_MS / 1000);
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

const event = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_test_1',
    type: 'invoice.paid',
    created: Math.floor(NOW_MS / 1000),
    data: {
      object: {
        id: 'in_1',
        customer: 'cus_1',
        subscription: 'sub_1',
        current_period_end: Math.floor(Date.parse('2026-10-10T12:00:00.000Z') / 1000),
        metadata: { adericel_subscription_id: 'sub-adericel-1' },
      },
    },
    ...overrides,
  });

describe('signature verification', () => {
  it('accepts a correctly signed delivery', () => {
    const body = event();
    expect(
      verifyStripeSignature({
        rawBody: body,
        signatureHeader: sign(body),
        secret: SECRET,
        nowEpochMs: NOW_MS,
      }).timestamp,
    ).toBe(Math.floor(NOW_MS / 1000));
  });

  it('refuses a delivery signed with a different secret', () => {
    const body = event();
    expect(() =>
      verifyStripeSignature({
        rawBody: body,
        signatureHeader: sign(body, { secret: 'whsec_someone_elses_secret' }),
        secret: SECRET,
        nowEpochMs: NOW_MS,
      }),
    ).toThrow(/does not match/);
  });

  it('refuses a body that changed after signing', () => {
    // The attack: take a real delivery, edit the amount or the subscription id,
    // and replay it. The signature covers the body, so it stops being valid.
    const original = event();
    const header = sign(original);
    const tampered = original.replace('sub-adericel-1', 'sub-adericel-victim');
    expect(() =>
      verifyStripeSignature({
        rawBody: tampered,
        signatureHeader: header,
        secret: SECRET,
        nowEpochMs: NOW_MS,
      }),
    ).toThrow(/does not match/);
  });

  it('refuses a delivery older than the tolerance, so a capture is not replayable forever', () => {
    const body = event();
    const header = sign(body, { timestamp: Math.floor(NOW_MS / 1000) - 3600 });
    expect(() =>
      verifyStripeSignature({
        rawBody: body,
        signatureHeader: header,
        secret: SECRET,
        nowEpochMs: NOW_MS,
      }),
    ).toThrow(/outside the accepted window/);
  });

  it('refuses a delivery from the future by the same margin', () => {
    const body = event();
    const header = sign(body, { timestamp: Math.floor(NOW_MS / 1000) + 3600 });
    expect(() =>
      verifyStripeSignature({
        rawBody: body,
        signatureHeader: header,
        secret: SECRET,
        nowEpochMs: NOW_MS,
      }),
    ).toThrow(/outside the accepted window/);
  });

  it('accepts either signature during a secret rotation', () => {
    // Stripe sends two v1 values while a secret is being rotated. Accepting
    // only the first would make every rotation an outage.
    const body = event();
    const timestamp = Math.floor(NOW_MS / 1000);
    const oldSig = createHmac('sha256', 'whsec_previous')
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const newSig = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');

    expect(() =>
      verifyStripeSignature({
        rawBody: body,
        signatureHeader: `t=${timestamp},v1=${oldSig},v1=${newSig}`,
        secret: SECRET,
        nowEpochMs: NOW_MS,
      }),
    ).not.toThrow();
  });

  it('refuses a header with no timestamp or no signature', () => {
    const body = event();
    for (const header of ['', 'v1=deadbeef', 't=123', 'nonsense']) {
      expect(() =>
        verifyStripeSignature({
          rawBody: body,
          signatureHeader: header,
          secret: SECRET,
          nowEpochMs: NOW_MS,
        }),
      ).toThrow();
    }
  });
});

describe('event translation', () => {
  const provider = createStripeProvider({
    secretKey: 'sk_test',
    webhookSigningSecret: SECRET,
  });

  const parse = (body: string) => provider.verifyAndParse(body, sign(body), NOW_MS);

  it('carries Adericel’s own subscription id back from provider metadata', () => {
    // Attribution without a lookup table that could drift out of step.
    const parsed = parse(event());
    expect(parsed.subscriptionId).toBe('sub-adericel-1');
    expect(parsed.externalSubscriptionRef).toBe('sub_1');
    expect(parsed.externalCustomerRef).toBe('cus_1');
  });

  it('maps the five event types that change entitlement', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['checkout.session.completed', 'SUBSCRIPTION_ACTIVATED'],
      ['customer.subscription.created', 'SUBSCRIPTION_ACTIVATED'],
      ['invoice.paid', 'SUBSCRIPTION_RENEWED'],
      ['invoice.payment_failed', 'PAYMENT_FAILED'],
      ['customer.subscription.deleted', 'SUBSCRIPTION_CANCELLED'],
    ];
    for (const [stripeType, expected] of cases) {
      expect(parse(event({ type: stripeType })).type).toBe(expected);
    }
  });

  it('ignores everything else, but records what it ignored', () => {
    const parsed = parse(event({ type: 'customer.updated' }));
    expect(parsed.type).toBe('IGNORED');
    // Kept so that a Stripe configuration sending more than Adericel needs is
    // visible in the audit trail rather than silently discarded.
    expect(parsed.rawType).toBe('customer.updated');
  });

  it('treats a subscription update as a cancellation only when it actually cancelled', () => {
    const cancelled = JSON.stringify({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      created: Math.floor(NOW_MS / 1000),
      data: { object: { id: 'sub_1', status: 'canceled' } },
    });
    const quantityChange = JSON.stringify({
      id: 'evt_3',
      type: 'customer.subscription.updated',
      created: Math.floor(NOW_MS / 1000),
      data: { object: { id: 'sub_1', status: 'active' } },
    });
    expect(parse(cancelled).type).toBe('SUBSCRIPTION_CANCELLED');
    expect(parse(quantityChange).type).toBe('IGNORED');
  });

  it('refuses an event with no id, because the id is the idempotency key', () => {
    const body = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
    expect(() => provider.verifyAndParse(body, sign(body), NOW_MS)).toThrow(/no id/);
  });
});

describe('what an event does to a subscription', () => {
  const at = (type: string) =>
    statusForEvent({
      id: 'evt',
      type: type as never,
      occurredAtIso: '2026-09-10T12:00:00.000Z',
      externalCustomerRef: null,
      externalSubscriptionRef: null,
      subscriptionId: null,
      currentPeriodEndIso: null,
      rawType: type,
    });

  it('moves a failed payment to PAST_DUE rather than suspending the portfolio', () => {
    // A failed card is usually an expired card. Suspending an MSP's whole
    // portfolio over one is disproportionate, and suspension should be a
    // decision somebody makes after dunning rather than an automatic
    // consequence of the most common billing event there is.
    expect(at('PAYMENT_FAILED')).toBe('PAST_DUE');
  });

  it('activates on checkout and renewal, cancels on cancellation', () => {
    expect(at('SUBSCRIPTION_ACTIVATED')).toBe('ACTIVE');
    expect(at('SUBSCRIPTION_RENEWED')).toBe('ACTIVE');
    expect(at('SUBSCRIPTION_CANCELLED')).toBe('CANCELLED');
  });

  it('returns null for an ignored event rather than the current status', () => {
    // So the caller cannot write an unchanged status and record it as a
    // transition that never happened.
    expect(at('IGNORED')).toBeNull();
  });
});
