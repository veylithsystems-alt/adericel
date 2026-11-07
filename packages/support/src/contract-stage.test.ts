import { SUPPORT_STAGES } from '@adericel/domain';
import { describe, expect, it } from 'vitest';
import { SUPPORT_CASE_STATES } from './case.js';
import {
  STAGE_OF_CASE_STATE,
  caseStatesInStage,
  caseStatesOutsideTheLifecycle,
  unoccupiedSupportStages,
} from './contract-stage.js';

/**
 * The correspondence between the stated support lifecycle and the built one.
 *
 * Twenty states against the contract's seven stages. These assert that the
 * mapping is total, that no stage the contract requires was dropped, and that
 * the two states deliberately outside it are exactly the two intended.
 */
describe('the support lifecycle against the one the contract states', () => {
  it('assigns every state of this system a stage, or explicitly none', () => {
    // Totality is enforced by the type, so this asserts the weaker but
    // still-breakable property: the record has an entry per state and no
    // stray keys. A stray key is what a rename leaves behind.
    expect(Object.keys(STAGE_OF_CASE_STATE).sort()).toEqual([...SUPPORT_CASE_STATES].sort());
  });

  it('names a stage from the contract, never one invented here', () => {
    const invented = Object.entries(STAGE_OF_CASE_STATE)
      .filter(([, stage]) => stage !== null)
      .filter(([, stage]) => !(SUPPORT_STAGES as readonly string[]).includes(stage as string))
      .map(([state, stage]) => `${state} -> ${stage}`);
    expect(invented, 'these name a stage the contract does not state').toEqual([]);
  });

  it('occupies every stage the contract states, so none was quietly dropped', () => {
    /**
     * The finding this file exists to make impossible to miss. A stage with no
     * state behind it is an obligation nothing in the system meets, and it
     * would otherwise be visible only to somebody holding both documents open.
     */
    expect(unoccupiedSupportStages(), 'these stated stages have no state here').toEqual([]);
  });

  it('leaves exactly the two endings that are not resolutions outside the path', () => {
    /**
     * `WITHDRAWN` and `REJECTED` map to no stage on purpose: the contract's
     * lifecycle is a path to resolution, and recording a refused case as
     * `RESOLVED` or `CLOSED` would make it indistinguishable from a fixed one.
     *
     * Asserted exactly rather than as a count, so a third state slipping out of
     * the lifecycle fails here by name instead of passing a loose bound.
     */
    expect(caseStatesOutsideTheLifecycle()).toEqual(['WITHDRAWN', 'REJECTED']);
  });

  it('keeps triage, its outcome and investigation in the stages the contract gives them', () => {
    // The specific collapses worth pinning, because they are the ones a reader
    // of the contract would challenge.
    expect(caseStatesInStage('TRIAGED')).toEqual(['TRIAGING', 'ROUTED_TO_MSP', 'QUEUED']);
    expect(caseStatesInStage('INVESTIGATING')).toEqual([
      'IN_PROGRESS',
      'SECURITY_REVIEW',
      'PRIVACY_REVIEW',
      'COMMERCIAL_REVIEW',
    ]);
    // Four kinds of waiting, one contract stage. The distinction is kept here
    // because "waiting on the customer" and "waiting on the vendor" have
    // different remedies, which is an operational fact the contract does not
    // need to carry.
    expect(caseStatesInStage('ACTION_REQUIRED')).toEqual([
      'AWAITING_CUSTOMER',
      'AWAITING_MSP',
      'AWAITING_VENDOR',
      'AWAITING_CHANGE',
    ]);
  });

  it('never puts a resolution and its verification in the same stage', () => {
    /**
     * A proposal nobody accepted and an acceptance nobody confirmed are both
     * `VERIFICATION_PENDING` to the contract, and must stay two states here —
     * collapsing them would let a case read as awaiting the customer's
     * confirmation when nobody had yet proposed anything.
     */
    expect(caseStatesInStage('VERIFICATION_PENDING')).toEqual([
      'RESOLUTION_PROPOSED',
      'AWAITING_VERIFICATION',
    ]);
    expect(caseStatesInStage('RESOLVED')).toEqual(['RESOLVED']);
    expect(caseStatesInStage('CLOSED')).toEqual(['CLOSED']);
  });
});
