import type { ClaimInput, NodeKind, ObservationKind, ObservationRecord } from '@adericel/domain';

/**
 * Observation normalisation.
 *
 * This is the layer that turns "what a connector saw" into the canonical
 * predicates the Truth Engine reasons about. It is deterministic and
 * side-effect free, which matters because a claim's origin is recorded as
 * DETERMINISTIC_NORMALISATION — an assertion that a human can check by reading
 * this code, not a probabilistic extraction.
 *
 * The payload-key to predicate mapping is a declarative table rather than a
 * sequence of statements. That is deliberate: the mapping is not only executed,
 * it is *read* — by capability derivation for declaratively configured
 * connectors, by the conformance suite, and by capability discovery answering
 * "what could this integration ever tell us?". A mapping that exists only as
 * control flow can be run but cannot be asked.
 */

export interface NormalisedSubject {
  readonly kind: NodeKind;
  readonly externalId: string;
  readonly label: string;
  readonly attributes: Record<string, unknown>;
}

export interface NormalisedClaim extends Omit<
  ClaimInput,
  'evidenceIds' | 'origin' | 'status' | 'metadata'
> {
  readonly subjectExternalId: string | null;
}

export interface Normalisation {
  readonly subjects: readonly NormalisedSubject[];
  readonly claims: readonly NormalisedClaim[];
}

export type Normaliser = (observation: ObservationRecord) => Normalisation;

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'True' || value === 1) return true;
  if (value === 'false' || value === 'False' || value === 0) return false;
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function raw(value: unknown): unknown {
  return value;
}

/** How a payload value is coerced before it becomes a claim value. */
export type Coercion = 'boolean' | 'string' | 'number' | 'raw';

const COERCIONS: Record<Coercion, (value: unknown) => unknown> = {
  boolean: bool,
  string: str,
  number: num,
  raw,
};

/**
 * One canonical payload key and the predicate it becomes.
 *
 * `subject: 'record'` attaches the claim to the observed thing; `'organisation'`
 * makes it a claim about the organisation itself, which is how SINGLE-aggregation
 * rules consume settings that have no per-asset subject.
 */
export interface PredicateMapping {
  /** Canonical payload key a connector writes, e.g. `diskEncrypted`. */
  readonly payloadKey: string;
  /** Canonical predicate the Truth Engine reasons about. */
  readonly predicate: string;
  readonly coercion: Coercion;
  readonly subject: 'record' | 'organisation';
}

function m(
  payloadKey: string,
  predicate: string,
  coercion: Coercion,
  subject: 'record' | 'organisation' = 'record',
): PredicateMapping {
  return { payloadKey, predicate, coercion, subject };
}

/**
 * The canonical mapping table, by observation kind.
 *
 * Payload keys are Adericel's own vocabulary — connectors map their vendor's
 * shape onto these keys, which is why one table serves every vendor in a
 * category and why swapping Intune for an RMM changes no rule.
 */
