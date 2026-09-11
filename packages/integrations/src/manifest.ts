import { z } from 'zod';
import type { ObservationKind } from '@adericel/domain';

/**
 * The connector manifest.
 *
 * A connector's metadata used to be scattered across interface fields, which
 * made it readable by TypeScript and by nothing else. The manifest is
 * machine-readable and authoritative: what a connector can collect, what it can
 * execute, what it can verify, and — the part that was entirely missing — which
 * canonical predicates it is able to supply.
 *
 * That last point is what separates this from documentation. Without it,
 * Adericel cannot answer "what can this customer's integrations actually tell
 * us?", which is the difference between
 *
 *   this control is FAILING
 *
 * and
 *
 *   this control CANNOT CURRENTLY BE ASSESSED
 *
 * and getting that distinction wrong is how an assurance product tells its most
 * damaging lie.
 *
 * The manifest declares capability, never meaning. A connector says "I can
 * supply `identity.mfa.enforced`"; what that predicate proves about Cyber
 * Essentials is the ruleset's business and no connector may encode it.
 */

/**
 * Evidence domains.
 *
 * Coarse groupings a person recognises — "can you see our endpoints?" — used
 * for capability discovery rather than for any assurance decision.
 */
export const EVIDENCE_DOMAINS = [
  'IDENTITY',
  'ENDPOINT',
  'CLOUD',
  'DATA',
  'NETWORK',
  'BACKUP',
  'VULNERABILITY',
  'TICKETING',
  'DOCUMENTATION',
  'INCIDENT',
  'TRAINING',
  'SUPPLIER',
] as const;
export type EvidenceDomain = (typeof EVIDENCE_DOMAINS)[number];

/**
 * Which evidence domain an observation kind belongs to.
 *
 * Used only for discovery and grouping. It carries no assurance meaning: no
 * rule may branch on a domain, because a domain describes where evidence came
 * from, never what it proves.
 */
export const DOMAIN_BY_OBSERVATION_KIND: Partial<Record<ObservationKind, EvidenceDomain>> = {
  IDENTITY_STATE: 'IDENTITY',
  DEVICE_STATE: 'ENDPOINT',
  CLOUD_RESOURCE_STATE: 'CLOUD',
  APPLICATION_STATE: 'ENDPOINT',
  VULNERABILITY: 'VULNERABILITY',
  BACKUP_STATE: 'BACKUP',
  CONFIGURATION_SETTING: 'IDENTITY',
  POLICY_DOCUMENT: 'DOCUMENTATION',
  SUPPLIER_ATTESTATION: 'SUPPLIER',
  INCIDENT: 'INCIDENT',
  TRAINING_RECORD: 'TRAINING',
  PATCH_STATE: 'ENDPOINT',
  ACCESS_GRANT: 'IDENTITY',
  LOG_EVENT: 'NETWORK',
};

/**
 * A collection capability: one thing a connector can go and look at.
 *
 * `predicates` is the load-bearing field. It is how a required predicate is
 * resolved to a connector, how a collection plan is built, and how a control
 * that cannot be assessed is distinguished from one that failed.
 */
export const collectCapabilitySchema = z.object({
  /** Stable identifier, e.g. `collect.identities`. Namespaced by verb. */
  key: z
    .string()
    .min(1)
    .max(120)
    .regex(/^collect\.[a-z0-9_.]+$/, 'Collection capability keys start with "collect."'),
  title: z.string().min(1).max(200),
  domain: z.enum(EVIDENCE_DOMAINS),
  /** Observation kinds this capability produces. */
  produces: z.array(z.string().min(1)).min(1),
  /**
   * Canonical predicates this capability can supply.
   *
   * Canonical, never vendor-shaped: `identity.mfa.enforced`, not
   * `entra_strongAuthenticationRequirements`. Vendor vocabulary stops at the
   * adapter boundary, which is what lets Intune, an RMM and a custom API all
   * feed one rule.
   */
  predicates: z.array(z.string().min(1)).min(1),
  /**
   * The external permission this capability needs, in the vendor's own words,
   * so a permission failure can tell an operator exactly what to grant.
   */
  requiredPermission: z.string().max(300).default(''),
  /** Whether this capability can be collected incrementally. */
  incremental: z.boolean().default(false),
  /** True when the capability is optional and its absence is not a fault. */
  optional: z.boolean().default(false),
});
export type CollectCapability = z.infer<typeof collectCapabilitySchema>;

