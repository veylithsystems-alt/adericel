import { z } from 'zod';

/**
 * Evidence is the load-bearing artefact in Adericel. Everything the Truth
 * Engine concludes rests on evidence with recorded provenance, integrity and
 * validity. Evidence is never overwritten: it is superseded or revoked, and the
 * superseded record remains readable so historical assessments stay explicable.
 */
export const EVIDENCE_SOURCE_TYPES = [
  'INTEGRATION_API',
  'DOCUMENT_UPLOAD',
  'ATTESTATION',
  'SCAN_RESULT',
  'CONFIGURATION_EXPORT',
  'LOG_EXTRACT',
  'THIRD_PARTY_REPORT',
  'ADERICEL_VERIFICATION',
  'MANUAL_ENTRY',
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];
export const evidenceSourceTypeSchema = z.enum(EVIDENCE_SOURCE_TYPES);

export const COLLECTION_METHODS = [
  'AUTOMATED_PULL',
  'AUTOMATED_PUSH',
  'WEBHOOK',
  'HUMAN_UPLOAD',
  'HUMAN_ATTESTATION',
  'DERIVED',
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];
export const collectionMethodSchema = z.enum(COLLECTION_METHODS);

export const EVIDENCE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export const evidenceStatusSchema = z.enum(EVIDENCE_STATUSES);

/**
 * How much we trust that the evidence is what it claims to be.
 *
 * This is emphatically NOT a probability that the organisation is secure. It
 * describes the artefact only.
 */
export const INTEGRITY_LEVELS = [
  'UNVERIFIED',
  'HASH_VERIFIED',
  'SOURCE_AUTHENTICATED',
  'CRYPTOGRAPHICALLY_SIGNED',
] as const;
export type IntegrityLevel = (typeof INTEGRITY_LEVELS)[number];
export const integrityLevelSchema = z.enum(INTEGRITY_LEVELS);

export const INTEGRITY_RANK: Record<IntegrityLevel, number> = {
  UNVERIFIED: 0,
  HASH_VERIFIED: 1,
  SOURCE_AUTHENTICATED: 2,
  CRYPTOGRAPHICALLY_SIGNED: 3,
};

export interface EvidenceRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly sourceType: EvidenceSourceType;
  readonly collectionMethod: CollectionMethod;
  readonly integrationId: string | null;
  readonly sourceSystem: string;
  readonly sourceReference: string | null;
  readonly title: string;
  readonly contentHash: string;
  readonly contentType: string;
  readonly contentSizeBytes: number | null;
  readonly storageKey: string | null;
  /** Small structured payloads live inline; large artefacts live in object storage. */
  readonly payload: Record<string, unknown> | null;
  readonly integrityLevel: IntegrityLevel;
  readonly status: EvidenceStatus;
  readonly supersedesEvidenceId: string | null;
  readonly revocationReason: string | null;

  /** When the underlying fact was true in the real world, if the source says. */
  readonly observedAt: string | null;
  /** When Adericel collected it. Always known. */
  readonly collectedAt: string;
  readonly validFrom: string;
  /** Beyond this instant the evidence no longer supports a positive claim. */
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly supersededAt: string | null;
  readonly createdAt: string;

  readonly collectedByActor: string;
  readonly metadata: Record<string, unknown>;
}

