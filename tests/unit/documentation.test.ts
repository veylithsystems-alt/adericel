import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENTATION_STATES,
  NOT_YET_CAPABILITY_STATES,
  declaredDocumentationState,
} from '@adericel/domain';
import { MUTATIONS } from '../mutation/registry.js';

/**
 * Documentation that matches the code.
 *
 * Prose drifts silently. Nothing fails when a package is added and the README
 * still lists the old set, or when a decision record is written and never
 * indexed — and the result is documentation that is confidently wrong, which is
 * worse than none because people act on it.
 *
 * These check the claims that can be checked mechanically. They cannot tell
 * whether a document is any good.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/**
 * Number words, generated rather than listed.
 *
 * Both counts below used to read from a hand-written map that stopped at
 * twenty-five and at fifty-five. Extending it was a chore nobody remembered,
 * and the failure it produced was "that is not a number this test knows" —
 * which looks like a broken test rather than a count that needs updating. A
 * guard whose maintenance cost falls on the person it is meant to help is a
 * guard that eventually gets deleted.
 */
const UNITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

/** The English for a number from 0 to 999, in the form this README uses. */
function inWords(value: number): string {
  if (value < 20) return UNITS[value];
  if (value < 100) {
    const tens = TENS[Math.floor(value / 10)];
    const unit = value % 10;
    return unit === 0 ? tens : `${tens}-${UNITS[unit]}`;
  }
  const hundreds = `${UNITS[Math.floor(value / 100)]} hundred`;
  const rest = value % 100;
  return rest === 0 ? hundreds : `${hundreds} and ${inWords(rest)}`;
}

/** Every number word up to 999, mapped back to its value. */
const NUMBER_WORDS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 1000 }, (_, value) => [inWords(value), value]),
);

/**
 * The company's own workspaces, which the product's README does not document.
 *
 * `packages/vaol` is Veylith's operating layer, `packages/autonomy` is the
 * policy compiler for what **the company** may do unattended, and
 * `apps/veylith` is Veylith's deployment. The README belongs to the product,
 * and the product ships none of them — so a README listing them would describe
 * software its reader does not have. Named here once rather than special-cased
 * in four tests.
 *
 * A customer organisation's own autonomy level is a different thing and lives
 * in `packages/domain`, which the product keeps.
 */
const COMPANY_PACKAGES = new Set(['vaol', 'autonomy']);

/** The packages the product actually contains. */
function productPackages(): readonly string[] {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !COMPANY_PACKAGES.has(name));
}

