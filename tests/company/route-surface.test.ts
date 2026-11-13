import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every company route checks a platform permission.
 *
 * WHY THIS IS NOT IN `tests/security`
 *
 * It reads the company's route module, which the product does not carry — so
 * the product's own repository would have failed this check with an ENOENT for
 * being the product. Found by extracting the product and running its suites.
 *
 * The rule itself is unchanged and is the one that matters most about Veylith's
 * own surface: a company route without `requirePlatform` would be reachable by
 * an MSP token, which is the single worst disclosure this system could make.
 */

const ROUTES = join(import.meta.dirname, '..', '..', 'apps', 'veylith', 'src');

describe("Veylith's own routes", () => {
  it('checks a platform permission on every company route', () => {
    const source = readFileSync(join(ROUTES, 'routes.ts'), 'utf8');
    const registration = /server\.(get|post|put|patch|delete)\(/g;
    const offenders: string[] = [];
    let found = 0;
    let match: RegExpExecArray | null;
    while ((match = registration.exec(source)) !== null) {
      found += 1;
      const rest = source.slice(match.index);
      const nextIndex = rest.slice(1).search(/\n {2}server\.(get|post|put|patch|delete)\(/);
      const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex + 1);
      const path = /['"`](\/[^'"`]*)['"`]/.exec(body)?.[1] ?? '';
      if (!/requirePlatform\(/.test(body)) offenders.push(path);
    }
    // The premise, asserted because a regex that matched nothing would make
    // this pass over a file full of unprotected routes.
    /**
     * The premise. A regex that matched nothing would make this pass over a
     * file full of unprotected routes — and `lastIndex` was the wrong thing to
     * assert on, because an exhausted global regex resets it to zero. Counted
     * instead, which is what was meant.
     */
    expect(found, 'no route registrations were found in the company route module').toBeGreaterThan(
      0,
    );
    expect(offenders, 'these company routes do not require platform scope').toEqual([]);
  });
});

/**
 * The company's own layering rule.
 *
 * `packages/autonomy` compiles and evaluates the policy for what Veylith may
 * do unattended, and the rule is the same as the Truth Engine's: a decision
 * about authority must be reproducible from its recorded inputs, which it
 * cannot be if the engine can reach a database or a vendor API.
 *
 * It lived in the product's architecture suite until the autonomy package was
 * recognised as company-owned — `apps/api` declared it and imported nothing
 * from it — at which point the product's own repository failed the rule for not
 * having the package. The rule is unchanged; only its address is.
 */
describe('the company autonomy engine', () => {
  it('stays free of infrastructure', () => {
    const manifest = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'packages', 'autonomy', 'package.json'),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string> };
    const internal = Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith('@adericel/'))
      .map((name) => name.replace('@adericel/', ''))
      .sort();
    expect(internal, 'the autonomy engine reaches past its layer').toEqual(['shared']);
  });
});
