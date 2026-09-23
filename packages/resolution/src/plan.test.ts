import { describe, expect, it } from 'vitest';
import { UNKNOWN_REASONS, DEGRADED_REASONS } from '@adericel/domain';
import { KIND_MEANING, KIND_OF_DEGRADED_REASON, KIND_OF_REASON, UNKNOWN_KINDS } from './kind.js';
import { assessMateriality, MATERIALITY } from './materiality.js';
import { orderResolutionQueue, planResolution, type UnknownItemInput } from './plan.js';

/**
 * Turning "we do not know" into "here is how to find out".
 *
 * The property running through this file: a plan is never allowed to be empty
 * where it matters. An MSP told that forty controls are undecided, with no
 * indication of which are one credential away and which nobody can answer, has
 * been handed the cost rather than relieved of it.
 */

function item(overrides: Partial<UnknownItemInput> = {}): UnknownItemInput {
  return {
    organisationId: 'org-1',
    controlId: 'ctl-1',
    controlKey: 'ce.access.mfa_on_cloud_services',
    controlTitle: 'Multi-factor authentication is applied to cloud services',
    unknownReason: 'NO_EVIDENCE',
    degradedReason: null,
    missingPredicates: ['identity.mfa.enforced'],
    supplyingConnector: 'microsoft-entra',
    connectorConfigured: false,
    attestationOnly: false,
    materialityInput: {
      severity: 'HIGH',
      controlsAffected: 1,
      blocksCommitment: false,
      daysUntilCommitment: null,
      awaitingPerson: false,
      actionable: true,
    },
    uncertaintyReduction: { controlsUnblocked: 1, controlsDecidedOutright: 1 },
    outstandingRequestAgeDays: null,
    ...overrides,
  };
}

describe('every unknown is classified, and the classification is total', () => {
  it('maps every engine reason to exactly one kind', () => {
    // Exhaustive by construction: adding a reason without deciding what a
    // person does about it does not compile. Asserted anyway, because the type
    // stops at the process boundary and a value can arrive from a column.
    for (const reason of UNKNOWN_REASONS) {
      expect(UNKNOWN_KINDS, reason).toContain(KIND_OF_REASON[reason]);
    }
    for (const reason of DEGRADED_REASONS) {
      expect(UNKNOWN_KINDS, reason).toContain(KIND_OF_DEGRADED_REASON[reason]);
    }
  });

  it('treats every degraded reason as a broken collection path', () => {
    // A DEGRADED control is one whose source is broken, by definition. Any
    // other classification would send an operator looking for evidence that
    // does not exist rather than repairing the path that would produce it.
    for (const reason of DEGRADED_REASONS) {
      expect(KIND_OF_DEGRADED_REASON[reason], reason).toBe('UNCOLLECTABLE');
    }
  });

  it('explains every kind in an operator’s words', () => {
    for (const kind of UNKNOWN_KINDS) {
      expect(KIND_MEANING[kind].length).toBeGreaterThan(40);
    }
  });
});

