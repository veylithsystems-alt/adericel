import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectTenantIsolation } from '@adericel/graph';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Tenant isolation.
 *
 * A cross-tenant read or write is a critical security failure, so these tests
 * attack the boundary from several directions rather than checking one happy
 * path: through the API with a valid token for the wrong tenant, directly
 * through the database layer with the wrong context, and with no context at all.
 *
 * Row level security is one layer, not the whole strategy — but it must hold on
 * its own, which is what the direct database cases prove.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('tenant isolation', () => {
  let harness: Harness;
  let alpha: SeededTenant;
  let beta: SeededTenant;
  let alphaToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();

    alpha = await seedTenant(harness, {
      slug: 'alpha-corp',
      records: [
        {
          kind: 'IDENTITY_STATE',
          subjectExternalId: 'alpha-user-1',
          payload: {
            externalId: 'alpha-user-1',
            displayName: 'Alpha Person',
            enabled: true,
            mfaEnforced: true,
          },
        },
      ],
    });
    beta = await seedTenant(harness, {
      slug: 'beta-ltd',
      records: [
        {
          kind: 'IDENTITY_STATE',
          subjectExternalId: 'beta-user-1',
          payload: {
            externalId: 'beta-user-1',
            displayName: 'Beta Person',
            enabled: true,
            mfaEnforced: false,
          },
        },
      ],
    });

    alphaToken = await signIn(harness, `owner-alpha-corp@test.invalid`);
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('through the API', () => {
    it("refuses a valid token used against another MSP's organisation", async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${beta.organisationId}/assurance`,
        headers: bearer(alphaToken),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('does not distinguish a non-existent organisation from an unauthorised one', async () => {
      const missing = await harness.server.inject({
        method: 'GET',
        url: '/v1/organisations/00000000-0000-4000-8000-000000000000/assurance',
        headers: bearer(alphaToken),
      });
      const unauthorised = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${beta.organisationId}/assurance`,
        headers: bearer(alphaToken),
      });
      // Identical status and message, so organisation ids cannot be probed.
      expect(missing.statusCode).toBe(unauthorised.statusCode);
      expect((missing.json() as { error: { message: string } }).error.message).toBe(
        (unauthorised.json() as { error: { message: string } }).error.message,
      );
    });

    it('refuses cross-tenant writes as firmly as reads', async () => {
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${beta.organisationId}/claims`,
        headers: bearer(alphaToken),
        payload: {
          predicate: 'identity.mfa.enforced',
          value: true,
          origin: 'HUMAN_ASSERTED',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('never returns another tenant node from a listing', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${alpha.organisationId}/nodes?limit=200`,
        headers: bearer(alphaToken),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { nodes: { organisationId: string; label: string }[] };
      expect(body.nodes.length).toBeGreaterThan(0);
      expect(body.nodes.every((n) => n.organisationId === alpha.organisationId)).toBe(true);
      expect(body.nodes.some((n) => n.label === 'Beta Person')).toBe(false);
    });

    it('scopes an audit read to the caller organisation', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${alpha.organisationId}/audit?limit=200`,
        headers: bearer(alphaToken),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { entries: { organisationId: string | null }[] };
      expect(
        body.entries.every(
          (e) => e.organisationId === alpha.organisationId || e.organisationId === null,
        ),
      ).toBe(true);
    });
  });

  /**
   * Before anything else, prove the suite can fail.
   *
   * Every test below asserts that row level security prevents something. RLS is
   * bypassed unconditionally by a superuser, and FORCE ROW LEVEL SECURITY does
   * nothing about that — so under a superuser connection all of them pass
   * vacuously while proving the exact opposite of what they claim.
   *
   * That is not hypothetical. These tests passed on a developer machine, where
   * the role happened to be a non-superuser owner, and failed in CI, where the
   * postgres image creates POSTGRES_USER as a superuser. The tests were right
   * and the schema was wrong: nothing assumed the restricted role, and the role
   * the configuration named did not exist.
   *
   * This block is the guard against that recurring. If it fails, none of the
   * others mean anything, whatever they report.
   */
  describe('the conditions under which this suite is meaningful', () => {
    it('runs as a role that cannot bypass row level security', async () => {
      const report = await inspectTenantIsolation(harness.db);
      expect(
        report.isSuperuser,
        `effective role "${report.effectiveRole}" is a superuser, so RLS is not enforced and ` +
          'every isolation assertion below would pass without proving anything',
      ).toBe(false);
      expect(report.bypassesRls, `effective role "${report.effectiveRole}" has BYPASSRLS`).toBe(
        false,
      );
    });

    it('assumes the dedicated application role rather than the connection role', async () => {
      // The connection may legitimately be the owner or a superuser — that is
      // the operator's choice and Adericel cannot control it. What it can
      // control is which role the transaction runs as.
      const report = await inspectTenantIsolation(harness.db);
      expect(report.effectiveRole).toBe('adericel_app');
    });

    it('reports isolation as enforced overall', async () => {
      const report = await inspectTenantIsolation(harness.db);
      expect(report.unprotectedTables).toEqual([]);
      expect(report.leaksWithoutContext).toBe(false);
      expect(report.enforced).toBe(true);
    });
  });

  describe('at the database, with row level security', () => {
    it('shows a tenant only its own rows', async () => {
      const alphaNodes = await harness.db.withTenant(alpha.organisationId, async (ctx) =>
        ctx.many<{ id: string }>('SELECT id FROM graph_nodes'),
      );
      const betaNodes = await harness.db.withTenant(beta.organisationId, async (ctx) =>
        ctx.many<{ id: string }>('SELECT id FROM graph_nodes'),
      );
      expect(alphaNodes.length).toBeGreaterThan(0);
      expect(betaNodes.length).toBeGreaterThan(0);
      const alphaIds = new Set(alphaNodes.map((n) => n.id));
      expect(betaNodes.some((n) => alphaIds.has(n.id))).toBe(false);
    });

    it('cannot read another tenant row even by explicit id', async () => {
      const betaNode = await harness.db.withTenant(beta.organisationId, async (ctx) =>
        ctx.oneOrFail<{ id: string }>('SELECT id FROM graph_nodes LIMIT 1', [], 'Node'),
      );
      const found = await harness.db.withTenant(alpha.organisationId, async (ctx) =>
        ctx.one<{ id: string }>('SELECT id FROM graph_nodes WHERE id = $1', [betaNode.id]),
      );
      // The row exists, but not for this tenant.
      expect(found).toBeNull();
    });

    it('rejects a write that names another tenant', async () => {
      await expect(
        harness.db.withTenant(alpha.organisationId, async (ctx) =>
          ctx.query(
            `INSERT INTO graph_nodes (organisation_id, kind, label) VALUES ($1, 'Person', 'Injected')`,
            [beta.organisationId],
          ),
        ),
      ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    });

    it('shows a tenant exactly one organisation row: its own', async () => {
      const rows = await harness.db.withTenant(alpha.organisationId, async (ctx) =>
        ctx.many<{ id: string }>('SELECT id FROM organisations'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(alpha.organisationId);
    });

    it('fails closed when no tenant context is set', async () => {
      // Simulates a bug that reaches the database without establishing context.
      // The correct outcome is nothing, never everything.
      const rows = await harness.db.withTenant(alpha.organisationId, async (ctx) => {
        await ctx.query(`SELECT set_config('adericel.organisation_id', '', true)`);
        await ctx.query(`SELECT set_config('adericel.scope', 'tenant', true)`);
        return ctx.many<{ id: string }>('SELECT id FROM graph_nodes');
      });
      expect(rows).toHaveLength(0);
    });

    it('rejects a malformed organisation identifier before it reaches the database', async () => {
      await expect(
        harness.db.withTenant("' OR '1'='1", async (ctx) => ctx.many('SELECT 1')),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('isolates evidence, claims, findings and actions alike', async () => {
      for (const table of [
        'evidence',
        'claims',
        'findings',
        'actions',
        'assessments',
        'audit_log',
      ]) {
        const alphaRows = await harness.db.withTenant(alpha.organisationId, async (ctx) =>
          ctx.many<{ organisation_id: string }>(`SELECT organisation_id FROM ${table}`),
        );
        expect(
          alphaRows.every((r) => r.organisation_id === alpha.organisationId),
          `${table} leaked rows from another tenant`,
        ).toBe(true);
      }
    });

    // The previous test names tables explicitly, which means it can only catch
    // regressions in tables somebody remembered to add. This one is the
    // structural guarantee: if a column called organisation_id exists, the
    // table it lives in is tenant data, and tenant data is protected by the
    // database whether or not anyone remembered.
    it('protects every table carrying an organisation_id with forced row level security', async () => {
      const rows = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{
          table_name: string;
          rowsecurity: boolean;
          forcerowsecurity: boolean;
          policies: string;
        }>(
          `SELECT c.relname          AS table_name,
                  c.relrowsecurity   AS rowsecurity,
                  c.relforcerowsecurity AS forcerowsecurity,
                  COALESCE(COUNT(p.polname), 0)::text AS policies
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
             LEFT JOIN pg_policy p ON p.polrelid = c.oid
            WHERE n.nspname = 'adericel'
              AND c.relkind = 'r'
              AND a.attname = 'organisation_id'
              AND a.attnum > 0
              AND NOT a.attisdropped
            GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
            ORDER BY c.relname`,
        ),
      );

      expect(
        rows.length,
        'no tenant tables found — the query is wrong, not the schema',
      ).toBeGreaterThan(5);

      const unprotected = rows.filter(
        (r) => !r.rowsecurity || !r.forcerowsecurity || Number(r.policies) === 0,
      );
      expect(
        unprotected.map((r) => r.table_name),
        'these tables hold tenant data with no forced row level security policy',
      ).toEqual([]);
    });

    /**
     * Tables that hold nothing but credential material.
     *
     * These have no organisation_id, so the check above never saw them, and
     * they had no policy at all. Nothing under a tenant transaction queried
     * them — but that made the isolation of password hashes, session tokens and
     * API secrets a convention rather than a control, and conventions are what
     * this codebase uses row level security instead of.
     */
    const CREDENTIAL_TABLES = [
      'api_keys',
      'mfa_challenges',
      'sessions',
      'user_credentials',
      'user_recovery_codes',
    ];

    it('forces row level security on every table holding credential material', async () => {
      const rows = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ table_name: string; rowsecurity: boolean; forcerowsecurity: boolean; policies: string }>(
          `SELECT c.relname AS table_name, c.relrowsecurity AS rowsecurity,
                  c.relforcerowsecurity AS forcerowsecurity,
                  (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'adericel' AND c.relkind = 'r'
              AND c.relname = ANY($1::text[])`,
          [CREDENTIAL_TABLES],
        ),
      );
      expect(rows.length).toBe(CREDENTIAL_TABLES.length);
      const unprotected = rows.filter(
        (r) => !r.rowsecurity || !r.forcerowsecurity || Number(r.policies) === 0,
      );
      expect(unprotected.map((r) => r.table_name)).toEqual([]);
    });

    it('shows a tenant transaction nothing at all in them', async () => {
      // The behavioural half. A policy that exists and does not bite is not a
      // control, and this is the query an attacker would actually run.
      for (const table of CREDENTIAL_TABLES) {
        const rows = await harness.db.withTenant(alpha.organisationId, async (ctx) =>
          ctx.many(`SELECT 1 FROM ${table}`, []),
        );
        expect(rows, `${table} is readable from a tenant transaction`).toHaveLength(0);
      }
    });

    it('has rows to hide, so the previous test is not vacuous', async () => {
      // Without this, dropping the tables entirely would make the isolation
      // test pass.
      const counts = await harness.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ sessions: string; credentials: string }>(
          `SELECT (SELECT count(*)::text FROM sessions) AS sessions,
                  (SELECT count(*)::text FROM user_credentials) AS credentials`,
          [],
          'Credential counts',
        ),
      );
      expect(Number(counts.credentials)).toBeGreaterThan(0);
    });

    /**
     * Identity tables that are legitimately read under tenant scope.
     *
     * "Who can approve an action here" and "who approved this one" are tenant
     * questions with tenant answers, so a platform-only policy would break real
     * functionality. They hold identity rather than secrets. Recorded here so
     * the gap is deliberate and visible rather than an oversight nobody noticed.
     */
    it('records which identity tables remain readable under tenant scope, and why', async () => {
      // Asserted structurally rather than by reading rows: a table that
      // happens to be empty in a fixture would otherwise look protected, and
      // this test would go green for the wrong reason.
      const rows = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ table_name: string; rowsecurity: boolean }>(
          `SELECT c.relname AS table_name, c.relrowsecurity AS rowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'adericel' AND c.relkind = 'r'
              AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
          [['users', 'grants', 'user_mfa_factors']],
        ),
      );

      // A known, accepted position rather than a target. These answer tenant
      // questions — who may approve here, who approved that — so a
      // platform-only policy would break the product. They hold identity, not
      // secrets. If this ever fails because one became protected, check that
      // approvals still work before celebrating.
      expect(rows.filter((r) => r.rowsecurity).map((r) => r.table_name)).toEqual([]);
    });
  });
});

describe.skipIf(available)('tenant isolation (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
