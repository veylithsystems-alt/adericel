import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/**
 * Adericel, as its own repository.
 *
 * WHY A DERIVATION AND NOT A FORK
 *
 * The contract requires one authoritative implementation of each platform
 * primitive — one Truth Engine, one evidence store, one tenancy system. Two
 * repositories each holding a *copy* of the product is exactly what that
 * forbids: trees that agree the day they are split and diverge afterwards, with
 * nothing noticing, and every improvement then has to be made twice, correctly,
 * forever. That is also why this matters for the instruction behind it — the
 * point of a separate repository is that the product has **one** home, not two.
 *
 * So this is a derivation with a stated direction, not a copy. Until the
 * product's repository is created and made authoritative, this repository is
 * the single source and the product tree is produced from it. Once the product
 * repository exists, the direction reverses: the product becomes the source,
 * and the company layer — `packages/vaol`, `apps/veylith`, `tests/company`,
 * three migrations and the commercial documents — is what lives separately,
 * depending on the product as a package. Either way there is one copy of each
 * primitive and one place to improve it.
 *
 * WHAT MADE THE EXTRACTION POSSIBLE AT ALL
 *
 * The composition was inverted first. The product's app used to declare the
 * company package in its manifest and reference it in its TypeScript project,
 * so extraction meant editing manifests on the way out — a separation held by a
 * patch script. `apps/veylith` now depends on the product and the product names
 * nothing of Veylith's.
 */

const ROOT = join(import.meta.dirname, '..');

/**
 * Everything Veylith's, and nothing else.
 *
 * Each entry carries its reason. The list is short on purpose: a long exclusion
 * list is a sign the separation is maintained by subtraction rather than by
 * structure.
 */
export const COMPANY_OWNED: readonly { readonly path: string; readonly why: string }[] = [
  {
    path: 'packages/vaol',
    why: "Veylith's own autonomy gate, exception queue, business ledger and pipeline.",
  },
  {
    path: 'packages/autonomy',
    why: "The autonomy policy compiler: rules about what **the company** may do unattended, as its own doc comment says. Its only consumers are packages/vaol and apps/veylith. A customer organisation's autonomy level is a different thing and lives in packages/domain, which the product keeps. apps/api declared this package and imported nothing from it — a dead dependency that also pulled it into the product image.",
  },
  {
    path: 'apps/veylith',
    why: "Veylith's own deployment: the entry point that composes the company layer onto the product.",
  },
  {
    path: 'tests/company',
    why: 'Every suite that needs the company layer, in one directory rather than scattered. Three used to live in tests/e2e and tests/security, and two more were halves of product suites — so a product repository would have carried tests importing a package it does not have.',
  },
  {
    path: 'database/migrations/0018_veylith_operating_core.sql',
    why: "Creates the veylith schema. A customer's database must not hold it.",
  },
  {
    path: 'database/migrations/0019_veylith_commercial_pipeline.sql',
    why: "Veylith's commercial pipeline tables.",
  },
  {
    path: 'database/migrations/0020_veylith_decision_binding.sql',
    why: "Binds Veylith's decisions to its own authority model.",
  },
  {
    path: 'docs/commercial',
    why: "Veylith's go-to-market: target buyers, price hypotheses, the metrics it sells on. Not the product, and not a customer's business.",
  },
  {
    path: 'scripts/extract-product.ts',
    why: 'The derivation machinery. It belongs to the repository the product is derived FROM; a product repository carrying it would describe a company layer it does not have.',
  },
  {
    path: 'tests/unit/product-extract.test.ts',
    why: 'Tests the derivation, so it lives with the derivation.',
  },
];

/**
 * The package names the company workspaces publish, read from their manifests.
 *
 * Derived rather than listed, so renaming a company package cannot leave a
 * stale name behind in the product's root manifest.
 */
const companyPackageNames = new Set(
  COMPANY_OWNED.map((entry) => join(ROOT, entry.path, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name)
    .filter((name): name is string => name !== undefined),
);

export function isCompanyOwned(file: string): boolean {
  return COMPANY_OWNED.some((entry) => file === entry.path || file.startsWith(`${entry.path}/`));
}

/** Tracked files only: no build output, no node_modules, no local scratch. */
function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((entry) => entry.length > 0);
}

export interface Extraction {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
}

/** What the extraction would do, without doing it. */
export function plan(): Extraction {
  const files = trackedFiles();
  return {
    kept: files.filter((file) => !isCompanyOwned(file)),
    removed: files.filter((file) => isCompanyOwned(file)),
  };
}

