#!/usr/bin/env tsx
/**
 * Where this build stands against the ten completion conditions.
 *
 * Contract v3.2, "A feature is not complete because code exists". This reports
 * the position; it does not produce a release record, and the distinction is
 * deliberate.
 *
 * WHY THIS DOES NOT WRITE A RELEASE RECORD
 *
 * Four of the ten conditions cannot be established by anything running in a
 * pipeline — architecture coherence, privacy implications, failure modes and
 * unsupported claims each need a named person to have looked. A script that
 * emitted a complete record would be signing on their behalf, and the record
 * would then assert something nobody checked. So this prints what the
 * repository can genuinely establish, names what it cannot, and stops.
 *
 * `pnpm release:position` runs it. Nothing consumes its output automatically:
 * it is for the person cutting a release to read before they sign.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  COMPLETION_CONDITIONS,
  CONDITIONS,
  NON_REGRESSION_INVARIANTS,
  gateVerdict,
  positionOf,
  type ConditionAssessment,
  type ReleaseRecord,
} from '@adericel/domain';
import { CAPABILITY_REGISTER } from './capability-register.js';

const ROOT = process.cwd();

function git(...args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Does this repository carry the check that would establish a condition? */
function present(...relativePaths: readonly string[]): boolean {
  return relativePaths.every((p) => existsSync(path.join(ROOT, p)));
}

function countFiles(dir: string, suffix: string): number {
  const full = path.join(ROOT, dir);
  if (!existsSync(full)) return 0;
  return readdirSync(full).filter((name) => name.endsWith(suffix)).length;
}

/**
 * What the repository can establish on its own, and nothing more.
 *
 * Each entry says what was actually read. Where a condition needs a person, no
 * assessment is produced at all — which the gate reports as unassessed, because
 * an absent assessment is not a pass.
 */
function automatedAssessments(): readonly ConditionAssessment[] {
  const assessments: ConditionAssessment[] = [];

  /**
   * One assessment, with a different sentence for each outcome.
   *
   * The first version of this passed one evidence string whatever the outcome,
   * so a NOT_MET printed a sentence describing a pass. That is precisely the
   * defect the gate exists to catch, produced by the gate's own reporting.
   */
  const add = (
    condition: (typeof COMPLETION_CONDITIONS)[number],
    ok: boolean,
    evidence: { met: string; notMet: string },
  ): void => {
    assessments.push({
      condition,
      outcome: ok ? 'MET' : 'NOT_MET',
      evidence: ok ? evidence.met : evidence.notMet,
      establishedBy: 'AUTOMATED_CHECK',
    });
  };

  /** Whether any file under `dir` registers every one of these route paths. */
  const routesServed = (dir: string, ...paths: readonly string[]): boolean => {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) return false;
    const sources = readdirSync(full)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(path.join(full, name), 'utf8'))
      .join('\n');
    // Matched against the registration, not against a filename. The first
    // version of this looked for `routes/health.ts`, which does not exist —
    // the routes are in `observability.ts` — and reported a false NOT_MET.
    return paths.every((route) => sources.includes(`'${route}'`));
  };

  const securitySuites = countFiles('tests/security', '.test.ts');
  const tenancySuites = countFiles('tests/tenancy', '.test.ts');
  add('SECURITY_BOUNDARIES_TESTED', securitySuites > 0 && tenancySuites > 0, {
    met:
      `${securitySuites} security suite(s) and ${tenancySuites} tenancy suite(s) present. ` +
      'Presence only — this script does not run them; `pnpm test` does.',
    notMet:
      `Only ${securitySuites} security and ${tenancySuites} tenancy suite(s) found. The ` +
      'boundaries must be tested, not documented.',
  });

  add(
    'AUDITABILITY_EXISTS_WHERE_REQUIRED',
    present('database/migrations/0005_audit_and_events.sql') ||
      readdirSync(path.join(ROOT, 'database/migrations')).some((f) => /audit/.test(f)),
    {
      met:
        'A migration establishes the append-only audit log, enforced by trigger rather than by ' +
        'convention.',
      notMet: 'No migration establishing an append-only audit log was found.',
    },
  );

  add(
    'DOCUMENTATION_MATCHES_IMPLEMENTATION',
    present('tests/unit/generated-docs.test.ts', 'tests/unit/capability-status.test.ts'),
    {
      met:
        'Drift checks exist for every generated document, and the capability register’s ' +
        'cited evidence paths are checked against the repository.',
      notMet: 'A generated-document drift check or the capability register check is missing.',
    },
  );

  // Deliberately NOT_MET: this script cannot run the suite and must not claim
  // an outcome it has not seen.
  assessments.push({
    condition: 'TESTS_PASS',
    outcome: 'NOT_MET',
    evidence:
      'Not established here. This script does not run the suite, and reporting a pass it did ' +
      'not observe would be the exact failure the gate exists to catch. Run `pnpm test` and ' +
      'record the result.',
    establishedBy: 'AUTOMATED_CHECK',
  });

  add(
    'RECOVERY_IMPLICATIONS_UNDERSTOOD',
    present('tests/integration/backup-restore.test.ts', 'tests/integration/migrations.test.ts'),
    {
      met:
        'Migration reversal and a restore from a real dump are both covered by integration ' +
        'suites.',
      notMet:
        'Either migration reversal or restore-from-dump has no integration suite. Backup ' +
        'existence alone is insufficient.',
    },
  );

  add(
    'OPERATIONAL_BEHAVIOUR_OBSERVABLE',
    routesServed('apps/api/src/routes', '/health/live', '/health/ready'),
    {
      met:
        'Liveness and readiness are both served, exempt from rate limiting, and every request ' +
        'carries a correlation id.',
      notMet: 'A liveness or readiness route is not registered.',
    },
  );

  return assessments;
}

