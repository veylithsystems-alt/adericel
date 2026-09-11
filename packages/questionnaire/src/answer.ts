import { z } from 'zod';

/**
 * What an answer can be.
 *
 * Six states, set by the Truth Engine and the attestation record — never by a
 * renderer, never by a model. The vocabulary is deliberately wider than the
 * Yes/No most forms offer, because the whole product thesis is that the honest
 * answer is often neither.
 *
 * See ADR-0034 (an answer is a determination) and ADR-0036 (no silent yes).
 */
export const ANSWER_STATES = [
  /** The requirement holds across its full scope, on evidence inside the window. */
  'SUPPORTED',
  /** The requirement demonstrably fails. */
  'NOT_MET',
  /** Holds for part of the scope. Exceptions exist and are named. */
  'QUALIFIED',
  /** Adericel cannot determine it: no evidence, stale evidence, or disputed sources. */
  'UNKNOWN',
  /** An organisational matter no system observes, confirmed by a named person. */
  'ATTESTED',
  /** Out of scope for this organisation, with a recorded reason. */
  'NOT_APPLICABLE',
] as const;
export type AnswerState = (typeof ANSWER_STATES)[number];
export const answerStateSchema = z.enum(ANSWER_STATES);

/**
 * The only state that may be rendered as a bare positive.
 *
 * Written as a set of one rather than as a comparison, so that any future
 * addition to the vocabulary has to be considered against this rule explicitly
 * instead of inheriting permission by looking similar to SUPPORTED.
 */
export const POSITIVE_RENDERABLE_STATES: ReadonlySet<AnswerState> = new Set<AnswerState>([
  'SUPPORTED',
]);

/**
 * Whether a state may be rendered as an unqualified positive.
 *
 * ATTESTED is deliberately excluded. A person saying "yes, we have a policy" is
 * a different kind of claim from an observation, and a form reader is entitled
 * to know which they are looking at. It renders as the attester's answer, with
 * the attestation stated.
 */
export function mayRenderAsBarePositive(state: AnswerState): boolean {
  return POSITIVE_RENDERABLE_STATES.has(state);
}

/** Who sent the form. Decides the rendering policy and the approval rules. */
export const SENDER_TYPES = [
  'INSURER',
  'BROKER',
  'CUSTOMER_DUE_DILIGENCE',
  'TENDER',
  'CERTIFICATION',
  'OTHER',
] as const;
export type SenderType = (typeof SENDER_TYPES)[number];
export const senderTypeSchema = z.enum(SENDER_TYPES);

/** The shape of answer the form will accept. */
export const ANSWER_FORMATS = [
  'YES_NO',
  'YES_NO_COMMENT',
  'MULTIPLE_CHOICE',
  'NUMBER',
  'DATE',
  'FREE_TEXT',
  'FILE_UPLOAD',
] as const;
export type AnswerFormat = (typeof ANSWER_FORMATS)[number];

/** One named thing the requirement does not hold for. */
export interface AnswerException {
  /** The subject, as the estate names it. */
  readonly subject: string;
  /** Why it is excepted, where a reason is recorded. */
  readonly reason: string | null;
  /** Since when, where that is known. */
  readonly since: string | null;
}

/**
 * The Truth Engine's result for one question.
 *
 * Produced by evaluating a confirmed interpretation, exactly as a control is
 * assessed. Carries its own provenance so it replays (ADR-0023).
 */
export interface AnswerDetermination {
  readonly state: AnswerState;
  /** Adericel's own words for why, in the form a person would read. */
  readonly reason: string;
  /** Every subject the requirement does not hold for. Never summarised away. */
  readonly exceptions: readonly AnswerException[];
  /** How many subjects were in scope, and how many satisfied it. */
  readonly subjectsInScope: number;
  readonly subjectsSatisfying: number;
  readonly evidenceIds: readonly string[];
  /** Age of the oldest evidence the answer rests on, in hours. */
  readonly oldestEvidenceAgeHours: number | null;
  readonly rulesetHash: string;
  readonly inputDigest: string;
  readonly determinedAt: string;
}

/**
 * Combine the parts of a compound question.
 *
 * "Do you have MFA and endpoint detection on all devices?" is two questions
 * wearing one question mark. Each part is determined separately and combined
 * here under Kleene logic, which is the same three-valued logic the Truth
 * Engine uses for controls:
 *
 *   any NOT_MET  -> NOT_MET     a demonstrated failure decides the whole
 *   any UNKNOWN  -> UNKNOWN     one thing you cannot see makes the answer unsafe
 *   any QUALIFIED -> QUALIFIED  exceptions anywhere are exceptions
 *
 * NOT_MET beats UNKNOWN because a known failure is more informative than an
 * unknown, and rendering "we cannot tell" when one half demonstrably fails
 * would understate the position.
 */
export function combineAnswerStates(states: readonly AnswerState[]): AnswerState {
  if (states.length === 0) return 'UNKNOWN';

  const present = new Set(states);
  // Parts that are out of scope do not drag the whole answer down; a compound
  // question all of whose parts are N/A is itself N/A.
  const material = states.filter((state) => state !== 'NOT_APPLICABLE');
  if (material.length === 0) return 'NOT_APPLICABLE';

  if (present.has('NOT_MET')) return 'NOT_MET';
  if (present.has('UNKNOWN')) return 'UNKNOWN';
  if (present.has('QUALIFIED')) return 'QUALIFIED';
  // A compound answer resting partly on somebody's word is an attested answer:
  // the weaker provenance governs, because a reader must not be told the whole
  // thing was observed when half of it was asserted.
  if (present.has('ATTESTED')) return 'ATTESTED';
  return 'SUPPORTED';
}