describe('the README describes the repository that exists', () => {
  /**
   * `lists every package` used to live here, checking that each package name
   * appeared as a line in an ASCII directory tree. It was removed rather than
   * fixed: the tree it depended on is gone, and a strictly stronger check
   * replaced it — see "the README explains every package, rather than listing
   * it" below, which requires each package to be discussed in prose with a path
   * a reader can follow. Naming something in a tree is not explaining it.
   */
  it('names no package that does not exist', () => {
    const packages = new Set(readdirSync(join(ROOT, 'packages')));
    const named = [...readme.matchAll(/`packages\/([a-z-]+)`/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(15);

    const phantom = [...new Set(named)].filter((name) => !packages.has(name));
    expect(
      phantom,
      `The README names packages that do not exist:\n  ${phantom.join('\n  ')}`,
    ).toEqual([]);
  });

  it('states the package count correctly, or not at all', () => {
    /**
     * The README's own rule is that a number in prose is a promise to update
     * prose and nobody keeps it. This one was introduced with the package tables
     * anyway, because a reader arriving cold deserves to know the order of
     * magnitude — so it is checked rather than trusted.
     *
     * A count in prose is allowed here on exactly one condition: something
     * fails when it drifts.
     */
    const stated = /\b([a-z-]+)\s+workspace packages\b/i.exec(readme)?.[1]?.toLowerCase();
    if (stated === undefined) return; // No claim made, nothing to be wrong about.

    // Counted over the product's packages. The company's operating layer is not
    // the product's to count, and in the extracted product tree it is not there
    // at all — a count including it was wrong in both trees for opposite
    // reasons.
    const actual = productPackages().length;
    expect(
      NUMBER_WORDS[stated],
      `The README says "${stated} workspace packages" and there are ${actual}.`,
    ).toBe(actual);
  });

  it('states the mutation count correctly, or not at all', () => {
    /**
     * Same rule as the package count, and this one earns its keep more.
     *
     * "Thirty-three are recorded" was true when it was written and silently
     * false ten mutations later. A number that describes the strength of the
     * test suite is exactly the number a reader uses to decide how much to
     * trust it, so it is the last place a stale figure is harmless.
     */
    const stated = /\b([a-z-]+)\s+are recorded\b/i.exec(readme)?.[1]?.toLowerCase();
    if (stated === undefined) return; // No claim made, nothing to be wrong about.
    expect(
      Object.keys(NUMBER_WORDS),
      `The README says "${stated} are recorded"; that is not a number this test knows.`,
    ).toContain(stated);
    expect(
      NUMBER_WORDS[stated],
      `The README says "${stated} are recorded" and the registry holds ${MUTATIONS.length}.`,
    ).toBe(MUTATIONS.length);
  });

  it('does not state a count that nothing verifies', () => {
    // "Twenty-two architecture decision records" was true once. Nothing counts
    // the ADRs, so the claim may not be made.
    expect(readme).not.toMatch(/\b(twenty|thirty|forty)[- ]?\w*\s+architecture decision records/i);
  });
});

describe('the decision records are indexed', () => {
  const adrDir = join(ROOT, 'docs', 'adr');
  const files = readdirSync(adrDir).filter((f) => /^ADR-\d{4}-.*\.md$/.test(f));
  const index = readFileSync(join(adrDir, 'README.md'), 'utf8');

  it('has an index entry for every record', () => {
    const missing = files.filter((file) => !index.includes(file));
    expect(missing.sort()).toEqual([]);
  });

  it('indexes no record that does not exist', () => {
    const linked = [...index.matchAll(/\(\.\/(ADR-\d{4}-[^)]+\.md)\)/g)].map((m) => m[1]!);
    const phantom = linked.filter((name) => !files.includes(name));
    expect(phantom).toEqual([]);
  });

  it('numbers them without gaps or duplicates', () => {
    // A gap means a record was deleted rather than superseded, which loses the
    // reasoning; a duplicate means two decisions share an identity.
    const numbers = files.map((f) => Number(f.slice(4, 8))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it('gives every record a status and a date', () => {
    for (const file of files) {
      const content = readFileSync(join(adrDir, file), 'utf8');
      expect(content, file).toMatch(/\*\*Status:\*\*/);
      expect(content, file).toMatch(/\*\*Date:\*\*|·\s*\*\*Date/);
    }
  });
});

describe('the migrations are numbered honestly', () => {
  it('numbers them without duplicates, and strictly increasing', () => {
    /**
     * Contiguity was the wrong invariant, and the extracted product tree proved
     * it.
     *
     * The rule used to be "no gaps", on the reasoning that a gap means a
     * migration was deleted rather than superseded. That holds in a tree that
     * carries every layer — and the product carries one. Veylith's three
     * migrations occupy numbers in the shared sequence, so removing the company
     * layer leaves gaps **by construction**, and a product repository would
     * have failed this check on the day it was created for doing exactly the
     * right thing.
     *
     * What the check was really for is preserved: no two migrations share an
     * identity, and the order is unambiguous. A deleted migration is caught by
     * the ledger instead — the runner refuses a schema whose applied set does
     * not match the files, which is a stronger statement than a numbering
     * convention.
     */
    const files = readdirSync(join(ROOT, 'database', 'migrations')).filter((f) =>
      f.endsWith('.sql'),
    );
    const numbers = files.map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b);
    expect(numbers.length, 'no migrations found at all').toBeGreaterThan(10);
    expect(new Set(numbers).size, 'two migrations share a number').toBe(numbers.length);
    for (const [index, number] of numbers.entries()) {
      if (index === 0) continue;
      expect(number, 'the sequence is not increasing').toBeGreaterThan(numbers[index - 1] ?? 0);
    }
  });

  it('gives every migration a down path', () => {
    // A migration that cannot be reverted is one nobody can safely deploy on a
    // Friday, and the pressure to skip writing it is highest exactly when the
    // change is riskiest.
    const dir = join(ROOT, 'database', 'migrations');
    const missing = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => !readFileSync(join(dir, f), 'utf8').includes('-- migrate:down'));
    expect(missing).toEqual([]);
  });
});

describe('the data protection documents describe the code that exists', () => {
  const dir = join(ROOT, 'docs', 'data-protection');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const index = readFileSync(join(dir, 'README.md'), 'utf8');

  it('indexes every document', () => {
    const missing = files.filter((file) => file !== 'README.md' && !index.includes(file));
    expect(missing.sort()).toEqual([]);
  });

  it('publishes a retention period for every fixed period the code enforces', async () => {
    const { timeLimitedEntries } = await import('@adericel/domain');
    const schedule = readFileSync(join(dir, 'retention.md'), 'utf8');
    // A published schedule that omits a period the sweep enforces is a document
    // that is confidently incomplete, which is worse than none.
    const undocumented = [...new Set(timeLimitedEntries().map((entry) => entry.retention.days))]
      .filter((days) => days !== null)
      .filter((days) => !schedule.includes(String(days)));
    expect(undocumented).toEqual([]);
  });

  it('states the erasure limitation rather than implying erasure is total', async () => {
    // The one place a data protection document is most tempted to overclaim.
    const notice = readFileSync(join(dir, 'privacy-notice.md'), 'utf8');
    const rights = readFileSync(join(dir, 'subject-rights.md'), 'utf8');
    expect(notice).toContain('17(3)(e)');
    expect(rights).toContain('17(3)(e)');
    expect(rights.toLowerCase()).toContain('pseudonym');
  });

  it('does not claim a compliance status the repository cannot support', () => {
    // Claim discipline applies to legal documents more than anywhere else,
    // because the reader has no way to check.
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, `${file} claims certification`).not.toMatch(
        /\b(ISO 27001|SOC 2|Cyber Essentials)[- ]certified\b/i,
      );
      expect(text, `${file} claims to be fully compliant`).not.toMatch(
        /\bfully (GDPR[- ])?compliant\b/i,
      );
    }
  });
});

