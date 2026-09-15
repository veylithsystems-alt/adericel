import { describe, expect, it } from 'vitest';
import { and, implies, not, or, type Trilean } from './kleene.js';

const ALL: Trilean[] = ['TRUE', 'FALSE', 'UNKNOWN'];

describe('Kleene logic', () => {
  it('lets FALSE dominate conjunction even against UNKNOWN', () => {
    expect(and(['FALSE', 'UNKNOWN'])).toBe('FALSE');
    expect(and(['UNKNOWN', 'FALSE'])).toBe('FALSE');
  });

  it('never reports TRUE for a conjunction containing UNKNOWN', () => {
    expect(and(['TRUE', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(and(['TRUE', 'TRUE', 'UNKNOWN'])).toBe('UNKNOWN');
  });

  it('lets TRUE dominate disjunction even against UNKNOWN', () => {
    expect(or(['TRUE', 'UNKNOWN'])).toBe('TRUE');
  });

  it('never reports FALSE for a disjunction containing UNKNOWN', () => {
    expect(or(['FALSE', 'UNKNOWN'])).toBe('UNKNOWN');
  });

  it('keeps UNKNOWN under negation', () => {
    expect(not('UNKNOWN')).toBe('UNKNOWN');
  });

  it('is commutative for both connectives', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(and([a, b])).toBe(and([b, a]));
        expect(or([a, b])).toBe(or([b, a]));
      }
    }
  });

  it('satisfies De Morgan across the whole truth table', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(not(and([a, b]))).toBe(or([not(a), not(b)]));
        expect(not(or([a, b]))).toBe(and([not(a), not(b)]));
      }
    }
  });

  it('treats an empty conjunction as TRUE and an empty disjunction as FALSE', () => {
    expect(and([])).toBe('TRUE');
    expect(or([])).toBe('FALSE');
  });

  it('defines implication consistently with disjunction of the negated antecedent', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(implies(a, b)).toBe(or([not(a), b]));
      }
    }
  });
});
