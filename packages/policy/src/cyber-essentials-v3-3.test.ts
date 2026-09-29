import { describe, expect, it } from 'vitest';
import {
  CE_THEMES,
  CE_V3_3_REQUIREMENTS,
  ceObservationGaps,
  ceRequirementsByTheme,
  summariseCeCoverage,
} from './cyber-essentials-v3-3.js';

/**
 * The map must be honest about itself before it is useful.
 *
 * Every test here is about the map's integrity rather than about Cyber
 * Essentials: a coverage map that overstates itself is worse than no map, because
 * an MSP acts on it.
 */
describe('the requirement map', () => {
  it('covers all five themes', () => {
    for (const theme of CE_THEMES) {
      expect(ceRequirementsByTheme(theme).length).toBeGreaterThan(0);
    }
  });

  it('gives every requirement a unique, citable id', () => {
    const ids = CE_V3_3_REQUIREMENTS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^(FW|SC|SU|UA|MP)-\d+$/);
    }
  });

  it('explains every gap, and never explains a non-gap away', () => {
    /**
     * A requirement that is not OBSERVED must say why in words an MSP would
     * want. A requirement that IS observed must not carry a note — a note on a
     * covered requirement is where a caveat gets smuggled in, and then the
     * thing that looks covered is not.
     */
    for (const requirement of CE_V3_3_REQUIREMENTS) {
      if (requirement.observability === 'OBSERVED') {
        expect(requirement.note).toBeNull();
      } else {
        expect(requirement.note).not.toBeNull();
        expect(requirement.note!.length).toBeGreaterThan(40);
      }
    }
  });

  it('keeps "nobody has built it" separate from "nothing could know it"', () => {
    /**
     * ATTESTED_ONLY is a gap a future connector closes. NOT_OBSERVABLE is a
     * statement about the world — no API reports whether an account is shared
     * between four people, and no future release changes that.
     *
     * Collapsing them would either promise coverage that will never arrive, or
     * write off work that is genuinely doable.
     */
    const notObservable = CE_V3_3_REQUIREMENTS.filter((r) => r.observability === 'NOT_OBSERVABLE');
    expect(notObservable.length).toBeGreaterThan(0);
    for (const requirement of notObservable) {
      // Nothing could evidence it, so it names no predicates. A predicate here
      // would be a promise the classification denies.
      expect(requirement.predicates).toEqual([]);
      expect(requirement.ruleKey).toBeNull();
    }
  });

  it('names predicates for everything it claims to observe', () => {
    for (const requirement of CE_V3_3_REQUIREMENTS) {
      if (requirement.observability === 'OBSERVED') {
        expect(requirement.predicates.length).toBeGreaterThan(0);
        expect(requirement.ruleKey).not.toBeNull();
      }
    }
  });

  it('has had nothing checked against the published scheme, and says so', () => {
    // The flag exists to stop this becoming a document that looks authoritative
    // because it is long. §37: no compliance claim merely because documentation
    // exists — and that applies to Adericel's own documents first.
    for (const requirement of CE_V3_3_REQUIREMENTS) {
      expect(requirement.sourceChecked).toBe(false);
    }
  });
});

describe('the coverage figure', () => {
  it('adds up', () => {
    const summary = summariseCeCoverage();
    expect(summary.observed + summary.partial + summary.attestedOnly + summary.notObservable).toBe(
      summary.total,
    );
  });

  it('excludes the unobservable from the denominator', () => {
    /**
     * Counting requirements no system could ever observe against Adericel
     * would make the figure a criticism of the scheme rather than a measure of
     * the product — and would also make it improvable by deleting rows.
     */
    const summary = summariseCeCoverage();
    const observable = summary.total - summary.notObservable;
    expect(summary.continuousCoverage).toBeCloseTo(summary.observed / observable, 10);
  });

  it('never travels without the sentence that stops it being a claim', () => {
    const summary = summariseCeCoverage();
    expect(summary.caveat).toMatch(/not a readiness figure/i);
    expect(summary.caveat).toMatch(/not a certification position/i);
    expect(summary.caveat).toMatch(/have not been checked/i);
  });

  it('reports zero coverage for an empty map rather than dividing by zero', () => {
    expect(summariseCeCoverage([]).continuousCoverage).toBe(0);
  });
});

describe('gaps against a real deployment', () => {
  it('reports what is missing given the predicates actually connected', () => {
    const gaps = ceObservationGaps(['device.firewall.enabled', 'device.managed']);
    // FW-6 is satisfied by exactly those two, so it must not appear.
    expect(gaps.map((g) => g.requirementId)).not.toContain('FW-6');
    // And something that needs more must.
    expect(gaps.map((g) => g.requirementId)).toContain('UA-4');
  });

  it('never lists a requirement nothing could satisfy', () => {
    // A gap an MSP cannot close is not a gap, it is noise in a queue.
    const gaps = ceObservationGaps([]);
    const unobservable = CE_V3_3_REQUIREMENTS.filter(
      (r) => r.observability === 'NOT_OBSERVABLE',
    ).map((r) => r.id);
    for (const id of unobservable) {
      expect(gaps.map((g) => g.requirementId)).not.toContain(id);
    }
  });

  it('closes every gap when everything is supplied', () => {
    const all = CE_V3_3_REQUIREMENTS.flatMap((r) => r.predicates);
    expect(ceObservationGaps(all)).toEqual([]);
  });
});
