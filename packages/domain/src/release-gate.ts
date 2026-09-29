import { z } from 'zod';

/**
 * The standard release and capability gate.
 *
 * Contract v3.2, "A feature is not complete because code exists": ten
 * conditions, all of which must hold before something is complete. They are
 * modelled here rather than kept in a checklist because a checklist is
 * satisfied by being read.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not compute a score, and it does not have a notion of "mostly
 * releasable". Nine conditions out of ten is not ninety per cent complete; it
 * is incomplete with one named reason. `gateVerdict()` returns BLOCKED with
 * that reason, and the reason is the useful output.
 *
 * WHY AN UNEVIDENCED CONDITION IS NOT_MET
 *
 * The tempting default is "we have no evidence either way, so treat it as
 * fine". That default is how a gate becomes a formality: the conditions nobody
 * can easily measure quietly pass, and those are exactly the conditions worth
 * measuring — privacy implications, failure modes, unsupported claims. So an
 * absent assessment is NOT_MET, and saying "not applicable" requires a reason
 * on the record.
 */

export const COMPLETION_CONDITIONS = [
  'ARCHITECTURE_COHERENT',
  'SECURITY_BOUNDARIES_TESTED',
  'PRIVACY_IMPLICATIONS_ADDRESSED',
  'FAILURE_MODES_EXPLICIT',
  'AUDITABILITY_EXISTS_WHERE_REQUIRED',
  'DOCUMENTATION_MATCHES_IMPLEMENTATION',
  'TESTS_PASS',
  'RECOVERY_IMPLICATIONS_UNDERSTOOD',
  'OPERATIONAL_BEHAVIOUR_OBSERVABLE',
  'NO_UNSUPPORTED_CLAIMS_INTRODUCED',
] as const;
export type CompletionCondition = (typeof COMPLETION_CONDITIONS)[number];
export const completionConditionSchema = z.enum(COMPLETION_CONDITIONS);

export interface ConditionDefinition {
  /** The contract's own words, so the gate cannot drift from what it cites. */
  readonly statement: string;
  /** What, in this repository, would establish it. */
  readonly establishedBy: string;
  /**
   * Whether a pipeline can establish it on its own.
   *
   * Four of the ten cannot be, and pretending otherwise is how a gate gets
   * automated into meaninglessness: a green build would then assert that
   * privacy implications had been addressed.
   */
  readonly automatable: boolean;
}

export const CONDITIONS: Readonly<Record<CompletionCondition, ConditionDefinition>> = {
  ARCHITECTURE_COHERENT: {
    statement: 'architecture is coherent',
    establishedBy:
      'The dependency-direction and engine-purity tests, plus an ADR for any material ' +
      'decision. Coherence is a judgement, and the tests bound it rather than make it.',
    automatable: false,
  },
  SECURITY_BOUNDARIES_TESTED: {
    statement: 'security boundaries are tested',
    establishedBy:
      'tests/security and tests/tenancy passing, and each invariant proved by deliberately ' +
      'breaking it — v3.2 requires the boundaries to be tested, not documented.',
    automatable: true,
  },
  PRIVACY_IMPLICATIONS_ADDRESSED: {
    statement: 'privacy implications are addressed',
    establishedBy:
      'A named person confirming the change against the personal-data model, retention and ' +
      'the processor/controller boundary. No pipeline can establish this.',
    automatable: false,
  },
  FAILURE_MODES_EXPLICIT: {
    statement: 'failure modes are explicit',
    establishedBy:
      'Each new path states what happens when it fails, and refuses rather than degrading ' +
      'silently. Reviewed by a person against the diff.',
    automatable: false,
  },
  AUDITABILITY_EXISTS_WHERE_REQUIRED: {
    statement: 'auditability exists where required',
    establishedBy:
      'Consequential actions write to the append-only audit log, and the append-only ' +
      'property is enforced by database trigger rather than by convention.',
    automatable: true,
  },
  DOCUMENTATION_MATCHES_IMPLEMENTATION: {
    statement: 'documentation matches implementation',
    establishedBy:
      'The generated-document drift checks, the capability register path check, and the ' +
      'documentation tests that refuse a compliance claim the repository cannot support.',
    automatable: true,
  },
  TESTS_PASS: {
    statement: 'tests pass',
    establishedBy: 'The full suite, run against a real database rather than mocks.',
    automatable: true,
  },
  RECOVERY_IMPLICATIONS_UNDERSTOOD: {
    statement: 'recovery implications are understood',
    establishedBy:
      'Every migration reversed and reapplied, and a restore performed from a real dump. ' +
      'v3.2: backup existence alone is insufficient.',
    automatable: true,
  },
  OPERATIONAL_BEHAVIOUR_OBSERVABLE: {
    statement: 'operational behaviour is observable',
    establishedBy:
      'Health and readiness endpoints, structured logs that carry a correlation id, and no ' +
      'path that fails without saying so.',
    automatable: true,
  },
  NO_UNSUPPORTED_CLAIMS_INTRODUCED: {
    statement: 'no unsupported claims are introduced',
    establishedBy:
      'A person reading the diff for claims, backed by the documentation tests and the ' +
      'capability register. The most easily skipped condition and the most damaging to skip.',
    automatable: false,
  },
};

/**
 * What no change may weaken, whatever else it achieves.
 *
 * Contract v3.2: "When requirements conflict, preserve authoritative truth and
 * legal defensibility over convenience." Separate from the ten conditions
 * because these are not things a release establishes — they are things a
 * release must not cost.
 */
