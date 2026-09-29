import { describe, expect, it } from 'vitest';
import {
  CONTAINMENT_DEFINITIONS,
  CONTAINMENT_LEVELS,
  definitionOf,
  effectiveLevel,
  isAtLeast,
  type ContainmentLevel,
} from './level.js';
import { CONTAINMENT_TRIGGERS, profileOf, TRIGGER_PROFILES } from './trigger.js';
import {
  authoriseContainment,
  AUTHORITY_CEILING,
  CONTAINMENT_ACTORS,
  leastDisruptiveLevel,
  type ContainmentRequest,
} from './authority.js';
import { authoriseRecovery, mayReturnDirectlyToNormal, type RecoveryRequest } from './recovery.js';
import { impairmentsFor, stopsCollection } from './impairment.js';

/**
 * Governed containment.
 *
 * Contract v3.1 §15. These tests are written from the position of somebody
 * trying to misuse containment rather than somebody hoping it works: the
 * failure modes that matter are an actor containing further than their
 * authority, a system releasing its own restriction, and containment being used
 * to deny an organisation access to its own record.
 */

const JUSTIFICATION = 'Entra client secret found in a public paste, rotating and isolating.';
const FINDINGS =
  'Secret was rotated, the paste was removed, and access logs show no use of the exposed value.';

function request(overrides: Partial<ContainmentRequest> = {}): ContainmentRequest {
  return {
    actor: 'VEYLITH',
    level: 'C2',
    scope: 'INTEGRATION',
    trigger: 'SECRET_EXPOSURE',
    actorGovernsTarget: true,
    justification: JUSTIFICATION,
    ...overrides,
  };
}

function recovery(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
  return {
    actor: 'VEYLITH',
    fromLevel: 'C2',
    toLevel: 'C0',
    resolution: 'RESOLVED',
    findings: FINDINGS,
    reObserved: true,
    evidencePreserved: true,
    riskAcceptedBy: null,
    actorGovernsTarget: true,
    ...overrides,
  };
}

describe('the invariant that holds at every level', () => {
  it('never denies an organisation its own assurance record', () => {
    /**
     * The single most important property in this package.
     *
     * Containment exists to stop Adericel doing things, not to stop customers
     * knowing things. An organisation locked out of its own record during an
     * incident is an organisation that cannot respond to it — and §16 is
     * explicit that a failing control is never a reason to deny access to
     * evidence.
     *
     * Asserted over the whole set rather than level by level, so a future level
     * cannot be added with this set false for a good-sounding reason.
     */
    for (const level of CONTAINMENT_LEVELS) {
      expect(definitionOf(level).evidenceReadable, `${level} withholds evidence`).toBe(true);
    }
  });

  it('restricts monotonically as the level rises', () => {
    // A higher level must never permit something a lower one forbade. Without
    // this, "more contained" stops meaning anything.
    const permissions = [
      'automationPermitted',
      'externalActionsPermitted',
      'tenantWritesPermitted',
    ] as const;
    for (const key of permissions) {
      let seenFalse = false;
      for (const level of CONTAINMENT_LEVELS) {
        const permitted = CONTAINMENT_DEFINITIONS[level][key];
        if (!permitted) seenFalse = true;
        else
          expect(seenFalse, `${level} re-permits ${key} after a stricter level forbade it`).toBe(
            false,
          );
      }
    }
  });

  it('takes the strictest level when several are in force', () => {
    // An organisation at C1 must not re-enable a connector separately held at C2.
    expect(effectiveLevel(['C1', 'C2'])).toBe('C2');
    expect(effectiveLevel(['C0'])).toBe('C0');
    expect(effectiveLevel([])).toBe('C0');
  });
});