describe('the eight things every plan carries', () => {
  const plan = planResolution(item());

  it('carries the kind in readable form, not only as an enum', () => {
    // A client that had to join the kind against a lookup table will render
    // the enum when the join is inconvenient, and `CONTRADICTORY` on a screen
    // tells a person nothing about what to do next.
    expect(plan.kind).toBe('MISSING');
    expect(plan.kindMeaning).toBe(KIND_MEANING.MISSING);
    expect(plan.kindMeaning).toMatch(/nothing has been observed yet/i);
  });

  it('says why it is unknown, without using the engine’s enum', () => {
    expect(plan.becauseUnknown).toMatch(/nothing is configured that could supply/i);
    expect(plan.becauseUnknown).not.toMatch(/NO_EVIDENCE/);
  });

  it('says what would resolve it, specifically', () => {
    expect(plan.resolvedBy).toContain('identity.mfa.enforced');
    expect(plan.resolvedBy).toContain('microsoft-entra');
  });

  it('names who can provide it, and why it is them', () => {
    expect(plan.owner).toBe('MSP');
    expect(plan.ownerDetail).toMatch(/not configured for this organisation/i);
  });

  it('states materiality with the reasoning that produced it', () => {
    expect(MATERIALITY).toContain(plan.materiality);
    expect(plan.materialityBecause.length).toBeGreaterThan(0);
    // An operator should be able to disagree with the reasoning rather than
    // with a number.
    expect(plan.materialityBecause[0]).toMatch(/the control is HIGH/i);
  });

  it('states the consequence in consequences, not in states', () => {
    // "The control will remain UNKNOWN" is a tautology. What an operator needs
    // is the sentence they would have to say to the customer.
    expect(plan.ifUnresolved).not.toMatch(/^the control (will )?remains? UNKNOWN\.?$/i);
    expect(plan.ifUnresolved.length).toBeGreaterThan(40);
  });

  it('gives one imperative next action', () => {
    expect(plan.nextAction).toMatch(/^Configure microsoft-entra/);
  });

  it('quantifies the uncertainty it would clear, as counts and never a probability', () => {
    /**
     * The honesty constraint. "73% confidence" would be a fabrication dressed
     * as precision; "resolving this decides four controls" is a fact about the
     * graph. The caveat travels with the numbers.
     */
    expect(plan.uncertaintyReduction.controlsUnblocked).toBe(1);
    expect(plan.uncertaintyReduction.caveat).toMatch(/not a probability/i);
    expect(plan.uncertaintyReduction.caveat).toMatch(/not a confidence level/i);
  });

  it('fills all eight for every reason the engine can produce', () => {
    // The guarantee, over the whole vocabulary rather than the one case above.
    for (const reason of UNKNOWN_REASONS) {
      const each = planResolution(item({ unknownReason: reason }));
      expect(each.becauseUnknown.length, reason).toBeGreaterThan(30);
      expect(each.resolvedBy.length, reason).toBeGreaterThan(20);
      expect(each.ownerDetail.length, reason).toBeGreaterThan(30);
      expect(each.ifUnresolved.length, reason).toBeGreaterThan(30);
      expect(each.nextAction.length, reason).toBeGreaterThan(20);
      expect(each.materialityBecause.length, reason).toBeGreaterThan(0);
    }
    for (const reason of DEGRADED_REASONS) {
      const each = planResolution(item({ unknownReason: null, degradedReason: reason }));
      expect(each.becauseUnknown.length, reason).toBeGreaterThan(30);
      expect(each.nextAction.length, reason).toBeGreaterThan(20);
    }
  });
});

