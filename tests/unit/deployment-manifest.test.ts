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

/**
 * Every project `tsc -b tsconfig.build.json` compiles, as workspace-relative
 * directories.
 *
 * Not the reference list in `tsconfig.build.json`. Project references are
 * transitive and `tsc -b` walks them, so the set that compiles is the closure:
 * `apps/veylith` references `packages/vaol`, which references
 * `packages/autonomy`, and neither of those appears in the root list at all.
 * Checking the root list alone is what let the image build break while this
 * suite stayed green.
 */
function compiledProjects(): string[] {
  const referencesOf = (dir: string): string[] => {
    const file = path.join(root, dir, dir === '.' ? 'tsconfig.build.json' : 'tsconfig.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { references?: { path: string }[] };
    return (parsed.references ?? []).map((reference) =>
      path.relative(root, path.resolve(root, dir, reference.path)),
    );
  };

  const found = new Set<string>();
  const visit = (dir: string): void => {
    for (const reference of referencesOf(dir)) {
      if (found.has(reference)) continue;
      found.add(reference);
      visit(reference);
    }
  };
  visit('.');
  return [...found].sort();
}

interface Stage {
  readonly name: string;
  readonly from: string;
  readonly lines: readonly string[];
}

/** The Dockerfile's named stages, by name. */
function stages(): Map<string, Stage> {
  const result = new Map<string, Stage>();
  let current: { name: string; from: string; lines: string[] } | undefined;
  for (const line of dockerfile.split('\n')) {
    const declaration = /^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/.exec(line);
    if (declaration !== null) {
      current = { from: declaration[1], name: declaration[2], lines: [] };
      result.set(declaration[2], current);
      continue;
    }
    current?.lines.push(line);
  }
  return result;
}

/** A stage's own lines preceded by those of every stage it derives from. */
function lineage(stageName: string): Stage[] {
  const all = stages();
  const found: Stage[] = [];
  let name: string | undefined = stageName;
  while (name !== undefined) {
    const stage = all.get(name);
    // A base image rather than a named stage: the lineage ends here.
    if (stage === undefined) break;
    found.unshift(stage);
    name = stage.from;
  }
  return found;
}

/**
 * The filesystem `pnpm install` sees in a stage: everything copied by the
 * stages it derives from, plus its own lines up to the install itself.
 *
 * Scope is the whole point. A manifest copied after the install, or into a
 * different image entirely — the `company` target copies all three of the
 * company layer's — is a manifest pnpm never read, and a check that searched
 * the whole file would be satisfied by one.
 */
function filesystemAtInstall(stageName: string): string {
  const lines: string[] = [];
  for (const stage of lineage(stageName)) {
    for (const line of stage.lines) {
      if (stage.name === stageName && /pnpm install/.test(line)) return lines.join('\n');
      lines.push(line);
    }
  }
  return lines.join('\n');
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

  it('installs the dependencies of every package the image compiles', () => {
    /**
     * A different set from "what the server needs", and the difference is what
     * broke the image build twice.
     *
     * The check above walks the dependency closure of the API and the worker —
     * correctly, for the question it asks. But the build stage runs `tsc -b`
     * over `tsconfig.build.json`, which compiles the transitive closure of its
     * project references, and a package the apps do not depend on still has to
     * compile. `resolution` and `crosswalk` had no manifest copied, so pnpm
     * never installed their dependencies and the build failed with `Cannot
     * find module 'zod'`. The first version of this test then checked only the
     * root reference list, so it passed while `packages/vaol` and
     * `packages/autonomy` — reached through `apps/veylith` — failed exactly
     * the same way.
     */
    const compiled = compiledProjects();

    // The premise: a closure that stopped at the root list would pass
    // vacuously on packages reached only through another project.
    expect(compiled.length, 'no project references found').toBeGreaterThan(15);
    expect(
      compiled,
      'the closure must reach past the root reference list, through apps/veylith',
    ).toContain('packages/vaol');

    const installSees = filesystemAtInstall('build');

    // The premise: this is a narrower view than the whole Dockerfile. Searching
    // the whole file would be satisfied by the `company` target's copies, which
    // happen in a different image long after this install.
    expect(installSees).not.toContain('ADERICEL_COMPANY_LAYER');
    expect(dockerfile).toContain('ADERICEL_COMPANY_LAYER');

    const missing = compiled.filter(
      (project) => !installSees.includes(`COPY ${project}/package.json`),
    );
    expect(
      missing,
      'the image compiles these projects and no manifest for them exists when ' +
        'pnpm install runs, so their dependencies will not be installed',
    ).toEqual([]);
  });

  it('copies the source of every app project the image compiles', () => {
    /**
     * The same failure one level up. `tsconfig.build.json` gained
     * `apps/veylith`, the build stage copied only `apps/api` and `apps/worker`,
     * and `tsc -b` stopped with "Cannot read file
     * '/app/apps/veylith/tsconfig.json'". Package sources arrive wholesale
     * through `COPY packages/ packages/`; apps are named one at a time.
     */
    const apps = compiledProjects()
      .filter((project) => project.startsWith('apps/'))
      // The interface is built by its own job and its own Dockerfile.
      .filter((project) => project !== 'apps/web');

    expect(apps.length, 'no app projects found in the compiled closure').toBeGreaterThan(1);

    const buildStage = lineage('build')
      .map((stage) => stage.lines.join('\n'))
      .join('\n');
    const missing = apps.filter((project) => !buildStage.includes(`COPY ${project}/ ${project}/`));
    expect(
      missing,
      'the build compiles these apps and the build stage does not copy their source',
    ).toEqual([]);
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
