import { describe, expect, it } from 'vitest';
import {
  CONTRACT_STAGE_OF_CASE_STATE,
  CONTRACT_SUPPORT_STAGES,
  NON_RESOLUTION_ENDINGS,
  SUPPORT_CASE_STATES,
  TERMINAL_CASE_STATES,
  isResolution,
  outcomeOfClosedCase,
} from './case.js';

/**
 * Twenty operational states against the contract's seven stages.
 *
 * The twenty are a refinement, not a disagreement. They exist because an MSP
 * cannot work a queue without them: "waiting on the customer" and "waiting on
 * the vendor" are the same contract stage and completely different work — one
 * needs a chase, the other needs patience.
 */
describe('the contract support lifecycle', () => {
  it('places every case state within a stated stage', () => {
    // Total by construction, asserted anyway: the type stops at the process
    // boundary and a state can arrive from a column.
    for (const state of SUPPORT_CASE_STATES) {
      expect(CONTRACT_SUPPORT_STAGES, state).toContain(CONTRACT_STAGE_OF_CASE_STATE[state]);
    }
    expect(Object.keys(CONTRACT_STAGE_OF_CASE_STATE).sort()).toEqual(
      [...SUPPORT_CASE_STATES].sort(),
    );
  });

  it('keeps identity and entitlement before triage, not within it', () => {
    /**
     * Nothing about an organisation may be disclosed before somebody is
     * identified, so these precede triage. A case in `IDENTITY_PENDING` has not
     * been looked at, and placing it at TRIAGED would say it had — on a report
     * an MSP shows a customer about their own response times.
     */
    expect(CONTRACT_STAGE_OF_CASE_STATE.IDENTITY_PENDING).toBe('RECEIVED');
    expect(CONTRACT_STAGE_OF_CASE_STATE.ENTITLEMENT_PENDING).toBe('RECEIVED');
  });

  it('treats a specialist review as work in progress, not as waiting', () => {
    // §26 requires security, privacy and commercial routing, and work is
    // actively happening in each — by a different person with a different
    // authority. Classing them as a wait would make a privacy review look like
    // an idle ticket.
    for (const state of ['SECURITY_REVIEW', 'PRIVACY_REVIEW', 'COMMERCIAL_REVIEW'] as const) {
      expect(CONTRACT_STAGE_OF_CASE_STATE[state], state).toBe('INVESTIGATING');
    }
  });

  it('treats every wait as the contract stage that names one', () => {
    for (const state of [
      'AWAITING_CUSTOMER',
      'AWAITING_MSP',
      'AWAITING_VENDOR',
      'AWAITING_CHANGE',
    ] as const) {
      expect(CONTRACT_STAGE_OF_CASE_STATE[state], state).toBe('ACTION_REQUIRED');
    }
  });
});

describe('an ending is not automatically a resolution', () => {
  it('counts only RESOLVED as a resolution', () => {
    /**
     * The defect this test exists for, which was written and then fixed.
     *
     * `isResolution` originally returned true for `CLOSED` as well. A withdrawn
     * case reaches `CLOSED` too, so a closed case's state alone cannot say
     * whether anything was solved — and returning true would have inflated
     * every support metric an MSP shows a customer, through the function
     * written to prevent exactly that.
     */
    const resolutions = SUPPORT_CASE_STATES.filter((state) => isResolution(state));
    expect(resolutions).toEqual(['RESOLVED']);
    expect(isResolution('CLOSED')).toBe(false);
    expect(isResolution('WITHDRAWN')).toBe(false);
    expect(isResolution('REJECTED')).toBe(false);
  });

  it('maps the two non-resolution endings to CLOSED without calling them resolved', () => {
    // The contract's sequence has no ending that is not a resolution. Real
    // support has two, so they are closed — nothing further happens — and
    // explicitly not RESOLVED.
    for (const state of NON_RESOLUTION_ENDINGS) {
      expect(CONTRACT_STAGE_OF_CASE_STATE[state], state).toBe('CLOSED');
      expect(TERMINAL_CASE_STATES, state).toContain(state);
      expect(isResolution(state), state).toBe(false);
    }
  });

  it('reads a closed case’s outcome from its history', () => {
    expect(outcomeOfClosedCase(['RECEIVED', 'TRIAGING', 'RESOLVED', 'CLOSED'])).toBe('RESOLVED');
    expect(outcomeOfClosedCase(['RECEIVED', 'TRIAGING', 'WITHDRAWN', 'CLOSED'])).toBe('WITHDRAWN');
    expect(outcomeOfClosedCase(['RECEIVED', 'IDENTITY_PENDING', 'REJECTED'])).toBe('REJECTED');
  });

  it('returns null rather than guessing when the history does not say', () => {
    /**
     * A support report with an unknown outcome is accurate. One that assumed
     * resolution is a claim nobody made, and it is the same failure as a
     * connector's silence becoming a pass.
     */
    expect(outcomeOfClosedCase(['RECEIVED', 'TRIAGING', 'CLOSED'])).toBeNull();
    expect(outcomeOfClosedCase([])).toBeNull();
  });

  it('takes the last decisive state, not the first', () => {
    // A case reopened after a withdrawal and then resolved ended in resolution.
    // Reading forwards would report the withdrawal.
    expect(
      outcomeOfClosedCase(['RECEIVED', 'WITHDRAWN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
    ).toBe('RESOLVED');
  });
});
