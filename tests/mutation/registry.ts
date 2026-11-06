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
  // The inventory of what shipped.
  // ---------------------------------------------------------------------------
  {
    id: 'sbom-collapses-versions',
    invariant:
      'Every installed version of a package appears in the inventory, not one row per name.',
    file: 'scripts/sbom.ts',
    find: 'seen.add(`${name}\\u0000${version}`);',
    replace: "seen.add(`${name}\\u0000${version}`.split('\\u0000')[0] ?? name);",
    suite: 'tests/unit/sbom.test.ts',
    mustFail: ['lists every installed version of a package, not one per name'],
  },
  {
    id: 'sbom-merges-dev-into-production',
    invariant: 'What ships and what it was built with are inventoried separately.',
    file: 'scripts/sbom.ts',
    find: "      const components = listed(deployable, kind === 'development');",
    replace: '      const components = listed(deployable, true);',
    suite: 'tests/unit/sbom.test.ts',
    mustFail: ['keeps what ships separate from what it was built with'],
  },
  {
    id: 'sbom-not-reproducible',
    invariant: 'Two inventories of an unchanged tree are identical, so a release can be rechecked.',
    file: 'scripts/sbom.ts',
    find: '    metadata: {\n      component:',
    replace: '    metadata: {\n      timestamp: new Date().toISOString(),\n      component:',
    suite: 'tests/unit/sbom.test.ts',
    mustFail: ['produces the same document twice for an unchanged tree'],
  },
  {
    id: 'sbom-not-tied-to-a-commit',
    invariant:
      'An inventory names the commit it describes, or it inventories nothing in particular.',
    file: 'scripts/sbom.ts',
    find: "        { name: 'adericel:commit', value: commit() },",
    replace: "        { name: 'adericel:commit', value: 'n/a' },",
    suite: 'tests/unit/sbom.test.ts',
    mustFail: ['records the commit, so the inventory is tied to a build'],
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
  {
    id: 'reobservation-recorded-as-nothing',
    invariant:
      'Re-observing an unchanged fact is recorded, so a stable estate that keeps being collected ' +
      'stays proven instead of decaying to UNKNOWN.',
    file: 'packages/evidence/src/observations.ts',
    // The defect that actually shipped: the conflict did nothing at all, so
    // nothing downstream ran and no evidence was ever refreshed.
    find: `           DO UPDATE SET
             collected_at = GREATEST(observations.collected_at, EXCLUDED.collected_at),
             observed_at = GREATEST(observations.observed_at, EXCLUDED.observed_at),
             integration_run_id = EXCLUDED.integration_run_id,
             correlation_id = EXCLUDED.correlation_id,
             subject_node_id = COALESCE(EXCLUDED.subject_node_id, observations.subject_node_id)`,
    replace: '           DO NOTHING',
    suite: 'tests/chaos/failure-injection.test.ts',
    mustFail: [
      'stays proven for as long as it keeps being observed',
      'stays proven when the source reports no timestamp of its own',
    ],
    needsDatabase: true,
  },
  {
    id: 'reobservation-does-not-refresh-collected-at',
    invariant:
      'Re-observation refreshes `collected_at`, which is the only recency anchor a source that ' +
      'reports no timestamp of its own ever has.',
    file: 'packages/evidence/src/observations.ts',
    find: 'collected_at = GREATEST(observations.collected_at, EXCLUDED.collected_at),',
    replace: 'collected_at = observations.collected_at,',
    suite: 'tests/chaos/failure-injection.test.ts',
    /**
     * Not the test above, and that is the whole point of this entry.
     *
     * This mutation SURVIVED when it was first recorded, pointed at the
     * twenty-day test. Evidence usability is anchored on
     * `observed_at ?? collected_at`, and the fixture always reported a
     * timestamp, so `observed_at` carried the property and breaking
     * `collected_at` changed nothing. The guard was real and had no test over
     * it — which is exactly the state the harness exists to detect, and it
     * detected it on the most important defect in the repository.
     */
    mustFail: ['stays proven when the source reports no timestamp of its own'],
    needsDatabase: true,
  },
  {
    id: 'reobservation-does-not-refresh-observed-at',
    invariant:
      'Re-observation refreshes `observed_at`, which is the anchor for every source that reports ' +
      'when a fact became true.',
    file: 'packages/evidence/src/observations.ts',
    find: 'observed_at = GREATEST(observations.observed_at, EXCLUDED.observed_at),',
    replace: 'observed_at = observations.observed_at,',
    suite: 'tests/chaos/failure-injection.test.ts',
    mustFail: ['stays proven for as long as it keeps being observed'],
    needsDatabase: true,
  },
  {
    id: 'evidence-identity-ignores-its-subject',
    invariant:
      'Evidence identity includes the subject it is evidence about, so two identically ' +
      'configured devices never share one proof record.',
    file: 'packages/evidence/src/repository.ts',
    find: '          sourceReference: input.sourceReference ?? null,\n',
    replace: '',
    suite: 'tests/chaos/failure-injection.test.ts',
    mustFail: ['never offers evidence about one subject as proof about another'],
    needsDatabase: true,
  },
  {
    id: 'engine-gets-no-impairment',
    invariant:
      'The assessment service supplies impairment to the engine, so a control whose source is ' +
      'broken names the repair instead of reporting INSUFFICIENT_EVIDENCE.',
    file: 'packages/actions/src/assessment-service.ts',
    find: 'impairments: impairments.filter((impairment) => predicates.includes(impairment.predicate)),',
    replace: 'impairments: [],',
    suite: 'tests/chaos/failure-injection.test.ts',
    // A literal title, not one of the generated per-code ones: the registry
    // checker matches `mustFail` against titles it can find in the file, and a
    // template literal is not findable. This test asserts the broken state is
    // DEGRADED, which is only reachable when impairment reaches the engine.
    mustFail: ['returns to proven only after a successful collection, not on repair alone'],
    needsDatabase: true,
  },
  {
    id: 'degraded-reason-never-persisted',
    invariant:
      'The reason a control is DEGRADED or BLOCKED is written to its state row, not only ' +
      'computed and dropped.',
    file: 'packages/actions/src/assessment-service.ts',
    find:
      '        outcome.provenance.assessedAt,\n' +
      '        outcome.degradedReason,\n' +
      '        outcome.blockedReason,\n' +
      '      ],\n',
    replace: '        outcome.provenance.assessedAt,\n        null,\n        null,\n      ],\n',
    suite: 'tests/chaos/failure-injection.test.ts',
    // Asserts `degraded_reason` reads SCHEMA_DRIFT, which is only true if the
    // reason computed by the engine was actually written to the state row.
    mustFail: ['treats a collection that read nothing as drift, not as a success'],
    needsDatabase: true,
  },
  {
    id: 'silent-schema-drift-recorded-as-success',
    invariant:
      'A collection that stored observations and derived no claims at all is reported as drift, ' +
      'never as a successful run.',
    file: 'packages/actions/src/collection-service.ts',
    find: 'processed.mappableObservations > 0 && processed.claimsDerived === 0',
    replace: 'processed.mappableObservations > 0 && processed.claimsDerived < 0',
    suite: 'tests/chaos/failure-injection.test.ts',
    mustFail: ['keeps detecting drift on the runs after the first'],
    needsDatabase: true,
  },
  {
    id: 'fixture-manifest-under-declares-its-predicates',
    invariant:
      "A connector's declared predicates are derived from what it can produce, not hand-listed, " +
      'because an omission silently disables impairment for the predicates it forgot.',
    file: 'packages/integrations/src/connectors/demo-fixture.ts',
    find: 'predicates: FIXTURE_KINDS.flatMap((kind) => predicatesForKind(kind)),',
    replace: "predicates: ['device.disk.encrypted', 'identity.mfa.enforced'],",
    suite: 'packages/integrations/src/impairment.test.ts',
    mustFail: ['declares every predicate the demonstration connector can actually produce'],
  },
  {
    id: 'failure-code-guessed-from-error-prose',
    invariant:
      'A collection failure is classified by the code the connector reported, never by ' +
      'pattern-matching a vendor error message.',
    file: 'packages/domain/src/collection-failure.ts',
    find:
      '  // Deliberately no message inspection. See the note on the code list above.\n' +
      "  return 'UNCLASSIFIED';",
    replace:
      '  const message = error instanceof Error ? error.message.toLowerCase() : String(error);\n' +
      "  if (message.includes('401') || message.includes('unauthor')) return 'CREDENTIAL_INVALID';\n" +
      "  if (message.includes('429')) return 'RATE_LIMITED';\n" +
      "  if (message.includes('consent')) return 'CONSENT_WITHDRAWN';\n" +
      "  if (message.includes('timedout')) return 'TIMEOUT';\n" +
      "  return 'UNCLASSIFIED';",
    suite: 'packages/domain/src/collection-failure.test.ts',
    mustFail: ['refuses to guess a code from an error message'],
  },
  {
    id: 'withdrawn-consent-routed-to-an-engineer',
    invariant:
      'A withdrawn consent is BLOCKED, routed to somebody with authority, because no engineer ' +
      'can repair a decision the customer made.',
    file: 'packages/domain/src/collection-failure.ts',
    find: "  CONSENT_WITHDRAWN: 'CONSENT_REQUIRED',",
    replace: '  CONSENT_WITHDRAWN: null,',
    suite: 'packages/domain/src/collection-failure.test.ts',
    mustFail: ['routes a withdrawn consent to somebody with authority, not to an engineer'],
  },
  {
    id: 'portfolio-sweep-silently-drops-the-tail',
    invariant:
      'A sweep with no named organisation processes every maintained organisation, or the ones ' +
      'it skipped are visible rather than silently absent.',
    file: 'apps/worker/src/jobs/handlers.ts',
    /**
     * Not a live defect, and recorded anyway.
     *
     * In production every organisation gets its own scheduled job, so
     * `organisationsToProcess` takes the single-organisation branch and this
     * limit is never reached — a fact worth stating, because a reader seeing
     * `LIMIT 200` would reasonably assume otherwise. It *is* reached by a
     * manual sweep, which is what an operator runs and what the load suite
     * drives.
     *
     * The trap is that moving these to one platform-wide schedule is the
     * obvious optimisation at scale, and doing it would silently stop
     * collecting from every customer past the two hundredth — each of whom
     * would keep looking healthy until their evidence aged out. That is the
     * day-seven defect arriving by a different route, so the guard is worth
     * keeping whether or not the branch is live today.
     */
    find: 'const BATCH = 200;',
    replace: 'const BATCH = 40;',
    suite: 'tests/load/portfolio-scale.test.ts',
    mustFail: ['collects from every organisation without dropping any'],
    needsDatabase: true,
  },
  {
    id: 'soak-accumulates-a-row-per-collection',
    invariant:
      'An unchanged fact re-collected daily for months is one evidence record, not one per ' +
      'collection.',
    file: 'packages/evidence/src/repository.ts',
    /**
     * The ruinous-but-correct implementation, re-introduced.
     *
     * Refreshing recency by writing a new row every time would keep a stable
     * estate proven and would cost an MSP with a hundred customers a hundred
     * thousand identical records a year. The chaos mutations cover the
     * correctness half of this fix; this covers the cost half, which only a
     * suite that runs for ninety days can see.
     */
    find: '      if (existing) {',
    replace: '      if (existing && false) {',
    suite: 'tests/soak/sustained-operation.test.ts',
    mustFail: ['stores one observation per distinct fact, not one per collection'],
    needsDatabase: true,
  },
  {
    id: 'self-erasure-reads-a-target',
    invariant:
      'Erasing yourself takes no target: the subject is the authenticated principal, so there is ' +
      'no parameter by which one person can erase another.',
    file: 'apps/api/src/routes/msps.ts',
    find:
      '    const report = await eraseDataSubject(app, principal.principalId, ' +
      '{ reason: body.reason });',
    replace:
      '    const target = (request.body as { userId?: string }).userId ?? principal.principalId;\n' +
      '    const report = await eraseDataSubject(app, target, { reason: body.reason });',
    suite: 'tests/e2e/subject-erasure.test.ts',
    mustFail: ['erases the caller, and takes no target to erase anybody else'],
    needsDatabase: true,
  },
  {
    id: 'on-behalf-erasure-reaches-across-msps',
    invariant:
      'An MSP may erase only its own members. A cross-tenant erasure is the most destructive act ' +
      'available through this API.',
    file: 'apps/api/src/routes/msps.ts',
    find: '`SELECT id FROM users WHERE id = $1 AND msp_id = $2`',
    replace: '`SELECT id FROM users WHERE id = $1 AND $2 IS NOT NULL`',
    suite: 'tests/e2e/subject-erasure.test.ts',
    mustFail: ['refuses to reach into another MSP'],
    needsDatabase: true,
  },
  {
    id: 'self-erasure-without-a-second-factor',
    invariant:
      'Erasing a person requires a second factor in this session, because the act cannot be ' +
      'undone and a stolen session must not be enough.',
    file: 'apps/api/src/routes/msps.ts',
    find: '    if (!principal.mfaSatisfied) {',
    replace: '    if (false as boolean) {',
    suite: 'tests/e2e/subject-erasure.test.ts',
    mustFail: ['refuses without a second factor, because it cannot be undone'],
    needsDatabase: true,
  },
  {
    id: 'erasure-permission-granted-to-a-service-identity',
    invariant:
      'No automation may erase a person. An n8n workflow holding a service token must not be ' +
      'able to remove somebody from the platform.',
    file: 'packages/domain/src/authz.ts',
    find: "  'msp:member:erase',\n]);\n\n/**\n * Permissions that require a second factor",
    replace: ']);\n\n/**\n * Permissions that require a second factor',
    suite: 'packages/domain/src/authz.test.ts',
    mustFail: [
      'never lets a service identity erase a person',
      'names every permission that only a human may hold, so additions are deliberate',
    ],
  },
  {
    id: 'upgrade-suite-populates-nothing',
    invariant:
      'The upgrade suite plants rows before the later migrations run, so each of them is applied ' +
      'to a populated database rather than an empty one.',
    file: 'tests/upgrade/populated-migration.test.ts',
    /**
     * The suite's own premise, which is the thing most worth guarding.
     *
     * Every assertion in that file is about rows surviving an upgrade. Point it
     * at a migration that does not exist and it populates nothing, migrates an
     * empty schema, and passes — proving exactly what the test suite as a whole
     * already proved and nothing more. That is the failure mode the chaos suite
     * shipped with, and the reason this file asserts its own premise.
     */
    find: "const POPULATE_AFTER = '0001_core_tenancy_identity';",
    replace: "const POPULATE_AFTER = '0001_core_tenancy_identity_renamed';",
    suite: 'tests/upgrade/populated-migration.test.ts',
    mustFail: ['applies every later migration against real rows'],
    needsDatabase: true,
  },
  /**
   * The register's own checks.
   *
   * This document is the artefact that says Adericel distinguishes what was
   * measured from what was asserted, and it had seven entries contradicting
   * themselves about whether a risk was live (RR-094). These five break each
   * rule separately, because a single check that catches all five would not
   * tell anybody which one had rotted.
   */
  {
    id: 'register-heading-contradicts-state',
    invariant:
      'An entry\'s heading and its State row must give the same answer to "is this risk live".',
    file: 'docs/audit/RESIDUAL_RISK_REGISTER.md',
    find: "### RR-080 — The contract's lifecycles and the implemented ones have never been reconciled",
    replace:
      "### RR-080 — The contract's lifecycles and the implemented ones have never been reconciled — **CLOSED 21 Oct 2026**",
    suite: 'tests/unit/risk-register.test.ts',
    mustFail: ['never lets a heading contradict the state it records'],
  },
  {
    id: 'register-closure-without-evidence',
    invariant:
      'A CLOSED entry must cite evidence, not merely a mitigation it planned to carry out.',
    file: 'docs/audit/RESIDUAL_RISK_REGISTER.md',
    find:
      '| **Verified**    | PR #3 (`increment-1-passport-interchange`) closed unmerged on 15 Sept 2026. ' +
      'Confirmed against GitHub: `state: closed`, `merged: false`. The duplicate never entered the tree, ' +
      'and ADR-0039 on the working branch is the only one. |\n',
    replace: '',
    suite: 'tests/unit/risk-register.test.ts',
    mustFail: ['never closes an entry without citing evidence'],
  },
  {
    id: 'register-dangling-cross-reference',
    invariant: 'Every entry this register refers to must be an entry this register defines.',
    file: 'docs/audit/RESIDUAL_RISK_REGISTER.md',
    /**
     * The defect that was actually there. RR-075's residual said "Tracked as
     * RR-080" and no RR-080 existed, so a residual risk recorded as handled
     * elsewhere was recorded nowhere at all — for three weeks, in the document
     * whose job is to not let that happen.
     */
    find: 'Raised as RR-095, and closed.',
    replace: 'Raised as RR-199, and closed.',
    suite: 'tests/unit/risk-register.test.ts',
    mustFail: ['never refers to an entry that does not exist'],
  },
  {
    id: 'register-cites-a-path-that-does-not-exist',
    invariant: 'Every repository path the register cites as evidence must resolve.',
    file: 'docs/audit/RESIDUAL_RISK_REGISTER.md',
    find: '`packages/support/src/case.ts` carries twenty states',
    replace: '`packages/support/src/cases.ts` carries twenty states',
    suite: 'tests/unit/risk-register.test.ts',
    mustFail: ['names real files wherever it cites one'],
  },
  {
    id: 'register-live-entry-without-an-owner',
    invariant: 'An OPEN or MITIGATING entry must name who owns it.',
    file: 'docs/audit/RESIDUAL_RISK_REGISTER.md',
    find:
      '| **Owner**       | **Founder.** It can only be closed by a real customer, and stating it in a ' +
      "commercial conversation is the founder's act, not a test's.",
    replace:
      '| **Note**        | **Founder.** It can only be closed by a real customer, and stating it in a ' +
      "commercial conversation is the founder's act, not a test's.",
    suite: 'tests/unit/risk-register.test.ts',
    mustFail: ['gives every live entry an owner'],
  },
  /**
   * The verification authority boundary (RR-095).
   *
   * Each of these reinstates a different half of the defect: accepting a value
   * nobody observed, turning an absence into a reading, and writing a
   * verification that does not say where its reading came from.
   */
  {
    id: 'verification-accepts-an-unattested-value',
    invariant:
      'The action service refuses a verification value that did not come out of a re-observer, ' +
      'before any state moves and before any evidence is written.',
    file: 'packages/actions/src/action-service.ts',
    find: '      assertReObservation(reobservation);\n',
    replace: '',
    suite: 'tests/security/verification-attestation.test.ts',
    mustFail: ['refuses the executor reporting its own success, and records nothing'],
    needsDatabase: true,
  },
  {
    id: 'an-absence-can-confirm',
    invariant:
      'A re-observation that could not be attempted reaches the judgement as nothing, so the ' +
      'only outcome it can produce is INCONCLUSIVE.',
    file: 'packages/actions/src/reobservation.ts',
    find: "  return reobservation.kind === 'OBSERVED' ? reobservation.value : undefined;",
    replace: "  return reobservation.kind === 'OBSERVED' ? reobservation.value : true;",
    suite: 'tests/security/verification-attestation.test.ts',
    mustFail: ['cannot confirm from an absence, however the absence is dressed up'],
    needsDatabase: true,
  },
  {
    id: 'verification-does-not-record-which-run-it-read',
    invariant:
      'A verification row names the integration run its reading came out of, or the reason there ' +
      'was no run. Never neither.',
    file: 'packages/actions/src/reobservation.ts',
    find: `  return reobservation.kind === 'OBSERVED'
    ? {
        integrationRunId: reobservation.integrationRunId,
        observedAt: reobservation.observedAt,
        notObservableReason: null,
      }
    : { integrationRunId: null, observedAt: null, notObservableReason: reobservation.reason };`,
    replace:
      '  return { integrationRunId: null, observedAt: null, notObservableReason: null };\n' +
      '  void reobservation;',
    suite: 'tests/security/verification-attestation.test.ts',
    mustFail: ['names the collection run its reading came out of'],
    needsDatabase: true,
  },
  {
    id: 'reobservation-shape-check-waves-everything-through',
    invariant:
      'The run-time attestation check actually inspects the value, rather than trusting that the ' +
      'compiler already did. The API boundary deserialises JSON and a cast silences the compiler.',
    file: 'packages/actions/src/reobservation.ts',
    find: '  const kind = (value as { kind?: unknown } | null)?.kind;',
    replace:
      "  const kind = (value as { kind?: unknown } | null)?.kind ?? 'OBSERVED';\n  if (true as boolean) return;",
    suite: 'tests/security/verification-attestation.test.ts',
    mustFail: ['refuses every value that did not come out of a re-observer'],
  },
  /**
   * The two honesty defects the first rendering of the interface found (RR-096).
   *
   * Both were individually defensible SQL and jointly a product that told an
   * MSP everything was fine about a customer it could say nothing about.
   */
  {
    id: 'portfolio-counts-only-what-was-assessed',
    invariant:
      'The MSP portfolio counts in-scope controls, so a control nobody has assessed yet counts ' +
      'as unknown rather than as nothing at all.',
    file: 'apps/api/src/routes/portfolio.ts',
    find: "count(c.*) FILTER (WHERE a.state = 'UNKNOWN' OR a.state IS NULL)::text AS unknown,",
    replace: "count(c.*) FILTER (WHERE a.state = 'UNKNOWN')::text AS unknown,",
    suite: 'tests/e2e/unassessed-is-not-nothing-wrong.test.ts',
    mustFail: ['is reported to the MSP as unknown, not as nothing wrong'],
    needsDatabase: true,
  },
  {
    id: 'unassessed-reported-as-no-evidence',
    invariant:
      'A control that has never been assessed reports NOT_YET_ASSESSED. It does not report ' +
      'NO_EVIDENCE, which asserts a cause nobody established and can contradict the evidence ' +
      'the organisation visibly holds.',
    file: 'apps/api/src/routes/assurance.ts',
    find: "CASE WHEN a.state IS NULL THEN 'NOT_YET_ASSESSED' ELSE a.unknown_reason END",
    replace: "CASE WHEN a.state IS NULL THEN 'NO_EVIDENCE' ELSE a.unknown_reason END",
    suite: 'tests/e2e/unassessed-is-not-nothing-wrong.test.ts',
    mustFail: [
      'says the controls have never been assessed, not that no evidence exists',
      'holds evidence, which is why "no evidence has been collected" was a lie',
    ],
    needsDatabase: true,
  },
  /**
   * The brand's one hard rule, now asserted against a rendered page (RR-097).
   *
   * Green means PROVEN. These paint something green that is not proven, and
   * detach a chip's colour from the state it describes.
   */
  {
    id: 'unknown-chip-painted-with-a-state-colour',
    invariant:
      'Unknown is hatched and has no colour, because any hue would place it on the good-to-bad ' +
      'axis and Unknown is not on that axis.',
    file: 'apps/web/src/styles/app.css',
    find: `.state--unknown {
  color: var(--text-primary);
  border-color: var(--text-primary);
  background-color: transparent;`,
    replace: `.state--unknown {
  color: var(--text-primary);
  border-color: var(--text-primary);
  background-color: var(--state-proven);`,
    suite: 'tests/browser/interface.test.ts',
    mustFail: ['gives Unknown no colour at all, as the brand requires'],
    needsDatabase: true,
  },
  {
    id: 'the-proven-colour-used-as-decoration',
    invariant:
      'No element wears the proven colour unless it is about something proven. A state colour is ' +
      'never decoration.',
    file: 'apps/web/src/styles/app.css',
    find: `.panel {
  border: var(--border);
  background: var(--surface-raised);`,
    replace: `.panel {
  border: var(--border);
  background: var(--state-proven);`,
    suite: 'tests/browser/interface.test.ts',
    mustFail: ['uses the proven colour for nothing but proven'],
    needsDatabase: true,
  },
  {
    id: 'chip-tone-stops-following-its-state',
    invariant:
      "A state chip's colour comes from the one module that maps states to presentation, so a " +
      'component cannot decide a tone for itself.',
    file: 'apps/web/src/components/State.tsx',
    find: 'className={`state state--${presentation.tone}`}',
    replace: "className={'state state--proven'}",
    suite: 'tests/browser/interface.test.ts',
    mustFail: ['labels every state chip the way the presentation module says'],
    needsDatabase: true,
  },
];
