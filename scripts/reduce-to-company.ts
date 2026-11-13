import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPANY_OWNED, isCompanyOwned, plan } from './extract-product.js';

/**
 * This repository, reduced to Veylith's own layer.
 *
 * WHY THIS IS A SCRIPT AND NOT A COMMIT
 *
 * Adericel has its own repository, and the instruction was that the build lives
 * there and nowhere else. The other half of that is this: once the product is
 * authoritative elsewhere, the copy here must go, or there are two and they
 * drift — which the contract forbids and which is the whole reason the product
 * was given its own home.
 *
 * Deleting five hundred and ninety-nine files is not something to do in the
 * middle of a conversation. As a script it is reviewable before it runs,
 * runnable in one step when the moment is right, and refuses outright until the
 * product repository is real — because the dangerous version of this change is
 * the one that removes the only copy.
 *
 * HOW THE COMPANY LAYER THEN CONSUMES THE PRODUCT
 *
 * As a git submodule pinned to a commit, not as a copy. The product's packages
 * are private and unpublished, so there is no registry to install them from;
 * a submodule is the lowest-infrastructure way to depend on an exact commit of
 * another repository without holding its history. A private package registry is
 * the better answer and it needs a publish pipeline and tokens, which is work
 * for after the first signed release rather than before it.
 *
 * Worth being precise about, because it sounds like a copy and is not: a
 * submodule records a commit identifier. The product's files appear in a
 * checkout and are absent from this repository's history, so there is exactly
 * one place the product is committed.
 */

const ROOT = join(import.meta.dirname, '..');
const PRODUCT_REMOTE = 'https://github.com/veylithsystems-alt/adericel-platform.git';
const SUBMODULE_PATH = 'vendor/adericel';

export interface Reduction {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
}

/** What reducing this repository would remove, without removing it. */
export function reductionPlan(): Reduction {
  const result = plan();
  // The mirror image of the extraction: what the product keeps is what this
  // repository gives up. Derived from the same list, so the two cannot disagree
  // about which files belong to which layer.
  return { removed: result.kept, kept: result.removed };
}

/**
 * The workspace definition the company repository needs.
 *
 * The product's packages are reached through the submodule, so the workspace
 * has to include them from there. Written out rather than hand-edited, so the
 * paths cannot drift from where the submodule actually is.
 */
export function companyWorkspace(): string {
  return [
    '# The company layer, plus the product it is composed onto.',
    '#',
    '# The product lives in its own repository and is reached here as a git',
    '# submodule pinned to a commit. It is not a copy: a submodule records a',
    '# commit identifier, so the product appears in a checkout and is absent from',
    '# this repository’s history. There is exactly one place it is committed.',
    'packages:',
    "  - 'packages/*'",
    "  - 'apps/*'",
    `  - '${SUBMODULE_PATH}/packages/*'`,
    `  - '${SUBMODULE_PATH}/apps/*'`,
    '',
    'onlyBuiltDependencies:',
    '  - esbuild',
    '',
  ].join('\n');
}

export function gitmodules(): string {
  return [
    `[submodule "${SUBMODULE_PATH}"]`,
    `\tpath = ${SUBMODULE_PATH}`,
    `\turl = ${PRODUCT_REMOTE}`,
    '\tbranch = main',
    '',
  ].join('\n');
}

/**
 * Refuse unless the product repository is reachable and has the product in it.
 *
 * The failure this exists to prevent: running the reduction against a
 * repository that was created and never populated, which would delete the only
 * copy of the product and leave an empty submodule pointing at nothing.
 */
