import { z } from 'zod';

/**
 * Billing model.
 *
 * Adericel is sold wholesale to MSPs, priced per organisation per month. The
 * price is configuration, never a constant: MSP agreements differ, currencies
 * differ, and the platform must not need a code change to sell.
 */
export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export const PLAN_TIERS = ['PILOT', 'STANDARD', 'VOLUME', 'ENTERPRISE'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface PlanDefinition {
  readonly key: string;
  readonly tier: PlanTier;
  readonly name: string;
  /** Price per organisation per month, in minor currency units. */
  readonly pricePerOrganisationMinor: number;
  readonly currency: string;
  /** Organisations included before per-organisation charges apply. */
  readonly includedOrganisations: number;
  /** Volume breakpoints: [minOrganisations, pricePerOrganisationMinor]. */
  readonly volumeTiers: readonly (readonly [number, number])[];
  readonly features: readonly string[];
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly mspId: string | null;
  readonly organisationId: string | null;
  readonly planKey: string;
  readonly status: SubscriptionStatus;
  readonly currency: string;
  readonly pricePerOrganisationMinor: number;
  readonly trialEndsAt: string | null;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly cancelledAt: string | null;
  readonly externalCustomerRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntitlementCheck {
  readonly allowed: boolean;
  readonly reason: string;
  readonly organisationsInUse: number;
  readonly organisationLimit: number | null;
}

/**
 * Effective unit price at a given organisation count, applying volume tiers.
 * Tiers are matched on the highest breakpoint not exceeding the count.
 */
export function effectiveUnitPriceMinor(plan: PlanDefinition, organisationCount: number): number {
  let price = plan.pricePerOrganisationMinor;
  for (const [threshold, tierPrice] of [...plan.volumeTiers].sort((a, b) => a[0] - b[0])) {
    if (organisationCount >= threshold) price = tierPrice;
  }
  return price;
}

export function monthlyChargeMinor(plan: PlanDefinition, organisationCount: number): number {
  const billable = Math.max(0, organisationCount - plan.includedOrganisations);
  return billable * effectiveUnitPriceMinor(plan, organisationCount);
}

/**
 * Whether an MSP may add another organisation. A suspended or cancelled
 * subscription blocks growth but never blocks read access to existing
 * assurance data — customers must always be able to export their own record.
 */
export function checkOrganisationEntitlement(
  subscription: Pick<SubscriptionRecord, 'status' | 'trialEndsAt'>,
  organisationsInUse: number,
  organisationLimit: number | null,
  atIso: string,
): EntitlementCheck {
  if (subscription.status === 'CANCELLED' || subscription.status === 'SUSPENDED') {
    return {
      allowed: false,
      reason: `Subscription is ${subscription.status.toLowerCase()}`,
      organisationsInUse,
      organisationLimit,
    };
  }
  if (
    subscription.status === 'TRIAL' &&
    subscription.trialEndsAt !== null &&
    Date.parse(subscription.trialEndsAt) <= Date.parse(atIso)
  ) {
    return { allowed: false, reason: 'Trial period has ended', organisationsInUse, organisationLimit };
  }
  if (organisationLimit !== null && organisationsInUse >= organisationLimit) {
    return {
      allowed: false,
      reason: `Organisation limit of ${organisationLimit} reached`,
      organisationsInUse,
      organisationLimit,
    };
  }
  return { allowed: true, reason: 'Entitled', organisationsInUse, organisationLimit };
}

/**
 * Built-in plans. Prices are defaults only — a deployment overrides them via
 * configuration or per-MSP subscription records.
 */
export const DEFAULT_PLANS: readonly PlanDefinition[] = [
  {
    key: 'pilot',
    tier: 'PILOT',
    name: 'Pilot',
    pricePerOrganisationMinor: 0,
    currency: 'GBP',
    includedOrganisations: 3,
    volumeTiers: [],
    features: ['assurance', 'evidence', 'findings'],
  },
  {
    key: 'standard',
    tier: 'STANDARD',
    name: 'MSP Standard',
    pricePerOrganisationMinor: 19_900,
    currency: 'GBP',
    includedOrganisations: 0,
    volumeTiers: [
      [25, 17_900],
      [50, 15_900],
      [100, 13_900],
    ],
    features: ['assurance', 'evidence', 'findings', 'actions', 'integrations', 'portfolio'],
  },
  {
    key: 'enterprise',
    tier: 'ENTERPRISE',
    name: 'Enterprise',
    pricePerOrganisationMinor: 12_900,
    currency: 'GBP',
    includedOrganisations: 0,
    volumeTiers: [[250, 9_900]],
    features: ['assurance', 'evidence', 'findings', 'actions', 'integrations', 'portfolio', 'sso', 'custom-frameworks'],
  },
];
