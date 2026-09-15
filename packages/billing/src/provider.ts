import type { SubscriptionStatus } from '@adericel/domain';

/**
 * The payment provider boundary.
 *
 * Adericel's billing model — plans, volume tiers, per-organisation pricing,
 * entitlement — lives in `@adericel/domain` and knows nothing about Stripe. This
 * interface is the only place a provider appears, for the same reason
 * `RootKeyProvider` exists for key management: the thing that is most likely to
 * be replaced should be the thing with the smallest, most explicit surface.
 *
 * A deployment that takes payment through an accountant and a bank transfer
 * implements `manualProvider` and everything above this line is unchanged.
 */

export interface CheckoutRequest {
  /** The MSP being billed. Carried through so the webhook can be attributed. */
  readonly mspId: string;
  readonly subscriptionId: string;
  readonly planKey: string;
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly quantity: number;
  readonly customerEmail: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /**
   * Stable across retries of the same intent, so a double-clicked button does
   * not produce two subscriptions.
   */
  readonly idempotencyKey: string;
}

export interface CheckoutSession {
  readonly sessionId: string;
  readonly url: string;
}

/**
 * A billing event, already translated out of the provider's vocabulary.
 *
 * Deliberately small. Stripe emits dozens of event types; Adericel acts on the
 * five that change what an MSP is entitled to, and ignoring the rest is a
 * decision rather than an oversight.
 */
export interface BillingEvent {
  /** Provider event id. The idempotency key for processing. */
  readonly id: string;
  readonly type:
    | 'SUBSCRIPTION_ACTIVATED'
    | 'SUBSCRIPTION_RENEWED'
    | 'PAYMENT_FAILED'
    | 'SUBSCRIPTION_CANCELLED'
    | 'IGNORED';
  readonly occurredAtIso: string;
  readonly externalCustomerRef: string | null;
  readonly externalSubscriptionRef: string | null;
  /** Adericel's own subscription id, round-tripped through provider metadata. */
  readonly subscriptionId: string | null;
  readonly currentPeriodEndIso: string | null;
  /** The provider's own type, kept for the audit trail. */
  readonly rawType: string;
}

export interface PaymentProvider {
  readonly key: string;
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
  /**
   * Verify a webhook delivery and translate it.
   *
   * Takes the *raw* body. A body that has been parsed and re-serialised no
   * longer produces the same signature, and the resulting failure looks like a
   * misconfigured secret rather than what it is.
   */
  verifyAndParse(rawBody: string, signatureHeader: string, nowEpochMs: number): BillingEvent;
  cancelSubscription(externalSubscriptionRef: string): Promise<void>;
}

/**
 * The status an event moves a subscription to.
 *
 * Returning null for IGNORED rather than the current status is deliberate: the
 * caller then cannot accidentally write an unchanged status and count it as a
 * transition in the audit trail.
 */
export function statusForEvent(event: BillingEvent): SubscriptionStatus | null {
  switch (event.type) {
    case 'SUBSCRIPTION_ACTIVATED':
    case 'SUBSCRIPTION_RENEWED':
      return 'ACTIVE';
    case 'PAYMENT_FAILED':
      // PAST_DUE, not SUSPENDED. A failed card is usually an expired card, and
      // suspending an MSP's whole portfolio over one is a disproportionate
      // response to the most common billing event there is. Suspension is a
      // decision someone makes after dunning, not an automatic consequence.
      return 'PAST_DUE';
    case 'SUBSCRIPTION_CANCELLED':
      return 'CANCELLED';
    case 'IGNORED':
      return null;
  }
}
