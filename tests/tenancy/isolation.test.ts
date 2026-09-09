import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
        body.entries.every((e) => e.organisationId === alpha.organisationId || e.organisationId === null),
      ).toBe(true);
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
      for (const table of ['evidence', 'claims', 'findings', 'actions', 'assessments', 'audit_log']) {
        const alphaRows = await harness.db.withTenant(alpha.organisationId, async (ctx) =>
          ctx.many<{ organisation_id: string }>(`SELECT organisation_id FROM ${table}`),
        );
        expect(
          alphaRows.every((r) => r.organisation_id === alpha.organisationId),
          `${table} leaked rows from another tenant`,
        ).toBe(true);
      }
    });
  });
});

describe.skipIf(available)('tenant isolation (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
