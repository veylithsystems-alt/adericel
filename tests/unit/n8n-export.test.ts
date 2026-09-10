import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAllWorkflows, OUTPUT_PATH } from '../../workflows/n8n/build.js';
import { resetNodeCounter } from '../../workflows/n8n/lib.js';

/**
 * The importable n8n export.
 *
 * It is generated rather than hand-maintained, which only helps if the
 * committed file is actually what the builder produces. A JSON file that has
 * drifted from its generator is worse than a hand-written one: it looks
 * reviewable and is not.
 */

const committed = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as Record<string, unknown>[];

function build(): Record<string, unknown>[] {
  resetNodeCounter();
  return buildAllWorkflows() as unknown as Record<string, unknown>[];
}

describe('the export matches its builder', () => {
  it('has not drifted from the generator', () => {
    // If this fails, run `pnpm n8n:build`. It means somebody edited the JSON,
    // or changed the builder and did not rebuild.
    expect(build()).toEqual(committed);
  });

  it('is deterministic', () => {
    // Node ids are derived from a counter and a seed. If they were random, every
    // rebuild would produce a diff and the check above would be unusable.
    expect(build()).toEqual(build());
  });
});

describe('the export carries nothing environment-specific', () => {
  const raw = JSON.stringify(committed);

  it('contains no tenant or workflow-instance identifiers', () => {
    // A UUID in the export is somebody's organisation id, and importing it into
    // another MSP's n8n would point their automation at a customer that is not
    // theirs.
    const uuids = new Set(
      raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ?? [],
    );
    expect([...uuids]).toEqual([]);
  });

  it('contains no credentials', () => {
    const secrets = raw.match(/(?:api[_-]?key|secret|password|token)"\s*:\s*"[^"]{8,}"/gi) ?? [];
    expect(secrets).toEqual([]);
  });

  it('resolves every external address from the environment', () => {
    // One default, for the service name inside the deployment's own compose
    // network. Anything else would be a URL that is right for exactly one
    // installation.
    const urls = new Set(raw.match(/https?:\/\/[a-zA-Z0-9./:_-]+/g) ?? []);
    expect([...urls].sort()).toEqual(['http://adericel-api:4000']);
  });

  it('reads its configuration from named environment variables', () => {
    for (const variable of ['ADERICEL_API_BASE_URL', 'ADERICEL_MSP_ID']) {
      expect(raw, variable).toContain(variable);
    }
  });
});

describe('coverage of the current product', () => {
  const names = committed.map((w) => String(w.name));

  it('covers the whole lifecycle, including its end', () => {
    // Offboarding was the gap: Adericel could onboard a customer and had no
    // workflow for one leaving.
    const required = [
      'Organisation onboarding',
      'Scheduled collection',
      'Scheduled reassessment',
      'Action execution',
      'Verification',
      'Offboarding',
    ];
    for (const fragment of required) {
      expect(names.some((name) => name.includes(fragment)), fragment).toBe(true);
    }
  });

  it('watches the failures that are silent', () => {
    // Both of these degrade assurance while every light stays green: two
    // systems disagreeing, and an integration that lost a permission but still
    // connects.
    expect(names.some((n) => n.includes('Source conflicts'))).toBe(true);
    expect(names.some((n) => n.includes('Coverage watch'))).toBe(true);
  });

  it('routes every workflow failure to the error handler', () => {
    const handler = committed.find((w) => String(w.name).includes('Error handler'));
    expect(handler).toBeDefined();

    // Notifications is the one exception, and it has to be: it is what the
    // error handler calls. Pointing it back at the handler would mean a failure
    // to notify triggers a notification, which fails, which triggers a
    // notification.
    const unhandled = committed
      .filter((w) => w !== handler && !String(w.name).includes('Notifications'))
      .filter((w) => {
        const settings = (w.settings ?? {}) as Record<string, unknown>;
        return typeof settings.errorWorkflow !== 'string' || settings.errorWorkflow.length === 0;
      })
      .map((w) => String(w.name));
    expect(unhandled).toEqual([]);
  });
});
