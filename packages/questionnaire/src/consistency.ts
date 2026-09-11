import { isBarePositive } from './render.js';
import type { AnswerDetermination } from './answer.js';

/**
 * Checking that a phrasing does not assert more than the determination allows.
 *
 * A model may be used to phrase a free-text answer more naturally than the
 * template does. That is the only job it has here, and it is the job most
 * likely to quietly overstate: models are trained on confident prose, and
 * confident prose about security controls is exactly what this product exists
 * not to produce.
 *
 * So every model-phrased rendering is compared against the determination before
 * it is saved, deterministically, with no model involved in the check. Anything
 * that asserts more than the state supports is rejected and the templated
 * wording is used instead.
 */

export const REJECTION_REASONS = [
  /** The phrasing reads as an unqualified positive and the state forbids one. */
  'BARE_POSITIVE_FOR_NON_SUPPORTED',
  /** It says "all" or "every" while the determination records exceptions. */
  'UNIVERSAL_CLAIM_WITH_EXCEPTIONS',
  /** It asserts something while the determination is UNKNOWN. */
  'ASSERTION_WHILE_UNKNOWN',
  /** The determination has exceptions and the phrasing does not mention them. */
  'EXCEPTIONS_OMITTED',
  /** It presents an attested answer as an observed one. */
  'ATTESTATION_PRESENTED_AS_OBSERVATION',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface ConsistencyResult {
  readonly accepted: boolean;
  readonly reasons: readonly RejectionReason[];
  /** What to use instead. Never null on rejection. */
  readonly replacement: string | null;
}

/** Words that claim the whole scope. */
const UNIVERSAL_WORDS = /\b(all|every|each|any and all|without exception|entire|100%)\b/i;

/** Words that hedge, which is what makes a partial claim honest. */
const QUALIFYING_WORDS =
  /\b(except|exception|exceptions|excluding|apart from|other than|save for|partial|partially|some|most|majority|with the exception)\b/i;

/** Phrasings that assert an observed fact. */
const ASSERTIVE = /\b(is|are|has|have|does|do|was|were|enforced|enabled|configured|in place)\b/i;

/**
 * Compare a phrasing with the determination behind it.
 *
 * Deliberately conservative: where the check is unsure, it rejects. The cost of
 * a false rejection is that a template is used instead of nicer prose. The cost
 * of a false acceptance is a client telling their insurer something untrue.
 */
export function checkConsistency(
  phrasing: string,
  determination: AnswerDetermination,
  templatedReplacement: string,
): ConsistencyResult {
  const reasons: RejectionReason[] = [];
  const text = phrasing.trim();
  const hasExceptions = determination.exceptions.length > 0;

  if (determination.state !== 'SUPPORTED' && isBarePositive(text)) {
    reasons.push('BARE_POSITIVE_FOR_NON_SUPPORTED');
  }

  if (hasExceptions && UNIVERSAL_WORDS.test(text) && !QUALIFYING_WORDS.test(text)) {
    // "MFA is enforced on all accounts" when two are excepted. The single most
    // likely and most damaging overstatement this product can make.
    reasons.push('UNIVERSAL_CLAIM_WITH_EXCEPTIONS');
  }

  if (
    determination.state === 'UNKNOWN' &&
    ASSERTIVE.test(text) &&
    !/\b(not|cannot|unable|could not|no evidence|unknown)\b/i.test(text)
  ) {
    reasons.push('ASSERTION_WHILE_UNKNOWN');
  }

  if (
    (determination.state === 'QUALIFIED' || hasExceptions) &&
    !QUALIFYING_WORDS.test(text) &&
    !determination.exceptions.some((exception) =>
      text.toLowerCase().includes(exception.subject.toLowerCase()),
    )
  ) {
    // An answer that is partial must say so somewhere. Naming the excepted
    // subjects counts; so does any qualifying word.
    reasons.push('EXCEPTIONS_OMITTED');
  }

  if (
    determination.state === 'ATTESTED' &&
    !/\b(attest|attested|confirmed by|declared|stated by|per management)\b/i.test(text)
  ) {
    reasons.push('ATTESTATION_PRESENTED_AS_OBSERVATION');
  }

  const accepted = reasons.length === 0;
  return {
    accepted,
    reasons,
    replacement: accepted ? null : templatedReplacement,
  };
}