describe('authority', () => {
  it('lets automation reach C2 and no further', () => {
    expect(AUTHORITY_CEILING.AUTOMATIC).toBe('C2');
    const denied = authoriseContainment(
      request({
        actor: 'AUTOMATIC',
        level: 'C3',
        scope: 'ORGANISATION',
        trigger: 'UNAUTHORISED_EXPORT',
      }),
    );
    expect(denied.permitted).toBe(false);
  });

  it('refuses an automatic containment at a level that restricts a customer', () => {
    // C3 is the first level that constrains what a customer can do, and no
    // automatic trigger may reach it. Automation raises the signal; a person
    // applies the restriction.
    const result = authoriseContainment(
      request({
        actor: 'AUTOMATIC',
        level: 'C3',
        scope: 'ORGANISATION',
        trigger: 'LEGAL_RESTRICTION_REQUIRED',
      }),
    );
    expect(result.permitted).toBe(false);
    if (result.permitted) return;
    expect(result.permittedCeiling).toBe('C2');
  });

  it('refuses automation on a trigger it may not act on unattended', () => {
    const result = authoriseContainment(
      request({ actor: 'AUTOMATIC', level: 'C2', trigger: 'CRITICAL_VULNERABILITY' }),
    );
    expect(result.permitted).toBe(false);
  });

  it('lets an MSP contain its own customer up to C3', () => {
    const result = authoriseContainment(
      request({ actor: 'MSP', level: 'C3', scope: 'ORGANISATION', trigger: 'UNAUTHORISED_EXPORT' }),
    );
    expect(result.permitted).toBe(true);
  });

  it('refuses an MSP a platform-wide protective state', () => {
    // C5 affects every other MSP. It is not one partner's to declare.
    const result = authoriseContainment(
      request({ actor: 'MSP', level: 'C5', scope: 'PLATFORM', trigger: 'PRODUCTION_COMPROMISE' }),
    );
    expect(result.permitted).toBe(false);
  });

  it('refuses any actor with no relationship to the estate', () => {
    // Checked here as well as by row-level security. This is the layer that can
    // say why, which matters during an incident.
    for (const actor of CONTAINMENT_ACTORS) {
      const result = authoriseContainment(request({ actor, actorGovernsTarget: false }));
      expect(result.permitted).toBe(false);
    }
  });

  it('refuses a level applied at a scope it was not designed for', () => {
    const result = authoriseContainment(
      request({ level: 'C5', scope: 'INTEGRATION', trigger: 'PRODUCTION_COMPROMISE' }),
    );
    expect(result.permitted).toBe(false);
  });

  it('refuses a containment with no stated reason', () => {
    const result = authoriseContainment(request({ justification: 'bad' }));
    expect(result.permitted).toBe(false);
  });

  it('sends every automatic containment for human review', () => {
    // Unreviewed automatic restriction is how a system quietly develops a habit
    // nobody chose.
    const result = authoriseContainment(request({ actor: 'AUTOMATIC', level: 'C2' }));
    expect(result.permitted).toBe(true);
    if (!result.permitted) return;
    expect(result.requiresHumanReview).toBe(true);
  });
});

describe('triggers', () => {
  it('assigns every trigger a level and a scope', () => {
    for (const trigger of CONTAINMENT_TRIGGERS) {
      const profile = profileOf(trigger);
      expect(CONTAINMENT_LEVELS).toContain(profile.minimumLevel);
      expect(profile.meaning.length).toBeGreaterThan(20);
    }
    expect(Object.keys(TRIGGER_PROFILES).sort()).toEqual([...CONTAINMENT_TRIGGERS].sort());
  });

  it('never permits automatic entry above C2', () => {
    // The ceiling, enforced at the trigger table as well as at the authority
    // check. Two independent places, because this is the rule most likely to be
    // relaxed by somebody adding a trigger in a hurry.
    for (const trigger of CONTAINMENT_TRIGGERS) {
      const profile = profileOf(trigger);
      if (profile.automaticEntryPermitted) {
        expect(
          isAtLeast(profile.minimumLevel, 'C3'),
          `${trigger} auto-enters ${profile.minimumLevel}`,
        ).toBe(false);
      }
    }
  });

  it('reaches platform scope only for platform-scale threats', () => {
    for (const trigger of CONTAINMENT_TRIGGERS) {
      const profile = profileOf(trigger);
      if (profile.minimumLevel === 'C5') expect(profile.naturalScope).toBe('PLATFORM');
    }
  });

  it('returns the least disruptive level that addresses a trigger', () => {
    // Containment reaching further than the threat is itself a harm.
    expect(leastDisruptiveLevel('SECRET_EXPOSURE')).toBe('C2');
    expect(leastDisruptiveLevel('OAUTH_PERMISSION_ANOMALY')).toBe('C1');
    expect(leastDisruptiveLevel('PRODUCTION_COMPROMISE')).toBe('C5');
  });
});

