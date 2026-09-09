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