export function productRepositoryIsReal(): { readonly ok: boolean; readonly why: string } {
  const submodule = join(ROOT, SUBMODULE_PATH);
  if (!existsSync(join(submodule, 'package.json'))) {
    return {
      ok: false,
      why:
        `${SUBMODULE_PATH} does not contain a checked-out product. Add the submodule and ` +
        'initialise it first:\n' +
        `  git submodule add ${PRODUCT_REMOTE} ${SUBMODULE_PATH}\n` +
        '  git submodule update --init --recursive',
    };
  }
  for (const required of [
    'packages/truth-engine/src/engine.ts',
    'apps/api/src/app.ts',
    'database/migrations/0001_core_tenancy_identity.sql',
  ]) {
    if (!existsSync(join(submodule, required))) {
      return {
        ok: false,
        why: `${SUBMODULE_PATH}/${required} is missing, so the product repository is not populated.`,
      };
    }
  }
  return { ok: true, why: 'the product is checked out and carries its core files' };
}

export function reduce(): Reduction {
  const readiness = productRepositoryIsReal();
  if (!readiness.ok) throw new Error(`Refusing to reduce: ${readiness.why}`);

  const result = reductionPlan();
  for (const file of result.removed) {
    // Never reach into the submodule, whatever the plan says: those files
    // belong to the other repository and are not this script's to delete.
    if (file.startsWith(`${SUBMODULE_PATH}/`)) continue;
    rmSync(join(ROOT, file), { force: true });
  }

  writeFileSync(join(ROOT, 'pnpm-workspace.yaml'), companyWorkspace(), 'utf8');
  writeFileSync(join(ROOT, '.gitmodules'), gitmodules(), 'utf8');
  writeFileSync(join(ROOT, 'README.md'), companyReadme(), 'utf8');
  return result;
}

export function companyReadme(): string {
  return [
    '# Veylith Systems — the company layer',
    '',
    '**Documentation state:** IMPLEMENTED',
    '',
    'This repository holds Veylith Systems’ own operating and commercial layer,',
    'and nothing of the product. Adericel lives in its own repository and is',
    'reached here as a git submodule pinned to a commit.',
    '',
    'That is not a copy. A submodule records a commit identifier, so the',
    'product appears in a checkout of this repository and is absent from its',
    'history — there is exactly one place the product is committed, which is the',
    'point. Two copies that drift is the one arrangement the build contract',
    'forbids outright, because every improvement then has to be made twice,',
    'correctly, forever.',
    '',
    '## What is here',
    '',
    ...COMPANY_OWNED.filter(
      (entry) => !entry.path.startsWith('scripts/') && !entry.path.startsWith('tests/unit/'),
    ).map((entry) => `- \`${entry.path}\` — ${entry.why}`),
    '',
    '## Working on it',
    '',
    '```',
    'git submodule update --init --recursive',
    'pnpm install',
    'pnpm test',
    '```',
    '',
    'The company suites run against the product in the submodule. A change the',
    'company layer needs from the product is made in the product’s repository and',
    'the submodule pointer moved — never by editing the submodule in place, which',
    'is how a submodule becomes a fork.',
    '',
  ].join('\n');
}

/**
 * Only when run directly.
 *
 * Without this the main block executed on **import**, so
 * `tests/unit/product-extract.test.ts` extracted a copy of the repository into
 * `var/product` every time it loaded the module — which is how a stray tree
 * came to sit inside the repository and get linted. A module that does work
 * when imported is a module nobody can safely import.
 */
const runDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (!runDirectly) {
  // Imported for its functions; do nothing.
} else if (process.argv.includes('--plan')) {
  const result = reductionPlan();
  const readiness = productRepositoryIsReal();
  process.stdout.write(
    `would remove ${result.removed.length} product files, keep ${result.kept.length}\n` +
      `product repository: ${readiness.ok ? 'ready' : 'NOT READY'} — ${readiness.why}\n`,
  );
} else {
  const result = reduce();
  process.stdout.write(
    `removed ${result.removed.length} product files; ${result.kept.length} company files remain\n`,
  );
}

/** Re-exported so the test can assert the two lists are mirror images. */
export { COMPANY_OWNED, isCompanyOwned };
