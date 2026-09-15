import { describe, expect, it } from 'vitest';
import {
  agedSeverity,
  rankOf,
  summariseQueue,
  EXCEPTION_KINDS,
  EXCEPTION_KINDS_BY_KEY,
  RESPONSE_TYPES,
  type PortfolioException,
} from './exception.js';
import { COVERAGE_STAGES, stageRank } from './coverage.js';

/**
 * The queue's ordering rules.
 *
 * An operator who cannot predict the order stops trusting it and reads the
 * whole list anyway, at which point the queue has failed at its only job. So
 * the ranking is deterministic, explainable, and tested here rather than tuned
 * by feel.
 */

function exception(overrides: Partial<PortfolioException> = {}): PortfolioException {
  return {
    key: 'K:1',
    kind: 'APPROVAL_REQUIRED',
    severity: 'HIGH',
    organisationId: 'org-1',
    organisationName: 'Org One',
    controlId: null,
    controlKey: null,
    controlTitle: null,
    truthState: null,
    unknownReason: null,
    cause: 'something',
    recommendedAction: 'do something',
    response: 'DECIDE',
    assuranceMaintained: true,
    automatable: false,
    approvalRequired: false,
    actionId: null,
    actionState: null,
    verificationOutcome: null,
    since: '2026-09-10T00:00:00.000Z',
    ageHours: 24,
    evidenceAgeHours: null,
    provenance: {},
    rank: 0,
    ...overrides,
  };
}

describe('every kind is fully defined', () => {
  it('gives each kind a response, a severity and a reason a person is needed', () => {
    for (const kind of EXCEPTION_KINDS) {
      const definition = EXCEPTION_KINDS_BY_KEY[kind];
      expect(definition, kind).toBeDefined();
      expect(RESPONSE_TYPES).toContain(definition.response);
      expect(definition.whyHuman.length, kind).toBeGreaterThan(20);
      expect(definition.summary.length, kind).toBeGreaterThan(10);
    }
  });

  it('knows which kinds mean Adericel has stopped seeing the truth', () => {
    // The ranking depends entirely on this being right, so it is asserted
    // directly rather than inferred from the ranking.
    const blind = EXCEPTION_KINDS.filter(
      (kind) => !EXCEPTION_KINDS_BY_KEY[kind].assuranceMaintained,
    );
    expect(blind).toContain('VERIFICATION_FAILED');
    expect(blind).toContain('CONNECTOR_AUTHENTICATION');
    expect(blind).toContain('EVIDENCE_CONFLICT');
    // An approval is waiting on a person and the picture is intact.
    expect(blind).not.toContain('APPROVAL_REQUIRED');
  });
});

describe('ranking', () => {
  it('puts a customer nobody can see above any severity of anything else', () => {
    const blind = rankOf({ severity: 'LOW', assuranceMaintained: false, ageHours: 0 });
    const critical = rankOf({ severity: 'CRITICAL', assuranceMaintained: true, ageHours: 24 * 14 });
    // A customer who has silently stopped being observed is the worst outcome
    // in this product and the least visible. Nothing outranks it.
    expect(blind).toBeGreaterThan(critical);
  });

  it('never lets age promote an item across a severity band', () => {
    const oldMedium = rankOf({ severity: 'MEDIUM', assuranceMaintained: true, ageHours: 24 * 365 });
    const freshHigh = rankOf({ severity: 'HIGH', assuranceMaintained: true, ageHours: 0 });
    // Otherwise a fortnight-old cosmetic item outranks a broken connector.
    expect(freshHigh).toBeGreaterThan(oldMedium);
  });

  it('floats a forgotten item above an identical newer one', () => {
    const older = rankOf({ severity: 'HIGH', assuranceMaintained: true, ageHours: 200 });
    const newer = rankOf({ severity: 'HIGH', assuranceMaintained: true, ageHours: 1 });
    expect(older).toBeGreaterThan(newer);
  });

  it('is deterministic', () => {
    const input = { severity: 'HIGH', assuranceMaintained: true, ageHours: 73.4 } as const;
    expect(rankOf(input)).toBe(rankOf(input));
  });
});

describe('ageing severity', () => {
  it('escalates a neglected item exactly one step, once', () => {
    expect(agedSeverity('LOW', 24 * 8)).toBe('MEDIUM');
    expect(agedSeverity('MEDIUM', 24 * 8)).toBe('HIGH');
    // Never to CRITICAL: neglect must not be able to manufacture urgency.
    expect(agedSeverity('HIGH', 24 * 365)).toBe('HIGH');
    expect(agedSeverity('CRITICAL', 24 * 365)).toBe('CRITICAL');
  });

  it('leaves a fresh item alone', () => {
    expect(agedSeverity('LOW', 1)).toBe('LOW');
  });
});

describe('summarising the queue', () => {
  it('counts customers rather than exceptions where that is the useful number', () => {
    const summary = summariseQueue([
      exception({ organisationId: 'a', kind: 'COVERAGE_GAP', assuranceMaintained: false }),
      exception({ organisationId: 'a', kind: 'APPROVAL_REQUIRED' }),
      exception({ organisationId: 'b', kind: 'APPROVAL_REQUIRED' }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.organisationsAffected).toBe(2);
    // One customer, however many of their things are broken.
    expect(summary.organisationsNotMaintained).toBe(1);
  });

  it('reports an empty queue as empty rather than as an error', () => {
    const summary = summariseQueue([]);
    expect(summary.total).toBe(0);
    expect(summary.organisationsAffected).toBe(0);
  });
});

describe('the coverage ladder', () => {
  it('is ordered from nothing to fully covered', () => {
    expect(COVERAGE_STAGES[0]).toBe('NOT_CONNECTED');
    expect(COVERAGE_STAGES[COVERAGE_STAGES.length - 1]).toBe('ASSURANCE_COVERED');
    for (let i = 1; i < COVERAGE_STAGES.length; i += 1) {
      expect(stageRank(COVERAGE_STAGES[i]!)).toBeGreaterThan(stageRank(COVERAGE_STAGES[i - 1]!));
    }
  });

  it('puts authentication below authorisation below coverage', () => {
    // The distinction the whole ladder exists for: a connector can be
    // authenticated, healthy and supplying nothing the controls need.
    expect(stageRank('AUTHENTICATED')).toBeLessThan(stageRank('AUTHORISED'));
    expect(stageRank('AUTHORISED')).toBeLessThan(stageRank('ASSURANCE_COVERED'));
    expect(stageRank('PREDICATES_OBSERVED')).toBeLessThan(stageRank('ASSURANCE_COVERED'));
  });
});
