import { describe, expect, it } from 'vitest';
import {
  ASSURANCE_STATES,
  aggregateAssurance,
  assuranceSeverityRank,
  BLOCKED_REASONS,
  DEGRADED_REASONS,
  isDeterminate,
  isUnknown,
  isUnsubstantiated,
  UNSUBSTANTIATED_STATES,
  type AssuranceState,
} from './assurance.js';

/**
 * DEGRADED and BLOCKED as first-class assurance states.
 *
 * Contract v3.1 §6 requires Adericel to distinguish them from UNKNOWN and says
 * these semantic distinctions must not be collapsed for convenience. Before
 * this, a failing connector produced UNKNOWN with reason COLLECTION_FAILED —
 * honest, and indistinguishable on a portfolio view from a control nobody had
 * ever assessed.
 *
 * The operational difference is the point: UNKNOWN is "connect a source",
 * DEGRADED is "the source you connected has broken", BLOCKED is "somebody has
 * to authorise this". One of those is a customer conversation, one is an
 * engineer's ticket, and one is neither.
 */

describe('the widened state set', () => {
  it('carries DEGRADED and BLOCKED', () => {
    expect(ASSURANCE_STATES).toContain('DEGRADED');
    expect(ASSURANCE_STATES).toContain('BLOCKED');
  });

  it('does not treat either as a determination about the organisation', () => {
    // The whole safety property: neither may ever be read as a finding. A
    // broken connector says nothing about whether the control is met.
    expect(isDeterminate('DEGRADED')).toBe(false);
    expect(isDeterminate('BLOCKED')).toBe(false);
  });

  it('keeps isUnknown narrow', () => {
    // isUnknown must stay literal. Widening it would silently change the
    // meaning of every existing caller that genuinely means "no evidence".
    expect(isUnknown('DEGRADED' as AssuranceState)).toBe(false);
    expect(isUnknown('BLOCKED' as AssuranceState)).toBe(false);
    expect(isUnknown('UNKNOWN')).toBe(true);
  });

  it('groups all three as unsubstantiated', () => {
    // This is the predicate callers actually want, and the reason it exists:
    // code asking `state === 'UNKNOWN'` to mean "not substantiated" would
    // silently start treating DEGRADED and BLOCKED as though they were.
    expect(isUnsubstantiated('UNKNOWN')).toBe(true);
    expect(isUnsubstantiated('DEGRADED')).toBe(true);
    expect(isUnsubstantiated('BLOCKED')).toBe(true);
    expect(isUnsubstantiated('SATISFIED')).toBe(false);
    expect(isUnsubstantiated('NOT_SATISFIED')).toBe(false);
    expect(UNSUBSTANTIATED_STATES).toHaveLength(3);
  });

  it('gives every reason code a distinct home', () => {
    // A reason must belong to exactly one state. Overlap would let a row carry
    // a reason its state cannot explain.
    const overlap = DEGRADED_REASONS.filter((r) =>
      (BLOCKED_REASONS as readonly string[]).includes(r),
    );
    expect(overlap).toEqual([]);
  });

  it('separates repairs from permissions in the reason vocabulary', () => {
    // DEGRADED reasons name something an engineer fixes.
    expect(DEGRADED_REASONS).toContain('CREDENTIAL_EXPIRED');
    expect(DEGRADED_REASONS).toContain('COLLECTION_FAILING');
    // BLOCKED reasons name a person who must act. No repair will clear them.
    expect(BLOCKED_REASONS).toContain('AUTHORITY_MISSING');
    expect(BLOCKED_REASONS).toContain('CONTAINED');
  });
});

describe('aggregation', () => {
  it('never lets an impaired child produce a satisfied parent', () => {
    // The single most important property here. A parent that reported
    // SATISFIED while a child was DEGRADED would be asserting a positive claim
    // on the strength of a source it cannot read.
    for (const impaired of ['DEGRADED', 'BLOCKED'] as const) {
      const result = aggregateAssurance(['SATISFIED', 'SATISFIED', impaired]);
      expect(result.state).not.toBe('SATISFIED');
      expect(result.state).toBe(impaired);
    }
  });

  it('ranks a known failure above an impairment', () => {
    // A known failure is a stronger and more actionable fact than a broken
    // source, exactly as it is stronger than an unknown.
    expect(aggregateAssurance(['NOT_SATISFIED', 'DEGRADED']).state).toBe('NOT_SATISFIED');
    expect(aggregateAssurance(['NOT_SATISFIED', 'BLOCKED']).state).toBe('NOT_SATISFIED');
  });

  it('ranks an impairment above a plain unknown', () => {
    // Both are stronger facts than "we do not know": each names a specific
    // cause, and each has somebody who can act on it.
    expect(aggregateAssurance(['UNKNOWN', 'DEGRADED']).state).toBe('DEGRADED');
    expect(aggregateAssurance(['UNKNOWN', 'BLOCKED']).state).toBe('BLOCKED');
  });

  it('prefers DEGRADED to BLOCKED when both are present', () => {
    expect(aggregateAssurance(['BLOCKED', 'DEGRADED']).state).toBe('DEGRADED');
  });

  it('counts impaired children against coverage', () => {
    // Coverage is "what proportion did we actually substantiate". A control
    // Adericel is not permitted to assess is not covered, however good the
    // reason — otherwise containment would improve the coverage figure.
    const result = aggregateAssurance(['SATISFIED', 'DEGRADED', 'BLOCKED', 'UNKNOWN']);
    expect(result.inScope).toBe(4);
    expect(result.coverage).toBe(0.25);
    expect(result.counts.DEGRADED).toBe(1);
    expect(result.counts.BLOCKED).toBe(1);
  });

  it('reports impaired counts separately rather than folding them into unknown', () => {
    const result = aggregateAssurance(['DEGRADED', 'BLOCKED', 'UNKNOWN']);
    expect(result.counts.UNKNOWN).toBe(1);
    expect(result.counts.DEGRADED).toBe(1);
    expect(result.counts.BLOCKED).toBe(1);
  });
});

describe('ordering', () => {
  it('is total and stable over every state', () => {
    const ranks = ASSURANCE_STATES.map((s) => assuranceSeverityRank(s));
    expect(new Set(ranks).size).toBe(ASSURANCE_STATES.length);
  });

  it('puts actionable states before the ones nobody has looked at', () => {
    expect(assuranceSeverityRank('NOT_SATISFIED')).toBeLessThan(assuranceSeverityRank('DEGRADED'));
    expect(assuranceSeverityRank('DEGRADED')).toBeLessThan(assuranceSeverityRank('UNKNOWN'));
    expect(assuranceSeverityRank('BLOCKED')).toBeLessThan(assuranceSeverityRank('UNKNOWN'));
    expect(assuranceSeverityRank('UNKNOWN')).toBeLessThan(assuranceSeverityRank('SATISFIED'));
  });
});