describe('routing it to somebody who can actually act', () => {
  it('sends an expired credential to the MSP with the specific repair', () => {
    const plan = planResolution(
      item({
        unknownReason: null,
        degradedReason: 'CREDENTIAL_EXPIRED',
        connectorConfigured: true,
      }),
    );
    expect(plan.kind).toBe('UNCOLLECTABLE');
    expect(plan.owner).toBe('MSP');
    expect(plan.nextAction).toMatch(/reauthorise microsoft-entra/i);
  });

  it('sends withdrawn consent to the MSP but names the client as the blocker', () => {
    // The MSP does the work; the client has to permit it first. An action that
    // said "re-run collection" would have the engineer retrying a refusal.
    const plan = planResolution(
      item({ unknownReason: null, degradedReason: 'CONSENT_WITHDRAWN', connectorConfigured: true }),
    );
    expect(plan.nextAction).toMatch(/ask the client to restore consent/i);
    expect(plan.nextAction).toMatch(/will not look again until they do/i);
  });

  it('sends an attestation-only fact to the client, and escalates when ignored', () => {
    const fresh = planResolution(item({ attestationOnly: true }));
    expect(fresh.owner).toBe('CLIENT');
    expect(fresh.nextAction).toMatch(/ask the client to confirm/i);

    const stale = planResolution(item({ attestationOnly: true, outstandingRequestAgeDays: 21 }));
    // Chasing again is not progress — it is the same request with more urgency.
    expect(stale.nextAction).toMatch(/21 day\(s\) old/);
    expect(stale.nextAction).toMatch(/escalate|accepted/i);
  });

  it('takes the blame itself when no connector could ever supply it', () => {
    /**
     * A coverage gap in Adericel is Adericel's, not the MSP's. Routing it to
     * them would have an engineer hunting for a setting that does not exist,
     * and they would eventually conclude the product is unreliable rather than
     * incomplete.
     */
    const plan = planResolution(item({ supplyingConnector: null }));
    expect(plan.owner).toBe('VEYLITH');
    expect(plan.ownerDetail).toMatch(/no connector adericel ships/i);
    expect(plan.nextAction).toMatch(/not the MSP’s work to do/i);
  });

  it('refuses to choose between disagreeing sources, and says whose job that is', () => {
    const plan = planResolution(item({ unknownReason: 'CONTRADICTORY_EVIDENCE' }));
    expect(plan.kind).toBe('CONTRADICTORY');
    expect(plan.ownerDetail).toMatch(/does not choose between disagreeing sources/i);
    expect(plan.resolvedBy).toMatch(/which source is authoritative/i);
  });

  it('routes an out-of-scope control to nobody, and says not to queue it', () => {
    const plan = planResolution(item({ unknownReason: 'NO_APPLICABLE_RULE' }));
    expect(plan.owner).toBe('NOBODY');
    expect(plan.actionable).toBe(false);
    expect(plan.nextAction).toMatch(/do not leave it in the queue as work/i);
  });
});

describe('materiality decides the order, and explains itself', () => {
  it('makes a dated commitment inside a month BLOCKING', () => {
    const verdict = assessMateriality({
      severity: 'MEDIUM',
      controlsAffected: 1,
      blocksCommitment: true,
      daysUntilCommitment: 9,
      awaitingPerson: false,
      actionable: true,
    });
    expect(verdict.materiality).toBe('BLOCKING');
    expect(verdict.because.join(' ')).toMatch(/9 day\(s\)/);
    expect(verdict.ifUnresolved).toMatch(/cannot be met honestly/i);
  });

  it('raises a one-fix-many unknown above a lone critical one', () => {
    /**
     * The factor an operator cannot see for themselves. Severity is on the
     * screen; "this one credential is why nine controls are dark" is not — and
     * it is usually the best hour of work available.
     */
    const fanOut = assessMateriality({
      severity: 'MEDIUM',
      controlsAffected: 9,
      blocksCommitment: false,
      daysUntilCommitment: null,
      awaitingPerson: false,
      actionable: true,
    });
    expect(fanOut.materiality).toBe('HIGH');
    expect(fanOut.because.join(' ')).toMatch(/9 controls cannot be decided/i);
  });

  it('does not raise materiality merely because somebody was already asked', () => {
    // Asking again is the same request with more urgency attached, which is
    // how a queue becomes noise.
    const base = {
      severity: 'HIGH' as const,
      controlsAffected: 1,
      blocksCommitment: false,
      daysUntilCommitment: null,
      actionable: true,
    };
    expect(assessMateriality({ ...base, awaitingPerson: true }).materiality).toBe(
      assessMateriality({ ...base, awaitingPerson: false }).materiality,
    );
    expect(assessMateriality({ ...base, awaitingPerson: true }).because.join(' ')).toMatch(
      /escalating or accepting the risk is/i,
    );
  });

  it('caps the unactionable at LOW rather than dropping it', () => {
    /**
     * Adericel cannot close it, which is not the same as it not mattering. A
     * CRITICAL control nobody can observe is a real hole and belongs in a
     * report — capped so it stops competing with work somebody can do today.
     */
    const verdict = assessMateriality({
      severity: 'CRITICAL',
      controlsAffected: 3,
      blocksCommitment: false,
      daysUntilCommitment: null,
      awaitingPerson: false,
      actionable: false,
    });
    expect(verdict.materiality).toBe('LOW');
    expect(verdict.because.join(' ')).toMatch(/still appears in the assurance position/i);
  });

  it('never returns a consequence of "nothing"', () => {
    // An unknown with no stated consequence has no business being in a queue.
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const) {
      for (const actionable of [true, false]) {
        const verdict = assessMateriality({
          severity,
          controlsAffected: 1,
          blocksCommitment: false,
          daysUntilCommitment: null,
          awaitingPerson: false,
          actionable,
        });
        expect(verdict.ifUnresolved.length, `${severity}/${actionable}`).toBeGreaterThan(30);
      }
    }
  });
});

