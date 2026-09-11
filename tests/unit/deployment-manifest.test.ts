import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The runtime image must contain every workspace package.
 *
 * The Dockerfile lists them explicitly, deliberately: a glob would copy a new
 * package's manifest without copying its build output, and the failure would
 * surface much later as a module-resolution error inside a running container.
 *
 * The cost of an explicit list is that somebody has to remember to extend it,
 * and nobody does — `@adericel/billing` was absent from the day it was written,
 * and `@adericel/notifications` from the day it was added. Both would have
 * built an image that passed CI and crashed on start. So the list is checked
 * against the filesystem rather than trusted.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const dockerfile = readFileSync(path.join(root, 'infrastructure/docker/Dockerfile'), 'utf8');

/** Workspace packages that ship in the server image. */
function workspacePackages(): string[] {
  return readdirSync(path.join(root, 'packages'))
    .filter((name) => existsSync(path.join(root, 'packages', name, 'package.json')))
    .sort();
}

/** Packages the API and worker actually reach, transitively. */
function serverPackages(): Set<string> {
  const manifestOf = (dir: string): { dependencies?: Record<string, string> } =>
    JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));

  const reached = new Set<string>();
  const visit = (dir: string): void => {
    for (const dep of Object.keys(manifestOf(dir).dependencies ?? {})) {
      if (!dep.startsWith('@adericel/')) continue;
      const name = dep.slice('@adericel/'.length);
      if (reached.has(name)) continue;
      reached.add(name);
      if (existsSync(path.join(root, 'packages', name, 'package.json'))) {
        visit(`packages/${name}`);
      }
    }
  };
  visit('apps/api');
  visit('apps/worker');
  return reached;
}

describe('runtime image manifest', () => {
  const packages = workspacePackages();

  it('finds the workspace packages', () => {
    expect(packages.length).toBeGreaterThanOrEqual(8);
  });

  it('copies the manifest of every package the server needs', () => {
    const needed = serverPackages();
    const missing = [...needed]
      .filter((name) => !dockerfile.includes(`packages/${name}/package.json`))
      .sort();
    expect(missing, 'these packages would not resolve inside the image').toEqual([]);
  });

  it('copies the build output of every package the server needs', () => {
    const needed = serverPackages();
    const missing = [...needed]
      .filter((name) => !dockerfile.includes(`/app/packages/${name}/dist`))
      .sort();
    // A manifest without its dist is worse than neither: pnpm symlinks the
    // package, the import resolves, and the file is not there.
    expect(missing, 'these packages would have a manifest but no code').toEqual([]);
  });

  it('ships the migrations and the runner that applies them', () => {
    // The schema must never be newer or older than the code that reads it.
    expect(dockerfile).toMatch(/COPY database\//);
    expect(dockerfile).toMatch(/COPY scripts\/migrate\.ts/);
  });

  it('does not run as root', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it('installs production dependencies only in the runtime stage', () => {
    // The build toolchain has no business in an image that faces the network.
    expect(dockerfile).toMatch(/pnpm install .*--prod/s);
  });
});
