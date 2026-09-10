import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTION_POLICY,
  actionTypeMatches,
  compilePolicy,
  evaluatePolicy,
  type PolicyQuestion,
} from './policy.js';

const policy = compilePolicy(DEFAULT_ACTION_POLICY);

function question(overrides: Partial<PolicyQuestion> = {}): PolicyQuestion {
  return {
    actionType: 'identity.mfa.require',
    riskClass: 'CONFIGURATION',
    findingSeverity: 'HIGH',
    organisationAutonomyLevel: 4,
    recentExecutions: 0,
    utcHour: 10,
    proposerUserId: null,
    ...overrides,
  };
}

describe('evaluatePolicy — default posture', () => {
  it('denies an action no rule covers', () => {
    const decision = evaluatePolicy(policy, question({ actionType: 'network.router.reconfigure' }));
    expect(decision.outcome).toBe('DENY');
    expect(decision.matchedRuleId).toBeNull();
  });

  it('never permits a destructive action, whatever the autonomy level', () => {
    for (const level of [0, 1, 2, 3, 4, 5] as const) {
      const decision = evaluatePolicy(
        policy,
        question({ riskClass: 'DESTRUCTIVE', organisationAutonomyLevel: level }),
      );
      expect(decision.outcome).toBe('DENY');
    }
  });

  it('lets a DENY rule beat a more specific ALLOW-style rule', () => {
    // identity.mfa.* would otherwise permit this, but the destructive risk class
    // matches the blanket DENY rule.
    const decision = evaluatePolicy(policy, question({ riskClass: 'DESTRUCTIVE' }));
    expect(decision.outcome).toBe('DENY');
    expect(decision.matchedRuleId).toBe('destructive-denied');
  });

  it('allows read-only actions without approval', () => {
    const decision = evaluatePolicy(
      policy,
      question({ actionType: 'identity.mfa.verify', riskClass: 'READ_ONLY' }),
    );
    expect(decision.outcome).toBe('ALLOW');
  });

  it('requires two approvers for disruptive actions', () => {
    const decision = evaluatePolicy(
      policy,
      question({ actionType: 'identity.account.disable', riskClass: 'DISRUPTIVE' }),
    );
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
    expect(decision.requiredApprovals).toBe(2);
  });
});

describe('evaluatePolicy — autonomy is a ceiling, never a grant', () => {
  it('takes the minimum of rule, organisation and risk-class ceilings', () => {
    const decision = evaluatePolicy(policy, question({ organisationAutonomyLevel: 2 }));
    expect(decision.effectiveAutonomyLevel).toBe(2);
    expect(decision.outcome).toBe('DENY');
    expect(decision.reason).toMatch(/permits proposal but not execution/);
  });

  it('caps a disruptive action at L3 even when the organisation is set to L5', () => {
    const decision = evaluatePolicy(
      policy,
      question({ riskClass: 'DISRUPTIVE', organisationAutonomyLevel: 5 }),
    );
    expect(decision.effectiveAutonomyLevel).toBe(3);
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
  });

  it('requires approval when the organisation sits at L3 even if the rule allows L4', () => {
    const decision = evaluatePolicy(policy, question({ organisationAutonomyLevel: 3 }));
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
  });

  it('permits autonomous execution only when every ceiling reaches L4', () => {
    const decision = evaluatePolicy(policy, question({ organisationAutonomyLevel: 4 }));
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
    // The default rule for identity.mfa.* has effect REQUIRE_APPROVAL, so even
    // at L4 a human is needed. Autonomy alone never overrides an explicit
    // approval requirement.
    expect(decision.effectiveAutonomyLevel).toBe(4);
  });

  it('executes autonomously when the rule effect is ALLOW and autonomy reaches L4', () => {
    const permissive = compilePolicy({
      ...DEFAULT_ACTION_POLICY,
      key: 'permissive',
      rules: [
        {
          id: 'mfa-auto',
          actionTypes: ['identity.mfa.*'],
          riskClasses: ['CONFIGURATION'],
          effect: 'ALLOW',
          maxAutonomyLevel: 4,
        },
      ],
    });
    const decision = evaluatePolicy(permissive, question({ organisationAutonomyLevel: 4 }));
    expect(decision.outcome).toBe('ALLOW');
  });
});

