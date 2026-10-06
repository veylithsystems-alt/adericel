/**
 * The mutation registry.
 *
 * Every invariant in Adericel that is claimed to be "proved by deliberately
 * breaking it" is recorded here, as the exact edit that breaks it and the exact
 * test that must then fail.
 *
 * WHY THIS FILE EXISTS
 *
 * The mutations were performed by hand and recorded in commit messages. That
 * proves the guard worked on the day it was written and nothing more. A test
 * that would still pass with its guard removed is a test that proves nothing,
 * and the way a suite arrives at that state is gradually: a refactor widens a
 * condition, a type changes, somebody replaces an assertion with a weaker one
 * that still passes. Nothing fails, so nobody looks.
 *
 * `pnpm test:mutation` applies each edit, runs only the suite that should care,
 * and asserts the named tests fail. A mutation that no longer kills its test is
 * reported as SURVIVED, which means the guard has rotted — not that the
 * mutation is wrong.
 *
 * HOW TO ADD ONE
 *
 * Perform the mutation by hand first and watch the test fail, exactly as
 * before. Then record it here so it cannot stop failing quietly. `find` must
 * match the file **once**: the runner refuses an ambiguous or absent match
 * rather than silently patching the wrong line, because a mutation applied
 * somewhere unintended would report a survival that means nothing.
 */

export interface Mutation {
  /** Stable id, so a report can be compared between runs. */
  readonly id: string;
  /** What invariant this is testing, in one line. */
  readonly invariant: string;
  /** Repository-relative source file. */
  readonly file: string;
  /** Text to replace. Must occur exactly once. */
  readonly find: string;
  /** What to replace it with: the defect a careless change would introduce. */
  readonly replace: string;
  /** The suite to run. Narrow, so the run stays fast. */
  readonly suite: string;
  /**
   * Test names that must fail once the mutation is applied.
   *
   * Named individually rather than counted. "Some test failed" would be
   * satisfied by a compile error, which proves nothing about the guard.
   */
  readonly mustFail: readonly string[];
  /** True when the suite needs PostgreSQL, so it can be skipped without one. */
  readonly needsDatabase?: boolean;
}

