import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every command this repository offers can actually run.
 *
 * `openapi:emit` pointed at `scripts/emit-openapi.ts`, which was never
 * committed. The command had always been broken and nothing noticed, because
 * nothing ran it — the same shape as the exported functions nothing calls
 * (RR-086, RR-088), arriving from the other direction: not behaviour declared
 * and never reached, but a *command* declared and never real.
 *
 * A broken command is worse than a missing one. Somebody reading
 * `package.json` to find out how to regenerate an artefact learns a command
 * that fails, and has to go and find out whether the artefact matters.
 */

const ROOT = join(import.meta.dirname, '..', '..');

interface Manifest {
  readonly scripts?: Record<string, string>;
}

describe('the commands this repository offers', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
  const scripts = Object.entries(manifest.scripts ?? {});

  it('names a real file wherever a script runs one', () => {
    /**
     * Only paths that look like a repository file are checked.
     *
     * A script invoking `vitest`, `eslint` or `docker compose` names a binary,
     * not a path, and resolving those is the package manager's job. What is
     * checked is the case that silently rots: a relative path to a `.ts`,
     * `.mjs`, `.js`, `.sh` or `.sql` file inside this tree.
     */
    const missing: string[] = [];
    for (const [name, command] of scripts) {
      for (const token of command.split(/\s+/)) {
        if (!/^[\w./-]+\.(ts|tsx|mjs|cjs|js|sh|sql)$/.test(token)) continue;
        // A glob is a pattern, not a path; `vitest run tests/unit` is a
        // directory. Both are out of scope for this check.
        if (token.includes('*')) continue;
        /**
         * Build outputs are out of scope, and leaving them in was a defect.
         *
         * `start:api` names `apps/api/dist/main.js`, which exists after a build
         * and not before. This check passed locally because a build had run and
         * failed in CI's unit job, which deliberately does not build — so the
         * repository's own fast-feedback job was red for a path that was never
         * supposed to be in the tree.
         *
         * What the check is for survives: a command naming a **source** file
         * that does not exist. `pnpm dev` pointing at a script nobody committed
         * is the defect it was written for, and that is still caught.
         */
        if (/(^|\/)dist\//.test(token)) continue;
        if (!existsSync(join(ROOT, token))) missing.push(`${name} -> ${token}`);
      }
    }
    expect(
      missing,
      'These commands name files that do not exist. A command that cannot run is worse than one ' +
        'that is missing: somebody reads package.json to learn how to regenerate something and ' +
        'is handed a failure.',
    ).toEqual([]);
  });

  it('checks enough commands to be worth having', () => {
    // A guard on the guard. If the manifest moved or the regex stopped
    // matching, the test above would pass over an empty set and prove nothing.
    const withFilePaths = scripts.filter(([, command]) =>
      command.split(/\s+/).some((t) => /^[\w./-]+\.(ts|tsx|mjs|cjs|js|sh|sql)$/.test(t)),
    );
    expect(withFilePaths.length).toBeGreaterThan(5);
  });
});
