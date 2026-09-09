import type { ClaimInput, NodeKind, ObservationKind, ObservationRecord } from '@adericel/domain';

/**
 * Observation normalisation.
 *
 * This is the layer that turns "what a connector saw" into the canonical
 * predicates the Truth Engine reasons about. It is deterministic and
 * side-effect free, which matters because a claim's origin is recorded as
 * DETERMINISTIC_NORMALISATION — an assertion that a human can check by reading
 * this code, not a probabilistic extraction.
 */

export interface NormalisedSubject {
  readonly kind: NodeKind;
  readonly externalId: string;
  readonly label: string;
  readonly attributes: Record<string, unknown>;
}

export interface NormalisedClaim extends Omit<ClaimInput, 'evidenceIds' | 'origin' | 'status' | 'metadata'> {
  readonly subjectExternalId: string | null;
}

export interface Normalisation {
  readonly subjects: readonly NormalisedSubject[];
  readonly claims: readonly NormalisedClaim[];
}

export type Normaliser = (observation: ObservationRecord) => Normalisation;

function claim(
  predicate: string,
  value: unknown,
  subjectExternalId: string | null,
  observedAt: string | null,
): NormalisedClaim {
  return {
    predicate,
    value,
    subjectExternalId,
    subjectNodeId: null,
    extractionConfidence: null,
    observedAt,
    validUntil: null,
    supersedesClaimId: null,
  };
}

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

function push(
  claims: NormalisedClaim[],
  predicate: string,
  value: unknown,
  subject: string | null,
  observedAt: string | null,
): void {
  // A predicate is only asserted when the source actually said something. An
  // absent field must stay absent so it becomes UNKNOWN rather than a default.
  if (value === undefined) return;
  claims.push(claim(predicate, value, subject, observedAt));
}

/**
 * Canonical normalisers by observation kind.
 *
 * Payload keys are Adericel's canonical vocabulary — connectors map their
 * vendor's shape onto these keys, which is why one normaliser serves every
 * vendor in a category.
 */
