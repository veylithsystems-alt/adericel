import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'var', 'sbom');

/**
 * The software bill of materials.
 *
 * Contract v3.2 lists dependency integrity among the security requirements. The
 * practical case arrived during a build session in which `pnpm audit` reported
 * clean, then two newly published high-severity advisories, then clean again,
 * without a line of this repository changing.
 *
 * An audit answers "is anything known to be wrong right now". An SBOM answers
 * the question that arrives after an incident: **what was in the build we
 * shipped.** These tests guard the properties that make the second answer
 * trustworthy.
 */

interface Bom {
  readonly bomFormat: string;
  readonly specVersion: string;
  readonly metadata: {
    readonly component: { readonly name: string; readonly version: string };
    readonly properties: readonly { readonly name: string; readonly value: string }[];
  };
  readonly components: readonly {
    readonly name: string;
    readonly version: string;
    readonly purl: string;
  }[];
}

const FILES = [
  'api.production.cdx.json',
  'api.development.cdx.json',
  'worker.production.cdx.json',
  'worker.development.cdx.json',
  'web.production.cdx.json',
  'web.development.cdx.json',
] as const;

function read(file: string): Bom {
  return JSON.parse(readFileSync(join(OUT, file), 'utf8')) as Bom;
}

describe('the software bill of materials', () => {
  beforeAll(() => {
    // Generated rather than assumed present: a committed SBOM is a snapshot,
    // and these tests are about the generator.
    execFileSync('pnpm', ['-s', 'sbom'], { cwd: ROOT, stdio: 'pipe' });
  }, 180_000);

  it('emits one per deployable, for both scopes', () => {
    const missing = FILES.filter((file) => !existsSync(join(OUT, file)));
    expect(missing).toEqual([]);
  });

  it('is valid CycloneDX', () => {
    for (const file of FILES) {
      const bom = read(file);
      expect(bom.bomFormat, file).toBe('CycloneDX');
      expect(bom.specVersion, file).toBe('1.5');
      expect(bom.components.length, file).toBeGreaterThan(0);
    }
  });

  it('lists every installed version of a package, not one per name', () => {
    /**
     * The defect this test exists for, which was written and then fixed.
     *
     * The generator originally keyed its component map by package name and
     * reported 71 components where 75 were installed: four packages are present
     * at two versions each, which is ordinary in a transitive tree. Keeping one
     * silently dropped the other.
     *
     * That is the worst possible place to be lossy. An incident responder
     * asking "are we running the version this advisory affects" would have had
     * a confident no from a document that threw the answer away.
     */
    const bom = read('api.production.cdx.json');
    const byName = new Map<string, Set<string>>();
    for (const component of bom.components) {
      byName.set(
        component.name,
        (byName.get(component.name) ?? new Set<string>()).add(component.version),
      );
    }

    const multiVersion = [...byName.entries()].filter(([, versions]) => versions.size > 1);
    expect(
      multiVersion.length,
      'No package appears at two versions, which is suspicious for a transitive tree of this ' +
        'size — the generator may be collapsing versions again.',
    ).toBeGreaterThan(0);

    // And the component count must equal the distinct name@version count, so a
    // collapse would show up as a mismatch rather than as a plausible number.
    const pairs = new Set(bom.components.map((c) => `${c.name}@${c.version}`));
    expect(pairs.size).toBe(bom.components.length);
  });

  it('keeps what ships separate from what it was built with', () => {
    /**
     * Both audit surprises this session were in `eslint` and
     * `@vitest/coverage-v8`. Neither is in any shipped image, and a single
     * merged SBOM would read as though a linter were part of the product — in
     * the one document an incident responder most needs to be literal.
     */
    const production = read('api.production.cdx.json');
    const names = new Set(production.components.map((c) => c.name));

    /**
     * Type packages are the discriminator, not `eslint`.
     *
     * A mutation that made the production scope list the dev tree killed the
     * wrong test, which is how this was found: `eslint` and `vitest` live in the
     * root manifest, not in the API's own devDependencies, so asserting their
     * absence from an API SBOM proved nothing. `@types/node` and `@types/pg`
     * are genuinely in the API's dev scope and genuinely must not ship — a
     * type definition in a production inventory is a component that does not
     * exist at runtime.
     */
    for (const devOnly of ['@types/node', '@types/pg', 'undici-types']) {
      expect(names, `${devOnly} is in the production SBOM`).not.toContain(devOnly);
    }

    // And the production scope must actually hold what ships, or an empty
    // production SBOM would satisfy every absence check above.
    for (const shipped of ['fastify', 'pg', 'zod']) {
      expect(names, `${shipped} is missing from the production SBOM`).toContain(shipped);
    }

    for (const file of FILES) {
      const bom = read(file);
      const scope = bom.metadata.properties.find((p) => p.name === 'adericel:scope')?.value;
      expect(scope, file).toBe(file.includes('.development.') ? 'development' : 'production');
    }
  });

  it('records the commit, so the inventory is tied to a build', () => {
    // An SBOM that does not say which commit it describes is an inventory of
    // nothing in particular.
    for (const file of FILES) {
      const commit = read(file).metadata.properties.find(
        (p) => p.name === 'adericel:commit',
      )?.value;
      expect(commit, file).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('states that it came from the lockfile rather than the declared ranges', () => {
    // `^4.1.0` is an intention; `4.1.3` is what ran. A reader has to be able to
    // tell which this document holds.
    for (const file of FILES) {
      const source = read(file).metadata.properties.find(
        (p) => p.name === 'adericel:source',
      )?.value;
      expect(source, file).toMatch(/resolved lockfile/);
    }
  });

  it('produces the same document twice for an unchanged tree', () => {
    /**
     * No timestamp, deliberately. A release can then be checked against its
     * SBOM by regenerating it — the same property the generated documents in
     * `docs/` have — and two SBOMs of an identical tree are identical rather
     * than differing by when somebody ran the command.
     */
    const before = readFileSync(join(OUT, 'api.production.cdx.json'), 'utf8');
    execFileSync('pnpm', ['-s', 'sbom'], { cwd: ROOT, stdio: 'pipe' });
    const after = readFileSync(join(OUT, 'api.production.cdx.json'), 'utf8');
    expect(after).toBe(before);
    expect(before).not.toMatch(/timestamp/);
  }, 180_000);

  it('gives every component a package URL a tool can resolve', () => {
    for (const file of FILES) {
      for (const component of read(file).components) {
        expect(component.purl, `${file} ${component.name}`).toMatch(/^pkg:npm\//);
        expect(component.purl, `${file} ${component.name}`).toContain(component.version);
      }
    }
  });
});
