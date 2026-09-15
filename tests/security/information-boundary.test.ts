import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INFORMATION_CLASSES,
  PERMISSIONS,
  PERMISSION_CLASS,
  ROLES,
  ROLES_VALID_IN_SCOPE,
  SCOPE_TYPES,
  SURFACES,
  SURFACE_DEFINITIONS,
  permissionsOnSurface,
  surfaceAdmits,
} from '@adericel/domain';
import { classifyRoute, surfacesForRoute } from '@adericel/api';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  TEST_PASSWORD,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * The three surfaces, and the walls between them.
 *
 * Adericel is the product; Veylith Systems is the company that runs it. Three
 * populations look at this platform and each is entitled to a strictly
 * different set of facts. This file holds that claim to account in three ways:
 *
 *   1. The declaration is complete and self-consistent — every permission is
 *      classified, every role is valid somewhere, and the matrix is locked so
 *      widening it is a visible edit rather than a side effect.
 *   2. Every route is classified, so no path reaches the API without a
 *      boundary someone chose.
 *   3. The walls hold against live HTTP requests from real signed-in sessions
 *      on the wrong side of each of them.
 *
 * The third is the one that matters. The first two only stop the third from
 * being quietly untrue.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ROUTES_DIR = join(ROOT, 'apps', 'api', 'src', 'routes');

/** Every route the API registers, read from source rather than from a list. */
function registeredRoutes(): { method: string; path: string; file: string }[] {
  const found: { method: string; path: string; file: string }[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const pattern = /server\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      found.push({ method: match[1]!.toUpperCase(), path: match[2]!, file });
    }
  }
  return found;
}

describe('the declaration itself', () => {
  it('classifies every permission exactly once', () => {
    for (const permission of PERMISSIONS) {
      const informationClass = PERMISSION_CLASS[permission];
      expect(informationClass, `${permission} is unclassified`).toBeDefined();
      expect(INFORMATION_CLASSES).toContain(informationClass);
    }
  });

  it('locks the matrix, so widening a surface is a deliberate edit', () => {
    // A change here changes who may know what. It should never happen as a
    // side effect of adding a feature.
    expect(
      Object.fromEntries(SURFACES.map((s) => [s, [...SURFACE_DEFINITIONS[s].reads].sort()])),
    ).toEqual({
      VEYLITH_INTERNAL: ['COMPANY_OPERATIONS', 'PLATFORM_ADMINISTRATION'],
      ADERICEL_MSP: ['MSP_PORTFOLIO', 'TENANT_ADMINISTRATION', 'TENANT_ASSURANCE'],
      ADERICEL_CLIENT: ['TENANT_ADMINISTRATION', 'TENANT_ASSURANCE'],
    });
  });

  it('keeps the internal control room free of customer data', () => {
    // Veylith's own staff have no standing entitlement to any customer's
    // assurance state or personal data. This is the whole point of the split.
    for (const permission of PERMISSIONS) {
      if (!permission.startsWith('org:')) continue;
      expect(
        surfaceAdmits('VEYLITH_INTERNAL', permission),
        `${permission} is reachable in the internal control room`,
      ).toBe(false);
    }
  });

  it('never lets a client see the MSP above it', () => {
    // A client organisation must not be able to learn who else its MSP serves,
    // what the MSP pays, or how large its book of business is.
    for (const permission of PERMISSIONS) {
      if (!permission.startsWith('msp:') && !permission.startsWith('platform:')) continue;
      expect(
        surfaceAdmits('ADERICEL_CLIENT', permission),
        `${permission} is reachable from the client view`,
      ).toBe(false);
    }
  });

  it('gives each surface a non-empty, distinct entitlement', () => {
    const seen = new Map<string, string>();
    for (const surface of SURFACES) {
      const permissions = permissionsOnSurface(surface);
      expect(permissions.length, `${surface} discloses nothing`).toBeGreaterThan(0);
      const signature = [...permissions].sort().join(',');
      const already = seen.get(signature);
      expect(already, `${surface} and ${already} are the same surface`).toBeUndefined();
      seen.set(signature, surface);
    }
  });

  it('binds every scope to exactly one surface', () => {
    const scopes = SURFACES.map((surface) => SURFACE_DEFINITIONS[surface].scope);
    expect([...scopes].sort()).toEqual([...SCOPE_TYPES].sort());
  });

  it('makes every role valid in at least one scope, and PLATFORM_ADMIN in only one', () => {
    for (const role of ROLES) {
      const scopes = SCOPE_TYPES.filter((scope) => ROLES_VALID_IN_SCOPE[scope].includes(role));
      expect(scopes.length, `${role} is valid nowhere`).toBeGreaterThan(0);
    }
    expect(
      SCOPE_TYPES.filter((scope) => ROLES_VALID_IN_SCOPE[scope].includes('PLATFORM_ADMIN')),
    ).toEqual(['PLATFORM']);
    // The reverse of the same rule: no MSP role means anything inside a single
    // organisation's own grant.
    for (const role of ROLES.filter((r) => r.startsWith('MSP_'))) {
      expect(ROLES_VALID_IN_SCOPE.ORGANISATION).not.toContain(role);
    }
  });
});

