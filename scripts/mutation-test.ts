#!/usr/bin/env tsx
/**
 * Run the mutation registry.
 *
 * For each recorded mutation: apply the edit, run only the suite that should
 * care, and assert the named tests fail. A mutation whose test still passes is
 * reported as SURVIVED — which means the guard has rotted, not that the mutation
 * is wrong.
 *
 * SAFETY, BECAUSE THIS EDITS SOURCE FILES
 *
 * Three rules, none of them optional:
 *
 *   1. It refuses to start on a dirty working tree. A crash mid-run would
 *      otherwise leave a mutated file indistinguishable from work in progress.
 *   2. Every file is restored in a `finally`, and the restoration is verified by
 *      re-reading the file. A silent failure to restore would leave a defect in
 *      the tree that the next test run might not catch.
 *   3. `find` must match exactly once. Zero matches means the code moved and the
 *      mutation is stale; more than one means it would patch somewhere
 *      unintended. Either way a survival would mean nothing, so both are errors
 *      rather than warnings.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { MUTATIONS, type Mutation } from '../tests/mutation/registry.js';

const ROOT = process.cwd();

type Outcome = 'KILLED' | 'SURVIVED' | 'STALE' | 'AMBIGUOUS' | 'SKIPPED';

interface Result {
  readonly mutation: Mutation;
  readonly outcome: Outcome;
  readonly detail: string;
}

function assertCleanTree(): void {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (status.trim() !== '') {
    process.stderr.write(
      'Refusing to run: the working tree has uncommitted changes.\n\n' +
        'This script edits source files and restores them. If it is interrupted while the tree ' +
        'is already dirty, a mutated file is indistinguishable from your own work in progress.\n' +
        'Commit or stash first.\n',
    );
    process.exit(2);
  }
}

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString:
      process.env.TEST_DATABASE_URL ?? 'postgres://adericel:adericel@localhost:5432/adericel_test',
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Run one suite and return the names of the tests that failed. */
function failingTests(suite: string): readonly string[] {
  try {
    execFileSync(
      'pnpm',
      ['-s', 'vitest', 'run', suite, '--reporter=json', '--outputFile=.mutation-report.json'],
      {
        cwd: ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
      },
    );
  } catch {
    // A non-zero exit is the expected case: tests failed, which is the point.
  }
  try {
    const report = JSON.parse(readFileSync(path.join(ROOT, '.mutation-report.json'), 'utf8')) as {
      testResults?: { assertionResults?: { title: string; status: string }[] }[];
    };
    return (report.testResults ?? []).flatMap((file) =>
      (file.assertionResults ?? [])
        .filter((test) => test.status === 'failed')
        .map((test) => test.title),
    );
  } catch {
    // No parseable report at all: the suite did not run. Reported rather than
    // treated as a kill, because a compile error failing everything proves
    // nothing about the guard.
    return [];
  }
}

/**
 * Undo anything the suite changed beyond the file we patched.
 *
 * Found by running the harness: the capability-register mutation is checked by a
 * suite whose drift test **regenerates** `CAPABILITY_STATUS.md`, so the mutated
 * path was written into a committed document and restoring the source file left
 * it behind. A harness that leaves a deliberate defect in the tree is worse than
 * no harness at all.
 *
 * The tree was verified clean before the run, so anything dirty afterwards is
 * this script's own doing and can be discarded without judgement.
 */
function restoreEverythingElse(mutation: Mutation): void {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((name) => name !== '');
  if (dirty.length === 0) return;
  execFileSync('git', ['checkout', '--', '.'], { cwd: ROOT, stdio: 'pipe' });
  process.stdout.write(
    `    (${mutation.id} also changed ${dirty.join(', ')} through its suite; restored)\n`,
  );
}

async function run(): Promise<void> {
  assertCleanTree();
  const hasDatabase = await databaseAvailable();
  const only = process.argv[2];

  const results: Result[] = [];

  for (const mutation of MUTATIONS) {
    if (only !== undefined && mutation.id !== only) continue;

    if (mutation.needsDatabase === true && !hasDatabase) {
      results.push({
        mutation,
        outcome: 'SKIPPED',
        detail: 'No test database reachable; this mutation needs one.',
      });
      continue;
    }

    const file = path.join(ROOT, mutation.file);
    const original = readFileSync(file, 'utf8');
    const occurrences = original.split(mutation.find).length - 1;

    if (occurrences === 0) {
      results.push({
        mutation,
        outcome: 'STALE',
        detail: `The text to mutate is no longer in ${mutation.file}. The code moved; update the registry.`,
      });
      continue;
    }
    if (occurrences > 1) {
      results.push({
        mutation,
        outcome: 'AMBIGUOUS',
        detail: `Matches ${occurrences} places in ${mutation.file}. Narrow it, or it patches somewhere unintended.`,
      });
      continue;
    }

    try {
      writeFileSync(file, original.replace(mutation.find, mutation.replace), 'utf8');
      const failed = failingTests(mutation.suite);
      const missing = mutation.mustFail.filter(
        (name) => !failed.some((actual) => actual.includes(name)),
      );

      results.push(
        missing.length === 0
          ? {
              mutation,
              outcome: 'KILLED',
              detail: `${mutation.mustFail.length} named test(s) failed, as they must.`,
            }
          : {
              mutation,
              outcome: 'SURVIVED',
              detail:
                `These tests did NOT fail with the guard broken:\n      ${missing.join('\n      ')}` +
                (failed.length > 0
                  ? `\n    (what did fail: ${failed.join('; ')})`
                  : '\n    (nothing failed at all)'),
            },
      );
    } finally {
      writeFileSync(file, original, 'utf8');
      // Verified rather than assumed. A restoration that silently failed would
      // leave a deliberate defect in the tree.
      if (readFileSync(file, 'utf8') !== original) {
        process.stderr.write(
          `\nFAILED TO RESTORE ${mutation.file} — run \`git checkout\` on it now.\n`,
        );
        process.exit(3);
      }
      restoreEverythingElse(mutation);
    }
  }

  report(results);
}

function report(results: readonly Result[]): void {
  const width = Math.max(...results.map((r) => r.mutation.id.length), 10);
  process.stdout.write('\nMutation testing\n================\n\n');

  for (const { mutation, outcome, detail } of results) {
    process.stdout.write(
      `  [${outcome.padEnd(9)}] ${mutation.id.padEnd(width)}  ${mutation.invariant}\n`,
    );
    if (outcome !== 'KILLED') process.stdout.write(`    ${detail}\n`);
  }

  const counts = new Map<Outcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const bad =
    (counts.get('SURVIVED') ?? 0) + (counts.get('STALE') ?? 0) + (counts.get('AMBIGUOUS') ?? 0);

  process.stdout.write(
    `\n  ${counts.get('KILLED') ?? 0} killed, ${counts.get('SURVIVED') ?? 0} survived, ` +
      `${counts.get('STALE') ?? 0} stale, ${counts.get('AMBIGUOUS') ?? 0} ambiguous, ` +
      `${counts.get('SKIPPED') ?? 0} skipped\n\n`,
  );

  if (bad > 0) {
    process.stdout.write(
      '  A SURVIVED mutation means the guard has rotted: the test would still pass with the\n' +
        '  invariant broken. A STALE one means the code moved and the registry needs updating.\n' +
        '  Neither is a reason to delete the entry.\n\n',
    );
    process.exit(1);
  }
}

await run();
