import { describe, expect, it } from 'vitest';
import { CLAIM_ORIGINS, CLAIM_STATUSES, isRuleEligible } from './claim.js';
import {
  AUTHORITATIVE_TRUTH_STATES,
  isAuthoritative,
  TRUTH_STATES,
  TRUTH_STATE_PRESENTATION,
  truthStateOfClaim,
  type TruthState,
} from './truth-state.js';

/**
 * Truth state: what kind of truth an assertion is.
 *
 * Contract v3.1 §6. The property that matters most is the one connecting this
 * vocabulary to the existing enforcement: anything INTERPRETED must never reach
 * the Truth Engine. These tests check that the two mechanisms agree, because
 * two mechanisms that disagree about the same boundary is worse than one.
 */

describe('the mapping is exhaustive', () => {
  it('assigns a truth state to every claim origin', () => {
    // A new origin without a decided truth kind must be a failure, not a
    // silent default to whichever state happened to be most convenient.
    for (const origin of CLAIM_ORIGINS) {
      const state = truthStateOfClaim({ origin, status: 'CONFIRMED' });
      expect(TRUTH_STATES).toContain(state);
    }
  });

  it('presents every truth state', () => {
    for (const state of TRUTH_STATES) {
      expect(TRUTH_STATE_PRESENTATION[state].meaning.length).toBeGreaterThan(30);
    }
  });

  it('is total over every origin and status combination', () => {
    for (const origin of CLAIM_ORIGINS) {
      for (const status of CLAIM_STATUSES) {
        expect(() => truthStateOfClaim({ origin, status })).not.toThrow();
      }
    }
  });
});

describe('what each origin means', () => {
  it('treats machine-normalised source data as observed', () => {
    expect(truthStateOfClaim({ origin: 'DETERMINISTIC_NORMALISATION', status: 'ACTIVE' })).toBe(
      'OBSERVED',
    );
  });

  it('treats a re-observation after an action as verified', () => {
    expect(truthStateOfClaim({ origin: 'VERIFICATION_DERIVED', status: 'ACTIVE' })).toBe(
      'VERIFIED',
    );
  });

  it('treats a human attestation as assumed, not observed', () => {
    // The judgement most worth defending. A person saying something is evidence
    // of what they believe, not of what is true — they may be mistaken, working
    // from memory, or describing intent. Adericel uses it; it does not pretend
    // it was observed.
    expect(truthStateOfClaim({ origin: 'HUMAN_ASSERTED', status: 'ACTIVE' })).toBe('ASSUMED');
  });

  it('treats an unconfirmed model output as interpreted', () => {
    expect(truthStateOfClaim({ origin: 'AI_SUGGESTED', status: 'CANDIDATE' })).toBe('INTERPRETED');
  });

  it('promotes a confirmed model output to assumed, never to observed', () => {
    // Confirmation is a person reading the claim against its source and
    // standing behind it. That turns a reading into an assertion — which is an
    // assumption with an owner, not an observation.
    expect(truthStateOfClaim({ origin: 'AI_SUGGESTED', status: 'CONFIRMED' })).toBe('ASSUMED');
  });

  it('reports a withdrawn claim as unknown whatever its origin', () => {
    // A confirmed-then-withdrawn AI claim reading INTERPRETED would overstate
    // what is left of it. Nothing is left of it.
    for (const status of ['REJECTED', 'WITHDRAWN', 'SUPERSEDED', 'DISPUTED'] as const) {
      for (const origin of CLAIM_ORIGINS) {
        expect(truthStateOfClaim({ origin, status })).toBe('UNKNOWN');
      }
    }
  });
});

describe('the authority boundary', () => {
  it('admits only observed, verified and derived', () => {
    expect([...AUTHORITATIVE_TRUTH_STATES].sort()).toEqual(['DERIVED', 'OBSERVED', 'VERIFIED']);
  });

  it('refuses interpretation, assumption, target and unknown', () => {
    for (const state of ['INTERPRETED', 'ASSUMED', 'TARGET', 'UNKNOWN'] as TruthState[]) {
      expect(isAuthoritative(state)).toBe(false);
    }
  });

  it('never lets an INTERPRETED claim be rule-eligible', () => {
    /**
     * The property that connects this vocabulary to the existing enforcement.
     *
     * `isRuleEligible` is what the Truth Engine actually calls (ADR-0004). This
     * asserts the two agree: every claim combination that maps to INTERPRETED
     * must also be refused by the engine's own gate. Two mechanisms describing
     * one boundary and disagreeing about it would be worse than having one,
     * because whichever a reader checked would look authoritative.
     */
    for (const origin of CLAIM_ORIGINS) {
      for (const status of CLAIM_STATUSES) {
        const claim = { origin, status };
        if (truthStateOfClaim(claim) === 'INTERPRETED') {
          expect(
            isRuleEligible(claim).eligible,
            `${origin}/${status} maps to INTERPRETED but the engine would accept it`,
          ).toBe(false);
        }
      }
    }
  });

  it('never reports an engine-eligible claim as non-authoritative without reason', () => {
    // The converse direction. A claim the engine accepts should carry a truth
    // state a recipient can defend — or, where it does not, that must be a
    // deliberate decision rather than an oversight.
    const eligibleButNotAuthoritative: string[] = [];
    for (const origin of CLAIM_ORIGINS) {
      for (const status of CLAIM_STATUSES) {
        const claim = { origin, status };
        if (isRuleEligible(claim).eligible && !isAuthoritative(truthStateOfClaim(claim))) {
          eligibleButNotAuthoritative.push(`${origin}/${status}`);
        }
      }
    }

    // HUMAN_ASSERTED and confirmed AI claims are ASSUMED and the engine does
    // accept them: a control no API exposes has nothing else, and refusing
    // would make it permanently UNKNOWN. The Passport reports the truth state
    // so a recipient can weigh it, which is the honest resolution — but it is
    // recorded here so the trade-off cannot be forgotten.
    expect(
      eligibleButNotAuthoritative.every(
        (k) => k.includes('HUMAN_ASSERTED') || k.includes('AI_SUGGESTED'),
      ),
    ).toBe(true);
  });
});