describe('every route has a boundary', () => {
  const routes = registeredRoutes();

  it('finds the API surface at all', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('classifies every registered route', () => {
    const unclassified = routes
      .filter((route) => classifyRoute(route.method, route.path) === null)
      .map((route) => `${route.method} ${route.path} [${route.file}]`);
    // A route with no surface is a boundary nobody decided. The resolver fails
    // closed, so such a route is unusable rather than dangerous — but it is
    // still a mistake, and this is where it gets caught.
    expect(unclassified).toEqual([]);
  });

  it('puts every /v1/veylith route in the internal control room and nowhere else', () => {
    for (const route of routes.filter((r) => r.path.startsWith('/v1/veylith'))) {
      expect(surfacesForRoute(route.method, route.path)).toEqual(['VEYLITH_INTERNAL']);
    }
  });

  it('keeps every MSP route off the client view', () => {
    for (const route of routes.filter((r) => r.path.startsWith('/v1/msps/'))) {
      expect(surfacesForRoute(route.method, route.path)).not.toContain('ADERICEL_CLIENT');
    }
  });

  it('serves organisation routes to the MSP and the client, and to no one else', () => {
    const organisationRoutes = routes.filter(
      (r) =>
        r.path.startsWith('/v1/organisations/:organisationId') && r.path !== '/v1/organisations',
    );
    expect(organisationRoutes.length).toBeGreaterThan(40);
    for (const route of organisationRoutes) {
      expect([...surfacesForRoute(route.method, route.path)].sort()).toEqual([
        'ADERICEL_CLIENT',
        'ADERICEL_MSP',
      ]);
    }
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)('the walls, under live requests', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let other: SeededTenant;
  /** An MSP operator: the Adericel MSP Control Room. */
  let mspToken: string;
  /** A single organisation's own staff: the Adericel Client View. */
  let clientToken: string;
  /** Veylith's own operator: the internal control room. */
  let platformToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'boundary-corp', records: [] });
    other = await seedTenant(harness, { slug: 'boundary-rival', records: [] });
    mspToken = await signIn(harness, 'owner-boundary-corp@test.invalid');

    const { createPasswordHasher } = await import('@adericel/shared');
    const hash = await createPasswordHasher('').hash(TEST_PASSWORD);

    const makeUser = async (
      email: string,
      name: string,
      scopeType: string,
      scopeId: string | null,
      roles: readonly string[],
    ): Promise<void> => {
      await harness.db.withPlatform(async (ctx) => {
        const user = await ctx.oneOrFail<{ id: string }>(
          `INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'ACTIVE')
           ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
           RETURNING id`,
          [email, name],
          'User',
        );
        await ctx.query(
          `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
          [user.id, hash],
        );
        await ctx.query(
          `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
           VALUES ('USER', $1, $2, $3, $4::text[])
           ON CONFLICT (principal_type, principal_id, scope_type,
                        COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
           WHERE revoked_at IS NULL DO UPDATE SET roles = EXCLUDED.roles`,
          [user.id, scopeType, scopeId, roles],
        );
      });
    };

    // The client: an ORG_ADMIN of one organisation and nothing more. This is
    // the strongest role a customer's own staff can hold.
    await makeUser(
      'lead@boundary-corp.test.invalid',
      'Client Security Lead',
      'ORGANISATION',
      tenant.organisationId,
      ['ORG_ADMIN'],
    );
    clientToken = await signIn(harness, 'lead@boundary-corp.test.invalid');

    // Veylith's own operator, holding the most authority the company has.
    await makeUser('ops@veylith.test.invalid', 'Veylith Operator', 'PLATFORM', null, [
      'PLATFORM_ADMIN',
    ]);
    platformToken = await signIn(harness, 'ops@veylith.test.invalid');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('signs each of the three surfaces in', async () => {
    for (const token of [mspToken, clientToken, platformToken]) {
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);
    }
  });

  describe('the client view', () => {
    it('sees its own assurance state', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/assurance`,
        headers: bearer(clientToken),
      });
      expect(response.statusCode).toBe(200);
    });

    it('cannot see the MSP that operates it', async () => {
      for (const path of [
        `/v1/msps/${tenant.mspId}`,
        `/v1/msps/${tenant.mspId}/organisations`,
        `/v1/msps/${tenant.mspId}/portfolio`,
        `/v1/msps/${tenant.mspId}/portfolio/unknowns`,
        `/v1/msps/${tenant.mspId}/baselines`,
      ]) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(clientToken),
        });
        expect(response.statusCode, `${path} was served to the client view`).toBe(403);
      }
    });

    it('cannot see any other organisation', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${other.organisationId}/assurance`,
        headers: bearer(clientToken),
      });
      expect(response.statusCode).toBe(403);
    });

    it('cannot see the company running the platform', async () => {
      for (const path of [
        '/v1/veylith/exceptions',
        '/v1/veylith/autonomy',
        '/v1/veylith/processes',
        '/v1/veylith/events',
        '/v1/veylith/decisions',
        '/v1/system/health',
        '/v1/system/outbox',
      ]) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(clientToken),
        });
        expect(response.statusCode, `${path} was served to the client view`).toBe(403);
      }
    });
  });

  describe('the MSP control room', () => {
    it('sees its portfolio and its clients', async () => {
      for (const path of [
        `/v1/msps/${tenant.mspId}/portfolio`,
        `/v1/organisations/${tenant.organisationId}/assurance`,
      ]) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(mspToken),
        });
        expect(response.statusCode, `${path} was refused to its own MSP`).toBe(200);
      }
    });

    it('cannot reach an organisation belonging to another MSP', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${other.organisationId}/assurance`,
        headers: bearer(mspToken),
      });
      expect(response.statusCode).toBe(403);
    });

    it('cannot see the company running the platform', async () => {
      for (const path of ['/v1/veylith/exceptions', '/v1/veylith/autonomy', '/v1/system/outbox']) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(mspToken),
        });
        expect(response.statusCode, `${path} was served to an MSP`).toBe(403);
      }
    });
  });

  describe('the internal control room', () => {
    it('sees how the company is running', async () => {
      for (const path of ['/v1/veylith/exceptions', '/v1/veylith/autonomy', '/v1/system/outbox']) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(platformToken),
        });
        expect(response.statusCode, `${path} was refused to Veylith`).toBe(200);
      }
    });

    it('has no standing access to any customer assurance data', async () => {
      // The most important assertion in this file. A Veylith administrator
      // holding every platform permission there is still cannot read a
      // customer's controls, evidence, findings or actions. Support that
      // genuinely needs it is granted an expiring organisation or MSP grant,
      // which is a recorded act with a name against it.
      for (const path of [
        `/v1/organisations/${tenant.organisationId}/assurance`,
        `/v1/organisations/${tenant.organisationId}/evidence`,
        `/v1/organisations/${tenant.organisationId}/findings`,
        `/v1/organisations/${tenant.organisationId}/actions`,
        `/v1/organisations/${tenant.organisationId}/audit`,
        `/v1/organisations/${tenant.organisationId}/export`,
      ]) {
        const response = await harness.server.inject({
          method: 'GET',
          url: path,
          headers: bearer(platformToken),
        });
        expect(response.statusCode, `${path} was served to a platform administrator`).toBe(403);
      }
    });

    it('has no standing access to an MSP commercial position', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/msps/${tenant.mspId}/portfolio`,
        headers: bearer(platformToken),
      });
      expect(response.statusCode).toBe(403);
    });

    it('records which surface served a request', async () => {
      const run = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
        headers: bearer(clientToken),
        payload: {},
      });
      expect(run.statusCode).toBe(201);
      const row = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM audit_log
            WHERE organisation_id = $1 AND metadata ? 'surface'
            ORDER BY occurred_at DESC LIMIT 1`,
          [tenant.organisationId],
        ),
      );
      // An investigation needs to know whether a read arrived through the MSP's
      // delegated authority or through the organisation's own staff. That is
      // not recoverable from the actor alone.
      // The client's own staff reached it through their own organisation
      // grant, not through the MSP's delegated authority.
      expect(row?.metadata.surface).toBe('ADERICEL_CLIENT');
    });
  });

  describe('break-glass', () => {
    it('lets Veylith reach a customer only through an expiring grant it must issue', async () => {
      const before = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/assurance`,
        headers: bearer(platformToken),
      });
      expect(before.statusCode).toBe(403);

      await harness.db.withPlatform(async (ctx) => {
        const user = await ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = lower($1)`,
          ['ops@veylith.test.invalid'],
          'User',
        );
        await ctx.query(
          `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles, expires_at)
           VALUES ('USER', $1, 'ORGANISATION', $2, ARRAY['ORG_READONLY'], now() + interval '1 hour')`,
          [user.id, tenant.organisationId],
        );
      });

      const after = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/assurance`,
        headers: bearer(platformToken),
      });
      expect(after.statusCode).toBe(200);

      // And the grant is read-only: support is not a licence to change the
      // customer's estate.
      const write = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
        headers: bearer(platformToken),
        payload: {},
      });
      expect(write.statusCode).toBe(403);
    });
  });
});
