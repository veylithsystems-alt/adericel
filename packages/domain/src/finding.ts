import { z } from 'zod';

export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severitySchema = z.enum(SEVERITIES);

export const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export const FINDING_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_REMEDIATION',
  'RESOLVED',
  'ACCEPTED_RISK',
  'FALSE_POSITIVE',
  'SUPERSEDED',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export const findingStatusSchema = z.enum(FINDING_STATUSES);

/**
 * A finding is a durable statement that something is wrong, raised by an
 * assessment. Findings persist across reassessments via `fingerprint`, so an
 * MSP sees "this has been open for 40 days" rather than a new finding every
 * time the scheduler runs.
 */
export interface FindingRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly controlId: string | null;
  readonly requirementId: string | null;
  readonly subjectNodeId: string | null;
  readonly assessmentId: string;
  /** Stable identity of the underlying problem across reassessments. */
  readonly fingerprint: string;
  readonly title: string;
  readonly description: string;
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly evidenceIds: readonly string[];
  readonly firstDetectedAt: string;
  readonly lastDetectedAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: Record<string, unknown>;
}

export const RISK_TREATMENTS = ['MITIGATE', 'ACCEPT', 'TRANSFER', 'AVOID'] as const;
export type RiskTreatment = (typeof RISK_TREATMENTS)[number];

export const RISK_STATUSES = ['IDENTIFIED', 'ASSESSED', 'TREATED', 'ACCEPTED', 'CLOSED'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const LIKELIHOODS = ['RARE', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'ALMOST_CERTAIN'] as const;
export type Likelihood = (typeof LIKELIHOODS)[number];
export const LIKELIHOOD_RANK: Record<Likelihood, number> = {
  RARE: 1,
  UNLIKELY: 2,
  POSSIBLE: 3,
  LIKELY: 4,
  ALMOST_CERTAIN: 5,
};

export const IMPACTS = ['NEGLIGIBLE', 'MINOR', 'MODERATE', 'MAJOR', 'SEVERE'] as const;
export type Impact = (typeof IMPACTS)[number];
export const IMPACT_RANK: Record<Impact, number> = {
  NEGLIGIBLE: 1,
  MINOR: 2,
  MODERATE: 3,
  MAJOR: 4,
  SEVERE: 5,
};

export interface RiskRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly description: string | null;
  readonly likelihood: Likelihood | null;
  readonly impact: Impact | null;
  readonly inherentSeverity: Severity;
  readonly residualSeverity: Severity | null;
  readonly status: RiskStatus;
  readonly treatment: RiskTreatment | null;
  readonly ownerUserId: string | null;
  readonly findingIds: readonly string[];
  readonly reviewDueAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Risk severity from likelihood and impact.
 *
 * Returns null when either axis is unknown — an unassessed risk must not be
 * quietly rendered as LOW.
 */
export function deriveRiskSeverity(
  likelihood: Likelihood | null,
  impact: Impact | null,
): Severity | null {
  if (likelihood === null || impact === null) return null;
  const score = LIKELIHOOD_RANK[likelihood] * IMPACT_RANK[impact];
  if (score >= 20) return 'CRITICAL';
  if (score >= 12) return 'HIGH';
  if (score >= 6) return 'MEDIUM';
  if (score >= 3) return 'LOW';
  return 'INFO';
}

export const EXCEPTION_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/**
 * An exception is an authorised, time-bounded deviation. Exceptions always
 * expire: an exception without an end date is indistinguishable from ignoring
 * the control, so `expiresAt` is required.
 */
export interface ExceptionRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly controlId: string | null;
  readonly requirementId: string | null;
  readonly findingId: string | null;
  readonly subjectNodeId: string | null;
  readonly justification: string;
  readonly compensatingControls: string | null;
  readonly status: ExceptionStatus;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly effectiveFrom: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export const exceptionRequestSchema = z.object({
  controlId: z.string().uuid().nullable().optional(),
  requirementId: z.string().uuid().nullable().optional(),
  findingId: z.string().uuid().nullable().optional(),
  subjectNodeId: z.string().uuid().nullable().optional(),
  justification: z.string().min(20).max(4000),
  compensatingControls: z.string().max(4000).nullable().optional(),
  effectiveFrom: z.string().datetime().optional(),
  expiresAt: z.string().datetime(),
});

export type ExceptionRequest = z.infer<typeof exceptionRequestSchema>;

/** An exception only suppresses a control while it is approved and in date. */
export function isExceptionActive(
  exception: Pick<ExceptionRecord, 'status' | 'effectiveFrom' | 'expiresAt' | 'revokedAt'>,
  atIso: string,
): boolean {
  if (exception.status !== 'APPROVED') return false;
  if (exception.revokedAt !== null) return false;
  const at = Date.parse(atIso);
  return Date.parse(exception.effectiveFrom) <= at && Date.parse(exception.expiresAt) > at;
}