export const MUTATIONS: readonly Mutation[] = [
  // ---------------------------------------------------------------------------
  // UNKNOWN must never present as a pass.
  // ---------------------------------------------------------------------------
  {
    id: 'headline-not-applicable-proven',
    invariant: 'A control scoped out must not present outwardly as PROVEN.',
    file: 'packages/domain/src/assurance.ts',
    find: "  NOT_APPLICABLE: 'UNKNOWN',",
    replace: "  NOT_APPLICABLE: 'PROVEN',",
    suite: 'packages/domain/src/headline-state.test.ts',
    mustFail: [
      'presents nothing as PROVEN but a satisfied control',
      'does not let a scope decision become a compliance claim',
      'keeps NEVER_PROVEN_STATES consistent with the map it documents',
    ],
  },
  {
    id: 'headline-degraded-proven',
    invariant: 'A broken collection path must not present outwardly as PROVEN.',
    file: 'packages/domain/src/assurance.ts',
    find: "  DEGRADED: 'UNKNOWN',",
    replace: "  DEGRADED: 'PROVEN',",
    suite: 'packages/domain/src/headline-state.test.ts',
    mustFail: [
      'shows every indeterminate state as UNKNOWN rather than as an outcome',
      'presents nothing as PROVEN but a satisfied control',
    ],
  },
  {
    id: 'headline-partial-proven',
    invariant: 'A partially satisfied control must not present outwardly as PROVEN.',
    file: 'packages/domain/src/assurance.ts',
    find: "  PARTIALLY_SATISFIED: 'UNKNOWN',",
    replace: "  PARTIALLY_SATISFIED: 'PROVEN',",
    suite: 'packages/domain/src/headline-state.test.ts',
    mustFail: ['presents nothing as PROVEN but a satisfied control'],
  },

  // ---------------------------------------------------------------------------
  // The release gate must not become a formality.
  // ---------------------------------------------------------------------------
  {
    id: 'gate-silence-passes',
    invariant: 'An unassessed completion condition blocks a release; silence is not a pass.',
    file: 'packages/domain/src/release-gate.ts',
    find: `    if (!assessment) {
      unassessed.push(condition);`,
    replace: `    if (!assessment) {
      if (true) continue;
      unassessed.push(condition);`,
    suite: 'packages/domain/src/release-gate.test.ts',
    mustFail: [
      'treats an unassessed condition as blocking, not as a pass',
      'reports every blocker at once rather than the first',
    ],
  },
  {
    id: 'gate-pipeline-signs-for-a-person',
    invariant: 'A pipeline may not establish a condition that needs a named person.',
    file: 'packages/domain/src/release-gate.ts',
    find: "    if (!definition.automatable && assessment.establishedBy === 'AUTOMATED_CHECK') {",
    replace: "    if (false && assessment.establishedBy === 'AUTOMATED_CHECK') {",
    suite: 'packages/domain/src/release-gate.test.ts',
    mustFail: ['refuses a pipeline that claims a condition needing a person'],
  },
  {
    id: 'gate-invariants-unchecked',
    invariant: 'An unaffirmed non-regression invariant blocks a release.',
    file: 'packages/domain/src/release-gate.ts',
    find: '  for (const invariant of NON_REGRESSION_INVARIANTS) {',
    replace: '  for (const invariant of [] as readonly NonRegressionInvariant[]) {',
    suite: 'packages/domain/src/release-gate.test.ts',
    mustFail: [
      'blocks on every unaffirmed invariant, one reason each',
      'reports every blocker at once rather than the first',
    ],
  },

  // ---------------------------------------------------------------------------
  // Capability status must never be inferred.
  // ---------------------------------------------------------------------------
  {
    id: 'capability-backfills-skipped',
    invariant: 'A skipped capability status is reported, not filled in.',
    file: 'packages/domain/src/capability.ts',
    find: `  const skipped = CAPABILITY_STATUSES.filter(
    (status) =>
      status !== 'RETIRED' && order(status) < order(attested) && !attestedStatuses.has(status),
  );`,
    replace: '  const skipped: CapabilityStatus[] = [];',
    suite: 'packages/domain/src/capability.test.ts',
    mustFail: ['reports the statuses below the attested one that nobody attested'],
  },
  {
    id: 'capability-pipeline-proves',
    invariant: 'PROVEN, PRODUCTION_READY and COMMERCIAL_VALIDATED need a person.',
    file: 'packages/domain/src/capability.ts',
    find: `export const HUMAN_ESTABLISHED_STATUSES: readonly CapabilityStatus[] = [
  'PROVEN',
  'PRODUCTION_READY',
  'COMMERCIAL_VALIDATED',
];`,
    replace: 'export const HUMAN_ESTABLISHED_STATUSES: readonly CapabilityStatus[] = [];',
    suite: 'packages/domain/src/capability.test.ts',
    mustFail: [
      'refuses an automated attestation of every human-established status',
      'reports every problem across a register in one pass',
    ],
  },

  // ---------------------------------------------------------------------------
  // A crosswalk relates requirements; it never determines anything.
  // ---------------------------------------------------------------------------
  {
    id: 'crosswalk-determines-state',
    invariant: 'A crosswalk never establishes an assurance state, EQUIVALENT included.',
    file: 'packages/crosswalk/src/coverage.ts',
    find: `  return {
    state: 'UNKNOWN',`,
    replace: `  return {
    state: _crosswalks.some((c) => c.relation === 'EQUIVALENT') ? 'SATISFIED' : 'UNKNOWN',`,
    suite: 'packages/crosswalk/src/crosswalk.test.ts',
    mustFail: ['returns UNKNOWN whatever the crosswalks say, including EQUIVALENT'],
  },
  {
    id: 'crosswalk-symmetric',
    invariant: 'A directed crosswalk cannot be read in reverse.',
    file: 'packages/crosswalk/src/relation.ts',
    find: `export const SYMMETRIC_RELATIONS: readonly CrosswalkRelation[] = [
  'EQUIVALENT',
  'CONFLICTS',
  'UNRELATED',
];`,
    replace:
      'export const SYMMETRIC_RELATIONS: readonly CrosswalkRelation[] = [...CROSSWALK_RELATIONS];',
    suite: 'packages/crosswalk/src/crosswalk.test.ts',
    mustFail: [
      'treats only genuinely symmetric relations as readable in reverse',
      'refuses to flip a directed crosswalk',
    ],
  },
  {
    id: 'crosswalk-unconfirmed-ai-acts',
    invariant: 'A model-proposed crosswalk may not inform coverage until a person confirms it.',
    file: 'packages/crosswalk/src/crosswalk.ts',
    find: "export const UNCONFIRMED_PROVENANCE: readonly CrosswalkProvenance[] = ['AI_SUGGESTED'];",
    replace: 'export const UNCONFIRMED_PROVENANCE: readonly CrosswalkProvenance[] = [];',
    suite: 'packages/crosswalk/src/crosswalk.test.ts',
    mustFail: ['refuses to use an unconfirmed AI-suggested crosswalk'],
  },

  // ---------------------------------------------------------------------------
  // An unknown must be routed to somebody who can actually act.
  // ---------------------------------------------------------------------------
  {
    id: 'resolution-consent-to-msp',
    invariant: 'Withheld consent is the client’s to resolve, never the MSP’s to work around.',
    file: 'packages/resolution/src/plan.ts',
    find: `  CONSENT_REQUIRED: {
    owner: 'CLIENT',`,
    replace: `  CONSENT_REQUIRED: {
    owner: 'MSP',`,
    suite: 'packages/resolution/src/plan.test.ts',
    mustFail: ['never tells an operator to collect harder when consent was never given'],
  },
  {
    id: 'resolution-undefined-reason',
    invariant: 'An omitted reason is an absent one, not a defect report against ourselves.',
    file: 'packages/resolution/src/plan.ts',
    find: '    blockedReason: raw.blockedReason ?? null,',
    replace: '    blockedReason: raw.blockedReason,',
    suite: 'packages/resolution/src/plan.test.ts',
    mustFail: ['blames itself only when the engine really gave no reason'],
  },
  {
    id: 'resolution-contained-is-a-repair',
    invariant: 'A blocked control needs a decision, never a repair.',
    file: 'packages/resolution/src/kind.ts',
    find: "  CONTAINED: 'AWAITING_DECISION',",
    replace: "  CONTAINED: 'UNCOLLECTABLE',",
    suite: 'packages/resolution/src/plan.test.ts',
    mustFail: [
      'treats every blocked reason as a decision, never as a repair',
      'presents containment as a decision that was made, not as a fault',
    ],
  },

  // ---------------------------------------------------------------------------
  // A conflict must state what it costs.
  // ---------------------------------------------------------------------------
  {
    id: 'conflict-contested-reads-clean',
    invariant: 'A determination resting on one contested source is not unanimity.',
    file: 'packages/domain/src/conflict.ts',
    find: "    limitation: 'DETERMINATION_RESTS_ON_ONE_SOURCE',",
    replace: "    limitation: 'NONE',",
    suite: 'packages/domain/src/conflict-consequence.test.ts',
    mustFail: ['distinguishes "decided on a contested reading" from "undecided"'],
  },
  {
    id: 'conflict-double-counts-controls',
    invariant: 'A conflict’s stated cost must not be inflated by double counting.',
    file: 'packages/domain/src/conflict.ts',
    find: '  const affectedControlKeys = [...new Set(controlsReadingPredicate)].sort();',
    replace: '  const affectedControlKeys = [...controlsReadingPredicate];',
    suite: 'packages/domain/src/conflict-consequence.test.ts',
    mustFail: ['counts each affected control once, in a stable order'],
  },

  // ---------------------------------------------------------------------------
  // The resolution queue must see every undecided control. Needs a database.
  // ---------------------------------------------------------------------------
  {
    id: 'queue-misses-never-assessed',
    invariant:
      'A control that has never been assessed appears in the queue, rather than the queue ' +
      'reporting a fresh organisation as having nothing undecided.',
    file: 'apps/api/src/services/resolution.ts',
    find: `         FROM controls c
         LEFT JOIN assurance_states s`,
    replace: `         FROM controls c
         JOIN assurance_states s`,
    suite: 'tests/e2e/resolution-queue.test.ts',
    mustFail: [
      'shows every never-assessed control rather than reporting nothing to do',
      'ranks the gap that darkens five controls above a lone CRITICAL one',
    ],
    needsDatabase: true,
  },
  {
    id: 'queue-routes-on-first-predicate',
    invariant: 'The queue routes on the gap that darkens the most controls.',
    file: 'apps/api/src/services/resolution.ts',
    find: `  const widest = [...predicates].sort(
    (a, b) => (fanOut.get(b)?.length ?? 0) - (fanOut.get(a)?.length ?? 0),
  )[0];`,
    replace: '  const widest = [...predicates][0];',
    suite: 'tests/e2e/resolution-queue.test.ts',
    mustFail: ['ranks the gap that darkens five controls above a lone CRITICAL one'],
    needsDatabase: true,
  },
  {
    id: 'crosswalk-caveat-dropped',
    invariant:
      'Every crosswalk lead states that it does not determine the requirement, not just the ' +
      'first one.',
    file: 'packages/crosswalk/src/coverage.ts',
    find: '      doesNotDetermine: DOES_NOT_DETERMINE,',
    replace: "      doesNotDetermine: '',",
    suite: 'packages/crosswalk/src/crosswalk.test.ts',
    mustFail: ['says on every single lead that it does not determine the requirement'],
  },
  {
    id: 'readme-names-a-missing-script',
    invariant: 'The README never tells a reader to run a command that does not exist.',
    file: 'README.md',
    find: 'pnpm test:mutation    #',
    replace: 'pnpm test:mutants     #',
    suite: 'tests/unit/documentation.test.ts',
    mustFail: ['names no script that does not exist'],
  },
  // ---------------------------------------------------------------------------
  // Conformance to the lifecycles the contract states.
  // ---------------------------------------------------------------------------
  {
    id: 'lifecycle-dispatch-counted-as-success',
    invariant:
      'Dispatch and confirmation sit in different stages of the contract execution lifecycle.',
    file: 'packages/domain/src/contract-lifecycle.ts',
    find: "    actionStates: ['CONFIRMED', 'UNVERIFIED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'],",
    replace: "    actionStates: ['UNVERIFIED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'],",
    suite: 'packages/domain/src/contract-lifecycle.test.ts',
    mustFail: ['keeps dispatch and success in different stages'],
  },
  {
    id: 'lifecycle-stage-claimed-as-a-state',
    invariant:
      'A stage realised as a stored property is not reported as a state the entity passes through.',
    file: 'packages/domain/src/contract-lifecycle.ts',
    find: "  RISK: {\n    realisation: 'PROPERTY',",
    replace: "  RISK: {\n    realisation: 'STATE',",
    suite: 'packages/domain/src/contract-lifecycle.test.ts',
    mustFail: ['does not claim a stage is a state when it is a property'],
  },
  {
    id: 'support-closed-counted-as-resolved',
    invariant: 'A case that ended is not thereby a case that was resolved.',
    file: 'packages/support/src/case.ts',
    find: "  return state === 'RESOLVED';",
    replace: "  return state === 'RESOLVED' || state === 'CLOSED';",
    suite: 'packages/support/src/contract-stages.test.ts',
    mustFail: ['counts only RESOLVED as a resolution'],
  },
  {
    id: 'support-unknown-outcome-guessed',
    invariant: 'An outcome the history does not record is reported as unknown, never as resolved.',
    file: 'packages/support/src/case.ts',
    find: '  return null;\n}\n\n/** Case states that end the case without solving anything. */',
    replace:
      "  return 'RESOLVED';\n}\n\n/** Case states that end the case without solving anything. */",
    suite: 'packages/support/src/contract-stages.test.ts',
    mustFail: ['returns null rather than guessing when the history does not say'],
  },
  /**
   * The fifth README guard — that at least half the package rows state a
   * boundary rather than only a purpose — is deliberately absent from this
   * registry. It is a proportion across twenty rows, so no single find-and-
   * replace trips it, and the looseness is intentional: requiring a refusal in
   * every row would push somebody into writing one that is not true, and a
   * fabricated boundary is worse than a missing sentence. It was verified by
   * stripping the refusal language from every row at once and watching it fail.
   */
  {
    id: 'readme-lists-a-package-without-explaining-it',
    invariant:
      'Every package is discussed in the README prose, not merely named in a directory tree.',
    file: 'README.md',
    find: "| [`packages/containment`](./packages/containment)   | Governed containment C0–C5, its authority model and recovery preconditions. No level withholds an organisation's own assurance record, and automation can enter containment but never leave it. |\n",
    replace: '',
    suite: 'tests/unit/documentation.test.ts',
    mustFail: ['discusses every package in prose, not only in the directory tree'],
  },
  {
    id: 'readme-package-link-goes-nowhere',
    invariant: 'Every package path the README links to resolves to a real directory.',
    file: 'README.md',
    find: '](./packages/triage)',
    replace: '](./packages/triage-queue)',
    suite: 'tests/unit/documentation.test.ts',
    mustFail: ['links every package by a path that resolves'],
  },
  {
    id: 'readme-names-a-phantom-package',
    invariant: 'The README never names a package that does not exist in the repository.',
    file: 'README.md',
    find: '`packages/shared`',
    replace: '`packages/scheduling`',
    suite: 'tests/unit/documentation.test.ts',
    mustFail: ['names no package that does not exist'],
  },
  {
    id: 'readme-package-count-drifts',
    invariant: 'A count stated in the README prose is verified, or it is not stated.',
    file: 'README.md',
    find: 'Twenty workspace packages',
    replace: 'Eighteen workspace packages',
    suite: 'tests/unit/documentation.test.ts',
    mustFail: ['states the package count correctly, or not at all'],
  },
  {
    id: 'register-cites-missing-path',
    invariant: 'Every evidence path the capability register cites must exist.',
    file: 'scripts/capability-register.ts',
    find: 'tests/e2e/support-cases.test.ts',
    replace: 'tests/e2e/support-cases-renamed.test.ts',
    suite: 'tests/unit/capability-status.test.ts',
    mustFail: ['cites only paths that exist'],
  },
];
