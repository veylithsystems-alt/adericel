import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_CAPABILITY,
  COMMERCIAL_STATES,
  COMMERCIAL_TRANSITIONS,
  SERVICE_STOPPING_STATES,
  assuranceImpactOf,
  stopsService,
  transitionCommercial,
  type CommercialState,
} from './commercial.js';

const REASON = 'Invoice 4417 unpaid for 62 days after three dunning attempts.';

describe('the ten commercial states', () => {
  it('has exactly the ten §16 names', () => {
    expect([...COMMERCIAL_STATES]).toEqual([
      'DRAFT',
      'TRIAL',
      'ACTIVE',
      'PAST_DUE',
      'PAYMENT_PLAN',
      'COMMERCIAL_RESTRICTION',
      'COMMERCIAL_SUSPENSION',
      'TERMINATED',
      'ARCHIVED',
      'UNKNOWN',
    ]);
  });

  it('never withholds an organisation its own record, at any state', () => {
    /**
     * The invariant. Written out ten times in the table rather than assumed,
     * and asserted over every state rather than the three anybody would think
     * to check.
     *
     * A customer who stops paying stops receiving new assurance. They never
     * stop being able to read and export what they already proved. Holding a
     * compliance record hostage over an invoice is not a commercial lever.
     */
    for (const state of COMMERCIAL_STATES) {
      expect(COMMERCIAL_CAPABILITY[state].readOwnRecord).toBe(true);
      expect(COMMERCIAL_CAPABILITY[state].exportOwnRecord).toBe(true);
    }
  });

  it('charges for nothing it is not delivering', () => {
    // A state that has stopped collecting and assessing must not be billable.
    // Charging for a suspended service is the kind of thing that ends up in
    // front of a regulator.
    for (const state of COMMERCIAL_STATES) {
      const capability = COMMERCIAL_CAPABILITY[state];
      if (!capability.collectObservations && !capability.runAssessments) {
        expect(capability.chargeable).toBe(false);
      }
    }
  });

  it('treats a late invoice as a fact, not a lever', () => {
    // PAST_DUE is deliberately identical to ACTIVE in what it permits. Turning
    // a late payment into a service change on day one is how an
    // accounts-receivable problem becomes an assurance problem.
    const { summary: _a, ...pastDue } = COMMERCIAL_CAPABILITY.PAST_DUE;
    const { summary: _b, ...active } = COMMERCIAL_CAPABILITY.ACTIVE;
    expect(pastDue).toEqual(active);
  });

  it('keeps existing service running when the commercial position is UNKNOWN', () => {
    /**
     * An outage at a payment processor is not evidence that a customer has
     * stopped paying. Resolving UNKNOWN to unpaid by default would turn one
     * provider incident into an assurance incident for every customer at once.
     *
     * UNKNOWN restricts new chargeable commitments and changes nothing else.
     */
    expect(COMMERCIAL_CAPABILITY.UNKNOWN.collectObservations).toBe(true);
    expect(COMMERCIAL_CAPABILITY.UNKNOWN.runAssessments).toBe(true);
    expect(COMMERCIAL_CAPABILITY.UNKNOWN.newCommitments).toBe(false);
    expect(stopsService('UNKNOWN')).toBe(false);
  });

  it('never leaves UNKNOWN as a place to get stuck', () => {
    // It is a statement that the answer is not yet known, so it must be able to
    // resolve to whatever the provider eventually says.
    expect(COMMERCIAL_TRANSITIONS.UNKNOWN.length).toBeGreaterThan(0);
  });
});

