import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUTATIONS } from '../mutation/registry.js';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * The mutation registry, checked without running it.
 *
 * `pnpm test:mutation` applies every recorded edit and takes a couple of
 * minutes. These checks are the ones worth having at unit-test speed, because
 * each catches a way the registry stops meaning anything **without** the harness
 * reporting a failure:
 *
 *   - a `find` that no longer matches is a mutation that silently tests nothing,
 *   - one that matches twice patches somewhere unintended,
 *   - a suite path that moved runs no tests at all,
 *   - and a `replace` equal to its `find` is not a mutation.
 *
 * The harness reports the first two as STALE and AMBIGUOUS rather than as
 * passes. This file makes them fail in the fast suite as well, so a refactor
 * that moves the code is caught by whoever made it rather than by CI ten
 * minutes later.
 */
describe('the mutation registry', () => {
  it('records mutations to check', () => {
    // A guard on the guard: every loop below would pass vacuously over an empty
    // registry, and an empty registry is exactly what a frustrated engineer
    // produces when the harness is in the way.
    expect(MUTATIONS.length).toBeGreaterThan(15);
  });

  it('gives every mutation a distinct id', () => {
    const ids = MUTATIONS.map((m) => m.id);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicated).toEqual([]);
  });

  it('points every mutation at a file that exists', () => {
    const missing = MUTATIONS.filter((m) => !existsSync(join(ROOT, m.file))).map(
      (m) => `${m.id} -> ${m.file}`,
    );
    expect(missing).toEqual([]);
  });

  it('matches each target exactly once, so nothing is patched by accident', () => {
    const wrong = MUTATIONS.map((m) => {
      const source = readFileSync(join(ROOT, m.file), 'utf8');
      const count = source.split(m.find).length - 1;
      return { id: m.id, file: m.file, count };
    }).filter((entry) => entry.count !== 1);

    expect(
      wrong,
      `These mutations do not match their target exactly once:\n${wrong
        .map((w) => `  ${w.id} matches ${w.count} time(s) in ${w.file}`)
        .join('\n')}\n` +
        'Zero means the code moved and the mutation now tests nothing. More than one means it ' +
        'would patch somewhere unintended.',
    ).toEqual([]);
  });

  it('points every mutation at a suite that exists', () => {
    const missing = MUTATIONS.filter((m) => !existsSync(join(ROOT, m.suite))).map(
      (m) => `${m.id} -> ${m.suite}`,
    );
    expect(missing).toEqual([]);
  });

  it('names at least one test that must fail, for every mutation', () => {
    // "Some test failed" would be satisfied by a compile error, which proves
    // nothing about the guard. Each mutation names the tests it expects.
    const unnamed = MUTATIONS.filter((m) => m.mustFail.length === 0).map((m) => m.id);
    expect(unnamed).toEqual([]);
  });

  it('actually changes something, in every case', () => {
    const inert = MUTATIONS.filter((m) => m.find === m.replace).map((m) => m.id);
    expect(inert).toEqual([]);
  });

  it('names the tests it expects, in the words the suite uses', () => {
    /**
     * A `mustFail` entry that matches no test title in its suite would be
     * reported as SURVIVED forever — the harness would be looking for a test
     * that does not exist and correctly never seeing it fail. That reads as a
     * rotted guard when it is a typo, and the two need different fixes.
     */
    const unmatched: string[] = [];
    for (const mutation of MUTATIONS) {
      const suite = readFileSync(join(ROOT, mutation.suite), 'utf8');
      for (const name of mutation.mustFail) {
        // Apostrophes differ between the straight and typographic forms, and a
        // title written one way and quoted the other is the likeliest typo.
        const normalise = (text: string) => text.replace(/[‘’']/g, "'");
        if (!normalise(suite).includes(normalise(name))) {
          unmatched.push(`${mutation.id}: "${name}" is not a test title in ${mutation.suite}`);
        }
      }
    }
    expect(unmatched).toEqual([]);
  });

  it('gives every mutation an invariant a reader can understand', () => {
    /**
     * Length only.
     *
     * A keyword check was tried here — "must", "never", "cannot" — and it failed
     * on "A pipeline **may not** establish a condition that needs a named
     * person", which is a perfectly good invariant. Matching prose against a
     * keyword list is the same mistake as trying to catch unlabelled promises by
     * scanning for "will": English has too many ways to say a thing for a regex
     * to judge whether it was said well.
     */
    for (const mutation of MUTATIONS) {
      expect(mutation.invariant.length, mutation.id).toBeGreaterThan(30);
    }
  });
});