export const evidenceIngestSchema = z.object({
  sourceType: evidenceSourceTypeSchema,
  collectionMethod: collectionMethodSchema,
  integrationId: z.string().uuid().nullable().optional(),
  sourceSystem: z.string().min(1).max(200),
  sourceReference: z.string().max(1024).nullable().optional(),
  title: z.string().min(1).max(512),
  contentType: z.string().min(1).max(200).default('application/json'),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  storageKey: z.string().max(1024).nullable().optional(),
  contentHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  contentSizeBytes: z.number().int().nonnegative().nullable().optional(),
  integrityLevel: integrityLevelSchema.default('UNVERIFIED'),
  observedAt: z.string().datetime().nullable().optional(),
  collectedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  subjectNodeIds: z.array(z.string().uuid()).default([]),
  supersedesEvidenceId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type EvidenceIngestInput = z.infer<typeof evidenceIngestSchema>;

/**
 * Freshness policy. Different evidence classes decay at very different rates:
 * an MFA configuration snapshot is stale within days; a penetration test report
 * is meaningful for a year.
 */
export interface FreshnessPolicy {
  readonly maxAgeDays: number;
  /** Age at which the evidence is flagged as approaching expiry. */
  readonly warnAfterDays: number;
}

export const DEFAULT_FRESHNESS_BY_SOURCE_TYPE: Record<EvidenceSourceType, FreshnessPolicy> = {
  INTEGRATION_API: { maxAgeDays: 7, warnAfterDays: 5 },
  DOCUMENT_UPLOAD: { maxAgeDays: 365, warnAfterDays: 300 },
  ATTESTATION: { maxAgeDays: 180, warnAfterDays: 150 },
  SCAN_RESULT: { maxAgeDays: 30, warnAfterDays: 21 },
  CONFIGURATION_EXPORT: { maxAgeDays: 14, warnAfterDays: 10 },
  LOG_EXTRACT: { maxAgeDays: 7, warnAfterDays: 5 },
  THIRD_PARTY_REPORT: { maxAgeDays: 365, warnAfterDays: 300 },
  ADERICEL_VERIFICATION: { maxAgeDays: 30, warnAfterDays: 21 },
  MANUAL_ENTRY: { maxAgeDays: 90, warnAfterDays: 60 },
};

export const FRESHNESS_STATES = ['FRESH', 'AGEING', 'STALE', 'EXPIRED'] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/**
 * Whether a piece of evidence may currently be relied upon.
 *
 * Deliberately a pure function of the record, the policy and an explicit
 * instant — no ambient clock — so an assessment can be replayed exactly.
 */
export interface EvidenceUsability {
  readonly usable: boolean;
  readonly freshness: FreshnessState;
  readonly ageDays: number;
  readonly reason: string | null;
}

export function evaluateEvidenceUsability(
  evidence: Pick<
    EvidenceRecord,
    'status' | 'sourceType' | 'observedAt' | 'collectedAt' | 'validFrom' | 'validUntil'
  >,
  atIso: string,
  policy?: FreshnessPolicy,
): EvidenceUsability {
  const at = Date.parse(atIso);
  const effectivePolicy = policy ?? DEFAULT_FRESHNESS_BY_SOURCE_TYPE[evidence.sourceType];
  const anchorIso = evidence.observedAt ?? evidence.collectedAt;
  const anchor = Date.parse(anchorIso);
  const ageDays = (at - anchor) / 86_400_000;

  if (evidence.status === 'REVOKED') {
    return { usable: false, freshness: 'EXPIRED', ageDays, reason: 'Evidence has been revoked' };
  }
  if (evidence.status === 'SUPERSEDED') {
    return {
      usable: false,
      freshness: 'EXPIRED',
      ageDays,
      reason: 'Evidence has been superseded by a later record',
    };
  }
  if (Date.parse(evidence.validFrom) > at) {
    return { usable: false, freshness: 'FRESH', ageDays, reason: 'Evidence is not yet valid' };
  }
  if (evidence.validUntil !== null && Date.parse(evidence.validUntil) <= at) {
    return {
      usable: false,
      freshness: 'EXPIRED',
      ageDays,
      reason: 'Evidence validity period has ended',
    };
  }
  if (ageDays > effectivePolicy.maxAgeDays) {
    return {
      usable: false,
      freshness: 'STALE',
      ageDays,
      reason: `Evidence is ${ageDays.toFixed(1)} days old, beyond the ${effectivePolicy.maxAgeDays}-day limit for ${evidence.sourceType}`,
    };
  }
  if (ageDays > effectivePolicy.warnAfterDays) {
    return { usable: true, freshness: 'AGEING', ageDays, reason: null };
  }
  return { usable: true, freshness: 'FRESH', ageDays, reason: null };
}
