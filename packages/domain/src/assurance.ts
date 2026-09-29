import { z } from 'zod';

/**
 * The assurance state lattice.
 *
 * `UNKNOWN` is a first-class value, not a placeholder. It means: Adericel does
 * not hold sufficient trustworthy evidence to make a stronger statement. It is
 * never equivalent to satisfied, not satisfied, compliant or non-compliant, and
 * it must survive every aggregation, projection and export intact.
 */
export const ASSURANCE_STATES = [
  'SATISFIED',
  'PARTIALLY_SATISFIED',
  'NOT_SATISFIED',
  'EXCEPTED',
  'NOT_APPLICABLE',
  'UNKNOWN',
  /**
   * The mechanism that would establish this control is impaired.
   *
   * Distinct from UNKNOWN, and the distinction is the point. UNKNOWN says
   * Adericel does not hold enough evidence. DEGRADED says the thing that would
   * have supplied the evidence is broken: a connector that has started failing,
   * a credential that has expired, a consent that has been withdrawn.
   *
   * They read identically on a dashboard and require completely different work.
   * UNKNOWN is "connect something"; DEGRADED is "the connection you already
   * made has stopped working". For an MSP that is the difference between a
   * conversation with their customer and a ticket for their own engineer, and
   * collapsing the two costs them the ability to tell which they are looking
   * at (contract v3.1 §6).
   */
  'DEGRADED',
  /**
   * Something other than evidence prevents assessment.
   *
   * Authority, approval, consent, a dependency or a safety condition. The
   * evidence path may be perfectly healthy; Adericel is not permitted to
   * proceed, or is waiting on somebody who is.
   *
   * Separated from DEGRADED because nothing an engineer does will clear it. A
   * BLOCKED control needs a person with authority, not a repair.
   */
  'BLOCKED',
] as const;

export type AssuranceState = (typeof ASSURANCE_STATES)[number];

export const assuranceStateSchema = z.enum(ASSURANCE_STATES);

/**
 * The four states a customer or an assessor is shown.
 *
 * Contract v3.2 requires the outward vocabulary `PROVEN`, `FAILING`,
 * `EXCEPTION` and `UNKNOWN`. The eight `ASSURANCE_STATES` above are the
 * internal lattice, and they are deliberately more precise: an MSP acting on a
 * queue needs DEGRADED separated from BLOCKED, and PARTIALLY_SATISFIED
 * separated from both.
 *
 * WHY THIS IS A MAPPING AND NOT A RENAME
 *
 * Renaming the internal states to match would destroy the distinctions the
 * operating surfaces are built on, and it would falsify history: every
 * assessment on record was made under the vocabulary in force at the time, and
 * migration 0027 refused to rewrite the historical record for exactly this
 * reason. So the contract's four states are a derived view, computed here and
 * nowhere else.
 *
 * WHY THIS FUNCTION IS A SECURITY BOUNDARY
 *
 * It is the last place an internal state becomes an outward claim, so it is the
 * last place `UNKNOWN` could quietly become a pass. Everything indeterminate —
 * UNKNOWN, DEGRADED, BLOCKED, and PARTIALLY_SATISFIED — resolves to `UNKNOWN`
 * here, and nothing resolves to `PROVEN` but `SATISFIED`.
 */
export const HEADLINE_STATES = ['PROVEN', 'FAILING', 'EXCEPTION', 'UNKNOWN'] as const;
export type HeadlineState = (typeof HEADLINE_STATES)[number];
export const headlineStateSchema = z.enum(HEADLINE_STATES);

/**
 * Every assurance state's outward form. Total by construction, so adding an
 * assurance state without deciding what a customer is told does not compile.
 */