export function extract(destination: string): Extraction {
  const result = plan();
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  for (const file of result.kept) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, file), target);
  }

  /**
   * The transformations, and why there are four rather than none.
   *
   * Removing files is not quite enough: a manifest still naming a package the
   * tree no longer has will not install, and the error arrives as a resolution
   * failure far from its cause. Each of these is **derived** from the exclusion
   * list rather than hand-written, so adding a company package later needs no
   * change here.
   *
   * Stated plainly, because a derivation with hidden edits is a fork wearing a
   * script: anybody relying on this needs to know exactly what differs between
   * the two trees, and it is these four things and nothing else.
   */

  // (1) The root manifest must not declare company workspaces.
  const rootManifestPath = join(destination, 'package.json');
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = rootManifest[field];
    if (deps === null || typeof deps !== 'object') continue;
    rootManifest[field] = Object.fromEntries(
      Object.entries(deps as Record<string, string>).filter(
        ([name]) => !companyPackageNames.has(name),
      ),
    );
  }
  writeFileSync(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`, 'utf8');

  // (2) The build project must not reference a project that is not there.
  const buildConfigPath = join(destination, 'tsconfig.build.json');
  if (existsSync(buildConfigPath)) {
    const buildConfig = JSON.parse(readFileSync(buildConfigPath, 'utf8')) as {
      references?: { path: string }[];
    };
    buildConfig.references = (buildConfig.references ?? []).filter(
      (reference) => !isCompanyOwned(reference.path.replace(/^\.\//, '')),
    );
    writeFileSync(buildConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`, 'utf8');
  }

  /**
   * (3) `layers.json` names the migrations belonging to the company layer, and
   * `tests/unit/migration-layers.test.ts` asserts the manifest cannot drift from
   * the files in either direction — so a manifest naming migrations the product
   * does not have would fail honestly, for a reason that has nothing to do with
   * the product. Filtered rather than emptied, so the derivation stays correct
   * if a company migration is ever added or renamed.
   */
  const manifestPath = join(destination, 'database', 'migrations', 'layers.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const company = Array.isArray(manifest.company) ? (manifest.company as string[]) : [];
    manifest.company = company.filter((id) =>
      result.kept.some((file) => file === `database/migrations/${id}.sql`),
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  /**
   * (4) The lockfile cannot be derived, so it is removed and the one command
   * that regenerates it is written down.
   *
   * A pnpm lockfile records resolved versions per workspace importer. Editing
   * one by hand to drop two importers is the kind of change that appears to work
   * and then resolves something different six months later — and a lockfile is a
   * supply-chain control, so a wrong one is worse than an absent one.
   */
  rmSync(join(destination, 'pnpm-lock.yaml'), { force: true });
  writeFileSync(join(destination, 'EXTRACTION.md'), extractionNote(), 'utf8');

  return result;
}

export function extractionNote(): string {
  return [
    '# How this tree was produced',
    '',
    'Adericel is **derived** from Veylith Systems’ repository by',
    '`scripts/extract-product.ts`, which removes the company layer and nothing',
    'else. It is **not a fork**. There is one copy of each platform primitive and',
    'one place to improve it; two copies that drift is the one thing the build',
    'contract forbids outright.',
    '',
    'Which tree is authoritative is a decision, and it is recorded here rather',
    'than assumed. Until the product repository is created and declared the',
    'source, the repository this was derived from remains authoritative and',
    'nothing should be changed here that is not changed there. Once the product',
    'repository is the source, the direction reverses and the company layer is',
    'what lives separately, depending on the product as a package.',
    '',
    '## Before the first commit',
    '',
    '```',
    'pnpm install --lockfile-only',
    '```',
    '',
    'The lockfile is not carried across. It records resolved versions per',
    'workspace importer, and editing one by hand to drop the company importers is',
    'the kind of change that appears to work and resolves something different six',
    'months later. A lockfile is a supply-chain control, so a wrong one is worse',
    'than an absent one.',
    '',
    '## What was removed, and why',
    '',
    ...COMPANY_OWNED.map((entry) => `- \`${entry.path}\` — ${entry.why}`),
    '',
  ].join('\n');
}

if (process.argv.includes('--plan')) {
  const result = plan();
  process.stdout.write(`${result.kept.length} kept, ${result.removed.length} removed\n`);
  for (const entry of COMPANY_OWNED) {
    const count = result.removed.filter(
      (file) => file === entry.path || file.startsWith(`${entry.path}/`),
    ).length;
    process.stdout.write(`  ${entry.path}: ${count} file(s)\n`);
  }
} else {
  const destination = process.argv[2] ?? join(ROOT, 'var', 'product');
  const result = extract(destination);
  process.stdout.write(
    `extracted ${result.kept.length} files to ${destination}\n` +
      `removed ${result.removed.length} company-owned files\n`,
  );
}
