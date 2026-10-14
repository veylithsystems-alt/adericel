/**
 * Exports that nothing reaches.
 *
 * WHY THIS EXISTS
 *
 * `containmentImpairments` was a complete, correct, documented function with
 * zero callers. The Truth Engine's impairment logic had a passing unit suite
 * and no production path supplied its input, so a whole designed assurance
 * state — DEGRADED — was unreachable, and every broken connector in the
 * product told an engineer to go and connect something that was already
 * connected.
 *
 * Neither was a logic error. Both were holes *between* well-tested functions,
 * and that is a class of defect unit coverage cannot see: coverage measures
 * whether a function agrees with its test, never whether anything calls it. A
 * repository can be 100% covered and implement nothing.
 *
 * Two instances were found by accident. This looks for the rest.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * This is a reference scan, not a call graph. It answers "is this name
 * mentioned anywhere other than where it is defined and tested", which is
 * weaker than reachability from an entry point and much harder to get wrong.
 * A name mentioned in a comment counts as a reference — deliberately, because
 * the alternative is a tool that reports confident false positives, and a
 * check people learn to ignore is worse than no check.
 *
 * The failure it reliably catches is the one that actually happened: a
 * function exported, tested, and never named anywhere else in the repository.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Where product and company code lives. Scripts and tests are callers, not subjects. */
const SUBJECT_ROOTS = ['packages', 'apps'];

/** Everywhere a reference may legitimately come from, including the subjects themselves. */
const CALLER_ROOTS = ['packages', 'apps', 'scripts', 'tests', 'proof', 'workflows', 'database'];

export interface UnreachedExport {
  readonly name: string;
  readonly file: string;
  readonly kind: 'function' | 'class';
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Exported functions and classes in a file.
 *
 * Functions and classes only, deliberately. The first version of this check
 * also scanned `const`, `type` and `interface` and reported 695 findings,
 * almost all of which were a type used as a parameter in its own file —
 * entirely normal. A check reporting 695 things is a check nobody reads, and
 * this file's own doc comment says why that is worse than having none.
 *
 * Functions and classes are where the defect class lives: a *behaviour*
 * written, exported, tested and never invoked. `containmentImpairments` was a
 * function. The engine's impairment input was supplied by a function nothing
 * called.
 *
 * Only `export <kind> <name>` forms. `export *` and `export { … }` re-exports
 * are skipped: a barrel re-exporting a name is not the definition of it, and
 * treating it as one would report every package index as a pile of dead code.
 */
export function namedExports(source: string): readonly UnreachedExport[] {
  const out: UnreachedExport[] = [];
  const patterns: readonly [RegExp, UnreachedExport['kind']][] = [
    [/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, 'function'],
    [/^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, 'class'],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) out.push({ name, file: '', kind });
    }
  }
  return out;
}

/** How many times a name appears in a body of text, as a whole word. */
function occurrences(text: string, name: string): number {
  return text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
}

/**
 * Whether a file is this export's own test.
 *
 * A function referenced only by the test written for it is the exact shape of
 * the defect this looks for, so its test cannot count as a caller. `foo.ts`
 * and `foo.test.ts` are one unit for this purpose.
 */
function isOwnTest(candidateFile: string, definitionFile: string): boolean {
  const base = definitionFile.replace(/\.tsx?$/, '');
  return candidateFile === `${base}.test.ts` || candidateFile === `${base}.test.tsx`;
}

export function findUnreached(): readonly UnreachedExport[] {
  const subjectFiles = SUBJECT_ROOTS.flatMap((root) => walk(join(ROOT, root)));
  const callerFiles = CALLER_ROOTS.flatMap((root) => walk(join(ROOT, root)));

  const contents = new Map<string, string>();
  for (const file of callerFiles) contents.set(file, readFileSync(file, 'utf8'));

  const unreached: UnreachedExport[] = [];

  for (const file of subjectFiles) {
    // A barrel file's whole job is re-export; its own named exports, if any,
    // are reached through it by definition.
    if (/(^|\/)index\.tsx?$/.test(file)) continue;
    const source = contents.get(file) ?? readFileSync(file, 'utf8');

    for (const exported of namedExports(source)) {
      /**
       * Used inside its own file counts as used.
       *
       * A helper exported for a test while being called by its own module is
       * exported more widely than it needs to be, which is a tidiness question
       * and not this defect. Reporting it drowned the real findings: the first
       * version flagged `stopMaintaining`, called twice in its own file.
       *
       * More than one occurrence in the defining file means the definition
       * plus at least one use.
       */
      if (occurrences(source, exported.name) > 1) continue;

      let referenced = false;
      for (const [candidate, text] of contents) {
        if (candidate === file || isOwnTest(candidate, file)) continue;
        if (occurrences(text, exported.name) > 0) {
          referenced = true;
          break;
        }
      }
      if (!referenced) {
        unreached.push({ ...exported, file: relative(ROOT, file) });
      }
    }
  }

  return [...unreached].sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );
}

function main(): void {
  const unreached = findUnreached();
  if (unreached.length === 0) {
    process.stdout.write('Every export is referenced from somewhere other than its own test.\n');
    return;
  }
  process.stdout.write(
    `${unreached.length} exported function(s) or class(es) that nothing calls:\n`,
  );
  for (const item of unreached) {
    process.stdout.write(`  ${item.file}  ${item.kind} ${item.name}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main();
}
