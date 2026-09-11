import { describe, expect, it } from 'vitest';
import {
  aggregateAssurance,
  assuranceIndex,
  assuranceSeverityRank,
  summarise,
  type AssuranceState,
} from './assurance.js';

describe('aggregateAssurance', () => {
  it('returns UNKNOWN for an empty set — nothing proves nothing', () => {
    expect(aggregateAssurance([]).state).toBe('UNKNOWN');
  });

  it('never reports SATISFIED when any child is UNKNOWN', () => {
    const states: AssuranceState[] = ['SATISFIED', 'SATISFIED', 'UNKNOWN'];
    expect(aggregateAssurance(states).state).toBe('UNKNOWN');
  });

  it('lets a known failure outrank an unknown', () => {
    expect(aggregateAssurance(['UNKNOWN', 'NOT_SATISFIED']).state).toBe('NOT_SATISFIED');
  });

  it('excludes NOT_APPLICABLE from scope', () => {
    const result = aggregateAssurance(['NOT_APPLICABLE', 'SATISFIED']);
    expect(result.state).toBe('SATISFIED');
    expect(result.inScope).toBe(1);
  });

  it('reports NOT_APPLICABLE when everything is out of scope', () => {
    expect(aggregateAssurance(['NOT_APPLICABLE', 'NOT_APPLICABLE']).state).toBe('NOT_APPLICABLE');
  });

  it('treats an authorised exception alongside satisfied children as satisfied', () => {
    expect(aggregateAssurance(['SATISFIED', 'EXCEPTED']).state).toBe('SATISFIED');
  });

  it('reports EXCEPTED when every in-scope child is excepted', () => {
    expect(aggregateAssurance(['EXCEPTED', 'EXCEPTED']).state).toBe('EXCEPTED');
  });

  it('surfaces PARTIALLY_SATISFIED above satisfied children', () => {
    expect(aggregateAssurance(['SATISFIED', 'PARTIALLY_SATISFIED']).state).toBe(
      'PARTIALLY_SATISFIED',
    );
  });

  it('computes coverage as the determinate share of in-scope children', () => {
    const result = aggregateAssurance(['SATISFIED', 'UNKNOWN', 'NOT_APPLICABLE']);
    expect(result.inScope).toBe(2);
    expect(result.coverage).toBe(0.5);
  });
});

describe('summarise', () => {
  it('keeps satisfaction and coverage as separate dimensions', () => {
    const highSatisfactionLowCoverage = summarise([
      'SATISFIED',
      ...Array(9).fill('UNKNOWN'),
    ] as AssuranceState[]);
    expect(highSatisfactionLowCoverage.satisfactionOfKnown).toBe(1);
    expect(highSatisfactionLowCoverage.coverage).toBeCloseTo(0.1);
    expect(highSatisfactionLowCoverage.state).toBe('UNKNOWN');
  });

  it('returns null satisfaction when nothing is determinate', () => {
    expect(summarise(['UNKNOWN', 'UNKNOWN']).satisfactionOfKnown).toBeNull();
  });

  it('exposes unknown and failing counts on the index', () => {
    const index = assuranceIndex(summarise(['UNKNOWN', 'NOT_SATISFIED', 'SATISFIED']));
    expect(index.unknownCount).toBe(1);
    expect(index.failingCount).toBe(1);
  });
});

describe('assuranceSeverityRank', () => {
  it('sorts failures first and unknowns second', () => {
    const sorted: AssuranceState[] = [
      'SATISFIED',
      'NOT_APPLICABLE',
      'UNKNOWN',
      'NOT_SATISFIED',
      'EXCEPTED',
      'PARTIALLY_SATISFIED',
    ].sort(
      (a, b) =>
        assuranceSeverityRank(a as AssuranceState) - assuranceSeverityRank(b as AssuranceState),
    ) as AssuranceState[];
    expect(sorted[0]).toBe('NOT_SATISFIED');
    expect(sorted[1]).toBe('UNKNOWN');
  });
});
