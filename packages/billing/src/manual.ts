import { AdericelError } from '@adericel/shared';
import type { BillingEvent, CheckoutRequest, PaymentProvider } from './provider.js';

/**
 * No payment provider.
 *
 * The default, and not a stub. A great many MSPs will be invoiced on 30-day
 * terms by an accountant, and a self-hosting MSP running Adericel for their own
 * portfolio is not being billed by anyone. In both cases subscription state is
 * set by an administrator and there is nothing for a provider to do.
 *
 * It refuses rather than pretending: a checkout attempt with no provider
 * configured returns a message saying so, instead of a URL that goes nowhere.
 */
export function createManualProvider(): PaymentProvider {
  return {
    key: 'manual',

    async createCheckoutSession(_request: CheckoutRequest) {
      throw new AdericelError(
        'NOT_IMPLEMENTED',
        'No payment provider is configured. Subscriptions are administered directly; set ' +
          'BILLING_PROVIDER=stripe to take card payments.',
      );
    },

    verifyAndParse(): BillingEvent {
      throw new AdericelError(
        'NOT_IMPLEMENTED',
        'No payment provider is configured, so billing webhooks are not accepted.',
      );
    },

    async cancelSubscription() {
      throw new AdericelError(
        'NOT_IMPLEMENTED',
        'No payment provider is configured. Cancel the subscription directly.',
      );
    },
  };
}
