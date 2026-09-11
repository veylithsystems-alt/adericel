import { z } from 'zod';

/**
 * A claim is a structured, checkable statement about the organisation, derived
 * from evidence. Claims are the interface between messy source data and the
 * Truth Engine: rules are written against claim subjects and predicates, never
 * against a particular vendor's JSON shape.
 *
 * A claim is not a truth. It is a candidate proposition with a stated evidential
 * basis. The Truth Engine decides whether it is supported.
 */
export const CLAIM_ORIGINS = [
  'DETERMINISTIC_NORMALISATION',
  'INTEGRATION_ASSERTED',
  'HUMAN_ASSERTED',
  'AI_SUGGESTED',
  'VERIFICATION_DERIVED',
] as const;
export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];
export const claimOriginSchema = z.enum(CLAIM_ORIGINS);

/**
 * Claims produced by an LLM enter the graph as candidates only. They must be
 * confirmed by evidence or by a human before any rule may rely on them; the
 * Truth Engine enforces this and will not consume an unconfirmed AI claim.
 */
export const CLAIM_STATUSES = [
  'CANDIDATE',
  'CONFIRMED',
  'REJECTED',
  'SUPERSEDED',
  'WITHDRAWN',
  /**
   * Two sources disagree and nothing configured resolves it.
   *
   * A disputed claim is one Adericel refuses to read, not one it reads
   * cautiously: it is excluded from every rule query, so the controls resting
   * on it report UNKNOWN with the disagreement as their reason. Choosing a
   * value here would mean deciding a contested fact by scheduling accident.
   */
  'DISPUTED',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const claimStatusSchema = z.enum(CLAIM_STATUSES);

export interface ClaimRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  /** Dotted namespace, e.g. `identity.mfa.enforced` or `device.disk.encrypted`. */
  readonly predicate: string;
  /** Node the claim is about; null for organisation-wide claims. */
  readonly subjectNodeId: string | null;
  readonly subjectExternalId: string | null;
  /** Structured value of the claim. Shape is defined per predicate. */
  readonly value: unknown;
  readonly origin: ClaimOrigin;
  readonly status: ClaimStatus;
  /** Extraction/classification confidence, 0..1. Never an assurance probability. */
  readonly extractionConfidence: number | null;
  readonly evidenceIds: readonly string[];
  readonly supersedesClaimId: string | null;
  readonly observedAt: string | null;
  readonly assertedAt: string;
  readonly validUntil: string | null;
  readonly createdAt: string;
  readonly createdByActor: string;
  readonly metadata: Record<string, unknown>;
  /** The integration that produced this claim, or null if a person or a verification did. */
  readonly sourceIntegrationId: string | null;
}

export const claimInputSchema = z.object({
  predicate: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/, 'Predicate must be a dotted lowercase namespace'),
  subjectNodeId: z.string().uuid().nullable().optional(),
  subjectExternalId: z.string().max(512).nullable().optional(),
  value: z.unknown(),
  origin: claimOriginSchema,
  status: claimStatusSchema.default('CANDIDATE'),
  extractionConfidence: z.number().min(0).max(1).nullable().optional(),
  evidenceIds: z.array(z.string().uuid()).default([]),
  observedAt: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  supersedesClaimId: z.string().uuid().nullable().optional(),
  /**
   * The integration that produced this claim, where one did.
   *
   * Null for human assertions and verification-derived claims, which have no
   * source integration and must not be given a borrowed one. Recorded so that
   * two sources speaking to the same predicate can be compared rather than
   * silently superseding one another.
   */
  sourceIntegrationId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ClaimInput = z.infer<typeof claimInputSchema>;

/**
 * Whether a claim may be used as an input to a deterministic rule.
 *
 * AI-suggested claims are excluded unless a human or a verification has
 * confirmed them. This is the enforcement point for the AI/truth boundary.
 */
export function isRuleEligible(claim: Pick<ClaimRecord, 'origin' | 'status'>): {
  eligible: boolean;
  reason: string | null;
} {
  if (claim.status === 'REJECTED') return { eligible: false, reason: 'Claim was rejected' };
  if (claim.status === 'WITHDRAWN') return { eligible: false, reason: 'Claim was withdrawn' };
  if (claim.status === 'SUPERSEDED') return { eligible: false, reason: 'Claim was superseded' };
  if (claim.status === 'DISPUTED') {
    return { eligible: false, reason: 'Sources disagree and the disagreement is unresolved' };
  }
  if (claim.origin === 'AI_SUGGESTED' && claim.status !== 'CONFIRMED') {
    return {
      eligible: false,
      reason: 'AI-suggested claims require confirmation before they can support an assessment',
    };
  }
  return { eligible: true, reason: null };
}
