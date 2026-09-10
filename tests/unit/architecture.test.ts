import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

function manifest(pkg: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
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

  it('keeps the autonomy engine free of infrastructure', () => {
    // Same rule, same reason: a decision about authority must be reproducible
    // from its recorded inputs.
    expect(internalDeps('autonomy')).toEqual(['shared']);
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

  it('does not reference veylith tables outside the company layer', () => {
    const allowed = [
      join('packages', 'vaol'),
      join('apps', 'api', 'src', 'routes', 'veylith.ts'),
      // The composition root wires the layers together; that is its job.
      join('apps', 'api', 'src', 'app.ts'),
    ];
    const offenders: string[] = [];
    for (const dir of ['packages', 'apps']) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        if (file.endsWith('.test.ts')) continue;
        if (allowed.some((prefix) => file.includes(prefix))) continue;
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
