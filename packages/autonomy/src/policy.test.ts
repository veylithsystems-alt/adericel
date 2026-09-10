import { describe, expect, it } from 'vitest';
import {
  compileAutonomyPolicy,
  evaluateAutonomy,
  operationMatches,
  type AutonomyQuestion,
} from './policy.js';
import { DEFAULT_COMPANY_POLICY } from './default-policy.js';
import {
  AUTONOMY_OUTCOMES,
  mayProceedUnattended,
  mostRestrictive,
  requiresHuman,
  type AutonomyOutcome,
} from './decision.js';

/**
 * The company's authority model, attacked.
 *
 * These tests are written from the position of someone trying to make the
 * autonomous layer do something nobody authorised. Most of them assert that
 * something does NOT happen, which is the only useful shape of test for an
 * authority boundary: a boundary that has only ever been tested by well-formed
 * requests has not been tested.
 */

const policy = compileAutonomyPolicy(DEFAULT_COMPANY_POLICY);

function ask(over: Partial<AutonomyQuestion> = {}): AutonomyQuestion {
  return {
    processKey: 'market.prospect_discovery',
    operation: 'market.prospect_discovery.enrich',
    riskClass: 'INTERNAL',
    processMaturity: 3,
    recentOperations: 0,
    utcHour: 10,
    facts: {},
    ...over,
  };
}

describe('UNKNOWN never becomes permission', () => {
  it('is one of the outcomes at all, unlike the action policy', () => {
    expect(AUTONOMY_OUTCOMES).toContain('UNKNOWN');
  });

  it('does not permit unattended action', () => {
    expect(mayProceedUnattended('UNKNOWN')).toBe(false);
  });

  it('requires a human', () => {
    expect(requiresHuman('UNKNOWN')).toBe(true);
  });

  it('is the only outcome besides PERMIT that could be mistaken for one', () => {
    // Exhaustive, so a new outcome added later cannot quietly default to
    // permitting.
    const permitting = AUTONOMY_OUTCOMES.filter(mayProceedUnattended);
    expect(permitting).toEqual(['PERMIT']);
  });

  it('beats REQUIRE_APPROVAL and ESCALATE when results combine', () => {
    // Not knowing is more restrictive than knowing a person is needed: we do
    // not even know which person, or whether it should happen at all.
    expect(mostRestrictive(['PERMIT', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(mostRestrictive(['REQUIRE_APPROVAL', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(mostRestrictive(['ESCALATE', 'UNKNOWN'])).toBe('UNKNOWN');
    // DENY is still stronger: an explicit refusal is a decision.
    expect(mostRestrictive(['UNKNOWN', 'DENY'])).toBe('DENY');
  });

  it('is what an empty set of results means', () => {
    // "Nothing objected" is not "everything agreed".
    expect(mostRestrictive([])).toBe('UNKNOWN');
  });
});

describe('an operation nobody wrote a rule for', () => {
  it('is not permitted by omission', () => {
    const decision = evaluateAutonomy(policy, ask({ operation: 'something.nobody.anticipated' }));
    expect(decision.outcome).toBe('UNKNOWN');
    expect(mayProceedUnattended(decision.outcome)).toBe(false);
    expect(decision.reason).toContain('not thereby permitted');
  });

  it('cannot be permitted by configuring a permissive fallback', () => {
    // The schema does not admit PERMIT as a fallback, so a policy that
    // auto-allows the unanticipated is not expressible.
    expect(() =>
      compileAutonomyPolicy({ ...DEFAULT_COMPANY_POLICY, fallback: 'PERMIT' }),
    ).toThrow();
  });
});

describe('an unregistered process', () => {
  it('yields UNKNOWN rather than being treated as manual', () => {
    // Treating "not registered" as maturity 0 would let it inherit whatever a
    // permissive rule allows at low maturity. It is not a low-autonomy
    // process; it is one nobody has thought about.
    const decision = evaluateAutonomy(policy, ask({ processMaturity: null }));
    expect(decision.outcome).toBe('UNKNOWN');
    expect(decision.requiredAuthority).toContain('Register the process');
  });

  it('is not rescued by an otherwise permitting rule', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'INTERNAL',
        processMaturity: null,
      }),
    );
    expect(decision.outcome).toBe('UNKNOWN');
  });
});

describe('facts that were never established', () => {
  it('block permission rather than being read as false', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        facts: {},
      }),
    );
    expect(decision.outcome).toBe('UNKNOWN');
    expect(decision.evaluation.some((c) => c.detail.includes('Not established is not false'))).toBe(
      true,
    );
  });

  it('are distinguished from facts that are established and false', () => {
    // A false fact is a decision — DENY. An absent one is not.
    const denied = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        facts: { lawful_basis_recorded: false, not_suppressed: true, content_approved: true },
      }),
    );
    expect(denied.outcome).toBe('DENY');
  });

  it('permit only when every required fact holds', () => {
    const permitted = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        facts: { lawful_basis_recorded: true, not_suppressed: true, content_approved: true },
      }),
    );
    expect(permitted.outcome).toBe('PERMIT');
  });

  it('cannot be satisfied by a differently named fact', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        facts: { consent: true, lawfulBasisRecorded: true, approved: true },
      }),
    );
    expect(decision.outcome).toBe('UNKNOWN');
  });
});

