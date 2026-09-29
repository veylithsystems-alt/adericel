import { describe, expect, it } from 'vitest';
import {
  COMPLETION_CONDITIONS,
  CONDITIONS,
  DOCUMENTATION_STATES,
  NON_REGRESSION_INVARIANTS,
  NOT_YET_CAPABILITY_STATES,
  gateVerdict,
  type ConditionAssessment,
  type NonRegressionInvariant,
  type ReleaseRecord,
} from './release-gate.js';

/**
 * The standard release and capability gate.
 *
 * Contract v3.2, "A feature is not complete because code exists". The property
 * running through this file: **every way of not knowing blocks the gate.** A
 * gate that treats silence as a pass is a formality, and the conditions it
 * would wave through are the four nobody can measure automatically — which are
 * the four that matter most.
 */

function met(
  condition: (typeof COMPLETION_CONDITIONS)[number],
  overrides: Partial<ConditionAssessment> = {},
): ConditionAssessment {
  return {
    condition,
    outcome: 'MET',
    evidence: 'The named suite was run against a real database and passed in full',
    establishedBy: CONDITIONS[condition].automatable ? 'AUTOMATED_CHECK' : 'NAMED_PERSON',
    ...overrides,
  };
}

function affirmAll(): Record<NonRegressionInvariant, string> {
  return Object.fromEntries(
    NON_REGRESSION_INVARIANTS.map((invariant) => [
      invariant,
      `Unchanged by this release; checked against the ${invariant.toLowerCase()} suite`,
    ]),
  ) as Record<NonRegressionInvariant, string>;
}

function record(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    version: 'v0.1.0',
    commit: 'abc1234',
    at: '2026-09-29T00:00:00.000Z',
    assessments: COMPLETION_CONDITIONS.map((condition) => met(condition)),
    invariantsAffirmed: affirmAll(),
    ...overrides,
  };
}

describe('the ten completion conditions', () => {
  it('names exactly the ten the contract names, in its order', () => {
    expect(COMPLETION_CONDITIONS).toHaveLength(10);
    expect(COMPLETION_CONDITIONS.map((c) => CONDITIONS[c].statement)).toEqual([
      'architecture is coherent',
      'security boundaries are tested',
      'privacy implications are addressed',
      'failure modes are explicit',
      'auditability exists where required',
      'documentation matches implementation',
      'tests pass',
      'recovery implications are understood',
      'operational behaviour is observable',
      'no unsupported claims are introduced',
    ]);
  });

  it('gives every condition something that would establish it', () => {
    for (const condition of COMPLETION_CONDITIONS) {
      expect(CONDITIONS[condition].establishedBy.length, condition).toBeGreaterThan(30);
    }
  });

  it('keeps four conditions out of reach of any pipeline', () => {
    /**
     * If all ten were automatable the gate would collapse into "the tests
     * passed", which is condition seven restated nine times. These four need a
     * person because each is a judgement about the change rather than a
     * property of the code.
     */
    const manual = COMPLETION_CONDITIONS.filter((c) => !CONDITIONS[c].automatable);
    expect([...manual]).toEqual([
      'ARCHITECTURE_COHERENT',
      'PRIVACY_IMPLICATIONS_ADDRESSED',
      'FAILURE_MODES_EXPLICIT',
      'NO_UNSUPPORTED_CLAIMS_INTRODUCED',
    ]);
  });
});

