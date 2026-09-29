import { describe, expect, it } from 'vitest';
import {
  ASSURANCE_STATES,
  DETERMINATE_STATES,
  HEADLINE_OF_STATE,
  HEADLINE_STATES,
  NEVER_PROVEN_STATES,
  headlineOf,
  type AssuranceState,
} from './assurance.js';
import { CLAIM_ORIGINS, CLAIM_STATUSES } from './claim.js';
import {
  AUTHORITATIVE_TRUTH_STATES,
  NON_CLAIM_TRUTH_STATES,
  TRUTH_STATES,
  TRUTH_STATE_PRESENTATION,
  truthStateOfClaim,
} from './truth-state.js';

/**
 * The outward vocabulary.
 *
 * Contract v3.2 requires four headline states — PROVEN, FAILING, EXCEPTION,
 * UNKNOWN — and a richer internal provenance vocabulary of ten. This file
 * guards the join between them, which is the last place an internal state
 * becomes an outward claim and therefore the last place UNKNOWN could quietly
 * become a pass.
 */

describe('the four headline states', () => {
  it('names exactly the four the contract requires', () => {
    expect([...HEADLINE_STATES]).toEqual(['PROVEN', 'FAILING', 'EXCEPTION', 'UNKNOWN']);
  });

  it('maps every assurance state, with nothing left to a default', () => {
    // Totality is what stops a new assurance state picking up whatever the
    // fallback happened to be — and a fallback here would be a claim about an
    // organisation nobody decided to make.
    for (const state of ASSURANCE_STATES) {
      expect(HEADLINE_STATES, state).toContain(HEADLINE_OF_STATE[state]);
    }
    expect(Object.keys(HEADLINE_OF_STATE).sort()).toEqual([...ASSURANCE_STATES].sort());
  });

  it('presents nothing as PROVEN but a satisfied control', () => {
    /**
     * The invariant of the file.
     *
     * Every other state is either incomplete, negative, excused or unknown, and
     * each has a distinct tempting argument for being shown as a pass:
     * PARTIALLY_SATISFIED because most of the estate is fine,
     * NOT_APPLICABLE because there was nothing to do, EXCEPTED because somebody
     * signed it off, DEGRADED and BLOCKED because they were passing yesterday.
     */
    const proven = ASSURANCE_STATES.filter((state) => headlineOf(state) === 'PROVEN');
    expect(proven).toEqual(['SATISFIED']);
  });

  it('shows every indeterminate state as UNKNOWN rather than as an outcome', () => {
    for (const state of ['UNKNOWN', 'DEGRADED', 'BLOCKED'] as const) {
      expect(headlineOf(state), state).toBe('UNKNOWN');
    }
  });

  it('does not let a scope decision become a compliance claim', () => {
    // NOT_APPLICABLE to PROVEN is the single cheapest way to inflate a headline
    // figure: exclude a control from scope and it counts as a pass.
    expect(headlineOf('NOT_APPLICABLE')).toBe('UNKNOWN');
    expect(headlineOf('PARTIALLY_SATISFIED')).toBe('UNKNOWN');
  });

  it('keeps NEVER_PROVEN_STATES consistent with the map it documents', () => {
    // Two statements of one rule drift, and the one that drifts is the one
    // somebody quotes. Asserted against each other rather than trusted.
    const derived = ASSURANCE_STATES.filter((state) => headlineOf(state) !== 'PROVEN');
    expect([...NEVER_PROVEN_STATES].sort()).toEqual([...derived].sort());
  });

  it('agrees with the determinate-state list about what is a conclusion', () => {
    // DETERMINATE_STATES has said since the first migration which states assert
    // something about reality. A headline of PROVEN or FAILING is exactly such
    // an assertion, so the two lists must not disagree.
    for (const state of ASSURANCE_STATES) {
      const headline = headlineOf(state);
      if (headline === 'PROVEN' || headline === 'FAILING') {
        expect(DETERMINATE_STATES as readonly AssuranceState[], state).toContain(state);
      }
    }
  });
});

describe('the ten provenance truth states', () => {
  it('carries all ten the contract names', () => {
    expect([...TRUTH_STATES].sort()).toEqual(
      [
        'ASSUMED',
        'BLOCKED',
        'DEGRADED',
        'DERIVED',
        'FAILED',
        'INTERPRETED',
        'OBSERVED',
        'TARGET',
        'UNKNOWN',
        'VERIFIED',
      ].sort(),
    );
  });

  it('gives every state a meaning a recipient could act on', () => {
    for (const state of TRUTH_STATES) {
      const presentation = TRUTH_STATE_PRESENTATION[state];
      expect(presentation, state).toBeDefined();
      expect(presentation.label.length, state).toBeGreaterThan(2);
      expect(presentation.meaning.length, state).toBeGreaterThan(30);
    }
  });

  it('treats only observation, verification and derivation as authoritative', () => {
    expect([...AUTHORITATIVE_TRUTH_STATES]).toEqual(['OBSERVED', 'VERIFIED', 'DERIVED']);
    for (const state of NON_CLAIM_TRUTH_STATES) {
      expect(AUTHORITATIVE_TRUTH_STATES, state).not.toContain(state);
    }
  });

  it('never produces a collection state from a claim', () => {
    /**
     * DEGRADED, BLOCKED and FAILED describe what happened to a collection or an
     * authority, not what somebody asserted. If a claim could carry one, a
     * broken connector would be recorded as though a source had spoken.
     */
    // Quantified over every origin and status combination through the public
    // function rather than over the lookup table, so the branches above the
    // table — a withdrawn claim, a confirmed AI suggestion — are covered too.
    for (const origin of CLAIM_ORIGINS) {
      for (const status of CLAIM_STATUSES) {
        const state = truthStateOfClaim({ origin, status });
        expect(NON_CLAIM_TRUTH_STATES, `${origin}/${status}`).not.toContain(state);
        expect(TRUTH_STATES, `${origin}/${status}`).toContain(state);
      }
    }
  });
});