describe('evaluatePolicy — operational guards', () => {
  it('denies once the hourly rate limit is exhausted', () => {
    const decision = evaluatePolicy(policy, question({ recentExecutions: 50 }));
    expect(decision.outcome).toBe('DENY');
    expect(decision.reason).toMatch(/Rate limit reached/);
  });

  it('allows up to but not beyond the rate limit', () => {
    expect(evaluatePolicy(policy, question({ recentExecutions: 49 })).outcome).toBe(
      'REQUIRE_APPROVAL',
    );
  });

  it('enforces a change window when one is configured', () => {
    const windowed = compilePolicy({
      ...DEFAULT_ACTION_POLICY,
      key: 'windowed',
      rules: [
        {
          id: 'night-only',
          actionTypes: ['device.*'],
          effect: 'REQUIRE_APPROVAL',
          maxAutonomyLevel: 3,
          allowedHoursUtc: [1, 2, 3],
        },
      ],
    });
    expect(
      evaluatePolicy(windowed, question({ actionType: 'device.firewall.enable', utcHour: 2 }))
        .outcome,
    ).toBe('REQUIRE_APPROVAL');
    expect(
      evaluatePolicy(windowed, question({ actionType: 'device.firewall.enable', utcHour: 14 }))
        .outcome,
    ).toBe('DENY');
  });

  it('only applies a severity-gated rule at or above that severity', () => {
    const low = evaluatePolicy(
      policy,
      question({
        actionType: 'cloud.storage.block_public_access',
        findingSeverity: 'LOW',
      }),
    );
    expect(low.outcome).toBe('DENY');

    const high = evaluatePolicy(
      policy,
      question({
        actionType: 'cloud.storage.block_public_access',
        findingSeverity: 'CRITICAL',
      }),
    );
    expect(high.outcome).toBe('REQUIRE_APPROVAL');
  });
});

