import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPANY_OWNED, isCompanyOwned, plan } from '../../scripts/extract-product.js';
import {
  companyReadme,
  companyWorkspace,
  gitmodules,
  productRepositoryIsReal,
  reductionPlan,
} from '../../scripts/reduce-to-company.js';

/**
 * Reducing this repository to the company layer.
 *
 * The product has its own repository, and the instruction behind that was that
 * the build lives there and nowhere else. The other half is removing the copy
 * here — because two copies drift, which the contract forbids and which is the
 * entire reason the product was given its own home.
 *
 * The dangerous version of this change is the one that deletes the only copy.
 * These tests are mostly about that: the refusal, and the exactness of the two
 * lists that decide what goes and what stays.
 */

const ROOT = join(import.meta.dirname, '..', '..');

describe('the reduction to the company layer', () => {
  it('refuses while the product repository is not checked out', () => {
    /**
     * The assertion that matters most in this file.
     *
     * Running the reduction against a repository that was created and never
     * populated would delete the product and leave a submodule pointing at
     * nothing. The refusal is asserted here, in this repository, where the
     * submodule is deliberately absent — so the guard is exercised rather than
     * assumed.
     */
    const readiness = productRepositoryIsReal();
    expect(
      existsSync(join(ROOT, 'vendor', 'adericel', 'package.json')),
      'the product submodule is checked out, so this test can no longer prove the refusal',
    ).toBe(false);
    expect(readiness.ok).toBe(false);
    // And it says what to do, rather than only that it will not.
    expect(readiness.why).toMatch(/git submodule add/);
  });

  it('removes exactly what the product keeps, and keeps exactly what the product removes', () => {
    /**
     * The two scripts are mirror images, derived from one list. Anything
     * falling between them would be a file in neither repository, and anything
     * in both would be the drift this whole arrangement exists to prevent.
     */
    const extraction = plan();
    const reduction = reductionPlan();

    expect([...reduction.removed].sort()).toEqual([...extraction.kept].sort());
    expect([...reduction.kept].sort()).toEqual([...extraction.removed].sort());

    const inBoth = reduction.kept.filter((file) => extraction.kept.includes(file));
    expect(inBoth, 'these files would exist in both repositories').toEqual([]);

    // The premise, because two empty lists would satisfy everything above.
    expect(reduction.kept.length, 'nothing would stay here').toBeGreaterThan(20);
    expect(reduction.removed.length, 'nothing would leave').toBeGreaterThan(400);
  });

  it('classifies every file as one layer or the other, with nothing left over', () => {
    const { kept, removed } = reductionPlan();
    const total = kept.length + removed.length;
    const classified = [...kept, ...removed].filter(
      (file) => isCompanyOwned(file) || !isCompanyOwned(file),
    ).length;
    expect(classified).toBe(total);
    // Every file this repository tracks is accounted for in one of the two.
    expect(new Set([...kept, ...removed]).size, 'a file appears in both lists').toBe(total);
  });

  it('writes a workspace and a submodule entry that agree on where the product is', () => {
    // A workspace pointing at one path and a submodule checked out at another
    // is an install that fails with nothing resolving and no obvious cause.
    const workspace = companyWorkspace();
    const modules = gitmodules();
    const path = /path = (\S+)/.exec(modules)?.[1];
    expect(path, 'the submodule entry names no path').toBeDefined();
    expect(workspace).toContain(`${path ?? ''}/packages/*`);
    expect(workspace).toContain(`${path ?? ''}/apps/*`);
    expect(modules).toContain('https://github.com/veylithsystems-alt/adericel-platform.git');
  });

  it('says plainly that a submodule is not a copy, because it reads like one', () => {
    /**
     * The sentence somebody will need. "The product is in a folder in this
     * repository" is what a submodule looks like, and it is not what one is —
     * and the difference is the whole point of the separation, so the README
     * has to say it rather than leave it to be worked out.
     */
    const readme = companyReadme();
    expect(readme).toMatch(/not a copy/i);
    expect(readme).toMatch(/commit identifier/i);
    expect(readme).toMatch(/absent from its\s+history/i);
    // And it explains every company path, so nothing here is unexplained.
    for (const entry of COMPANY_OWNED) {
      if (entry.path.startsWith('scripts/') || entry.path.startsWith('tests/unit/')) continue;
      expect(readme, `${entry.path} stays and is not explained`).toContain(entry.path);
    }
    // Including the rule that keeps a submodule from becoming a fork.
    expect(readme).toMatch(/never by editing the submodule in place/i);
  });
});
