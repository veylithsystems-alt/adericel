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
] as const;

export type AssuranceState = (typeof ASSURANCE_STATES)[number];

export const assuranceStateSchema = z.enum(ASSURANCE_STATES);

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
 * Aggregation precedence when rolling child states up to a parent
 * (control -> requirement -> framework -> organisation).
 *
 * A known failure outranks an unknown, because a known failure is a stronger
 * and more actionable fact. An unknown outranks any positive state, because a
 * positive claim may never be made on the strength of absent evidence.
 */
const AGGREGATION_PRECEDENCE: readonly AssuranceState[] = [
  'NOT_SATISFIED',
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
  /** Proportion of in-scope children with a determinate (non-UNKNOWN) state. */
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

  const determinate = inScope - counts.UNKNOWN;
  const coverage = determinate / inScope;

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
  readonly failingCount: number;
}

export function assuranceIndex(summary: AssuranceSummary): AssuranceIndex {
  return {
    satisfactionOfKnown: summary.satisfactionOfKnown,
    coverage: summary.coverage,
    unknownCount: summary.counts.UNKNOWN,
    failingCount: summary.counts.NOT_SATISFIED,
  };
}

/** Ordering used for UI sorting: worst first. Stable and total. */
export function assuranceSeverityRank(state: AssuranceState): number {
  switch (state) {
    case 'NOT_SATISFIED':
      return 0;
    case 'UNKNOWN':
      return 1;
    case 'PARTIALLY_SATISFIED':
      return 2;
    case 'EXCEPTED':
      return 3;
    case 'SATISFIED':
      return 4;
    case 'NOT_APPLICABLE':
      return 5;
  }
}