export const PREDICATE_MAP: Partial<Record<ObservationKind, readonly PredicateMapping[]>> = {
  IDENTITY_STATE: [
    m('enabled', 'identity.account.enabled', 'boolean'),
    m('accountType', 'identity.account.type', 'string'),
    m('mfaEnforced', 'identity.mfa.enforced', 'boolean'),
    m('mfaMethods', 'identity.mfa.methods', 'raw'),
    m('privileged', 'identity.privileged', 'boolean'),
    m('adminAccountSeparate', 'identity.admin_account_separate', 'boolean'),
    m('lastSignInAt', 'identity.last_sign_in_at', 'string'),
  ],
  DEVICE_STATE: [
    m('managed', 'device.managed', 'boolean'),
    m('diskEncrypted', 'device.disk.encrypted', 'boolean'),
    m('firewallEnabled', 'device.firewall.enabled', 'boolean'),
    m('autorunDisabled', 'device.autorun_disabled', 'boolean'),
    m('osSupported', 'device.os.supported', 'boolean'),
    m('osVersion', 'device.os.version', 'string'),
    m('lastPatchedAt', 'device.patch.last_applied_at', 'string'),
    m('lastSyncAt', 'device.management.last_sync_at', 'string'),
    m('endpointProtectionInstalled', 'device.endpoint_protection.installed', 'boolean'),
    m('endpointProtectionRealtime', 'device.endpoint_protection.realtime_enabled', 'boolean'),
    m('signaturesUpdatedAt', 'device.endpoint_protection.signatures_updated_at', 'string'),
    m('vendorSupported', 'asset.vendor_supported', 'boolean'),
    m('defaultCredentialsPresent', 'asset.default_credentials_present', 'boolean'),
  ],
  CLOUD_RESOURCE_STATE: [
    m('category', 'cloud.resource.category', 'string'),
    m('publicAccess', 'cloud.storage.public_access', 'boolean'),
    m('encryptionEnabled', 'cloud.storage.encryption_enabled', 'boolean'),
    m('defaultCredentialsPresent', 'asset.default_credentials_present', 'boolean'),
  ],
  VULNERABILITY: [
    m('criticalOverdue', 'vulnerability.critical_overdue', 'boolean'),
    m('highOrCriticalOverdue14d', 'vulnerability.high_or_critical_overdue_14d', 'boolean'),
    m('openCount', 'vulnerability.open_count', 'number'),
  ],
  BACKUP_STATE: [
    m('required', 'data.backup.required', 'boolean'),
    m('lastStatus', 'data.backup.last_status', 'string'),
    m('lastSuccessAt', 'data.backup.last_success_at', 'string'),
  ],
  CONFIGURATION_SETTING: [
    m('passwordMinLength', 'organisation.password.min_length', 'number', 'organisation'),
    m(
      'passwordBreachScreening',
      'organisation.password.breach_screening_enabled',
      'boolean',
      'organisation',
    ),
    m('adminCount', 'organisation.identity.admin_count', 'number', 'organisation'),
    m('loggingEnabled', 'organisation.logging.enabled', 'boolean', 'organisation'),
    m('logRetentionDays', 'organisation.logging.retention_days', 'number', 'organisation'),
    m('lastRestoreTestAt', 'organisation.backup.last_restore_test_at', 'string', 'organisation'),
    m('trainingCompletionRate', 'organisation.training.completion_rate', 'number', 'organisation'),
    m('incidentPlanPublished', 'organisation.incident.plan_published', 'boolean', 'organisation'),
    m('incidentLastExerciseAt', 'organisation.incident.last_exercise_at', 'string', 'organisation'),
    m('changeProcessPublished', 'organisation.change.process_published', 'boolean', 'organisation'),
    m('boundaryFirewallPresent', 'network.firewall.present', 'boolean', 'organisation'),
    m(
      'firewallDefaultDenyInbound',
      'network.firewall.default_deny_inbound',
      'boolean',
      'organisation',
    ),
  ],
  POLICY_DOCUMENT: [
    m('published', 'policy.published', 'boolean'),
    m('lastReviewedAt', 'policy.last_reviewed_at', 'string'),
  ],
  SUPPLIER_ATTESTATION: [
    m('criticality', 'supplier.criticality', 'string'),
    m('assuranceType', 'supplier.assurance.type', 'string'),
    m('verifiedAt', 'supplier.assurance.verified_at', 'string'),
  ],
  APPLICATION_STATE: [
    m('vendorSupported', 'asset.vendor_supported', 'boolean'),
    m('defaultCredentialsPresent', 'asset.default_credentials_present', 'boolean'),
  ],
};

/**
 * The canonical predicates a set of payload keys would produce.
 *
 * Used to derive a declaratively configured connector's real capability from
 * its field mappings. A connector that writes `diskEncrypted` supplies
 * `device.disk.encrypted`; claiming it supplies `diskEncrypted` would make the
 * predicate unresolvable and the control silently unassessable.
 */
export function predicatesForPayloadKeys(
  kind: ObservationKind,
  payloadKeys: readonly string[],
): readonly string[] {
  const mappings = PREDICATE_MAP[kind] ?? [];
  const wanted = new Set(payloadKeys);
  return [
    ...new Set(mappings.filter((entry) => wanted.has(entry.payloadKey)).map((e) => e.predicate)),
  ].sort();
}

/** Every canonical predicate an observation kind can produce. */
export function predicatesForKind(kind: ObservationKind): readonly string[] {
  return [...new Set((PREDICATE_MAP[kind] ?? []).map((e) => e.predicate))].sort();
}

/** Every canonical payload key an observation kind understands. */
export function payloadKeysForKind(kind: ObservationKind): readonly string[] {
  return [...new Set((PREDICATE_MAP[kind] ?? []).map((e) => e.payloadKey))].sort();
}

