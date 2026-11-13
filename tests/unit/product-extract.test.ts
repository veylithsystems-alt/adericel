import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPANY_OWNED, extract, plan } from '../../scripts/extract-product.js';

/**
 * Adericel, extracted as its own repository.
 *
 * WHY A DERIVATION AND NOT A SECOND REPOSITORY
 *
 * The contract requires one authoritative implementation of each platform
 * primitive. Two repositories each holding a copy is precisely what that
 * forbids: trees that agree the day they are split and diverge afterwards, with
 * nothing noticing. These tests are what make the derivation trustworthy enough
 * to rely on instead of copying.
 *
 * WHAT THEY CHECK FOR
 *
 * Not "is the company layer absent" alone. A tree with no company import whose
 * manifests still declare it does not install; a tree missing a file something
 * imports does not build. Both were true before the composition was inverted:
 * `apps/api` declared the company package and referenced it in its TypeScript
 * project, so extraction meant patching manifests on the way out — a separation
 * held by a script rather than by structure.
 */

/** Source and configuration, where naming the company layer is a defect. */
function isCodeOrManifest(file: string): boolean {
  return /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|sql)$/.test(file) && !file.endsWith('.test.ts');
}

/** Comments removed, so a rule can be explained in the file it governs. */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

function filesUnder(dir: string, prefix = ''): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return filesUnder(join(dir, entry.name), path);
    return [path];
  });
}

