import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@adericel/shared';
import { describe, expect, it } from 'vitest';

/**
 * Architectural boundaries, enforced rather than described.
 *
 * A layering rule that lives only in a document is one that holds until the
 * first person in a hurry. These are the rules that, if broken, would be
 * expensive to unpick later — a dependency cycle, a package reaching past its
 * layer, or a component opening its own database connection and stepping around
 * tenant isolation entirely.
 */

const ROOT = join(import.meta.dirname, '..', '..');

function packageNames(): string[] {
  return readdirSync(join(ROOT, 'packages')).filter((name) =>
    statSync(join(ROOT, 'packages', name)).isDirectory(),
  );
}

function manifest(pkg: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8')) as never;
}

function internalDeps(pkg: string): string[] {
  const m = manifest(pkg);
  return [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})]
    .filter((name) => name.startsWith('@adericel/'))
    .map((name) => name.replace('@adericel/', ''));
}

/** Every .ts file under a directory, excluding build output. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('package layering', () => {
  it('has no dependency cycles', () => {
    // A cycle between packages makes the build order undefined and, worse,
    // means two packages can no longer be reasoned about separately.
    const graph = new Map(packageNames().map((pkg) => [pkg, internalDeps(pkg)]));
    const cycles: string[] = [];

    const visit = (node: string, path: string[]): void => {
      if (path.includes(node)) {
        cycles.push([...path.slice(path.indexOf(node)), node].join(' -> '));
        return;
      }
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    };
    for (const pkg of graph.keys()) visit(pkg, []);

    expect(cycles).toEqual([]);
  });

  it('keeps shared as a leaf', () => {
    // Everything depends on shared. The moment it depends on anything, every
    // other package inherits that dependency.
    expect(internalDeps('shared')).toEqual([]);
  });

  it('keeps the domain model free of infrastructure', () => {
    // The domain is the vocabulary. A domain that knows about databases,
    // connectors or HTTP is one that cannot be reasoned about without them.
    expect(internalDeps('domain')).toEqual(['shared']);
  });

  it('keeps the truth engine free of infrastructure', () => {
    // ADR-0002. The engine must be a pure function of its inputs, which it
    // cannot be if it can reach a database or a vendor API.
    const deps = internalDeps('truth-engine').sort();
    expect(deps).toEqual(['domain', 'shared']);
  });

  it('does not let a connector reach the database', () => {
    // A connector that could write claims directly would be deciding assurance
    // truth, which is the one thing the adapter boundary exists to prevent.
    expect(internalDeps('integrations')).not.toContain('graph');
    expect(internalDeps('integrations')).not.toContain('evidence');
  });
});

describe('database access', () => {
  it('opens connections in exactly one place', () => {
    // Every path to tenant data goes through withTenant, which sets the scope
    // and the restricted role. A component holding its own client would bypass
    // both, and the failure mode is serving one customer another's data.
    const offenders: string[] = [];
    for (const dir of ['packages', 'apps']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
        if (file.endsWith(join('graph', 'src', 'db.ts'))) continue;
        const source = readFileSync(file, 'utf8');
        if (/new pg\.(Pool|Client)\b|pool\.connect\(/.test(source)) {
          offenders.push(file.replace(ROOT, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps SQL out of the web application', () => {
    const offenders = sourceFiles(join(ROOT, 'apps', 'web', 'src')).filter((file) =>
      /\bSELECT\b.*\bFROM\b|ctx\.(query|one|many)\(/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });
});

/**
 * The company layer's own files: the only places that may name it.
 *
 * Two directories and one test directory, named once. The previous version of
 * these checks listed individual file paths, which is how a company route file
 * came to live inside the product's app for as long as it did.
 */
function isCompanyOwned(file: string): boolean {
  return (
    file.includes(join('packages', 'vaol')) ||
    file.includes(join('apps', 'veylith')) ||
    file.includes(join('tests', 'company'))
  );
}

/**
 * Source with comments removed, so a rule can be explained where it applies.
 *
 * Found by running the check: the comment in `app.ts` explaining why the
 * product no longer imports the company layer quoted the import it no longer
 * performs, and tripped the rule. A check that forbids describing itself is one
 * somebody works around by deleting the description.
 *
 * Crude on purpose — it does not understand a `//` inside a string literal, and
 * does not need to: the question asked of the result is only whether a module
 * specifier appears.
 */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