export const HEADLINE_OF_STATE: Readonly<Record<AssuranceState, HeadlineState>> = {
  SATISFIED: 'PROVEN',
  NOT_SATISFIED: 'FAILING',
  EXCEPTED: 'EXCEPTION',

  /**
   * Not PROVEN, and not FAILING either.
   *
   * Some subjects meet the control and some do not, which is a statement about
   * the estate rather than about the control. Calling it PROVEN would assert
   * something untrue of part of the estate; calling it FAILING would assert
   * something untrue of the rest. The honest outward answer is that the
   * organisation does not have a single answer yet.
   */
  PARTIALLY_SATISFIED: 'UNKNOWN',

  /**
   * NOT_APPLICABLE reads outward as UNKNOWN rather than as PROVEN.
   *
   * A control that does not apply has not been satisfied — there was nothing to
   * satisfy. Mapping it to PROVEN is the single most tempting way to inflate a
   * headline figure, and it is how scope decisions turn into compliance claims.
   * Callers that need to exclude it from a denominator should read the
   * assurance state, which still says NOT_APPLICABLE.
   */
  NOT_APPLICABLE: 'UNKNOWN',

  UNKNOWN: 'UNKNOWN',
  DEGRADED: 'UNKNOWN',
  BLOCKED: 'UNKNOWN',
};

export function headlineOf(state: AssuranceState): HeadlineState {
  return HEADLINE_OF_STATE[state];
}

/**
 * Assurance states that must never present as PROVEN.
 *
 * Kept as data so the invariant can be asserted directly rather than inferred
 * from the map. Every state here is one where Adericel does not hold a
 * positive, complete determination.
 */
export const NEVER_PROVEN_STATES: readonly AssuranceState[] = [
  'PARTIALLY_SATISFIED',
  'NOT_SATISFIED',
  'EXCEPTED',
  'NOT_APPLICABLE',
  'UNKNOWN',
  'DEGRADED',
  'BLOCKED',
];

/**
 * Why an assurance state is UNKNOWN. Recording the reason is what makes an
 * unknown actionable — "no integration connected" and "the evidence we hold
 * contradicts itself" require completely different responses.
 */
export const UNKNOWN_REASONS = [
  'NO_EVIDENCE',
  'INSUFFICIENT_EVIDENCE',
  'STALE_EVIDENCE',
  'CONTRADICTORY_EVIDENCE',
  'EVIDENCE_INTEGRITY_UNVERIFIED',
  'EVIDENCE_REVOKED',
  'NO_APPLICABLE_RULE',
  'RULE_INPUTS_MISSING',
  'COLLECTION_FAILED',
  'NOT_YET_ASSESSED',
] as const;

export type UnknownReason = (typeof UNKNOWN_REASONS)[number];
export const unknownReasonSchema = z.enum(UNKNOWN_REASONS);

/**
 * Why a control is DEGRADED. Each names a repair somebody can carry out.
 */
export const DEGRADED_REASONS = [
  /** The integration that supplies a required predicate is failing. */
  'COLLECTION_FAILING',
  /** The stored credential no longer authenticates. */
  'CREDENTIAL_EXPIRED',
  /** The customer withdrew consent, or an administrator revoked it. */
  'CONSENT_WITHDRAWN',
  /** The upstream source is unreachable or returning errors. */
  'SOURCE_UNAVAILABLE',
  /** Collection ran but returned only part of the expected estate. */
  'PARTIAL_COLLECTION',
  /** The source changed shape and normalisation no longer maps it. */
  'SCHEMA_DRIFT',
  /** The source is throttling us hard enough that collection cannot complete. */
  'RATE_LIMITED',
] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];
export const degradedReasonSchema = z.enum(DEGRADED_REASONS);

/**
 * Why a control is BLOCKED. Each names a person, not a repair.
 */