export const connectorManifestSchema = z.object({
  id: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  vendor: z.string().min(1).max(120),
  products: z.array(z.string().min(1)).default([]),
  category: z.string().min(1),
  authentication: z.array(z.string().min(1)).min(1),
  collect: z.array(collectCapabilitySchema).default([]),
  /** Action types this connector can execute. Mirrors ConnectorCapability. */
  execute: z.array(z.string().min(1)).default([]),
  /** Predicates re-observed to verify an execution. */
  verify: z.array(z.string().min(1)).default([]),
  pagination: z.boolean().default(false),
  incrementalCollection: z.boolean().default(false),
  /**
   * Whether this connector talks to a real external system.
   *
   * A fixture is a legitimate and useful thing; presenting one as a live
   * integration is not. Surfaced through the API and the interface so nobody
   * can mistake demonstration data for an observation of their estate.
   */
  fidelity: z.enum(['LIVE', 'DEMONSTRATION']).default('LIVE'),
  documentationUrl: z.string().max(500).default(''),
});
export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/**
 * How a single capability fared in one collection run.
 *
 * This is what turns partial collection from a boolean into something an
 * operator can act on. "The integration is degraded" is not actionable;
 * "device compliance returned PERMISSION_DENIED, and these four controls are
 * UNKNOWN as a result" is.
 */
export const CAPABILITY_OUTCOMES = [
  /** Collected, and the connector believes completely. */
  'AVAILABLE',
  /** Collected, but the connector knows it did not get everything. */
  'PARTIAL',
  /** The credentials are valid and lack the permission this needs. */
  'PERMISSION_DENIED',
  /** The credentials themselves were rejected. */
  'AUTHENTICATION_FAILED',
  /** The upstream refused to serve us for now. */
  'RATE_LIMITED',
  /** The upstream could not be reached or returned an error. */
  'UPSTREAM_UNAVAILABLE',
  /** The response parsed, and did not contain what this connector expects. */
  'SCHEMA_DRIFT',
  /** The connector supports this capability and this configuration disables it. */
  'NOT_CONFIGURED',
  /** The upstream has nothing of this kind — a real, informative answer. */
  'EMPTY',
] as const;
export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number];

/**
 * Outcomes that mean Adericel did NOT learn what it went to learn.
 *
 * `EMPTY` is deliberately absent: an organisation with no cloud resources is a
 * fact, not a failure, and treating it as one would make a small customer look
 * broken. The Truth Engine already distinguishes "none exist" from "never
 * looked" through `observedSubjectKinds`.
 */
export const UNINFORMATIVE_OUTCOMES: ReadonlySet<CapabilityOutcome> = new Set([
  'PERMISSION_DENIED',
  'AUTHENTICATION_FAILED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'SCHEMA_DRIFT',
  'NOT_CONFIGURED',
]);

export interface CapabilityReport {
  readonly capability: string;
  readonly outcome: CapabilityOutcome;
  /** Plain-language reason. Shown to an operator, so no stack traces. */
  readonly detail: string;
  readonly recordsCollected: number;
  readonly observationsProduced: number;
  /**
   * The vendor permission that would fix a PERMISSION_DENIED, echoed from the
   * manifest so the message is actionable without a documentation hunt.
   */
  readonly requiredPermission?: string;
  /** Fields the connector expected and did not find. Populates SCHEMA_DRIFT. */
  readonly missingFields?: readonly string[];
}

export function capabilityInformative(outcome: CapabilityOutcome): boolean {
  return !UNINFORMATIVE_OUTCOMES.has(outcome);
}

/**
 * Predicates a run failed to establish.
 *
 * Feeds straight into the existing UNKNOWN architecture: a predicate nobody
 * could supply produces no claim, the engine finds nothing, and the control
 * reports UNKNOWN with a reason. This function is what lets that reason name
 * the integration and the permission rather than saying "no claim recorded".
 */
export function unavailablePredicates(
  manifest: ConnectorManifest,
  reports: readonly CapabilityReport[],
): readonly string[] {
  const byKey = new Map(manifest.collect.map((c) => [c.key, c]));
  const unavailable = new Set<string>();
  for (const report of reports) {
    if (capabilityInformative(report.outcome)) continue;
    for (const predicate of byKey.get(report.capability)?.predicates ?? []) {
      unavailable.add(predicate);
    }
  }
  return [...unavailable].sort();
}

/**
 * The health a run implies, from its capability reports alone.
 *
 * Deterministic, because "why is this integration amber?" must have exactly one
 * answer. Ordered by severity: an authentication failure is worse than a
 * permission gap, which is worse than partial data.
 */
export type IntegrationHealth =
  | 'HEALTHY'
  | 'PARTIAL'
  | 'RATE_LIMITED'
  | 'SCHEMA_DRIFT'
  | 'AUTHORISED_BUT_RESTRICTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED';