describe('the company layer stays out of the product', () => {
  it('does not let Adericel packages depend on VAOL', () => {
    // Adericel must be deployable without the company's own operating layer.
    // A customer's assurance must not depend on Veylith's sales pipeline
    // existing.
    for (const pkg of packageNames()) {
      if (pkg === 'vaol') continue;
      expect(internalDeps(pkg), pkg).not.toContain('vaol');
    }
  });

  it('names the company layer nowhere in the product, statically or dynamically', () => {
    /**
     * The rule got stronger, twice.
     *
     * First version checked `packages/` only, and the dependency was in
     * `apps/`. Second version allowed a dynamic import behind a flag, which
     * kept the company layer out of a product build's module graph — and not
     * out of the product's **source tree**: `apps/api` declared the dependency
     * in its manifest and referenced it in its TypeScript project, so giving
     * Adericel its own repository meant editing manifests on the way out. A
     * separation held by a patch script is one that eventually does not hold.
     *
     * So there is no sanctioned shape any more. The product may not name the
     * company layer at all. `apps/veylith` is the company's own deployment: it
     * depends on the product, and nothing points back.
     */
    const offenders: string[] = [];
    for (const dir of ['apps', 'packages']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        if (file.endsWith('.test.ts')) continue;
        if (isCompanyOwned(file)) continue;
        const source = code(readFileSync(file, 'utf8'));
        // Static or dynamic, by name or by path. Both are now the same defect.
        if (/['"]@adericel\/vaol['"]/.test(source) || /routes\/veylith\.js/.test(source)) {
          offenders.push(file.replace(ROOT, ''));
        }
      }
    }
    expect(offenders, 'the product names the company layer').toEqual([]);
  });

  it('declares the company layer in no product manifest or project file', () => {
    /**
     * The half that was missing, and the reason the product could not simply be
     * copied out. A source tree with no import of the company layer, whose
     * manifest still declares it and whose TypeScript project still references
     * it, is a tree that will not install or build without the company layer
     * present — and the failure arrives as a package resolution error far from
     * its cause.
     */
    const offenders: string[] = [];
    const manifests = [
      ...readdirSync(join(ROOT, 'apps'))
        .filter((name) => name !== 'veylith')
        .flatMap((name) => [
          join(ROOT, 'apps', name, 'package.json'),
          join(ROOT, 'apps', name, 'tsconfig.json'),
        ]),
      ...readdirSync(join(ROOT, 'packages'))
        .filter((name) => name !== 'vaol')
        .flatMap((name) => [
          join(ROOT, 'packages', name, 'package.json'),
          join(ROOT, 'packages', name, 'tsconfig.json'),
        ]),
    ].filter((file) => existsSync(file));

    for (const file of manifests) {
      const source = readFileSync(file, 'utf8');
      if (/@adericel\/(vaol|veylith)/.test(source) || /packages\/vaol|apps\/veylith/.test(source)) {
        offenders.push(file.replace(ROOT, ''));
      }
    }
    /**
     * The repository root is deliberately not checked. It is the workspace that
     * holds both, and must name them: it is the one place a reader should be
     * able to see that a company layer exists at all.
     */
    expect(offenders, 'these product manifests declare the company layer').toEqual([]);
  });

  it('defaults the company layer off, so an unset flag is a customer', () => {
    // The direction of the default is the whole decision. Wrong one way, a
    // Veylith operator sees a 404 and sets a flag. Wrong the other way, a
    // customer's database holds Veylith's commercial pipeline.
    const base = { DATABASE_URL: 'postgres://adericel@localhost:5432/adericel' };
    const flagged = (value?: string): boolean =>
      loadConfig(value === undefined ? base : { ...base, ADERICEL_COMPANY_LAYER: value })
        .companyLayerEnabled;

    expect(flagged()).toBe(false);
    // "false" as a string is the coercion that catches everybody. Boolean('false')
    // is true, and a config flag that reads its own negation as affirmative is
    // the most expensive one-line bug available here.
    for (const off of ['', 'false', 'FALSE', '0', 'no', 'off', '  off  ']) {
      expect(flagged(off), off).toBe(false);
    }
    for (const on of ['true', '1', 'yes', 'enabled']) {
      expect(flagged(on), on).toBe(true);
    }
  });

  it('does not reference veylith tables outside the company layer', () => {
    const offenders: string[] = [];
    for (const dir of ['packages', 'apps']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        if (file.endsWith('.test.ts')) continue;
        // `app.ts` used to be exempt because the composition root wired the
        // layers together. It no longer wires them: the company's deployment
        // composes itself onto the product, so the product's composition root
        // has no company knowledge to need an exemption for.
        if (isCompanyOwned(file)) continue;
        // A SQL reference to a company table, not merely the word — a policy
        // key such as `veylith.company.default` is a string, not a schema.
        if (/\b(FROM|INTO|UPDATE|TABLE|JOIN)\s+veylith\.\w+/i.test(readFileSync(file, 'utf8'))) {
          offenders.push(file.replace(ROOT, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