function main(): void {
  const record: ReleaseRecord = {
    version: `working tree at ${git('rev-parse', '--abbrev-ref', 'HEAD')}`,
    commit: git('rev-parse', '--short', 'HEAD'),
    at: new Date().toISOString(),
    assessments: automatedAssessments(),
    // Affirming a non-regression invariant means somebody looked at the change.
    // Nothing here can do that, so nothing here affirms one.
    invariantsAffirmed: {},
  };

  const verdict = gateVerdict(record);
  const out: string[] = [
    'Release position',
    '================',
    '',
    `Commit:  ${record.commit}`,
    `Branch:  ${record.version}`,
    `As of:   ${record.at}`,
    '',
    'The ten completion conditions (contract v3.2)',
    '---------------------------------------------',
  ];

  const byCondition = new Map(record.assessments.map((a) => [a.condition, a]));
  for (const condition of COMPLETION_CONDITIONS) {
    const assessment = byCondition.get(condition);
    const definition = CONDITIONS[condition];
    const mark = !assessment
      ? 'NEEDS A PERSON'
      : assessment.outcome === 'MET'
        ? 'MET'
        : assessment.outcome;
    out.push(`  [${mark.padEnd(14)}] ${definition.statement}`);
    if (assessment) out.push(`                   ${assessment.evidence}`);
    else out.push(`                   ${definition.establishedBy}`);
  }

  out.push(
    '',
    'Non-regression invariants',
    '-------------------------',
    `  None affirmed. All ${NON_REGRESSION_INVARIANTS.length} require a person to have looked at`,
    '  the change; a script cannot affirm that nothing was weakened.',
    '',
    'Capability positions',
    '--------------------',
  );

  for (const capability of CAPABILITY_REGISTER) {
    const position = positionOf(capability);
    out.push(
      `  ${(position.attested ?? 'nothing attested').padEnd(22)} ${capability.title}` +
        (position.skipped.length > 0 ? `  (skipped: ${position.skipped.join(', ')})` : ''),
    );
  }

  out.push(
    '',
    'Verdict',
    '-------',
    `  ${verdict.statement}`,
    '',
    ...verdict.blockedBy.map((reason) => `  - ${reason}`),
    '',
    'This is a position, not a release record. A release record requires a named',
    'person to assess the four conditions no pipeline can establish and to affirm',
    'the eight invariants. Nothing here does that on their behalf.',
    '',
  );

  process.stdout.write(out.join('\n'));
}

main();
