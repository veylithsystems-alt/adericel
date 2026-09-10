import {
  claimOriginSchema,
  claimStatusSchema,
  evidenceSourceTypeSchema,
  evidenceStatusSchema,
} from '@adericel/domain';
import { z } from 'zod';
import type { ControlAssessmentInput } from './engine.js';

/**
 * The recorded input of an assessment.
 *
 * An assessment records a digest of the facts it used. A digest can confirm a
 * candidate set of facts; it cannot reconstruct them. Without the facts
 * themselves, "why did Adericel say this?" is answerable only for as long as
 * nothing has changed — which, for a system whose whole purpose is to watch
 * things change, is no time at all.
 *
 * So the input is stored verbatim and replayed from the record. This schema is
 * the boundary: a snapshot read back from the database is data of unknown
 * provenance until it has been parsed, and the engine is never handed anything
 * that has not been.
 */

const isoInstant = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO 8601 instant');

export const evidenceFactsSchema = z.object({
  id: z.string().min(1),
  status: evidenceStatusSchema,
  sourceType: evidenceSourceTypeSchema,
  observedAt: isoInstant.nullable(),
  collectedAt: isoInstant,
  validFrom: isoInstant,
  validUntil: isoInstant.nullable(),
});

export const claimFactsSchema = z.object({
  id: z.string().min(1),
  predicate: z.string().min(1),
  value: z.unknown(),
  origin: claimOriginSchema,
  status: claimStatusSchema,
  observedAt: isoInstant.nullable(),
  assertedAt: isoInstant,
  validUntil: isoInstant.nullable(),
  evidenceIds: z.array(z.string().min(1)),
});

export const subjectFactsSchema = z.object({
  nodeId: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  claims: z.array(claimFactsSchema),
});

export const exceptionFactsSchema = z.object({
  id: z.string().min(1),
  subjectNodeId: z.string().min(1).nullable(),
  justification: z.string(),
  expiresAt: isoInstant,
});

export const controlAssessmentInputSchema = z.object({
  organisationId: z.string().min(1),
  controlId: z.string().min(1),
  controlKey: z.string().min(1),
  ruleKey: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  asOfIso: isoInstant,
  subjects: z.array(subjectFactsSchema),
  organisationClaims: z.array(claimFactsSchema),
  evidence: z.array(evidenceFactsSchema),
  activeExceptions: z.array(exceptionFactsSchema),
  observedSubjectKinds: z.array(z.string().min(1)),
});

/**
 * Parse a stored snapshot back into engine input.
 *
 * Throws on anything that is not a complete, well-formed input. A snapshot that
 * cannot be parsed must surface as a failure to reproduce, never as a partially
 * populated input that quietly assesses to UNKNOWN — that would turn a storage
 * fault into an apparent finding about the customer's estate.
 */
export function parseAssessmentInput(value: unknown): ControlAssessmentInput {
  return controlAssessmentInputSchema.parse(value) as ControlAssessmentInput;
}