describe('money', () => {
  it('is refused outright, at every maturity', () => {
    for (const maturity of [0, 1, 2, 3, 4, 5]) {
      const decision = evaluateAutonomy(
        policy,
        ask({
          processKey: 'finance.payments',
          operation: 'finance.payments.send',
          riskClass: 'FINANCIAL',
          processMaturity: maturity,
          facts: {},
        }),
      );
      expect(decision.outcome, `maturity L${maturity}`).toBe('DENY');
    }
  });

  it('is still refused when every fact is asserted true', () => {
    // Supplying facts must not be a route around a DENY.
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'finance.payments',
        operation: 'finance.payments.send',
        riskClass: 'FINANCIAL',
        facts: {
          approved: true,
          authorised: true,
          subscription_active: true,
          amount_matches_agreement: true,
        },
      }),
    );
    expect(decision.outcome).toBe('DENY');
  });

  it('refuses even when a permitting rule also matches', () => {
    // `billing.routine` permits invoicing. It must not extend to moving money,
    // and the most-restrictive combination is what guarantees that.
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'finance.payments',
        operation: 'finance.payments.settle_invoice',
        riskClass: 'FINANCIAL',
        facts: { subscription_active: true, amount_matches_agreement: true },
      }),
    );
    expect(decision.outcome).toBe('DENY');
  });
});

describe('legal position', () => {
  it('cannot be taken autonomously', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'legal.contract',
        operation: 'legal.contract.accept_terms',
        riskClass: 'CONTRACTUAL',
        facts: { template_is_approved_standard: true, no_terms_varied: true },
      }),
    );
    expect(decision.outcome).toBe('DENY');
  });

  it('still permits the administrative half', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'legal.contract',
        operation: 'legal.contract.generate',
        riskClass: 'INTERNAL',
        facts: { template_is_approved_standard: true, no_terms_varied: true },
      }),
    );
    expect(decision.outcome).toBe('PERMIT');
  });

  it('refuses generation the moment terms are varied', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'legal.contract',
        operation: 'legal.contract.generate',
        riskClass: 'INTERNAL',
        facts: { template_is_approved_standard: true, no_terms_varied: false },
      }),
    );
    expect(decision.outcome).toBe('DENY');
  });
});

describe('the irreversible backstop', () => {
  it('catches an irreversible operation whatever else permits it', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'market.prospect_discovery',
        operation: 'market.prospect_discovery.enrich',
        riskClass: 'IRREVERSIBLE',
        processMaturity: 5,
      }),
    );
    expect(mayProceedUnattended(decision.outcome)).toBe(false);
  });

  it('cannot be overridden by adding a permitting rule', () => {
    // Rules combine to the most restrictive result, so a new rule can narrow
    // authority and never widen it. This is the property that lets the policy
    // be extended without re-auditing everything already in it.
    const widened = compileAutonomyPolicy({
      ...DEFAULT_COMPANY_POLICY,
      rules: [
        ...DEFAULT_COMPANY_POLICY.rules,
        {
          id: 'attacker.permit-everything',
          description: 'A rule added in an attempt to widen authority.',
          operations: ['*'],
          riskClasses: [],
          maxUnattendedRisk: 'IRREVERSIBLE',
          minMaturity: 0,
          outcome: 'PERMIT',
          requiredApprovals: 0,
          requiredAuthority: '',
          rateLimitPerHour: null,
          allowedUtcHours: [],
          requiresFacts: [],
        },
      ],
    });

    for (const operation of [
      'finance.payments.send',
      'legal.contract.accept_terms',
      'strategy.direction.set',
      'engineering.deployment.production',
    ]) {
      const decision = evaluateAutonomy(
        widened,
        ask({ operation, riskClass: 'IRREVERSIBLE', processMaturity: 5 }),
      );
      expect(mayProceedUnattended(decision.outcome), operation).toBe(false);
    }
  });
});