describe('recovery', () => {
  it('never lets automation release containment it entered', () => {
    /**
     * A system able to un-contain itself has no containment, only a pause.
     * Automation may enter C1 and C2; it may leave nothing.
     */
    for (const from of ['C1', 'C2', 'C3', 'C4', 'C5'] as ContainmentLevel[]) {
      const result = authoriseRecovery(
        recovery({ actor: 'AUTOMATIC', fromLevel: from, toLevel: 'C0' }),
      );
      expect(result.permitted, `automation released ${from}`).toBe(false);
    }
  });

  it('refuses recovery without re-observation', () => {
    // §5.5: believing it is fixed is not the same as having looked.
    const result = authoriseRecovery(recovery({ reObserved: false }));
    expect(result.permitted).toBe(false);
    if (result.permitted) return;
    expect(result.missing.join(' ')).toMatch(/re-observation/i);
  });

  it('refuses recovery that cannot confirm evidence survived', () => {
    const result = authoriseRecovery(recovery({ evidencePreserved: false }));
    expect(result.permitted).toBe(false);
  });

  it('refuses an accepted risk with nobody accepting it', () => {
    // An accepted risk with no owner is an unresolved risk somebody stopped
    // talking about.
    const result = authoriseRecovery(
      recovery({ resolution: 'RISK_ACCEPTED', riskAcceptedBy: null }),
    );
    expect(result.permitted).toBe(false);
    const named = authoriseRecovery(
      recovery({ resolution: 'RISK_ACCEPTED', riskAcceptedBy: 'J. Whitmore' }),
    );
    expect(named.permitted).toBe(true);
  });

  it('refuses recovery with no account of what was found', () => {
    const result = authoriseRecovery(recovery({ findings: 'fixed' }));
    expect(result.permitted).toBe(false);
  });

  it('refuses an actor lifting containment above their ceiling', () => {
    // Whoever was able to impose it is who may lift it.
    const result = authoriseRecovery(recovery({ actor: 'MSP', fromLevel: 'C5', toLevel: 'C0' }));
    expect(result.permitted).toBe(false);
  });

  it('refuses a "recovery" that raises containment', () => {
    const result = authoriseRecovery(recovery({ fromLevel: 'C1', toLevel: 'C3' }));
    expect(result.permitted).toBe(false);
  });

  it('always requires the recovery itself to be verified', () => {
    const result = authoriseRecovery(recovery());
    expect(result.permitted).toBe(true);
    if (!result.permitted) return;
    expect(result.verificationRequired).toBe(true);
  });

  it('routes a serious containment back through observation, not straight to normal', () => {
    // An estate that needed operations restricted comes back through C1, so
    // somebody watches it run before Adericel is trusted to act on it again.
    expect(mayReturnDirectlyToNormal('C1')).toBe(true);
    expect(mayReturnDirectlyToNormal('C2')).toBe(true);
    expect(mayReturnDirectlyToNormal('C3')).toBe(false);
    expect(mayReturnDirectlyToNormal('C4')).toBe(false);
    expect(mayReturnDirectlyToNormal('C5')).toBe(false);
  });
});

describe('what containment does to assurance', () => {
  it('says CONTAINED rather than letting controls decay to unknown', () => {
    /**
     * The connection that makes containment honest.
     *
     * Left alone, a contained estate's controls decay to UNKNOWN — true, and
     * deeply misleading, because UNKNOWN reads as "nobody looked". Somebody
     * looked, decided it was not safe to keep looking, and wrote down why.
     */
    const impairments = impairmentsFor({
      level: 'C2',
      predicates: ['identity.mfa.enforced', 'device.encrypted'],
      since: '2026-09-15T09:00:00.000Z',
      reason: 'credential compromise',
    });
    expect(impairments).toHaveLength(2);
    for (const impairment of impairments) {
      expect(impairment.kind).toBe('BLOCKED');
      expect(impairment.reason).toBe('CONTAINED');
      expect(impairment.detail).toMatch(/has not changed and has not failed/i);
    }
  });

  it('degrades nothing when containment does not stop observation', () => {
    // C1 stops Adericel acting while deliberately keeping it watching. Marking
    // controls BLOCKED there would report a loss of assurance that has not
    // happened.
    expect(stopsCollection('C0')).toBe(false);
    expect(stopsCollection('C1')).toBe(false);
    expect(
      impairmentsFor({
        level: 'C1',
        predicates: ['identity.mfa.enforced'],
        since: 'x',
        reason: 'y',
      }),
    ).toEqual([]);
  });

  it('stops collection from C2 upward', () => {
    for (const level of ['C2', 'C3', 'C4', 'C5'] as ContainmentLevel[]) {
      expect(stopsCollection(level)).toBe(true);
    }
  });
});
