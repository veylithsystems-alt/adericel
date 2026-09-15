import { describe, expect, it } from 'vitest';
import { compileAutonomyPolicy, evaluateAutonomy, operationMatches } from './policy.js';
import {
  AUTONOMY_OUTCOMES,
  mayProceedUnattended,
  mostRestrictive,
  requiresHuman,
} from './decision.js';

/**
 * The engine, tested without any particular company's policy.
 *
 * These are the mechanics: what the outcomes mean, how results combine, how
 * patterns match. Veylith's own policy is tested where it lives, in
 * `@adericel/vaol` — a general engine whose test suite depends on one company's
 * rules is a general engine only by accident.
 */

const minimal = compileAutonomyPolicy({
  key: 'test.engine',
  name: 'Engine mechanics',
  fallback: 'UNKNOWN',
  rules: [
    {
      id: 'permit-internal',
      operations: ['thing.*'],
      riskClasses: ['INTERNAL'],
      maxUnattendedRisk: 'INTERNAL',
      minMaturity: 2,
      outcome: 'PERMIT',
      requiresFacts: ['ready'],
    },
  ],
});

const ask = (over: Record<string, unknown> = {}) => ({
  processKey: 'thing',
  operation: 'thing.do',
  riskClass: 'INTERNAL' as const,
  processMaturity: 3,
  recentOperations: 0,
  utcHour: 12,
  facts: { ready: true },
  ...over,
});

describe('outcome semantics', () => {
  it('permits unattended action for exactly one outcome', () => {
    // Exhaustive, so an outcome added later cannot quietly default to
    // permitting.
    expect(AUTONOMY_OUTCOMES.filter(mayProceedUnattended)).toEqual(['PERMIT']);
  });

  it('needs a human for everything that is not a permit or a refusal', () => {
    expect(AUTONOMY_OUTCOMES.filter(requiresHuman).sort()).toEqual([
      'ESCALATE',
      'REQUIRE_APPROVAL',
      'UNKNOWN',
    ]);
  });

  it('combines results to the most restrictive', () => {
    expect(mostRestrictive(['PERMIT', 'REQUIRE_APPROVAL'])).toBe('REQUIRE_APPROVAL');
    expect(mostRestrictive(['REQUIRE_APPROVAL', 'ESCALATE'])).toBe('ESCALATE');
    expect(mostRestrictive(['ESCALATE', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(mostRestrictive(['UNKNOWN', 'DENY'])).toBe('DENY');
  });

  it('treats an empty set of results as UNKNOWN', () => {
    // "Nothing objected" is not "everything agreed".
    expect(mostRestrictive([])).toBe('UNKNOWN');
  });
});

describe('pattern matching', () => {
  it('matches a namespace prefix', () => {
    expect(operationMatches('a.*', 'a.b.c')).toBe(true);
    expect(operationMatches('*', 'anything')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    // The trap this exists to avoid: `finance.*` matching `financeadmin.pay`.
    expect(operationMatches('finance.*', 'financeadmin.transfer')).toBe(false);
    expect(operationMatches('a.*', 'a')).toBe(false);
  });

  it('treats an exact pattern as exact', () => {
    expect(operationMatches('a.b', 'a.b')).toBe(true);
    expect(operationMatches('a.b', 'a.bc')).toBe(false);
  });
});

describe('compilation', () => {
  it('refuses duplicate rule ids', () => {
    const rule = {
      id: 'same',
      operations: ['x.*'],
      outcome: 'DENY' as const,
    };
    expect(() => compileAutonomyPolicy({ key: 'k', name: 'n', rules: [rule, rule] })).toThrow(
      /Duplicate/,
    );
  });

  it('will not accept a fallback that permits', () => {
    // A policy whose unanticipated case is automatically allowed is the exact
    // failure this design exists to prevent, so it is not expressible.
    expect(() =>
      compileAutonomyPolicy({ key: 'k', name: 'n', fallback: 'PERMIT', rules: [] }),
    ).toThrow();
  });

  it('hashes over meaning, not formatting', () => {
    const a = compileAutonomyPolicy({ key: 'k', name: 'n', rules: [] });
    const b = compileAutonomyPolicy({ key: 'k', name: 'n', description: '', rules: [] });
    expect(a.hash).toBe(b.hash);
    const c = compileAutonomyPolicy({ key: 'k', name: 'n', fallback: 'DENY', rules: [] });
    expect(c.hash).not.toBe(a.hash);
  });
});

describe('evaluation', () => {
  it('permits when every condition holds', () => {
    expect(evaluateAutonomy(minimal, ask()).outcome).toBe('PERMIT');
  });

  it('is UNKNOWN when the process is not registered', () => {
    expect(evaluateAutonomy(minimal, ask({ processMaturity: null })).outcome).toBe('UNKNOWN');
  });

  it('is UNKNOWN when no rule covers the operation', () => {
    expect(evaluateAutonomy(minimal, ask({ operation: 'other.do' })).outcome).toBe('UNKNOWN');
  });

  it('distinguishes an absent fact from a false one', () => {
    // The distinction the whole model rests on.
    expect(evaluateAutonomy(minimal, ask({ facts: {} })).outcome).toBe('UNKNOWN');
    expect(evaluateAutonomy(minimal, ask({ facts: { ready: false } })).outcome).toBe('DENY');
  });

  it('will not permit above the rule’s own risk ceiling', () => {
    expect(
      mayProceedUnattended(evaluateAutonomy(minimal, ask({ riskClass: 'IRREVERSIBLE' })).outcome),
    ).toBe(false);
  });

  it('will not permit below the rule’s maturity requirement', () => {
    expect(evaluateAutonomy(minimal, ask({ processMaturity: 1 })).outcome).toBe('REQUIRE_APPROVAL');
  });

  it('is deterministic', () => {
    const question = ask();
    expect(evaluateAutonomy(minimal, question)).toEqual(evaluateAutonomy(minimal, question));
  });

  it('records every check, so a decision can be shown rather than asserted', () => {
    const decision = evaluateAutonomy(minimal, ask({ facts: {} }));
    expect(decision.evaluation.length).toBeGreaterThan(0);
    expect(decision.evaluation.every((check) => check.detail.length > 0)).toBe(true);
  });
});