export const NON_REGRESSION_INVARIANTS = [
  'TRUTH_INTEGRITY',
  'EVIDENCE_INTEGRITY',
  'TENANT_ISOLATION',
  'SECURITY',
  'PRIVACY',
  'AUDITABILITY',
  'VERIFICATION',
  'LEGAL_DEFENSIBILITY',
] as const;
export type NonRegressionInvariant = (typeof NON_REGRESSION_INVARIANTS)[number];

/**
 * How documentation must label a capability.
 *
 * Contract v3.2: "Documentation must distinguish: implemented; tested; planned;
 * assumed; externally dependent; legally pending. Never present a target as an
 * implemented capability."
 */
export const DOCUMENTATION_STATES = [
  'IMPLEMENTED',
  'TESTED',
  'PLANNED',
  'ASSUMED',
  'EXTERNALLY_DEPENDENT',
  'LEGALLY_PENDING',
] as const;
export type DocumentationState = (typeof DOCUMENTATION_STATES)[number];

/** Documentation states that must never be presented as a working capability. */
export const NOT_YET_CAPABILITY_STATES: readonly DocumentationState[] = [
  'PLANNED',
  'ASSUMED',
  'EXTERNALLY_DEPENDENT',
  'LEGALLY_PENDING',
];

export const CONDITION_OUTCOMES = ['MET', 'NOT_MET', 'NOT_APPLICABLE'] as const;
export type ConditionOutcome = (typeof CONDITION_OUTCOMES)[number];

export interface ConditionAssessment {
  readonly condition: CompletionCondition;
  readonly outcome: ConditionOutcome;
  /** What was actually run, read or signed. Never a restatement of the outcome. */
  readonly evidence: string;
  /** Required when the outcome is NOT_APPLICABLE. */
  readonly whyNotApplicable?: string;
  /** Who or what established it. */
  readonly establishedBy: 'AUTOMATED_CHECK' | 'NAMED_PERSON';
}

export interface ReleaseRecord {
  readonly version: string;
  readonly commit: string;
  readonly at: string;
  readonly assessments: readonly ConditionAssessment[];
  /** Each invariant, affirmed with what shows it was not weakened. */
  readonly invariantsAffirmed: Readonly<Partial<Record<NonRegressionInvariant, string>>>;
}

export interface GateVerdict {
  readonly releasable: boolean;
  /** Every reason it is not, in the order the conditions are defined. */
  readonly blockedBy: readonly string[];
  /** Conditions with no assessment at all, named separately from failures. */
  readonly unassessed: readonly CompletionCondition[];
  readonly statement: string;
}

export function gateVerdict(record: ReleaseRecord): GateVerdict {
  const byCondition = new Map(record.assessments.map((a) => [a.condition, a]));
  const blockedBy: string[] = [];
  const unassessed: CompletionCondition[] = [];

  for (const condition of COMPLETION_CONDITIONS) {
    const assessment = byCondition.get(condition);
    const definition = CONDITIONS[condition];

    if (!assessment) {
      unassessed.push(condition);
      blockedBy.push(
        `${condition} was not assessed. An absent assessment is not a pass: "${definition.statement}" ` +
          'is one of the conditions most easily left unmeasured.',
      );
      continue;
    }

    if (assessment.outcome === 'NOT_MET') {
      blockedBy.push(`${condition} is not met — ${assessment.evidence}`);
      continue;
    }

    if (assessment.outcome === 'NOT_APPLICABLE') {
      if (
        typeof assessment.whyNotApplicable !== 'string' ||
        assessment.whyNotApplicable.trim().length < 12
      ) {
        blockedBy.push(
          `${condition} is recorded NOT_APPLICABLE without a reason. "Not applicable" with no ` +
            'reason is the cheapest way to pass a gate.',
        );
      }
      continue;
    }

    /**
     * A condition a pipeline cannot establish, claimed by a pipeline.
     *
     * This is the check that keeps the gate meaningful under pressure. Four of
     * the ten need a person, and a build that asserted them would turn the
     * whole gate into a restatement of "the tests passed".
     */
    if (!definition.automatable && assessment.establishedBy === 'AUTOMATED_CHECK') {
      blockedBy.push(
        `${condition} was claimed by an automated check, and "${definition.statement}" cannot ` +
          'be established by one. It needs a named person.',
      );
      continue;
    }

    /**
     * A malformed assessment blocks; it does not throw.
     *
     * The first version read `assessment.evidence.trim()` directly and crashed
     * on an assessment whose evidence was undefined — which a caller can
     * produce despite the type, because a record may be read from JSON or built
     * by a script with a bug. A gate that throws cannot report, and "the gate
     * errored" is indistinguishable from "the gate was never run".
     */
    if (typeof assessment.evidence !== 'string' || assessment.evidence.trim().length < 12) {
      blockedBy.push(
        `${condition} is recorded ${assessment.outcome} with no usable evidence. An assessment ` +
          'with nothing behind it is not an assessment.',
      );
    }
  }

  for (const invariant of NON_REGRESSION_INVARIANTS) {
    const affirmation = record.invariantsAffirmed[invariant];
    if (!affirmation || affirmation.trim().length < 12) {
      blockedBy.push(
        `${invariant} is not affirmed. No change may weaken it, and silence is not an ` +
          'affirmation that it was not weakened.',
      );
    }
  }

  return {
    releasable: blockedBy.length === 0,
    blockedBy,
    unassessed,
    statement:
      blockedBy.length === 0
        ? `${record.version} meets all ten completion conditions and affirms every ` +
          'non-regression invariant.'
        : `${record.version} is not releasable. ${blockedBy.length} condition(s) or ` +
          `invariant(s) block it${unassessed.length > 0 ? `, ${unassessed.length} of them never assessed` : ''}.`,
  };
}