export function healthFromReports(reports: readonly CapabilityReport[]): IntegrationHealth {
  const has = (outcome: CapabilityOutcome): boolean =>
    reports.some((report) => report.outcome === outcome);

  if (has('AUTHENTICATION_FAILED')) return 'AUTHENTICATION_FAILED';
  if (has('UPSTREAM_UNAVAILABLE')) return 'UPSTREAM_UNAVAILABLE';
  // Restricted before drift: a missing permission is a thing an operator can
  // fix in five minutes, and drift is a thing they must report to us.
  if (has('PERMISSION_DENIED')) return 'AUTHORISED_BUT_RESTRICTED';
  if (has('SCHEMA_DRIFT')) return 'SCHEMA_DRIFT';
  if (has('RATE_LIMITED')) return 'RATE_LIMITED';
  if (has('PARTIAL') || has('NOT_CONFIGURED')) return 'PARTIAL';
  return 'HEALTHY';
}

/**
 * Health that must never be presented as green.
 *
 * The rule this encodes: an integration failing to collect something important
 * must not display as healthy. A green light over a permission failure is how
 * a customer comes to believe they are covered for something nobody is looking
 * at.
 */
export function healthIsDegraded(health: IntegrationHealth): boolean {
  return health !== 'HEALTHY';
}

/**
 * Classify an upstream failure into a capability outcome.
 *
 * The distinction that matters most is PERMISSION_DENIED against
 * UPSTREAM_UNAVAILABLE. One is a consent an administrator can grant in five
 * minutes; the other is somebody else's outage. Reporting both as "degraded"
 * leaves a customer with a red light and nothing to do about it.
 *
 * Conservative by design: anything it cannot confidently classify becomes
 * UPSTREAM_UNAVAILABLE, which is still uninformative and still withholds the
 * predicates. Nothing here can turn a failure into an informative outcome.
 */
export function classifyCollectionError(error: unknown): CapabilityOutcome {
  const status =
    typeof error === 'object' && error !== null && 'safeDetails' in error
      ? Number((error as { safeDetails?: { status?: unknown } }).safeDetails?.status)
      : Number.NaN;

  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 429) return 'RATE_LIMITED';
  if (Number.isFinite(status) && status >= 500) return 'UPSTREAM_UNAVAILABLE';

  // Fall back to the message only where the status was not carried. A vendor
  // that returns 200 with an error body is exactly why this exists.
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/\b(403|forbidden|insufficient privileges|access denied|scope)\b/.test(message)) {
    return 'PERMISSION_DENIED';
  }
  if (/\b(401|unauthori[sz]ed|invalid_client|invalid_grant)\b/.test(message)) {
    return 'AUTHENTICATION_FAILED';
  }
  if (/\b(429|rate limit|throttl)/.test(message)) return 'RATE_LIMITED';
  return 'UPSTREAM_UNAVAILABLE';
}

/**
 * Build a capability report, keeping the manifest's declared permission on it.
 *
 * The permission is echoed here rather than looked up at render time so the
 * message an administrator reads names what to grant even if the connector is
 * later rewritten.
 */
export function capabilityReport(
  manifest: ConnectorManifest,
  capability: string,
  outcome: CapabilityOutcome,
  detail: string,
  counts: { records?: number; observations?: number; missingFields?: readonly string[] } = {},
): CapabilityReport {
  const declared = manifest.collect.find((entry) => entry.key === capability);
  return {
    capability,
    outcome,
    detail,
    recordsCollected: counts.records ?? 0,
    observationsProduced: counts.observations ?? 0,
    requiredPermission: declared?.requiredPermission ?? '',
    ...(counts.missingFields && counts.missingFields.length > 0
      ? { missingFields: [...counts.missingFields] }
      : {}),
  };
}

/**
 * Turn a failure into a report that names what to do about it.
 *
 * A PERMISSION_DENIED with the vendor's own permission string in it is the
 * difference between an integration that stays broken for a fortnight and one
 * an administrator fixes before lunch.
 */
export function reportFromError(
  manifest: ConnectorManifest,
  capability: string,
  error: unknown,
): CapabilityReport {
  const outcome = classifyCollectionError(error);
  const declared = manifest.collect.find((entry) => entry.key === capability);
  const cause = error instanceof Error ? error.message : String(error);
  const remedy =
    outcome === 'PERMISSION_DENIED' && declared?.requiredPermission
      ? ` Grant ${declared.requiredPermission} to restore it.`
      : '';
  return capabilityReport(
    manifest,
    capability,
    outcome,
    `${declared?.title ?? capability} could not be collected: ${cause}.${remedy}`,
  );
}