export const BLOCKED_REASONS = [
  /** Adericel holds no authority to observe what this control needs. */
  'AUTHORITY_MISSING',
  /** An action this control depends on is waiting for a human approval. */
  'APPROVAL_PENDING',
  /** The customer has not yet granted the consent collection requires. */
  'CONSENT_REQUIRED',
  /** Another control or system this one depends on is itself unresolved. */
  'DEPENDENCY_BLOCKED',
  /** A safety precondition for assessing or acting is not met. */
  'SAFETY_CONDITION_UNMET',
  /**
   * The integration or organisation is under containment.
   *
   * Assessment stops deliberately, and says so. A contained estate must not
   * quietly report UNKNOWN as though nobody had looked — somebody decided not
   * to look, and that decision is the fact worth surfacing.
   */
  'CONTAINED',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
export const blockedReasonSchema = z.enum(BLOCKED_REASONS);

/** States that assert a positive or negative conclusion about reality. */
export const DETERMINATE_STATES: readonly AssuranceState[] = [
  'SATISFIED',
  'PARTIALLY_SATISFIED',
  'NOT_SATISFIED',
];

export function isDeterminate(state: AssuranceState): boolean {
  return DETERMINATE_STATES.includes(state);
}

export function isUnknown(state: AssuranceState): state is 'UNKNOWN' {
  return state === 'UNKNOWN';
}

/**
 * States in which Adericel has NOT substantiated a positive claim.
 *
 * This is the predicate almost every caller actually wants, and the reason it
 * exists is a specific hazard introduced by widening the state set: code that
 * asks `state === 'UNKNOWN'` to mean "not substantiated" silently starts
 * treating DEGRADED and BLOCKED as though they were substantiated. That failure
 * is invisible — it produces a more confident answer, not an error.
 *
 * Use this wherever the question is "may we rely on this?". Use `isUnknown`
 * only where the question is specifically about absent evidence.
 */
export const UNSUBSTANTIATED_STATES: readonly AssuranceState[] = ['UNKNOWN', 'DEGRADED', 'BLOCKED'];

export function isUnsubstantiated(state: AssuranceState): boolean {
  return UNSUBSTANTIATED_STATES.includes(state);
}

/**
 * Aggregation precedence when rolling child states up to a parent
 * (control -> requirement -> framework -> organisation).
 *
 * A known failure outranks an unknown, because a known failure is a stronger
 * and more actionable fact. An unknown outranks any positive state, because a
 * positive claim may never be made on the strength of absent evidence.
 */
const AGGREGATION_PRECEDENCE: readonly AssuranceState[] = [
  'NOT_SATISFIED',
  // DEGRADED and BLOCKED outrank UNKNOWN for the same reason NOT_SATISFIED
  // outranks it: they are stronger facts. "The connector broke" and "we are not
  // permitted to look" are both more informative, and more actionable, than
  // "we do not know". They rank below NOT_SATISFIED because a known failure is
  // stronger still.
  'DEGRADED',
  'BLOCKED',
  'UNKNOWN',
  'PARTIALLY_SATISFIED',
  'EXCEPTED',
  'SATISFIED',
];

export type AssuranceStateCounts = Record<AssuranceState, number>;

export function emptyCounts(): AssuranceStateCounts {
  return {
    SATISFIED: 0,
    PARTIALLY_SATISFIED: 0,
    NOT_SATISFIED: 0,
    EXCEPTED: 0,
    NOT_APPLICABLE: 0,
    UNKNOWN: 0,
    DEGRADED: 0,
    BLOCKED: 0,
  };
}

export function countStates(states: readonly AssuranceState[]): AssuranceStateCounts {
  const counts = emptyCounts();
  for (const state of states) counts[state] += 1;
  return counts;
}

export interface AggregateResult {
  readonly state: AssuranceState;
  readonly counts: AssuranceStateCounts;
  /** Children that carry a real determination, i.e. excluding NOT_APPLICABLE. */
  readonly inScope: number;
  /**
   * Proportion of in-scope children Adericel has actually substantiated.
   *
   * DEGRADED and BLOCKED children count against coverage exactly as UNKNOWN
   * does. A control Adericel is not permitted to assess is not covered, however
   * good the reason.
   */
  readonly coverage: number;
}

/**
 * Roll a set of child states into one parent state.
 *
 * NOT_APPLICABLE children are excluded from scope entirely. When nothing is in
 * scope the result is UNKNOWN rather than SATISFIED: an empty set of controls
 * proves nothing about an organisation.
 */
export function aggregateAssurance(states: readonly AssuranceState[]): AggregateResult {
  const counts = countStates(states);
  const inScope = states.length - counts.NOT_APPLICABLE;

  if (inScope === 0) {
    return {
      state: states.length === 0 ? 'UNKNOWN' : 'NOT_APPLICABLE',
      counts,
      inScope: 0,
      coverage: 0,
    };
  }

  const substantiated = inScope - counts.UNKNOWN - counts.DEGRADED - counts.BLOCKED;
  const coverage = substantiated / inScope;

  for (const candidate of AGGREGATION_PRECEDENCE) {
    if (counts[candidate] > 0) {
      // A parent whose children are all satisfied but for some excepted ones is
      // reported as SATISFIED with the exceptions visible in `counts`, because
      // an authorised exception is an accepted state, not a failure.
      if (candidate === 'EXCEPTED' && counts.SATISFIED > 0) {
        return { state: 'SATISFIED', counts, inScope, coverage };
      }
      return { state: candidate, counts, inScope, coverage };
    }
  }
  return { state: 'UNKNOWN', counts, inScope, coverage };
}

/**
 * Assurance summary for a scope (organisation, framework, requirement).
 *
 * There is deliberately no single "security score" here. If a summary number is
 * needed it is derived by `assuranceIndex` below, which keeps unknown coverage
 * separate from satisfaction so the two can never be conflated.
 */
export interface AssuranceSummary {
  readonly state: AssuranceState;
  readonly counts: AssuranceStateCounts;
  readonly inScope: number;
  /** 0..1, share of in-scope items Adericel can actually speak to. */
  readonly coverage: number;
  /** 0..1, share of *determinate* items that are satisfied or excepted. */
  readonly satisfactionOfKnown: number | null;
}

export function summarise(states: readonly AssuranceState[]): AssuranceSummary {
  const aggregate = aggregateAssurance(states);
  const determinate = aggregate.inScope - aggregate.counts.UNKNOWN;
  const satisfied = aggregate.counts.SATISFIED + aggregate.counts.EXCEPTED;
  return {
    state: aggregate.state,
    counts: aggregate.counts,
    inScope: aggregate.inScope,
    coverage: aggregate.coverage,
    satisfactionOfKnown: determinate === 0 ? null : satisfied / determinate,
  };
}

/**
 * A two-dimensional index. Never collapse these into one number: an
 * organisation with 100% satisfaction over 10% coverage is not equivalent to
 * one with 10% satisfaction over 100% coverage, and a single score would render
 * them identical.
 */
export interface AssuranceIndex {
  readonly satisfactionOfKnown: number | null;
  readonly coverage: number;
  readonly unknownCount: number;
  /** Controls whose evidence path is impaired. Reported separately from unknown. */
  readonly degradedCount: number;
  /** Controls Adericel is not permitted to assess. Reported separately again. */
  readonly blockedCount: number;
  readonly failingCount: number;
}

export function assuranceIndex(summary: AssuranceSummary): AssuranceIndex {
  return {
    satisfactionOfKnown: summary.satisfactionOfKnown,
    coverage: summary.coverage,
    unknownCount: summary.counts.UNKNOWN,
    degradedCount: summary.counts.DEGRADED,
    blockedCount: summary.counts.BLOCKED,
    failingCount: summary.counts.NOT_SATISFIED,
  };
}

/** Ordering used for UI sorting: worst first. Stable and total. */
export function assuranceSeverityRank(state: AssuranceState): number {
  switch (state) {
    case 'NOT_SATISFIED':
      return 0;
    // Ranked above UNKNOWN because they are actionable: a named repair and a
    // named person respectively. An operator sorting worst-first should meet
    // the things somebody can do something about before the ones nobody has
    // looked at yet.
    case 'DEGRADED':
      return 1;
    case 'BLOCKED':
      return 2;
    case 'UNKNOWN':
      return 3;
    case 'PARTIALLY_SATISFIED':
      return 4;
    case 'EXCEPTED':
      return 5;
    case 'SATISFIED':
      return 6;
    case 'NOT_APPLICABLE':
      return 7;
  }
}
