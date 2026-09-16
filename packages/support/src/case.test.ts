import { describe, expect, it } from 'vitest';
import {
  DISCLOSURE_PERMITTED_STATES,
  PROHIBITED_TRANSITIONS,
  SEVERITY_DEFINITIONS,
  SUPPORT_CASE_STATES,
  SUPPORT_CASE_TRANSITIONS,
  SUPPORT_CATEGORIES,
  SUPPORT_QUEUES,
  SUPPORT_SEVERITIES,
  TERMINAL_CASE_STATES,
  isTerminal,
  mayDiscloseAt,
  transitionCase,
  type SupportCaseState,
} from './case.js';

const REASON = 'Entra connector reauthorised; re-collection queued and confirmed running.';

describe('the support vocabulary', () => {
  it('has the §21 counts', () => {
    expect(SUPPORT_CATEGORIES).toHaveLength(14);
    expect(SUPPORT_QUEUES).toHaveLength(12);
    expect(SUPPORT_SEVERITIES).toHaveLength(4);
    expect(SUPPORT_CASE_STATES).toHaveLength(20);
  });

  it('names every state on both sides of the transition table', () => {
    for (const state of SUPPORT_CASE_STATES) {
      expect(SUPPORT_CASE_TRANSITIONS[state]).toBeDefined();
      for (const target of SUPPORT_CASE_TRANSITIONS[state]) {
        expect(SUPPORT_CASE_STATES).toContain(target);
      }
    }
  });

  it('lets nothing out of a terminal state', () => {
    for (const state of TERMINAL_CASE_STATES) {
      expect(SUPPORT_CASE_TRANSITIONS[state]).toEqual([]);
      expect(isTerminal(state)).toBe(true);
    }
  });

  it('can be abandoned from anywhere ordinary, and nowhere it must not be', () => {
    /**
     * A requester is entitled to withdraw. A state from which a case could not
     * be abandoned would be a trap, and the trapped case would sit in a queue
     * forever being counted as work.
     *
     * Three states deliberately refuse it, and the refusal is the point:
     *
     *   SECURITY_REVIEW  — a security report that the reporter withdraws is
     *                      exactly what somebody probing the platform would do
     *                      afterwards. The review completes regardless.
     *   PRIVACY_REVIEW   — a data-subject request carries a statutory clock.
     *                      It is not cancelled by the requester going quiet.
     *   COMMERCIAL_REVIEW — a contractual question, once raised, is answered.
     *
     * Also refused from AWAITING_VERIFICATION and RESOLVED: by then the work
     * is done, and "withdrawn" would misrecord a fix as an abandonment.
     */
    const cannotWithdraw = SUPPORT_CASE_STATES.filter(
      (state) => !isTerminal(state) && !SUPPORT_CASE_TRANSITIONS[state].includes('WITHDRAWN'),
    );
    expect([...cannotWithdraw].sort()).toEqual([
      'AWAITING_VERIFICATION',
      'COMMERCIAL_REVIEW',
      'PRIVACY_REVIEW',
      'RESOLVED',
      'SECURITY_REVIEW',
    ]);
  });
});

describe('disclosure states', () => {
  it('discloses nothing before identity and entitlement are established', () => {
    /**
     * §22. The four arrival states say nothing about any organisation —
     * including whether it exists. A support system that confirms an
     * organisation is a customer before establishing who is asking has already
     * disclosed something.
     */
    for (const state of ['RECEIVED', 'IDENTITY_PENDING', 'ENTITLEMENT_PENDING'] as const) {
      expect(mayDiscloseAt(state)).toBe(false);
    }
    // And once triaged, it may.
    expect(mayDiscloseAt('TRIAGING')).toBe(true);
  });

  it('never discloses from a state the case cannot reach after being abandoned', () => {
    for (const state of ['WITHDRAWN', 'REJECTED'] as const) {
      expect(DISCLOSURE_PERMITTED_STATES).not.toContain(state);
    }
  });
});