describe('risk ceilings and maturity', () => {
  it('does not let a rule permit beyond its own risk ceiling', () => {
    // `internal.record-keeping` permits `market.*` — but only at INTERNAL risk.
    const decision = evaluateAutonomy(
      policy,
      ask({ operation: 'market.prospect_discovery.publish', riskClass: 'OUTWARD_FACING' }),
    );
    expect(decision.outcome).not.toBe('PERMIT');
  });

  it('will not run unattended below the maturity the rule requires', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        processMaturity: 1,
        facts: { lawful_basis_recorded: true, not_suppressed: true, content_approved: true },
      }),
    );
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
  });
});

describe('rate limits', () => {
  it('escalate rather than ask for approval', () => {
    // Hitting a cap usually means something is malfunctioning. Asking a person
    // to rubber-stamp the four thousandth email is the wrong question.
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        recentOperations: 120,
        facts: { lawful_basis_recorded: true, not_suppressed: true, content_approved: true },
      }),
    );
    expect(decision.outcome).toBe('ESCALATE');
    expect(decision.reason).toContain('something is wrong');
  });

  it('applies at the cap, not one past it', () => {
    const atCap = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        recentOperations: 119,
        facts: { lawful_basis_recorded: true, not_suppressed: true, content_approved: true },
      }),
    );
    expect(atCap.outcome).toBe('PERMIT');
  });
});

describe('determinism', () => {
  it('produces the same decision for the same question', () => {
    const question = ask({
      processKey: 'sales.outreach',
      operation: 'sales.outreach.send_email',
      riskClass: 'OUTWARD_FACING',
      facts: { lawful_basis_recorded: true, not_suppressed: true, content_approved: true },
    });
    expect(evaluateAutonomy(policy, question)).toEqual(evaluateAutonomy(policy, question));
  });

  it('records every check, so a decision can be shown rather than asserted', () => {
    const decision = evaluateAutonomy(
      policy,
      ask({
        processKey: 'sales.outreach',
        operation: 'sales.outreach.send_email',
        riskClass: 'OUTWARD_FACING',
        facts: { lawful_basis_recorded: true, not_suppressed: false, content_approved: true },
      }),
    );
    expect(decision.evaluation.length).toBeGreaterThan(1);
    expect(decision.evaluation.every((c) => c.detail.length > 0)).toBe(true);
  });

  it('hashes the policy so a decision names the rules it ran under', () => {
    expect(policy.hash).toMatch(/^sha256:/);
    const same = compileAutonomyPolicy(DEFAULT_COMPANY_POLICY);
    expect(same.hash).toBe(policy.hash);
    const changed = compileAutonomyPolicy({ ...DEFAULT_COMPANY_POLICY, fallback: 'DENY' });
    expect(changed.hash).not.toBe(policy.hash);
  });
});

describe('pattern matching', () => {
  it('matches a namespace prefix but not a sibling with a shared prefix', () => {
    expect(operationMatches('sales.*', 'sales.outreach.send')).toBe(true);
    expect(operationMatches('sales.*', 'sales')).toBe(false);
    // The trap: `finance.*` must not match `financeadmin.something`.
    expect(operationMatches('finance.*', 'financeadmin.transfer')).toBe(false);
  });

  it('treats an exact pattern as exact', () => {
    expect(operationMatches('legal.contract.generate', 'legal.contract.generate')).toBe(true);
    expect(operationMatches('legal.contract.generate', 'legal.contract.generate_and_sign')).toBe(
      false,
    );
  });
});

describe('the policy is well formed', () => {
  it('refuses duplicate rule ids', () => {
    expect(() =>
      compileAutonomyPolicy({
        ...DEFAULT_COMPANY_POLICY,
        rules: [DEFAULT_COMPANY_POLICY.rules[0]!, DEFAULT_COMPANY_POLICY.rules[0]!],
      }),
    ).toThrow(/Duplicate/);
  });

  it('never permits any strategy operation', () => {
    for (const operation of ['strategy.direction.set', 'strategy.pricing.change']) {
      const decision = evaluateAutonomy(policy, ask({ operation, processMaturity: 5 }));
      expect(decision.outcome, operation).toBe('DENY');
    }
  });

  it('permits nothing outward-facing without an established lawful basis', () => {
    const outward: AutonomyOutcome[] = [];
    for (const operation of [
      'sales.outreach.send_email',
      'marketing.publish_post',
      'customer_ops.reporting.send',
    ]) {
      outward.push(evaluateAutonomy(policy, ask({ operation, riskClass: 'OUTWARD_FACING' })).outcome);
    }
    expect(outward.some(mayProceedUnattended)).toBe(false);
  });
});