describe('the queue an operator actually works', () => {
  it('orders by materiality, then by how much each unlocks', () => {
    const plans = [
      planResolution(
        item({
          controlId: 'a',
          materialityInput: {
            severity: 'LOW',
            controlsAffected: 1,
            blocksCommitment: false,
            daysUntilCommitment: null,
            awaitingPerson: false,
            actionable: true,
          },
        }),
      ),
      planResolution(
        item({
          controlId: 'b',
          materialityInput: {
            severity: 'MEDIUM',
            controlsAffected: 1,
            blocksCommitment: true,
            daysUntilCommitment: 5,
            awaitingPerson: false,
            actionable: true,
          },
        }),
      ),
      planResolution(
        item({
          controlId: 'c',
          uncertaintyReduction: { controlsUnblocked: 9, controlsDecidedOutright: 7 },
          materialityInput: {
            severity: 'HIGH',
            controlsAffected: 9,
            blocksCommitment: false,
            daysUntilCommitment: null,
            awaitingPerson: false,
            actionable: true,
          },
        }),
      ),
    ];
    const { work } = orderResolutionQueue(plans);
    expect(work.map((plan) => plan.controlId)).toEqual(['b', 'c', 'a']);
  });

  it('separates what nobody can action, without discarding it', () => {
    /**
     * An item nobody can action sitting in a work queue teaches an operator to
     * distrust the queue, and a distrusted queue is how the real items get
     * missed. It is still returned, because it is still true.
     */
    const { work, notActionable } = orderResolutionQueue([
      planResolution(item()),
      planResolution(item({ controlId: 'x', unknownReason: 'NO_APPLICABLE_RULE' })),
    ]);
    expect(work).toHaveLength(1);
    expect(notActionable).toHaveLength(1);
    expect(notActionable[0]!.controlId).toBe('x');
  });

  it('summarises the queue in terms of work and of what it would buy', () => {
    const { summary } = orderResolutionQueue([
      planResolution(
        item({ uncertaintyReduction: { controlsUnblocked: 4, controlsDecidedOutright: 4 } }),
      ),
      planResolution(
        item({
          controlId: 'b',
          materialityInput: {
            severity: 'HIGH',
            controlsAffected: 1,
            blocksCommitment: true,
            daysUntilCommitment: 3,
            awaitingPerson: false,
            actionable: true,
          },
        }),
      ),
      planResolution(item({ controlId: 'c', unknownReason: 'NO_APPLICABLE_RULE' })),
    ]);
    expect(summary).toMatch(/2 unknown\(s\) can be resolved/);
    expect(summary).toMatch(/1 of them blocking a dated commitment/);
    expect(summary).toMatch(/5 control assessment\(s\) decidable/);
    expect(summary).toMatch(/1 further unknown\(s\) cannot be closed/);
  });

  it('is empty and says so, rather than erroring', () => {
    const { work, notActionable, summary } = orderResolutionQueue([]);
    expect(work).toEqual([]);
    expect(notActionable).toEqual([]);
    expect(summary).toMatch(/0 unknown\(s\) can be resolved/);
  });
});
