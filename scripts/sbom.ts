#!/usr/bin/env tsx
/**
 * Generate a CycloneDX software bill of materials, per deployable.
 *
 * Contract v3.2 lists **dependency integrity** among the security requirements,
 * and the practical argument for this arrived during a build session in which
 * `pnpm audit` reported clean, then two newly published high-severity
 * advisories, then clean again — without a line of this repository changing.
 *
 * WHAT AN SBOM IS FOR, AND WHAT IT IS NOT
 *
 * A clean audit is a point-in-time fact about the advisory database. It answers
 * "is anything known to be wrong right now". It cannot answer the question that
 * actually arrives after an incident: **what was in the build we shipped eight
 * weeks ago.** Only a recorded inventory answers that, and a dependency tree
 * reconstructed later from a version range is a guess.
 *
 * So this emits one SBOM per deployable — api, worker, web — from the resolved
 * lockfile rather than from the declared ranges, because `^4.1.0` is an
 * intention and `4.1.3` is what ran.
 *
 * WHY PRODUCTION ONLY
 *
 * The audit's noise this session was entirely in `eslint` and
 * `@vitest/coverage-v8`. Neither is in any shipped image, and including them
 * would make every SBOM read as though a linter were part of the product —
 * which would be the same overclaiming this repository refuses elsewhere, in
 * the one document an incident responder most needs to be literal.
 *
 * The dev tree is not ignored: it is emitted separately and labelled, so the
 * question "what did we build it with" is also answerable without the two being
 * confused.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'var', 'sbom');

/** The things that actually get deployed. */
const DEPLOYABLES = ['@adericel/api', '@adericel/worker', '@adericel/web'] as const;

interface PnpmNode {
  readonly version?: string;
  readonly dependencies?: Record<string, PnpmNode>;
}

interface PnpmRoot {
  readonly dependencies?: Record<string, PnpmNode>;
  readonly devDependencies?: Record<string, PnpmNode>;
}

interface Component {
  readonly name: string;
  readonly version: string;
}

function listed(filter: string, dev: boolean): readonly Component[] {
  const out = execFileSync(
    'pnpm',
    ['ls', '--depth=Infinity', dev ? '--dev' : '--prod', '--json', '--filter', filter],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );

  /**
   * Keyed by name AND version, not by name.
   *
   * The first version of this keyed by name and reported 71 components where 75
   * were installed: four packages — `fastify-plugin`, `process-warning`,
   * `fast-uri`, `real-require` — are present at two versions each, which is
   * ordinary in a transitive tree. Keeping one silently dropped the other.
   *
   * That is the worst possible place to be lossy. An incident responder asking
   * "are we running the version this advisory affects" would have got a
   * confident no from a document that had thrown the answer away.
   */
  const seen = new Set<string>();
  const walk = (deps: Record<string, PnpmNode> | undefined): void => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const version = info.version ?? '';
      // A workspace link is this repository's own code, already in the
      // repository and already versioned by the commit. Listing it as a
      // third-party component would misreport what was obtained from a registry.
      if (!version.startsWith('link:') && version !== '') seen.add(`${name}\u0000${version}`);
      walk(info.dependencies);
    }
  };

  for (const root of JSON.parse(out) as PnpmRoot[]) {
    walk(dev ? root.devDependencies : root.dependencies);
  }

  return [...seen]
    .map((key) => {
      const [name = '', version = ''] = key.split('\u0000');
      return { name, version };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * A CycloneDX 1.5 document.
 *
 * Deliberately without a `metadata.timestamp`. A timestamp would make two SBOMs
 * of an identical dependency tree differ, and the property worth having is that
 * the same input produces the same document — so a release can be checked
 * against its SBOM by regenerating it, exactly as the generated documents in
 * `docs/` are checked.
 */
function cycloneDx(
  subject: string,
  kind: 'production' | 'development',
  components: readonly Component[],
): string {
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: { type: 'application', name: subject, version: releaseVersion() },
      properties: [
        { name: 'adericel:scope', value: kind },
        {
          name: 'adericel:source',
          value: 'pnpm resolved lockfile, not declared ranges',
        },
        { name: 'adericel:commit', value: commit() },
      ],
    },
    components: components.map((component) => ({
      type: 'library',
      name: component.name,
      version: component.version,
      purl: `pkg:npm/${component.name.replace('@', '%40')}@${component.version}`,
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function commit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function releaseVersion(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '0.0.0-unreleased';
  }
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const written: { file: string; components: number; digest: string }[] = [];

  for (const deployable of DEPLOYABLES) {
    const short = deployable.replace('@adericel/', '');
    for (const kind of ['production', 'development'] as const) {
      const components = listed(deployable, kind === 'development');
      const body = cycloneDx(deployable, kind, components);
      const file = path.join(OUT_DIR, `${short}.${kind}.cdx.json`);
      writeFileSync(file, body, 'utf8');
      written.push({
        file: path.relative(ROOT, file),
        components: components.length,
        // The digest is over the document, so a release record can cite one
        // line rather than a file nobody will diff.
        digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      });
    }
  }

  for (const entry of written) {
    process.stdout.write(
      `${entry.file.padEnd(42)} ${String(entry.components).padStart(4)} components  ${entry.digest}\n`,
    );
  }
  process.stdout.write(
    '\nProduction scopes contain only what ships. The development scope is listed\n' +
      'separately and labelled, so "what is in the product" and "what we built it\n' +
      'with" cannot be confused for one another.\n',
  );
}

main();