function claimsFromTable(observation: ObservationRecord, recordSubject: string | null) {
  const mappings = PREDICATE_MAP[observation.kind] ?? [];
  const payload = observation.payload;
  const claims: NormalisedClaim[] = [];
  for (const entry of mappings) {
    const value = COERCIONS[entry.coercion](payload[entry.payloadKey]);
    // A predicate is only asserted when the source actually said something. An
    // absent field must stay absent so it becomes UNKNOWN rather than a default.
    if (value === undefined) continue;
    claims.push({
      predicate: entry.predicate,
      value,
      subjectExternalId: entry.subject === 'organisation' ? null : recordSubject,
      subjectNodeId: null,
      extractionConfidence: null,
      observedAt: observation.observedAt,
      validUntil: null,
      supersedesClaimId: null,
    });
  }
  return claims;
}

/**
 * Subject construction by observation kind.
 *
 * Claims come from the table above; the node a claim hangs off is
 * kind-specific, so it stays here.
 */
type SubjectBuilder = (
  observation: ObservationRecord,
  externalId: string,
) => readonly NormalisedSubject[];

const SUBJECT_BUILDERS: Partial<Record<ObservationKind, SubjectBuilder>> = {
  IDENTITY_STATE: (o, externalId) => [
    {
      kind: 'Identity',
      externalId,
      label: str(o.payload.displayName) ?? str(o.payload.userPrincipalName) ?? externalId,
      attributes: {
        userPrincipalName: o.payload.userPrincipalName ?? null,
        accountType: o.payload.accountType ?? null,
        privileged: o.payload.privileged ?? null,
      },
    },
  ],
  DEVICE_STATE: (o, externalId) => [
    {
      kind: 'Device',
      externalId,
      label: str(o.payload.name) ?? externalId,
      attributes: {
        operatingSystem: o.payload.operatingSystem ?? null,
        osVersion: o.payload.osVersion ?? null,
        owner: o.payload.owner ?? null,
      },
    },
  ],
  CLOUD_RESOURCE_STATE: (o, externalId) => [
    {
      kind: 'CloudResource',
      externalId,
      label: str(o.payload.name) ?? externalId,
      attributes: {
        provider: o.payload.provider ?? null,
        region: o.payload.region ?? null,
        category: o.payload.category ?? null,
      },
    },
  ],
  BACKUP_STATE: (o, externalId) => [
    {
      kind: 'DataAsset',
      externalId,
      label: str(o.payload.name) ?? externalId,
      attributes: { system: o.payload.system ?? null },
    },
  ],
  POLICY_DOCUMENT: (o, externalId) => [
    {
      kind: 'Policy',
      externalId,
      label: str(o.payload.title) ?? externalId,
      attributes: { owner: o.payload.owner ?? null, version: o.payload.version ?? null },
    },
  ],
  SUPPLIER_ATTESTATION: (o, externalId) => [
    {
      kind: 'Supplier',
      externalId,
      label: str(o.payload.name) ?? externalId,
      attributes: { criticality: o.payload.criticality ?? null },
    },
  ],
  APPLICATION_STATE: (o, externalId) => [
    {
      kind: 'Application',
      externalId,
      label: str(o.payload.name) ?? externalId,
      attributes: { vendor: o.payload.vendor ?? null, version: o.payload.version ?? null },
    },
  ],
  // VULNERABILITY and CONFIGURATION_SETTING create no nodes of their own: a
  // vulnerability is a fact about an asset another observation already created,
  // and a setting is a fact about the organisation.
};

/** Where an observation's per-record subject identifier lives in its payload. */
const SUBJECT_ID_FIELD: Partial<Record<ObservationKind, string>> = {
  VULNERABILITY: 'assetExternalId',
};

/** Normalise an observation; returns empty when no mapping is registered. */
export function normalise(observation: ObservationRecord): Normalisation {
  const mappings = PREDICATE_MAP[observation.kind];
  if (!mappings) return { subjects: [], claims: [] };

  const idField = SUBJECT_ID_FIELD[observation.kind] ?? 'externalId';
  const externalId = str(observation.payload[idField]) ?? observation.subjectExternalId ?? '';

  const subjects = SUBJECT_BUILDERS[observation.kind]?.(observation, externalId) ?? [];
  return { subjects, claims: claimsFromTable(observation, externalId) };
}

/**
 * Kept for callers that dispatch by kind. Backed by the same table, so there is
 * no second implementation to drift.
 */
export const NORMALISERS: Partial<Record<ObservationKind, Normaliser>> = Object.fromEntries(
  Object.keys(PREDICATE_MAP).map((kind) => [kind, (o: ObservationRecord) => normalise(o)]),
) as Partial<Record<ObservationKind, Normaliser>>;
