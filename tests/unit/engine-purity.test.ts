import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Truth Engine's purity, asserted structurally.
 *
 * `engine.test.ts` proves the engine behaves deterministically for the inputs
 * it is given. That is necessary and not sufficient: a behavioural test only
 * covers the paths it exercises, and the failure this guards against is someone
 * reaching for the database, the clock or an LLM inside a branch no test
 * happens to reach. So the module graph itself is checked.
 *
 * If this test blocks a change, the change is in the wrong place. Impurity
 * belongs in packages/actions, which orchestrates; the engine only decides.
 */

const engineSrc = fileURLToPath(new URL('../../packages/truth-engine/src', import.meta.url));
const packageJsonPath = fileURLToPath(
  new URL('../../packages/truth-engine/package.json', import.meta.url),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

const files = sourceFiles(engineSrc);

/** Packages the engine may depend on, and why each is safe. */
const PERMITTED_IMPORTS = new Set([
  // Canonical JSON and hashing. No I/O.
  '@adericel/shared',
  // Enumerations and pure predicate helpers over evidence and claims.
  '@adericel/domain',
  // Schema validation. No I/O.
  'zod',
]);

/**
 * Node built-ins that would give the engine a way to observe or change the
 * world. `node:crypto` is on the list deliberately: hashing belongs to shared,
 * and an engine that can generate randomness is an engine that can be
 * non-deterministic.
 */
const FORBIDDEN_BUILTINS = [
  'node:fs',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'node:child_process',
  'node:worker_threads',
  'node:crypto',
  'node:process',
  'fs',
  'net',
  'http',
  'https',
  'dns',
  'child_process',
  'crypto',
  'pg',
  'undici',
  'ioredis',
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) found.push(match[1]!);
  }
  return found;
}

describe('truth engine purity', () => {
  it('has source files to inspect', () => {
    // A refactor that moves or renames the package must not turn this suite
    // into a set of assertions over an empty list that all trivially pass.
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it('imports nothing that can reach the world', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiers(source)) {
        if (specifier.startsWith('.')) continue;
        if (PERMITTED_IMPORTS.has(specifier)) continue;
        violations.push(`${path.relative(engineSrc, file)} imports ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('names no forbidden module anywhere in its source', () => {
    // Belt and braces against an import expressed in a form the parser above
    // does not recognise, such as a computed specifier.
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const builtin of FORBIDDEN_BUILTINS) {
        if (new RegExp(`['"]${builtin}['"]`).test(source)) {
          violations.push(`${path.relative(engineSrc, file)} references ${builtin}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares no runtime dependency capable of I/O', () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([...PERMITTED_IMPORTS].sort());
  });

  it('does not read the wall clock, randomness, or the environment', () => {
    // `asOfIso` is an input for exactly this reason: two runs of the same
    // assessment must not differ because one of them happened later.
    const forbidden: readonly [RegExp, string][] = [
      [/\bDate\.now\s*\(/, 'Date.now()'],
      [/\bnew\s+Date\s*\(\s*\)/, 'new Date() with no argument'],
      [/\bMath\.random\s*\(/, 'Math.random()'],
      [/\bprocess\.env\b/, 'process.env'],
      [/\bprocess\.hrtime\b/, 'process.hrtime'],
      [/\bperformance\.now\s*\(/, 'performance.now()'],
      [/\brandomUUID\s*\(/, 'randomUUID()'],
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bglobalThis\b/, 'globalThis'],
    ];
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const [pattern, label] of forbidden) {
        if (pattern.test(source)) {
          violations.push(`${path.relative(engineSrc, file)} uses ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('holds no mutable module-level state', () => {
    // A cache or counter at module scope would make the engine's output depend
    // on what it was asked before, which replay could never reproduce.
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        if (/^(export\s+)?(let|var)\s/.test(line)) {
          violations.push(`${path.relative(engineSrc, file)}:${index + 1} ${line.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
