import { z } from 'zod';
import { CLAIM_ORIGINS, type ClaimOrigin, type ClaimStatus } from './claim.js';

/**
 * What KIND of truth an assertion is.
 *
 * Contract v3.1 §6. Distinct from assurance state, and the distinction matters:
 * assurance state says whether a control is met, truth state says how firmly
 * Adericel knows anything at all. A SATISFIED control resting on a human's
 * attestation and one resting on a re-observed API reading are the same
 * assurance state and very different claims, and a recipient of an Assurance
 * Passport is entitled to tell them apart.
 *
 * DERIVED, NOT STORED
 *
 * These are computed from vocabulary the repository already has — claim origin
 * and claim status — rather than written into a new column. Two fields
 * describing one thing is how they drift, and the one that drifts is the one
 * somebody quotes. `truthStateOfClaim` is the single mapping, and a test
 * asserts it covers every origin, so adding an origin without deciding its
 * truth kind fails rather than defaulting to something flattering.
 */
export const TRUTH_STATES = [
  /** Directly established from attributable source evidence. */
  'OBSERVED',
  /** Observed and then independently checked, reconciled or re-observed. */
  'VERIFIED',
  /** Calculated from authoritative evidence by defined deterministic logic. */
  'DERIVED',
  /**
   * Analysed or explained by a human or a model. Not authoritative fact.
   *
   * The state that must never reach the Truth Engine. Everything Adericel
   * asserts about an organisation has to rest on something firmer than an
   * interpretation, however good the interpretation.
   */
  'INTERPRETED',
  /** Provisionally believed, and insufficiently evidenced to be more. */
  'ASSUMED',
  /** A desired future state. Never proof that it was achieved. */
  'TARGET',
  /** Insufficient, unavailable, contradictory, stale or unverifiable. */
  'UNKNOWN',
] as const;

export type TruthState = (typeof TRUTH_STATES)[number];
export const truthStateSchema = z.enum(TRUTH_STATES);

/**
 * Truth states firm enough to support an assurance determination.
 *
 * INTERPRETED, ASSUMED, TARGET and UNKNOWN are excluded, each for its own
 * reason: an interpretation is somebody's reading, an assumption is a belief
 * nobody evidenced, a target is a plan, and an unknown is nothing at all.
 */
export const AUTHORITATIVE_TRUTH_STATES: readonly TruthState[] = [
  'OBSERVED',
  'VERIFIED',
  'DERIVED',
];

export function isAuthoritative(state: TruthState): boolean {
  return AUTHORITATIVE_TRUTH_STATES.includes(state);
}

/**
 * The truth state of a claim, from its origin and status.
 *
 * Exhaustive over `CLAIM_ORIGINS` by construction — a `Record`, not a switch
 * with a default — so a new origin is a compile error rather than a silent
 * fall-through to whatever the default happened to be.
 */
const ORIGIN_TRUTH: Readonly<Record<ClaimOrigin, TruthState>> = {
  /** Normalised from source evidence by deterministic mapping. */
  DETERMINISTIC_NORMALISATION: 'OBSERVED',
  /** The integration asserted it directly; still an observation of a source. */
  INTEGRATION_ASSERTED: 'OBSERVED',
  /**
   * A person said so.
   *
   * ASSUMED rather than OBSERVED, and this is the judgement most worth
   * defending. A human attestation is evidence of what somebody believes, which
   * is not the same as evidence of what is true — they may be mistaken, working
   * from memory, or describing intent. It is often the only thing available for
   * a control no API exposes, and Adericel uses it; it simply does not pretend
   * it was observed.
   */
  HUMAN_ASSERTED: 'ASSUMED',
  /** A model's reading. Never authoritative (ADR-0004). */
  AI_SUGGESTED: 'INTERPRETED',
  /** Produced by re-observing after an action, which is what verification is. */
  VERIFICATION_DERIVED: 'VERIFIED',
};

export function truthStateOfClaim(claim: {
  readonly origin: ClaimOrigin;
  readonly status: ClaimStatus;
}): TruthState {
  // A claim nobody can rely on has no truth kind worth reporting, whatever its
  // origin. Checked first so a confirmed-then-withdrawn AI claim reads UNKNOWN
  // rather than INTERPRETED, which would overstate what is left of it.
  if (
    claim.status === 'REJECTED' ||
    claim.status === 'WITHDRAWN' ||
    claim.status === 'SUPERSEDED' ||
    claim.status === 'DISPUTED'
  ) {
    return 'UNKNOWN';
  }

  /**
   * A confirmed AI suggestion stops being an interpretation.
   *
   * Confirmation is a named person reading the claim against its source and
   * accepting it, which is exactly the act that turns somebody's reading into
   * somebody's assertion. It becomes ASSUMED, not OBSERVED: the human is now
   * standing behind it, and a human standing behind something is an assumption
   * with an owner, not an observation.
   */
  if (claim.origin === 'AI_SUGGESTED' && claim.status === 'CONFIRMED') return 'ASSUMED';

  return ORIGIN_TRUTH[claim.origin];
}

/** Every origin, for tests that assert the mapping stays exhaustive. */
export const MAPPED_ORIGINS = CLAIM_ORIGINS;

export interface TruthStatePresentation {
  readonly label: string;
  /** What this does and does not let a reader conclude. */
  readonly meaning: string;
}

/**
 * What each truth state means, in the words a recipient would need.
 *
 * Carried in the domain rather than the interface because an Assurance Passport
 * is read by an insurer or an auditor who never sees the interface, and the
 * sentence they read must be the same one.
 */
export const TRUTH_STATE_PRESENTATION: Readonly<Record<TruthState, TruthStatePresentation>> = {
  OBSERVED: {
    label: 'Observed',
    meaning: 'Read directly from the system it describes, with the source recorded.',
  },
  VERIFIED: {
    label: 'Verified',
    meaning: 'Observed, and then checked again independently rather than assumed to have held.',
  },
  DERIVED: {
    label: 'Derived',
    meaning: 'Calculated from recorded evidence by logic that can be replayed and audited.',
  },
  INTERPRETED: {
    label: 'Interpreted',
    meaning:
      'Somebody or something read this and formed a view. It is a reading, not a fact, and ' +
      'nothing in Adericel will treat it as one.',
  },
  ASSUMED: {
    label: 'Assumed',
    meaning:
      'Believed on the strength of an assertion rather than an observation. Usually a person ' +
      'stating something Adericel cannot see for itself.',
  },
  TARGET: {
    label: 'Target',
    meaning: 'An intended state. It says what should be true, never that it is.',
  },
  UNKNOWN: {
    label: 'Unknown',
    meaning: 'Adericel cannot establish this. Not the same as false.',
  },
};