describe('the product, extracted', () => {
  let destination: string;
  let extracted: readonly string[];

  beforeAll(() => {
    destination = mkdtempSync(join(tmpdir(), 'adericel-product-'));
    extract(destination);
    extracted = filesUnder(destination);
  }, 120_000);

  afterAll(() => {
    rmSync(destination, { recursive: true, force: true });
  });

  it('removed something, and kept most of it', () => {
    /**
     * The premise. An extraction that removed nothing would satisfy every
     * assertion below about company content being absent, and would be a copy
     * of this repository rather than the product — the same shape as a mutation
     * that does not apply.
     */
    const result = plan();
    expect(result.removed.length, 'the extraction removed nothing').toBeGreaterThan(15);
    expect(result.kept.length, 'the extraction kept almost nothing').toBeGreaterThan(400);
    /**
     * Counted exactly rather than with a tolerance: every kept file, minus the
     * lockfile the extraction removes, plus the note it writes. A `±1` here
     * would hide a file silently going missing.
     */
    const expected = result.kept.filter((file) => file !== 'pnpm-lock.yaml').length + 1;
    expect(extracted.length, 'the extracted tree has a different number of files').toBe(expected);
  });

  it('still contains the product it is supposed to be', () => {
    // Named explicitly rather than counted, because "600 files" would be
    // satisfied by 600 of the wrong ones.
    for (const required of [
      'packages/truth-engine/src/engine.ts',
      'packages/domain/src/assurance.ts',
      'packages/evidence/src/repository.ts',
      'packages/graph/src/db.ts',
      'apps/api/src/app.ts',
      'apps/api/src/main.ts',
      'apps/worker/src/main.ts',
      'apps/web/src/main.tsx',
      'database/migrations/0001_core_tenancy_identity.sql',
      'tests/chaos/failure-injection.test.ts',
      'tests/upgrade/populated-migration.test.ts',
      'tests/browser/interface.test.ts',
      'tests/e2e/product-separation.test.ts',
      'README.md',
      'package.json',
    ]) {
      expect(extracted, `${required} is missing from the product`).toContain(required);
    }
  });

  it('contains none of the company layer', () => {
    const present = COMPANY_OWNED.map((entry) => entry.path).filter((path) =>
      existsSync(join(destination, path)),
    );
    expect(present, 'these company paths survived the extraction').toEqual([]);
  });

  it('names the company layer in no code or manifest it kept', () => {
    /**
     * The half that matters. A tree with the company files deleted and a
     * manifest still naming them will not install, and the error arrives as a
     * package resolution failure far from the cause.
     *
     * Prose is exempt: the README and the risk register discuss the separation
     * at length, and must. The rule is about what a build reads.
     */
    const offenders: string[] = [];
    for (const file of extracted) {
      if (!isCodeOrManifest(file)) continue;
      const source = code(readFileSync(join(destination, file), 'utf8'));
      if (/@adericel\/(vaol|veylith)/.test(source)) offenders.push(`${file}: names the package`);
      else if (/packages\/vaol|apps\/veylith|tests\/company/.test(source)) {
        offenders.push(`${file}: names the path`);
      }
    }
    expect(offenders, 'the extracted product refers to the company layer').toEqual([]);
  });

  it('resolves every workspace dependency it declares', () => {
    /**
     * The check that would have caught the old arrangement without anybody
     * reading the manifests. Every `workspace:*` dependency in the extracted
     * tree must name a package the extracted tree actually has.
     */
    const offenders: string[] = [];
    const manifests = extracted.filter((file) => file.endsWith('package.json'));
    const names = new Set<string>();
    for (const file of manifests) {
      const manifest = JSON.parse(readFileSync(join(destination, file), 'utf8')) as {
        name?: string;
      };
      if (manifest.name !== undefined) names.add(manifest.name);
    }
    for (const file of manifests) {
      const manifest = JSON.parse(readFileSync(join(destination, file), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const [dependency, range] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        if (!range.startsWith('workspace:')) continue;
        if (!names.has(dependency)) offenders.push(`${file} needs ${dependency}`);
      }
    }
    expect(offenders, 'these workspace dependencies do not exist in the product').toEqual([]);
  });

  it('resolves every TypeScript project reference it declares', () => {
    const offenders: string[] = [];
    const configs = extracted.filter(
      (file) => file.endsWith('tsconfig.json') || file === 'tsconfig.build.json',
    );
    for (const file of configs) {
      const parsed = JSON.parse(code(readFileSync(join(destination, file), 'utf8'))) as {
        references?: { path: string }[];
      };
      for (const reference of parsed.references ?? []) {
        if (!existsSync(join(destination, file, '..', reference.path))) {
          offenders.push(`${file} references ${reference.path}`);
        }
      }
    }
    expect(offenders, 'these project references point outside the product').toEqual([]);
  });

  it('carries no company migration, and says so in its manifest', () => {
    const company = extracted
      .filter((file) => file.startsWith('database/migrations/'))
      .filter((file) => /veylith/i.test(file));
    expect(company, 'a company migration survived').toEqual([]);

    const manifest = JSON.parse(
      readFileSync(join(destination, 'database', 'migrations', 'layers.json'), 'utf8'),
    ) as { company?: string[] };
    expect(manifest.company, 'the product still claims company migrations').toEqual([]);
  });

  it('is a tree git can turn into a repository, and says how it was made', () => {
    for (const required of ['pnpm-workspace.yaml', '.github/workflows/ci.yml']) {
      expect(extracted, `${required} is missing`).toContain(required);
    }
    /**
     * The lockfile is deliberately absent, and the absence is documented.
     *
     * A missing lockfile with no explanation reads as an oversight, and
     * somebody would commit a hand-patched one — which is worse than none,
     * because a lockfile is a supply-chain control.
     */
    expect(extracted, 'the lockfile was carried across and cannot be correct').not.toContain(
      'pnpm-lock.yaml',
    );
    expect(extracted).toContain('EXTRACTION.md');

    const note = readFileSync(join(destination, 'EXTRACTION.md'), 'utf8');
    expect(note).toContain('pnpm install --lockfile-only');
    // It must say what this tree is, so nobody treats it as a fork, and it must
    // say which tree is authoritative, because that is a decision rather than
    // something a reader should infer.
    expect(note).toMatch(/derived/i);
    expect(note).toMatch(/not a fork/i);
    expect(note).toMatch(/authoritative/i);
    for (const entry of COMPANY_OWNED) {
      expect(note, `${entry.path} is removed and not explained`).toContain(entry.path);
    }

    expect(statSync(join(destination, 'package.json')).size).toBeGreaterThan(100);
    execFileSync('git', ['init', '--quiet'], { cwd: destination });
    expect(existsSync(join(destination, '.git'))).toBe(true);
  });
});