describe('transitions', () => {
  it('refuses a move that is not on the list', () => {
    const decision = transitionCommercial({
      from: 'ACTIVE',
      to: 'COMMERCIAL_SUSPENSION',
      reason: REASON,
      customerNotified: true,
    });
    expect(decision.permitted).toBe(false);
    // ACTIVE is restricted before it is suspended. Suspension stops assurance
    // being maintained and is not arrived at in one step from paying-and-current.
    expect(decision.permitted === false && decision.reason).toContain('cannot become');
  });

  it('refuses to stop maintaining assurance without telling the customer first', () => {
    for (const to of SERVICE_STOPPING_STATES) {
      const from = (Object.keys(COMMERCIAL_TRANSITIONS) as CommercialState[]).find((candidate) =>
        COMMERCIAL_TRANSITIONS[candidate].includes(to),
      );
      if (!from) continue;
      const decision = transitionCommercial({ from, to, reason: REASON, customerNotified: false });
      expect(decision.permitted).toBe(false);
      expect(decision.permitted === false && decision.reason).toMatch(/must be told/i);
    }
  });

  it('refuses a reason nobody could act on', () => {
    const decision = transitionCommercial({
      from: 'ACTIVE',
      to: 'PAST_DUE',
      reason: 'unpaid',
      customerNotified: true,
    });
    expect(decision.permitted).toBe(false);
    expect(decision.permitted === false && decision.reason).toMatch(/at least/i);
  });

  it('permits a legal move and says what the customer will experience', () => {
    const decision = transitionCommercial({
      from: 'PAST_DUE',
      to: 'PAYMENT_PLAN',
      reason: 'Agreed to clear £4,180 of arrears over four months from 1 October.',
      customerNotified: true,
    });
    expect(decision.permitted).toBe(true);
    expect(decision.permitted === true && decision.customerImpact).toContain('Service continues');
  });

  it('lets nothing out of ARCHIVED', () => {
    expect(COMMERCIAL_TRANSITIONS.ARCHIVED).toEqual([]);
    for (const to of COMMERCIAL_STATES) {
      if (to === 'ARCHIVED') continue;
      const decision = transitionCommercial({
        from: 'ARCHIVED',
        to,
        reason: REASON,
        customerNotified: true,
      });
      expect(decision.permitted).toBe(false);
    }
  });

  it('lets nothing back into DRAFT', () => {
    // DRAFT means "nothing has been provisioned yet". Once something has, the
    // account cannot become un-started, and a state that could be re-entered
    // would let a live customer be quietly de-provisioned by a status change.
    for (const from of COMMERCIAL_STATES) {
      expect(COMMERCIAL_TRANSITIONS[from]).not.toContain('DRAFT');
    }
  });

  it('can always be ended from anywhere that is still running', () => {
    // A customer is entitled to leave. A state that could not reach TERMINATED
    // would be a trap, and the one thing worse than a bad commercial state is
    // one you cannot get out of.
    for (const from of COMMERCIAL_STATES) {
      if (from === 'TERMINATED' || from === 'ARCHIVED') continue;
      expect(COMMERCIAL_TRANSITIONS[from]).toContain('TERMINATED');
    }
  });
});

describe('commercial is not security', () => {
  /**
   * Contract v3.1 §16, and the sharpest edge in this file.
   *
   * The two models must not cascade into each other. These assertions are
   * structural: they check that the vocabularies do not overlap and that
   * neither module knows how to produce the other's type. A function mapping
   * one to the other is the thing that would make the separation a comment.
   */
  // The cross-module half of this — that no commercial state shares a name
  // with a containment level, and that no function maps between them — lives
  // in `tests/security/commercial-separation.test.ts`, where both packages can
  // be imported without `@adericel/domain` taking a dependency on the thing it
  // is supposed to be independent of.

  it('changes no assurance outcome, at any state', () => {
    // §16: billing is never assurance truth. A suspended customer's last
    // assessment said what it said and goes on saying it. What changes is that
    // nothing new is decided — a fact about freshness, not about outcome.
    for (const state of COMMERCIAL_STATES) {
      expect(assuranceImpactOf(state).changesAnyOutcome).toBe(false);
    }
  });

  it('reports stopping maintenance exactly where service stops, and nowhere else', () => {
    for (const state of COMMERCIAL_STATES) {
      expect(assuranceImpactOf(state).stopsBeingMaintained).toBe(
        !COMMERCIAL_CAPABILITY[state].collectObservations,
      );
    }
  });
});