describe('the residual-risk register', () => {
  const REGISTER = 'docs/audit/RESIDUAL_RISK_REGISTER.md';
  const register = readFileSync(join(ROOT, REGISTER), 'utf8');

  /** Each `### RR-nnn` entry and its body. */
  function entries(section: string): readonly { heading: string; body: string }[] {
    return section
      .split(/(?=^### RR-)/m)
      .filter((block) => block.startsWith('### RR-'))
      .map((block) => ({ heading: block.split('\n')[0] ?? '', body: block }));
  }

  it('files no open risk under the heading that says it is closed', () => {
    /**
     * Found by adding RR-073 and noticing it landed in the wrong section
     * alongside four others that were already there.
     *
     * A register that files an open risk under "Closed" is worse than no
     * register: somebody reading it to decide whether a risk was dealt with
     * gets the answer "yes" from the heading and "no" from the row, and the
     * heading is what they skim. §37 is about exactly this kind of claim.
     */
    const closed = register.split(/^## Closed$/m)[1];
    expect(closed, `${REGISTER} has no "## Closed" section`).toBeDefined();

    const misfiled = entries(closed ?? '')
      .filter((entry) => /\|\s*\*\*State\*\*\s*\|\s*`OPEN`/.test(entry.body))
      .map((entry) => entry.heading);

    expect(misfiled, `Open risks filed under "## Closed":\n${misfiled.join('\n')}`).toEqual([]);
  });

  it('gives every entry a state, because an entry without one asserts nothing', () => {
    const stateless = entries(register)
      .filter((entry) => !/\|\s*\*\*State\*\*\s*\|/.test(entry.body))
      .map((entry) => entry.heading);
    expect(stateless).toEqual([]);
  });

  it('numbers every entry uniquely', () => {
    const numbers = entries(register).map(
      (entry) => /### (RR-\d+)/.exec(entry.heading)?.[1] ?? entry.heading,
    );
    const duplicated = numbers.filter((number, index) => numbers.indexOf(number) !== index);
    expect(duplicated).toEqual([]);
  });
});

describe('documentation distinguishes what is built from what is not', () => {
  const PRODUCT_DOCS = 'docs/product';

  /**
   * Contract v3.2: "Documentation must distinguish: implemented; tested;
   * planned; assumed; externally dependent; legally pending. Never present a
   * target as an implemented capability."
   *
   * Applied to `docs/product` specifically: those are the documents written for
   * somebody outside the build to read, so they are where an unlabelled target
   * does real damage. An ADR is a decision record and says so by being one; a
   * runbook describes an operation somebody is performing.
   *
   * WHAT WAS TRIED AND ABANDONED
   *
   * Scanning prose for forward-looking promises about the product. Across the
   * whole repository it produced eleven hits and not one was real — English uses
   * the future tense for a deterministic system's reliable behaviour ("it will
   * refuse rather than degrade"), which is the voice this product is written in.
   * Eleven exceptions would have been needed, and a check needing an exception
   * per instance is not a check. The note in `release-gate.ts` records it so it
   * is not attempted again as though it were new.
   */
  const productDocs = readdirSync(join(ROOT, PRODUCT_DOCS)).filter((name) => name.endsWith('.md'));

  it('has product documents to check', () => {
    // A guard on the guard: if the directory moves, the loops below would pass
    // by iterating nothing.
    expect(productDocs.length).toBeGreaterThan(3);
  });

  it('declares a recognised state on every customer-facing document', () => {
    const undeclared = productDocs.filter(
      (name) =>
        declaredDocumentationState(readFileSync(join(ROOT, PRODUCT_DOCS, name), 'utf8')) === null,
    );
    expect(
      undeclared,
      `These documents declare no documentation state:\n${undeclared.join('\n')}\n` +
        `Add one of: ${DOCUMENTATION_STATES.join(', ')}`,
    ).toEqual([]);
  });

  it('says plainly, in any document that is not yet a capability, that it is not one', () => {
    /**
     * The rule the contract is actually protecting. A document labelled PLANNED
     * whose body reads like a description of working software has satisfied the
     * letter of the label and none of its purpose — a reader skims the prose,
     * not the header.
     */
    for (const name of productDocs) {
      const text = readFileSync(join(ROOT, PRODUCT_DOCS, name), 'utf8');
      const state = declaredDocumentationState(text);
      if (state === null || !NOT_YET_CAPABILITY_STATES.includes(state)) continue;

      // The caveat must be near the top, where a reader meets it before the
      // body rather than after being persuaded by it.
      const opening = text.split('\n').slice(0, 12).join('\n');
      expect(opening, `${name} is ${state} and does not say so in its opening`).toMatch(
        /not (?:built|a working capability)|should (?:not )?be read as/i,
      );
    }
  });

  it('labels the generated documents from their generators, not by hand', () => {
    // A marker added by hand to a generated file is removed by the next run,
    // and the drift check would then fail for a reason nobody expects.
    for (const name of ['CAPABILITY_STATUS.md', 'MSP_OPERATING_MODEL.md']) {
      const text = readFileSync(join(ROOT, PRODUCT_DOCS, name), 'utf8');
      expect(text, name).toMatch(/Do not edit by hand/);
      expect(declaredDocumentationState(text), name).not.toBeNull();
    }
  });
});

describe('the README tells a reader to run things that exist', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const scripts = Object.keys(
    (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts,
  );

  /** Every `pnpm <name>` the README names, deduplicated. */
  const invoked = [
    ...new Set(
      [...readme.matchAll(/(?:^|[\s`])pnpm\s+((?:[a-z]+:)?[a-z][a-z0-9:-]*)/g)].map(
        (m) => m[1] ?? '',
      ),
    ),
  ].filter((name) => name !== '');

  it('names commands to check', () => {
    // A guard on the guard: if the pattern stops matching, the check below would
    // pass by finding nothing to verify.
    expect(invoked.length).toBeGreaterThan(5);
  });

  it('names no script that does not exist', () => {
    /**
     * The failure this prevents is small and corrosive: a script is renamed, the
     * README keeps telling people to run the old name, and the first thing a new
     * reader does with this repository does not work. "Documentation matches
     * implementation" is one of the ten completion conditions, and a command is
     * the most literal form of it.
     */
    const passthrough = new Set(['install', 'dlx', 'exec', 'run', 'add', 'why', 'audit', 'store']);
    const unknown = invoked.filter((name) => !scripts.includes(name) && !passthrough.has(name));
    expect(
      unknown,
      `The README tells a reader to run scripts that are not in package.json:\n  ${unknown.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });
});

describe('the README explains every package, rather than listing it', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  /**
   * The README with every fenced code block removed.
   *
   * A directory tree inside a code fence names a package without engaging with
   * it, and cannot be clicked. The point of this check is that each package is
   * discussed in prose a reader can follow, so the tree does not count.
   */
  const prose = readme.replace(/```[\s\S]*?```/g, '');

  /**
   * The product's packages. Veylith's operating layer is not among them.
   *
   * The README belongs to the product, and the product ships no company layer —
   * so requiring the README to explain `packages/vaol` required it to describe
   * software its reader does not have, and requiring a resolvable link to it
   * made the README unusable in the extracted product tree, where the path is
   * not there. Both were wrong for the same reason.
   */
  const packages = productPackages();

  it('finds packages to check', () => {
    // A guard on the guard. An empty list would make the checks below vacuous,
    // and the directory layout is exactly the kind of thing that moves.
    expect(packages.length).toBeGreaterThan(15);
  });

  it('discusses every package in prose, not only in the directory tree', () => {
    /**
     * Seventeen of twenty packages were listed and never mentioned again when
     * this check was written. A reader could see that `containment` existed and
     * had nowhere to go to find out what it refuses to do.
     *
     * A full section each would have made the README worse — nobody reads forty
     * sections — so what is required is that each package is named in prose with
     * a path a reader can follow.
     */
    const unexplained = packages.filter((name) => !new RegExp(`packages/${name}\\b`).test(prose));
    expect(
      unexplained,
      `These packages appear in the repository and are not discussed in the README ` +
        `outside its directory tree:\n  ${unexplained.join('\n  ')}`,
    ).toEqual([]);
  });

  it('links every package by a path that resolves', () => {
    // A link is only useful if it goes somewhere. A renamed package would
    // otherwise leave a README full of paths that 404 on GitHub.
    const linked = [...prose.matchAll(/\]\(\.\/(packages\/[a-z-]+)\)/g)].map((m) => m[1] ?? '');
    expect(linked.length).toBeGreaterThan(15);

    const broken = [...new Set(linked)].filter((target) => !existsSync(join(ROOT, target)));
    expect(
      broken,
      `These README links point at paths that do not exist:\n  ${broken.join('\n  ')}`,
    ).toEqual([]);
  });

  it('says what each package refuses to do, not just what it is', () => {
    /**
     * The house style, and the reason the tables have the heading they have. A
     * package description that only says what something does tells a reader
     * nothing about the boundary — and the boundaries are the product.
     *
     * Checked loosely and deliberately: at least half the rows must carry a
     * refusal. Requiring it of every row would push somebody into writing one
     * that is not true, and a fabricated boundary is worse than a missing
     * sentence.
     */
    const rows = [...prose.matchAll(/^\| \[`packages\/[a-z-]+`\].*$/gm)].map((m) => m[0]);
    expect(rows.length).toBeGreaterThan(15);

    const refusals = rows.filter((row) =>
      /\bnever\b|\brefus|\bnot\b|\bno \b|\bcannot\b|\bonly\b|\bprohibited\b/i.test(row),
    );
    expect(
      refusals.length * 2,
      `Only ${refusals.length} of ${rows.length} package rows state a boundary.`,
    ).toBeGreaterThanOrEqual(rows.length);
  });
});
