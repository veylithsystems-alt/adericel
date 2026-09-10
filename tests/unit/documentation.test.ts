import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

describe('the README describes the repository that exists', () => {
  it('lists every package', () => {
    const packages = readdirSync(join(ROOT, 'packages'));
    const missing = packages.filter((name) => !readme.includes(`  ${name}/`));
    expect(missing).toEqual([]);
  });

  it('lists no package that does not exist', () => {
    const packages = new Set(readdirSync(join(ROOT, 'packages')));
    const listed = [...readme.matchAll(/^ {2}([a-z-]+)\/ {2,}/gm)].map((m) => m[1]!);
    const phantom = listed.filter(
      (name) => !packages.has(name) && !['api', 'worker', 'web'].includes(name),
    );
    expect(phantom).toEqual([]);
  });

  it('does not state a count that will go stale', () => {
    // "Twenty-two architecture decision records" was true once. A number in
    // prose is a promise to update prose, and nobody keeps it.
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

describe('the migrations are contiguous', () => {
  it('numbers them without gaps or duplicates', () => {
    const files = readdirSync(join(ROOT, 'database', 'migrations')).filter((f) =>
      f.endsWith('.sql'),
    );
    const numbers = files.map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
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