describe('what blocks a release', () => {
  it('passes a record that assesses all ten and affirms all eight', () => {
    const verdict = gateVerdict(record());
    expect(verdict.blockedBy).toEqual([]);
    expect(verdict.releasable).toBe(true);
    expect(verdict.unassessed).toEqual([]);
  });

  it('treats an unassessed condition as blocking, not as a pass', () => {
    /**
     * The defect this model exists to prevent.
     *
     * "No evidence either way, so treat it as fine" is how the hard-to-measure
     * conditions quietly pass — and those are privacy implications, failure
     * modes and unsupported claims.
     */
    const verdict = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.filter(
          (c) => c !== 'PRIVACY_IMPLICATIONS_ADDRESSED',
        ).map((c) => met(c)),
      }),
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict.unassessed).toEqual(['PRIVACY_IMPLICATIONS_ADDRESSED']);
    expect(verdict.blockedBy.join(' ')).toMatch(/An absent assessment is not a pass/);
    expect(verdict.statement).toMatch(/1 of them never assessed/);
  });

  it('refuses a pipeline that claims a condition needing a person', () => {
    // A build asserting that privacy implications were addressed is the
    // cheapest way to automate a gate into meaninglessness.
    const verdict = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.map((c) =>
          c === 'PRIVACY_IMPLICATIONS_ADDRESSED'
            ? met(c, { establishedBy: 'AUTOMATED_CHECK' })
            : met(c),
        ),
      }),
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict.blockedBy.join(' ')).toMatch(/cannot be established by one.*named person/s);
  });

  it('refuses NOT_APPLICABLE without a reason, and accepts it with one', () => {
    const without = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.map((c) =>
          c === 'RECOVERY_IMPLICATIONS_UNDERSTOOD' ? met(c, { outcome: 'NOT_APPLICABLE' }) : met(c),
        ),
      }),
    );
    expect(without.blockedBy.join(' ')).toMatch(/cheapest way to pass a gate/);

    const with_ = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.map((c) =>
          c === 'RECOVERY_IMPLICATIONS_UNDERSTOOD'
            ? met(c, {
                outcome: 'NOT_APPLICABLE',
                whyNotApplicable: 'This release touches no migration and no stored data shape',
              })
            : met(c),
        ),
      }),
    );
    expect(with_.releasable).toBe(true);
  });

  it('refuses a MET condition with no usable evidence', () => {
    const verdict = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.map((c) =>
          c === 'TESTS_PASS' ? met(c, { evidence: 'green' }) : met(c),
        ),
      }),
    );
    expect(verdict.blockedBy.join(' ')).toMatch(/MET with no usable evidence/);
  });

  it('blocks on every unaffirmed invariant, one reason each', () => {
    // Silence is not an affirmation that an invariant was not weakened, and the
    // contract is explicit that no change may weaken any of the eight.
    const verdict = gateVerdict(record({ invariantsAffirmed: {} }));
    expect(verdict.releasable).toBe(false);
    expect(verdict.blockedBy).toHaveLength(NON_REGRESSION_INVARIANTS.length);
    for (const invariant of NON_REGRESSION_INVARIANTS) {
      expect(verdict.blockedBy.join(' '), invariant).toContain(invariant);
    }
  });

  it('gives no partial credit and computes no score', () => {
    /**
     * Nine of ten is not ninety per cent complete. It is incomplete with one
     * named reason, and the reason is the useful output — a score would let
     * somebody ship on "close enough".
     */
    const verdict = gateVerdict(
      record({ assessments: [met('TESTS_PASS'), met('SECURITY_BOUNDARIES_TESTED')] }),
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict).not.toHaveProperty('score');
    expect(verdict.unassessed).toHaveLength(8);
  });

  it('blocks on a malformed assessment rather than throwing', () => {
    /**
     * Found by running the position script, which built an assessment with
     * undefined evidence through a bug of its own. The gate crashed.
     *
     * A gate that throws cannot report, and "the gate errored" is
     * indistinguishable from "the gate was never run" — so a record this
     * malformed has to come back as blocked, with the condition named.
     */
    const verdict = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.map((c) =>
          c === 'TESTS_PASS'
            ? ({ ...met(c), evidence: undefined } as unknown as ConditionAssessment)
            : met(c),
        ),
      }),
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict.blockedBy.join(' ')).toMatch(/TESTS_PASS is recorded MET with no usable/);
  });

  it('blocks on a NOT_APPLICABLE whose reason is missing rather than throwing', () => {
    const verdict = gateVerdict(
      record({
        assessments: COMPLETION_CONDITIONS.map((c) =>
          c === 'RECOVERY_IMPLICATIONS_UNDERSTOOD'
            ? ({
                ...met(c),
                outcome: 'NOT_APPLICABLE',
                whyNotApplicable: undefined,
              } as unknown as ConditionAssessment)
            : met(c),
        ),
      }),
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict.blockedBy.join(' ')).toMatch(/without a reason/);
  });

  it('reports every blocker at once rather than the first', () => {
    // A gate that surfaces one problem per run takes as many runs to clear as
    // it has problems, which is how a gate stops being run.
    const verdict = gateVerdict(record({ assessments: [], invariantsAffirmed: {} }));
    expect(verdict.blockedBy).toHaveLength(
      COMPLETION_CONDITIONS.length + NON_REGRESSION_INVARIANTS.length,
    );
  });
});

describe('how documentation must label a capability', () => {
  it('carries the six states the contract names', () => {
    expect([...DOCUMENTATION_STATES]).toEqual([
      'IMPLEMENTED',
      'TESTED',
      'PLANNED',
      'ASSUMED',
      'EXTERNALLY_DEPENDENT',
      'LEGALLY_PENDING',
    ]);
  });

  it('never lets a target be presented as a working capability', () => {
    // "Never present a target as an implemented capability" — so the four
    // states that are not yet a capability are named, and IMPLEMENTED and
    // TESTED are deliberately not among them.
    expect([...NOT_YET_CAPABILITY_STATES]).toEqual([
      'PLANNED',
      'ASSUMED',
      'EXTERNALLY_DEPENDENT',
      'LEGALLY_PENDING',
    ]);
    expect(NOT_YET_CAPABILITY_STATES).not.toContain('IMPLEMENTED');
    expect(NOT_YET_CAPABILITY_STATES).not.toContain('TESTED');
  });
});
