import { describe, expect, it } from 'vitest';
import { ACTION_STATES, TERMINAL_ACTION_STATES } from './action.js';
import {
  EXECUTION_REALISATION,
  EXECUTION_STAGES,
  REALISATIONS,
  STAGE_OF_ACTION_STATE,
  SUPPORT_STAGES,
  unmappedActionStates,
  unrealisedExecutionStages,
} from './contract-lifecycle.js';

/**
 * Conformance to the lifecycles the contract states.
 *
 * These sequences were recorded in this repository as *missing from the
 * contract* for several days, because two hand-rolled PDF readers could not
 * decode them. A real library read them immediately. This file is the other
 * half of that correction: conformance is now checked by the build rather than
 * asserted by a document.
 */

describe('the authoritative execution lifecycle', () => {
  it('quotes the contract exactly, in its order', () => {
    expect([...EXECUTION_STAGES]).toEqual([
      'INTENT',
      'POLICY',
      'AUTHORISATION',
      'RISK',
      'ACTION',
      'RE_OBSERVE',
      'VERIFY',
      'EVIDENCE',
    ]);
  });

  it('places every action state within a stage', () => {
    /**
     * The drift this catches. A state added without deciding which stage of the
     * contract's lifecycle it belongs to is a state nobody has reconciled, and
     * it would otherwise be invisible — the action path would keep working and
     * the conformance claim would quietly stop being true.
     */
    const unmapped = unmappedActionStates();
    expect(
      unmapped,
      `These action states belong to no stage of the contract's lifecycle:\n  ${unmapped.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });

  it('realises every stated stage, by something named', () => {
    const unrealised = unrealisedExecutionStages();
    expect(unrealised).toEqual([]);

    for (const stage of EXECUTION_STAGES) {
      const realisation = EXECUTION_REALISATION[stage];
      expect(REALISATIONS, stage).toContain(realisation.realisation);
      // Never a restatement of the stage name: "INTENT is realised by intent"
      // would satisfy a length check and establish nothing.
      expect(realisation.by.length, stage).toBeGreaterThan(60);
      expect(realisation.by.toUpperCase(), stage).not.toBe(stage);
    }
  });

  it('does not claim a stage is a state when it is a property', () => {
    /**
     * RISK is the honest case. The contract names it as a stage; this system
     * evaluates it as a classification carried by the action from proposal
     * onwards, because a DESTRUCTIVE action is still destructive at the moment
     * of execution and a stage would let the classification go stale between
     * evaluation and act.
     *
     * Saying so is cheaper than pretending the shapes match.
     */
    expect(EXECUTION_REALISATION.RISK.realisation).toBe('PROPERTY');
    expect(EXECUTION_REALISATION.RISK.actionStates).toEqual([]);
    expect(EXECUTION_REALISATION.EVIDENCE.realisation).toBe('ARTEFACT');

    // And a stage realised as a property or an artefact claims no states, or
    // the totality check above would be satisfied by a stage that is not one.
    for (const stage of EXECUTION_STAGES) {
      const realisation = EXECUTION_REALISATION[stage];
      if (realisation.realisation === 'STATE') {
        expect(realisation.actionStates.length, stage).toBeGreaterThan(0);
      } else {
        expect(realisation.actionStates, stage).toEqual([]);
      }
    }
  });

  it('keeps dispatch and success in different stages', () => {
    /**
     * The contract's sharpest rule about execution: "No consequential action
     * becomes successful merely because an action was dispatched."
     *
     * `EXECUTING` and `EXECUTED` are ACTION. Confirmation is VERIFY, two stages
     * later, with re-observation in between. If they ever shared a stage the
     * lifecycle would permit exactly what the contract forbids.
     */
    expect(STAGE_OF_ACTION_STATE.EXECUTING).toBe('ACTION');
    expect(STAGE_OF_ACTION_STATE.EXECUTED).toBe('ACTION');
    expect(STAGE_OF_ACTION_STATE.VERIFYING).toBe('RE_OBSERVE');
    expect(STAGE_OF_ACTION_STATE.CONFIRMED).toBe('VERIFY');
    expect(STAGE_OF_ACTION_STATE.EXECUTED).not.toBe(STAGE_OF_ACTION_STATE.CONFIRMED);
  });

  it('keeps an unestablished outcome terminal rather than hopeful', () => {
    // `UNVERIFIED` is a VERIFY-stage state and it is terminal: an outcome that
    // could not be established stays unestablished and enters reconciliation.
    // A non-terminal UNVERIFIED would be a state that decays into success.
    expect(STAGE_OF_ACTION_STATE.UNVERIFIED).toBe('VERIFY');
    expect(TERMINAL_ACTION_STATES).toContain('UNVERIFIED');
    expect(TERMINAL_ACTION_STATES).toContain('CONFIRMED');
  });

  it('derives the state-to-stage map rather than stating it twice', () => {
    // Two statements of one mapping drift, and the one that drifts is the one
    // somebody quotes. Asserted against the source of truth.
    for (const state of ACTION_STATES) {
      const stage = STAGE_OF_ACTION_STATE[state];
      if (stage === null) continue;
      expect(EXECUTION_REALISATION[stage].actionStates, state).toContain(state);
    }
  });
});

describe('the support lifecycle', () => {
  it('quotes the contract exactly, in its order', () => {
    expect([...SUPPORT_STAGES]).toEqual([
      'RECEIVED',
      'TRIAGED',
      'INVESTIGATING',
      'ACTION_REQUIRED',
      'VERIFICATION_PENDING',
      'RESOLVED',
      'CLOSED',
    ]);
  });
});
