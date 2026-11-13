import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@adericel/shared';

/**
 * The first three commands anybody runs against this repository.
 *
 * The README says:
 *
 *     cp .env.example .env          # defaults are fine for local work
 *     pnpm db:migrate
 *     pnpm dev                      # API on :4000, interface on :5173
 *
 * Every one of those failed, in four separate ways, and nothing caught it
 * because nothing in CI follows the quickstart:
 *
 *   1. `pnpm dev` pointed at `scripts/dev.mjs`, which had never been committed.
 *   2. Nothing loaded `.env`, so `pnpm db:migrate` and the API both reported
 *      `DATABASE_URL is not set` while the file sat there containing it.
 *   3. `AUTH_JWT_SECRET` and `AUTH_CREDENTIAL_ENCRYPTION_KEY` were blank, so
 *      the API and worker refused to start on a length check.
 *   4. `STORAGE_DRIVER` was `s3`, so the worker died pinging a bucket a
 *      developer on a laptop does not have — leaving a running API and
 *      interface with nothing collecting or assessing anything.
 *
 * A quickstart that does not work is worse than none. It is the first thing an
 * evaluating MSP tries, it fails in a way that looks like the product is
 * broken, and the README's own claim that the defaults are fine is the thing
 * that made it embarrassing rather than merely inconvenient.
 *
 * This asserts the shape of the promise: that the example file alone produces a
 * configuration the product accepts. It cannot start the processes — that is
 * what running `pnpm dev` does — so `tests/unit/scripts-resolve.test.ts` guards
 * the commands existing and this guards their configuration being usable.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** `.env.example` parsed the way Node's `--env-file` reads it. */
function exampleEnvironment(): Record<string, string> {
  const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    out[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return out;
}

describe('the quickstart in the README', () => {
  const example = exampleEnvironment();

  it('produces a configuration the product accepts, with nothing added', () => {
    /**
     * The whole promise, in one assertion. `loadConfig` is what the API and
     * the worker both call on startup, so if it throws here they would have
     * refused to start — which is exactly what happened on a blank
     * `AUTH_JWT_SECRET`.
     */
    expect(() => loadConfig({ ...example, NODE_ENV: 'development' })).not.toThrow();
  });

  it('points storage somewhere a laptop actually has', () => {
    // `s3` here killed the worker on startup. A developer would have seen a
    // working interface and an estate that never updated.
    expect(
      example.STORAGE_DRIVER,
      'the example configuration points at object storage, which a developer following the ' +
        'quickstart does not have. The worker pings storage on startup and dies.',
    ).toBe('filesystem');
  });

  it('ships development secrets that production refuses by name', () => {
    /**
     * These are safe to ship *because* they are known: `assertProductionSafety`
     * rejects both by value when `NODE_ENV` is production. Shipping blanks
     * instead is what broke the quickstart; shipping a plausible-looking
     * random value would be far worse, because it would start in production.
     */
    expect(example.AUTH_JWT_SECRET?.length ?? 0).toBeGreaterThanOrEqual(32);
    expect(example.AUTH_CREDENTIAL_ENCRYPTION_KEY?.length ?? 0).toBeGreaterThanOrEqual(32);

    /**
     * And production refuses the whole file, naming each setting.
     *
     * Stronger than it needed to be, and worth asserting as it stands: the
     * same example that makes a laptop work is rejected item by item when
     * `NODE_ENV` is production — the secrets, the filesystem driver, and the
     * notifier that cannot reach a person. Somebody who copies this file onto
     * a server is told exactly what to change rather than running a product
     * with a published key.
     */
    let refusal: unknown;
    try {
      loadConfig({ ...example, NODE_ENV: 'production' });
    } catch (error) {
      refusal = error;
    }
    expect(refusal, 'the example configuration started in production').toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toContain('AUTH_JWT_SECRET is a dev placeholder');
    expect(message).toContain('AUTH_CREDENTIAL_ENCRYPTION_KEY is a dev placeholder');
    expect(message).toContain('STORAGE_DRIVER=filesystem is not supported in production');
  });

  it('loads the file for every development command that needs it', () => {
    /**
     * The fix for (2), asserted where it can rot.
     *
     * `--env-file-if-exists` is on the development commands and deliberately
     * **not** on `start:api` or `start:worker`. A production entry point must
     * take its configuration from the environment the orchestrator gives it,
     * never from a file that happens to be on the disk.
     */
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['db:migrate', 'db:seed', 'dev:api', 'dev:worker']) {
      expect(manifest.scripts[name], `${name} does not read .env`).toContain(
        '--env-file-if-exists=.env',
      );
    }
    for (const name of ['start:api', 'start:worker']) {
      expect(
        manifest.scripts[name],
        `${name} is a production entry point and must not read a file from the disk`,
      ).not.toContain('--env-file');
    }
  });

  it('names the commands the README tells somebody to run', () => {
    // A guard on the guard: if the README's quickstart changes to different
    // commands, the assertions above are testing something nobody runs.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const command of ['cp .env.example .env', 'pnpm db:migrate', 'pnpm dev']) {
      expect(readme, `the README no longer tells anybody to run ${command}`).toContain(command);
    }
  });
});
