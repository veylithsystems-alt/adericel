import { z } from 'zod';
import type { DegradedReason, UnknownReason } from '@adericel/domain';

/**
 * What kind of not-knowing this is.
 *
 * Saying "UNKNOWN" is honest and, on its own, useless. An MSP with two hundred
 * unknowns across forty clients cannot act on a word — they need to know which
 * of these are one credential away from resolution and which are questions
 * nobody can answer from a system at all.
 *
 * The ten `UnknownReason` values the Truth Engine produces are precise about
 * mechanism. These five are about **what a person does next**, which is a
 * different question and the one an operator is actually asking. Each reason
 * maps to exactly one kind, so the mapping is total and cannot drift.
 */
export const UNKNOWN_KINDS = [
  /**
   * Nothing has been observed. The evidence does not exist yet.
   *
   * The cheapest kind to resolve and the most common on a new estate: usually
   * a connector nobody has configured, or a predicate nothing supplies.
   */
  'MISSING',
  /**
   * It was observed, and the observation is too old to rely on.
   *
   * Different work from MISSING and often much cheaper — the collection path
   * exists and ran once. Something stopped it, or nobody re-ran it.
   */
  'STALE',
  /**
   * Two sources disagree.
   *
   * The most expensive kind, and the one an MSP most wants flagged: it cannot
   * be resolved by collecting harder, because collecting harder produces more
   * disagreement. Somebody has to decide which source is authoritative.
   */
  'CONTRADICTORY',
  /**
   * The question does not apply, or Adericel cannot see this class of thing.
   *
   * Not a gap to be closed by effort. Recorded so it stops appearing in a
   * queue as though it were work — an item nobody can action is noise, and
   * noise in a queue is how the real items get missed.
   */
  'OUT_OF_SCOPE',
  /**
   * Collection is broken. The path exists and is not working.
   *
   * A repair rather than an addition, and usually the highest-value thing in
   * the queue: one broken credential typically darkens several controls.
   */
  'UNCOLLECTABLE',
] as const;
export type UnknownKind = (typeof UNKNOWN_KINDS)[number];
export const unknownKindSchema = z.enum(UNKNOWN_KINDS);

/**
 * Every `UnknownReason`, classified. Exhaustive by construction — adding a
 * reason without deciding what a person does about it does not compile.
 */
export const KIND_OF_REASON: Readonly<Record<UnknownReason, UnknownKind>> = {
  NO_EVIDENCE: 'MISSING',
  INSUFFICIENT_EVIDENCE: 'MISSING',
  RULE_INPUTS_MISSING: 'MISSING',
  NOT_YET_ASSESSED: 'MISSING',

  STALE_EVIDENCE: 'STALE',

  CONTRADICTORY_EVIDENCE: 'CONTRADICTORY',

  // Both are integrity events rather than absences. They read as contradictory
  // because the thing on record no longer matches what it claims to be, and
  // the remedy is the same: somebody decides what to trust.
  EVIDENCE_INTEGRITY_UNVERIFIED: 'CONTRADICTORY',
  EVIDENCE_REVOKED: 'CONTRADICTORY',

  NO_APPLICABLE_RULE: 'OUT_OF_SCOPE',

  COLLECTION_FAILED: 'UNCOLLECTABLE',
};

/** Every `DegradedReason` is a broken collection path by definition. */
export const KIND_OF_DEGRADED_REASON: Readonly<Record<DegradedReason, UnknownKind>> = {
  COLLECTION_FAILING: 'UNCOLLECTABLE',
  CREDENTIAL_EXPIRED: 'UNCOLLECTABLE',
  CONSENT_WITHDRAWN: 'UNCOLLECTABLE',
  SOURCE_UNAVAILABLE: 'UNCOLLECTABLE',
  PARTIAL_COLLECTION: 'UNCOLLECTABLE',
  SCHEMA_DRIFT: 'UNCOLLECTABLE',
  RATE_LIMITED: 'UNCOLLECTABLE',
};

/**
 * Kinds that no amount of effort inside Adericel will close.
 *
 * Kept as data because it decides whether an item belongs in a work queue at
 * all. An `OUT_OF_SCOPE` unknown appearing in a backlog alongside a broken
 * credential teaches an operator to distrust the backlog.
 */
export const UNACTIONABLE_KINDS: readonly UnknownKind[] = ['OUT_OF_SCOPE'];

export function isActionable(kind: UnknownKind): boolean {
  return !UNACTIONABLE_KINDS.includes(kind);
}

/** Said to an operator, in their terms rather than the engine's. */
export const KIND_MEANING: Readonly<Record<UnknownKind, string>> = {
  MISSING: 'Nothing has been observed yet. The evidence does not exist.',
  STALE: 'It was observed, and the observation is now too old to rely on.',
  CONTRADICTORY:
    'Two sources disagree, or evidence on record no longer matches what it claims to be. ' +
    'Collecting more will not settle it; somebody has to decide which source is authoritative.',
  OUT_OF_SCOPE:
    'Adericel cannot see this, and no connector would change that. It needs a person to ' +
    'assert it, or it does not apply.',
  UNCOLLECTABLE:
    'The collection path exists and is not working. This is a repair, and it usually ' +
    'darkens more than one control.',
};