describe('prohibited transitions', () => {
  /**
   * §21 calls these out specifically. Each is prohibited because allowing it
   * would let the system record something that did not happen.
   */

  it('cannot reach RESOLVED except through verification', () => {
    const others = SUPPORT_CASE_STATES.filter(
      (state) => state !== 'AWAITING_VERIFICATION' && state !== 'RESOLVED',
    );
    for (const from of others) {
      expect(SUPPORT_CASE_TRANSITIONS[from]).not.toContain('RESOLVED');
    }
  });

  it('cannot reopen a closed case', () => {
    // Work that continues is a new case with a link to the old one, so the
    // history shows two episodes rather than one that never ended.
    const decision = transitionCase({
      from: 'CLOSED',
      to: 'IN_PROGRESS',
      reason: REASON,
      severity: 'S3',
    });
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.reason).toMatch(/finished record/i);
  });

  it('cannot start work before knowing who is asking', () => {
    const decision = transitionCase({
      from: 'RECEIVED',
      to: 'IN_PROGRESS',
      reason: REASON,
      severity: 'S1',
    });
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.reason).toMatch(/identity and entitlement/i);
  });

  it('closes only from RESOLVED or an MSP takeover', () => {
    // Everything else that stops mattering is WITHDRAWN or REJECTED. Those are
    // different facts and must not be recorded as a resolution.
    const closers = SUPPORT_CASE_STATES.filter((state) =>
      SUPPORT_CASE_TRANSITIONS[state].includes('CLOSED'),
    );
    expect([...closers].sort()).toEqual(['RESOLVED', 'ROUTED_TO_MSP']);
  });

  it('states a reason for every prohibition it names', () => {
    for (const rule of PROHIBITED_TRANSITIONS) {
      expect(rule.because.length).toBeGreaterThan(80);
      expect(SUPPORT_CASE_STATES).toContain(rule.to);
      if (rule.from !== '*') expect(SUPPORT_CASE_STATES).toContain(rule.from);
    }
  });

  it('actually refuses every prohibition it names', () => {
    // The list and the table must agree. A named prohibition the table permits
    // would be documentation of a control that does not exist.
    for (const rule of PROHIBITED_TRANSITIONS) {
      const froms: SupportCaseState[] =
        rule.from === '*'
          ? SUPPORT_CASE_STATES.filter(
              (state) => !SUPPORT_CASE_TRANSITIONS[state].includes(rule.to),
            )
          : [rule.from];
      for (const from of froms) {
        if (from === rule.to) continue;
        expect(SUPPORT_CASE_TRANSITIONS[from]).not.toContain(rule.to);
      }
    }
  });
});

describe('resolution', () => {
  it('will not let an engineer resolve their own S1', () => {
    /**
     * An S1 means Adericel asserted something untrue, or an organisation could
     * not reach its own record. The customer is the only party who can confirm
     * that is no longer true — a system that lets the engineer mark it resolved
     * measures how confident engineers are, not whether anything got fixed.
     */
    const decision = transitionCase({
      from: 'AWAITING_VERIFICATION',
      to: 'RESOLVED',
      reason: REASON,
      severity: 'S1',
      customerVerified: false,
    });
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.reason).toMatch(/customer says it is/i);
  });

  it('permits it once the customer has confirmed', () => {
    const decision = transitionCase({
      from: 'AWAITING_VERIFICATION',
      to: 'RESOLVED',
      reason: REASON,
      severity: 'S1',
      customerVerified: true,
    });
    expect(decision.permitted).toBe(true);
  });

  it('does not require confirmation for a question', () => {
    // S4 is nothing being broken. Requiring a customer to confirm that their
    // question was answered is a way of generating unclosed cases.
    const decision = transitionCase({
      from: 'AWAITING_VERIFICATION',
      to: 'RESOLVED',
      reason: REASON,
      severity: 'S4',
    });
    expect(decision.permitted).toBe(true);
  });

  it('requires confirmation exactly where assurance was affected', () => {
    for (const severity of SUPPORT_SEVERITIES) {
      const definition = SEVERITY_DEFINITIONS[severity];
      // S1 and S2 are the two where something Adericel said or maintained was
      // wrong or stale. Those are the two the customer must confirm.
      expect(definition.closureNeedsCustomerConfirmation).toBe(
        severity === 'S1' || severity === 'S2',
      );
    }
  });

  it('refuses a reason the next person could not act on', () => {
    const decision = transitionCase({
      from: 'IN_PROGRESS',
      to: 'RESOLUTION_PROPOSED',
      reason: 'fixed',
      severity: 'S3',
    });
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.reason).toMatch(/at least/i);
  });

  it('acknowledges faster the worse the consequence is', () => {
    const minutes = SUPPORT_SEVERITIES.map(
      (severity) => SEVERITY_DEFINITIONS[severity].acknowledgeWithinMinutes,
    );
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });
});
