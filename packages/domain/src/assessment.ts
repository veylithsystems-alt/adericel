import { z } from 'zod';
import {
  assuranceStateSchema,
  unknownReasonSchema,
  type AssuranceState,
  type UnknownReason,
} from './assurance.js';

/**
 * An assessment is a recorded, reproducible determination made by the Truth
 * Engine. Everything needed to re-run it is captured: which rules, which
 * version of those rules, which inputs, and at what instant.
 */
export const ASSESSMENT_SUBJECT_KINDS = [
  'CONTROL',
  'REQUIREMENT',
  'FRAMEWORK',
  'ORGANISATION',
] as const;
export type AssessmentSubjectKind = (typeof ASSESSMENT_SUBJECT_KINDS)[number];
export const assessmentSubjectKindSchema = z.enum(ASSESSMENT_SUBJECT_KINDS);

export const ASSESSMENT_TRIGGERS = [
  'SCHEDULED',
  'EVIDENCE_CHANGED',
  'CLAIM_CHANGED',
  'MANUAL',
  'ACTION_VERIFICATION',
  'ONBOARDING',
  'RULESET_CHANGED',
  'REPLAY',
] as const;
export type AssessmentTrigger = (typeof ASSESSMENT_TRIGGERS)[number];
export const assessmentTriggerSchema = z.enum(ASSESSMENT_TRIGGERS);

/**
 * Reproducibility record. `inputDigest` is the canonical hash of the exact
 * inputs handed to the engine, so a replay can prove it used the same facts.
 */
export interface AssessmentProvenance {
  readonly engineVersion: string;
  readonly rulesetKey: string;
  readonly rulesetVersion: string;
  readonly rulesetHash: string;
  readonly ruleKey: string;
  readonly inputDigest: string;
  readonly evidenceIds: readonly string[];
  readonly claimIds: readonly string[];
  readonly assessedAt: string;
}

export interface AssessmentRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly subjectKind: AssessmentSubjectKind;
  readonly subjectId: string;
  readonly state: AssuranceState;
  readonly unknownReason: UnknownReason | null;
  /** Human-readable, rule-authored explanation of the determination. */
  readonly rationale: string;
  /** Machine-readable trace of which conditions held. */
  readonly reasoning: readonly ReasoningStep[];
  readonly trigger: AssessmentTrigger;
  readonly provenance: AssessmentProvenance;
  readonly previousAssessmentId: string | null;
  readonly stateChanged: boolean;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

/** One evaluated condition inside a rule, retained for explainability. */
export interface ReasoningStep {
  readonly step: string;
  readonly outcome: 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIPPED';
  readonly detail: string;
  readonly evidenceIds?: readonly string[];
  readonly claimIds?: readonly string[];
}

export const reasoningStepSchema = z.object({
  step: z.string().min(1),
  outcome: z.enum(['PASS', 'FAIL', 'UNKNOWN', 'SKIPPED']),
  detail: z.string(),
  evidenceIds: z.array(z.string().uuid()).optional(),
  claimIds: z.array(z.string().uuid()).optional(),
});

export const assessmentRequestSchema = z.object({
  subjectKind: assessmentSubjectKindSchema,
  subjectId: z.string().uuid(),
  trigger: assessmentTriggerSchema.default('MANUAL'),
  /** Assess as at a historical instant. Used for replay and audit. */
  asOf: z.string().datetime().optional(),
  rulesetVersion: z.string().optional(),
});

export type AssessmentRequest = z.infer<typeof assessmentRequestSchema>;

/**
 * The current assurance state of a subject, maintained as a projection of the
 * latest assessment. Kept as its own record so the portfolio view does not have
 * to scan assessment history on every read.
 */
export interface AssuranceStateRecord {
  readonly organisationId: string;
  readonly subjectKind: AssessmentSubjectKind;
  readonly subjectId: string;
  readonly state: AssuranceState;
  readonly unknownReason: UnknownReason | null;
  readonly assessmentId: string;
  readonly since: string;
  readonly lastAssessedAt: string;
  readonly previousState: AssuranceState | null;
  readonly updatedAt: string;
}

export const assuranceStateRecordSchema = z.object({
  subjectKind: assessmentSubjectKindSchema,
  subjectId: z.string().uuid(),
  state: assuranceStateSchema,
  unknownReason: unknownReasonSchema.nullable(),
});