export const NORMALISERS: Partial<Record<ObservationKind, Normaliser>> = {
  IDENTITY_STATE(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'identity.account.enabled', bool(p.enabled), externalId, observedAt);
    push(claims, 'identity.account.type', str(p.accountType), externalId, observedAt);
    push(claims, 'identity.mfa.enforced', bool(p.mfaEnforced), externalId, observedAt);
    push(claims, 'identity.mfa.methods', p.mfaMethods, externalId, observedAt);
    push(claims, 'identity.privileged', bool(p.privileged), externalId, observedAt);
    push(claims, 'identity.admin_account_separate', bool(p.adminAccountSeparate), externalId, observedAt);
    push(claims, 'identity.last_sign_in_at', str(p.lastSignInAt), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'Identity',
          externalId,
          label: str(p.displayName) ?? str(p.userPrincipalName) ?? externalId,
          attributes: {
            userPrincipalName: p.userPrincipalName ?? null,
            accountType: p.accountType ?? null,
            privileged: p.privileged ?? null,
          },
        },
      ],
      claims,
    };
  },

  DEVICE_STATE(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'device.managed', bool(p.managed), externalId, observedAt);
    push(claims, 'device.disk.encrypted', bool(p.diskEncrypted), externalId, observedAt);
    push(claims, 'device.firewall.enabled', bool(p.firewallEnabled), externalId, observedAt);
    push(claims, 'device.autorun_disabled', bool(p.autorunDisabled), externalId, observedAt);
    push(claims, 'device.os.supported', bool(p.osSupported), externalId, observedAt);
    push(claims, 'device.os.version', str(p.osVersion), externalId, observedAt);
    push(claims, 'device.patch.last_applied_at', str(p.lastPatchedAt), externalId, observedAt);
    push(claims, 'device.endpoint_protection.installed', bool(p.endpointProtectionInstalled), externalId, observedAt);
    push(claims, 'device.endpoint_protection.realtime_enabled', bool(p.endpointProtectionRealtime), externalId, observedAt);
    push(claims, 'device.endpoint_protection.signatures_updated_at', str(p.signaturesUpdatedAt), externalId, observedAt);
    push(claims, 'asset.vendor_supported', bool(p.vendorSupported), externalId, observedAt);
    push(claims, 'asset.default_credentials_present', bool(p.defaultCredentialsPresent), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'Device',
          externalId,
          label: str(p.name) ?? externalId,
          attributes: {
            operatingSystem: p.operatingSystem ?? null,
            osVersion: p.osVersion ?? null,
            owner: p.owner ?? null,
          },
        },
      ],
      claims,
    };
  },

  CLOUD_RESOURCE_STATE(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'cloud.resource.category', str(p.category), externalId, observedAt);
    push(claims, 'cloud.storage.public_access', bool(p.publicAccess), externalId, observedAt);
    push(claims, 'cloud.storage.encryption_enabled', bool(p.encryptionEnabled), externalId, observedAt);
    push(claims, 'asset.default_credentials_present', bool(p.defaultCredentialsPresent), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'CloudResource',
          externalId,
          label: str(p.name) ?? externalId,
          attributes: { provider: p.provider ?? null, region: p.region ?? null, category: p.category ?? null },
        },
      ],
      claims,
    };
  },

  VULNERABILITY(observation) {
    const p = observation.payload;
    const externalId = str(p.assetExternalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'vulnerability.critical_overdue', bool(p.criticalOverdue), externalId, observedAt);
    push(claims, 'vulnerability.high_or_critical_overdue_14d', bool(p.highOrCriticalOverdue14d), externalId, observedAt);
    push(claims, 'vulnerability.open_count', num(p.openCount), externalId, observedAt);
    return { subjects: [], claims };
  },

  BACKUP_STATE(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'data.backup.required', bool(p.required), externalId, observedAt);
    push(claims, 'data.backup.last_status', str(p.lastStatus), externalId, observedAt);
    push(claims, 'data.backup.last_success_at', str(p.lastSuccessAt), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'DataAsset',
          externalId,
          label: str(p.name) ?? externalId,
          attributes: { system: p.system ?? null },
        },
      ],
      claims,
    };
  },

  CONFIGURATION_SETTING(observation) {
    const p = observation.payload;
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    // Organisation-wide settings carry no subject: they are claims about the
    // organisation itself, which is how SINGLE-aggregation rules consume them.
    push(claims, 'organisation.password.min_length', num(p.passwordMinLength), null, observedAt);
    push(claims, 'organisation.password.breach_screening_enabled', bool(p.passwordBreachScreening), null, observedAt);
    push(claims, 'organisation.identity.admin_count', num(p.adminCount), null, observedAt);
    push(claims, 'organisation.logging.enabled', bool(p.loggingEnabled), null, observedAt);
    push(claims, 'organisation.logging.retention_days', num(p.logRetentionDays), null, observedAt);
    push(claims, 'organisation.backup.last_restore_test_at', str(p.lastRestoreTestAt), null, observedAt);
    push(claims, 'organisation.training.completion_rate', num(p.trainingCompletionRate), null, observedAt);
    push(claims, 'network.firewall.present', bool(p.boundaryFirewallPresent), null, observedAt);
    push(claims, 'network.firewall.default_deny_inbound', bool(p.firewallDefaultDenyInbound), null, observedAt);
    return { subjects: [], claims };
  },

  POLICY_DOCUMENT(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'policy.published', bool(p.published), externalId, observedAt);
    push(claims, 'policy.last_reviewed_at', str(p.lastReviewedAt), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'Policy',
          externalId,
          label: str(p.title) ?? externalId,
          attributes: { owner: p.owner ?? null, version: p.version ?? null },
        },
      ],
      claims,
    };
  },

  SUPPLIER_ATTESTATION(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'supplier.criticality', str(p.criticality), externalId, observedAt);
    push(claims, 'supplier.assurance.type', str(p.assuranceType), externalId, observedAt);
    push(claims, 'supplier.assurance.verified_at', str(p.verifiedAt), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'Supplier',
          externalId,
          label: str(p.name) ?? externalId,
          attributes: { criticality: p.criticality ?? null },
        },
      ],
      claims,
    };
  },

  APPLICATION_STATE(observation) {
    const p = observation.payload;
    const externalId = str(p.externalId) ?? observation.subjectExternalId ?? '';
    const observedAt = observation.observedAt;
    const claims: NormalisedClaim[] = [];
    push(claims, 'asset.vendor_supported', bool(p.vendorSupported), externalId, observedAt);
    push(claims, 'asset.default_credentials_present', bool(p.defaultCredentialsPresent), externalId, observedAt);
    return {
      subjects: [
        {
          kind: 'Application',
          externalId,
          label: str(p.name) ?? externalId,
          attributes: { vendor: p.vendor ?? null, version: p.version ?? null },
        },
      ],
      claims,
    };
  },
};

/** Normalise an observation; returns empty when no normaliser is registered. */
export function normalise(observation: ObservationRecord): Normalisation {
  const normaliser = NORMALISERS[observation.kind];
  if (!normaliser) return { subjects: [], claims: [] };
  return normaliser(observation);
}
