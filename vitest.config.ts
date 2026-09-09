import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

const workspacePackages = [
  'shared',
  'domain',
  'graph',
  'evidence',
  'truth-engine',
  'policy',
  'actions',
  'integrations',
];

/**
 * NodeNext requires relative imports to carry an explicit `.js` extension even
 * though the source on disk is `.ts`. Vite resolves most of these, but this
 * plugin guarantees it for every workspace file so that the test runner and the
 * compiled output agree on module identity.
 */
function tsExtensionResolver(): Plugin {
  return {
    name: 'adericel:ts-extension-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      const candidate = path.resolve(path.dirname(importer), source);
      const tsCandidate = candidate.replace(/\.js$/, '.ts');
      if (existsSync(tsCandidate)) return tsCandidate;
      const indexCandidate = candidate.replace(/\.js$/, '/index.ts');
      if (existsSync(indexCandidate)) return indexCandidate;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [tsExtensionResolver()],
  resolve: {
    alias: Object.fromEntries(
      workspacePackages.map((name) => [
        `@adericel/${name}`,
        path.resolve(root, `packages/${name}/src/index.ts`),
      ]),
    ),
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