describe('policy explainability and integrity', () => {
  it('records every check that ran', () => {
    const decision = evaluatePolicy(policy, question());
    expect(decision.evaluation.map((c) => c.check)).toContain('autonomy-ceiling');
    expect(decision.evaluation.map((c) => c.check)).toContain('rate-limit');
    expect(decision.evaluation.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('stamps the policy hash on the decision', () => {
    const decision = evaluatePolicy(policy, question());
    expect(decision.policyHash).toBe(policy.hash);
    expect(decision.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hashes deterministically', () => {
    expect(compilePolicy(DEFAULT_ACTION_POLICY).hash).toBe(
      compilePolicy(DEFAULT_ACTION_POLICY).hash,
    );
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      compilePolicy({
        ...DEFAULT_ACTION_POLICY,
        rules: [DEFAULT_ACTION_POLICY.rules[0], DEFAULT_ACTION_POLICY.rules[0]],
      }),
    ).toThrow(/duplicate rule id/);
  });
});

describe('actionTypeMatches', () => {
  it('matches namespace prefixes but not unrelated namespaces', () => {
    expect(actionTypeMatches('identity.*', 'identity.mfa.require')).toBe(true);
    expect(actionTypeMatches('identity.*', 'device.firewall.enable')).toBe(false);
    expect(actionTypeMatches('*', 'anything.at.all')).toBe(true);
    expect(actionTypeMatches('identity.mfa.require', 'identity.mfa.require')).toBe(true);
    expect(actionTypeMatches('identity.mfa.require', 'identity.mfa.requires')).toBe(false);
  });
});

/**
 * The whole authority surface, quantified rather than sampled.
 *
 * Each of these is a property that must hold for every combination, not for the
 * combinations somebody thought to write down. A policy language is exactly the
 * kind of thing where the dangerous case is the one nobody enumerated.
 */
describe('evaluatePolicy — authority invariants over the whole matrix', () => {
  const RISK_CLASSES = [
    'READ_ONLY',
    'LOW_IMPACT',
    'CONFIGURATION',
    'DISRUPTIVE',
    'DESTRUCTIVE',
  ] as const;
  const LEVELS = [0, 1, 2, 3, 4, 5] as const;
  const SEVERITIES = [null, 'INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

  /** A deliberately reckless policy: everything allowed, at maximum autonomy. */
  const permissive = compilePolicy({
    key: 'reckless',
    name: 'Allow everything',
    defaultAutonomyLevel: 5,
    defaultEffect: 'ALLOW',
    rules: [
      {
        id: 'allow-all',
        actionTypes: ['*'],
        riskClasses: [],
        minSeverity: null,
        effect: 'ALLOW',
        maxAutonomyLevel: 5,
        requiredApprovals: 1,
        approvalWindowHours: 720,
        rateLimitPerHour: null,
        allowedHoursUtc: [],
        reason: 'Everything, immediately.',
      },
    ],
  });

  it('never lets a destructive action run without a human, however the policy is written', () => {
    const escapes: string[] = [];
    for (const organisationAutonomyLevel of LEVELS) {
      for (const findingSeverity of SEVERITIES) {
        for (const actionType of ['data.bucket.delete', 'identity.account.purge', 'anything']) {
          const decision = evaluatePolicy(
            permissive,
            question({
              actionType,
              riskClass: 'DESTRUCTIVE',
              organisationAutonomyLevel,
              findingSeverity,
            }),
          );
          if (decision.outcome === 'ALLOW') {
            escapes.push(`${actionType} @L${organisationAutonomyLevel}/${String(findingSeverity)}`);
          }
        }
      }
    }
    // No policy expression is worth an unrecoverable change to a customer's
    // environment. This is a hard ceiling in the domain, not a default.
    expect(escapes).toEqual([]);
  });

  it('never lets a disruptive action run without a human either', () => {
    const escapes: string[] = [];
    for (const organisationAutonomyLevel of LEVELS) {
      const decision = evaluatePolicy(
        permissive,
        question({ riskClass: 'DISRUPTIVE', organisationAutonomyLevel }),
      );
      if (decision.outcome === 'ALLOW') escapes.push(`L${organisationAutonomyLevel}`);
    }
    expect(escapes).toEqual([]);
  });

  it('never reports an effective autonomy above the organisation setting', () => {
    const escapes: string[] = [];
    for (const riskClass of RISK_CLASSES) {
      for (const organisationAutonomyLevel of LEVELS) {
        const decision = evaluatePolicy(
          permissive,
          question({ riskClass, organisationAutonomyLevel }),
        );
        if (decision.effectiveAutonomyLevel > organisationAutonomyLevel) {
          escapes.push(
            `${riskClass}: org L${organisationAutonomyLevel} -> L${decision.effectiveAutonomyLevel}`,
          );
        }
      }
    }
    // The organisation's own setting is a ceiling that no policy may raise.
    expect(escapes).toEqual([]);
  });

  it('never reports an effective autonomy above the risk-class ceiling', () => {
    const ceilings = {
      READ_ONLY: 5,
      LOW_IMPACT: 5,
      CONFIGURATION: 4,
      DISRUPTIVE: 3,
      DESTRUCTIVE: 3,
    } as const;
    const escapes: string[] = [];
    for (const riskClass of RISK_CLASSES) {
      for (const organisationAutonomyLevel of LEVELS) {
        const decision = evaluatePolicy(
          permissive,
          question({ riskClass, organisationAutonomyLevel }),
        );
        if (decision.effectiveAutonomyLevel > ceilings[riskClass]) {
          escapes.push(`${riskClass} -> L${decision.effectiveAutonomyLevel}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it('denies everything at autonomy L0, L1 and L2, whatever the risk class', () => {
    const escapes: string[] = [];
    for (const riskClass of RISK_CLASSES) {
      for (const organisationAutonomyLevel of [0, 1, 2] as const) {
        const decision = evaluatePolicy(
          permissive,
          question({ riskClass, organisationAutonomyLevel }),
        );
        // Below L3 Adericel may propose and stage, never dispatch. An
        // organisation that has not opted in to execution must not be executed
        // against by a policy an MSP wrote.
        if (decision.outcome !== 'DENY') {
          escapes.push(`${riskClass} @L${organisationAutonomyLevel} -> ${decision.outcome}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it('never requires fewer than two approvers for a disruptive or destructive action', () => {
    const escapes: string[] = [];
    for (const riskClass of ['DISRUPTIVE', 'DESTRUCTIVE'] as const) {
      for (const organisationAutonomyLevel of LEVELS) {
        const decision = evaluatePolicy(
          compilePolicy({
            key: 'one-approver',
            name: 'One approver is plenty',
            defaultAutonomyLevel: 5,
            defaultEffect: 'REQUIRE_APPROVAL',
            rules: [],
          }),
          question({ riskClass, organisationAutonomyLevel }),
        );
        if (decision.outcome !== 'DENY' && decision.requiredApprovals < 2) {
          escapes.push(`${riskClass} -> ${decision.requiredApprovals} approver(s)`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it('carries the deciding policy identity on every outcome, including denials', () => {
    for (const riskClass of RISK_CLASSES) {
      const decision = evaluatePolicy(policy, question({ riskClass }));
      // "Why was this allowed?" and "why was this refused?" are the same
      // question months later, and both need the policy that answered it.
      expect(decision.policyKey).toBe('adericel-default');
      expect(decision.policyHash).toMatch(/^sha256:/);
      expect(decision.evaluation.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same question always gets the same answer', () => {
    for (const riskClass of RISK_CLASSES) {
      const q = question({ riskClass, organisationAutonomyLevel: 4 });
      const first = evaluatePolicy(policy, q);
      const second = evaluatePolicy(policy, q);
      expect(second).toEqual(first);
    }
  });
});
