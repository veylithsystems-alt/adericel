import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Deployment configuration, checked statically.
 *
 * These exist because the shipped deployment could not serve a request. Compose
 * passed `N8N_DOMAIN: ${N8N_DOMAIN:-}` — an EMPTY string — and Caddy's
 * `{$VAR:default}` substitutes its default only when a variable is UNSET. The
 * empty value expanded to nothing, producing a site block with no address, and
 * Caddy refused the entire configuration with "server block without any key".
 * Every deployment that did not run n8n — the default, since n8n is an optional
 * profile — had a reverse proxy in a crash loop and no route to the API or the
 * interface at all.
 *
 * Nothing caught it because nobody had brought the stack up. A build that
 * succeeds and a deployment that serves traffic are different claims.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const composeRaw = readFileSync(`${root}/docker-compose.yml`, 'utf8');
/**
 * Comments are stripped before scanning. They discuss the very patterns being
 * searched for — the note explaining this defect quotes it verbatim — and a
 * check that fails on its own explanation is a check nobody keeps.
 */
const compose = composeRaw
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const caddyfile = readFileSync(`${root}/infrastructure/docker/Caddyfile`, 'utf8');

/** Variables the Caddyfile reads with a fallback: `{$NAME:fallback}`. */
function caddyPlaceholdersWithDefaults(): string[] {
  const names = new Set<string>();
  for (const match of caddyfile.matchAll(/\{\$([A-Z0-9_]+):[^}]*\}/g)) names.add(match[1]!);
  return [...names].sort();
}

/** Variables compose passes with an empty fallback: `${NAME:-}`. */
function composeEmptyDefaults(): string[] {
  const names = new Set<string>();
  for (const match of compose.matchAll(/\$\{([A-Z0-9_]+):-\}/g)) names.add(match[1]!);
  return [...names].sort();
}

/** Environment keys the caddy service is given. */
function caddyServiceEnvironment(): string[] {
  const block = /\n {2}caddy:\n([\s\S]*?)(?=\n {2}[a-z]|\nvolumes:)/.exec(compose);
  if (!block) return [];
  const env = /\n {4}environment:\n([\s\S]*?)(?=\n {4}[a-z]|\n {2}[a-z])/.exec(block[1]!);
  if (!env) return [];
  return [...env[1]!.matchAll(/^\s+([A-Z0-9_]+):/gm)].map((m) => m[1]!);
}

describe('deployment configuration', () => {
  it('reads the files it is checking', () => {
    expect(compose.length).toBeGreaterThan(1000);
    expect(caddyfile.length).toBeGreaterThan(500);
  });

  it('never passes an empty string where the Caddyfile relies on its own default', () => {
    // Caddy substitutes `{$VAR:default}` only when VAR is UNSET. Passing an
    // empty value defeats the default and, for a site address, breaks the whole
    // configuration rather than that one block.
    const placeholders = new Set(caddyPlaceholdersWithDefaults());
    const emptied = composeEmptyDefaults().filter((name) => placeholders.has(name));
    expect(
      emptied,
      'compose passes these as empty strings, defeating the Caddyfile default and breaking the proxy',
    ).toEqual([]);
  });

  it('gives every Caddyfile placeholder a value the proxy can use', () => {
    const provided = new Set(caddyServiceEnvironment());
    const missing = caddyPlaceholdersWithDefaults()
      .filter((name) => !name.startsWith('ACME_'))
      .filter((name) => !provided.has(name));
    // A site address that resolves to nothing is a configuration Caddy rejects
    // outright, so an unprovided one is not a partial failure.
    expect(missing, 'the caddy service is not given these').toEqual([]);
  });

  it('every site block in the Caddyfile has an address', () => {
    // The global options block is the only keyless block permitted, and only as
    // the first one. Anything else keyless is the failure this suite exists for.
    const keyless = [...caddyfile.matchAll(/^\{\s*$/gm)];
    expect(keyless.length).toBeLessThanOrEqual(1);
    const firstBrace = caddyfile.indexOf('\n{\n');
    const firstSite = caddyfile.search(/^\{\$/m);
    if (keyless.length === 1 && firstSite >= 0) {
      expect(firstBrace).toBeLessThan(firstSite);
    }
  });

  it('requires notification configuration the API refuses to start without', () => {
    // Production start-up rejects a channel that cannot reach a person. A
    // compose file that does not pass these produces a stack whose API and
    // worker crash-loop on boot, which is exactly what happened.
    for (const key of ['NOTIFY_DRIVER', 'NOTIFY_FROM_ADDRESS', 'NOTIFY_HTTP_ENDPOINT']) {
      expect(compose, `compose does not pass ${key} to the application`).toContain(key);
    }
  });

  it('mounts no host path that the repository does not contain', () => {
    // A bind mount to a missing directory is created by Docker as an empty
    // root-owned directory, which looks like a working mount and is not.
    const mounts = [...compose.matchAll(/- \.\/([^:\s]+):/g)].map((m) => m[1]!);
    const missing = mounts.filter((relative) => !existsSync(`${root}/${relative}`));
    expect(missing, 'these bind mounts point at paths that do not exist').toEqual([]);
  });

  it('publishes only the proxy to the host', () => {
    // PostgreSQL, MinIO, n8n and the API are reachable only on the compose
    // network. A stray `ports:` on any of them puts a database on the internet.
    const published = [...compose.matchAll(/^\s+- '(\d+):(\d+)'/gm)].map((m) => m[1]!);
    expect(published.sort()).toEqual(['443', '80']);
  });
});
