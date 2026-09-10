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
 * Erasure and retention, run rather than described.
 *
 * Migration 0021 added `erasure_requested_at` and `erasure_completed_at` and a
 * comment describing an erasure process. Nothing referenced either column. A
 * column that names a capability nobody implemented is the same failure this
 * product exists to refuse: a record asserting something that was never done.
 *
 * These tests do the thing and then look. The check that matters is not that
 * the endpoint returned 200 — it is that the rows are gone afterwards, counted
 * from the database rather than taken from the report.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('erasing an organisation', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'erasure-corp',
      records: [
        {
          kind: 'IdentityAccount',
          subjectExternalId: 'user:alice@erasure-corp.test',
          payload: { mfaEnabled: true },
        },
      ],
    });
    token = await signIn(harness, 'owner-erasure-corp@test.invalid');
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function tenantRowCount(organisationId: string): Promise<number> {
    return harness.db.withPlatform(async (ctx) => {
      const tables = await ctx.many<{ table_name: string }>(
        `SELECT c.table_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'adericel' AND c.column_name = 'organisation_id'
            AND t.table_type = 'BASE TABLE'
            AND c.table_name NOT IN ('organisations', 'erased_organisations')`,
      );
      let total = 0;
      for (const { table_name } of tables) {
        const row = await ctx.one<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table_name} WHERE organisation_id = $1`,
          [organisationId],
        );
        total += Number(row?.count ?? '0');
      }
      return total;
    });
  }

  it('refuses erasure for an organisation that is still running', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/erasure`,
      headers: bearer(token),
      payload: { reason: 'The customer has asked us to delete everything.' },
    });
    // Leaving and being erased are different decisions. Conflating them would
    // destroy the record of a customer who only meant to stop paying.
    expect(response.statusCode).toBe(412);
    expect(response.json().error.message).toContain('not closed');
  });

  it('refuses to execute an erasure nobody asked for', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/erasure/execute`,
      headers: bearer(token),
      payload: {},
    });
    expect(response.statusCode).toBe(412);
  });

  it('erases only after the customer has been given their record', async () => {
    // The whole offboarding sequence, because erasure sits at the end of it and
    // the ordering is the guarantee.
    const begin = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/offboarding`,
      headers: bearer(token),
      payload: { reason: 'Customer has moved to another provider.' },
    });
    expect(begin.statusCode).toBe(200);

    const exported = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/offboarding/export`,
      headers: bearer(token),
      payload: {},
    });
    expect(exported.statusCode).toBe(200);

    const revoked = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/offboarding/revoke`,
      headers: bearer(token),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);

    const closed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/offboarding/close`,
      headers: bearer(token),
      payload: {},
    });
    expect(closed.statusCode).toBe(200);

    const before = await tenantRowCount(tenant.organisationId);
    expect(before, 'the organisation should hold data before it is erased').toBeGreaterThan(0);

    const requested = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/erasure`,
      headers: bearer(token),
      payload: { reason: 'The customer has exercised their right to erasure.' },
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json().eligible).toBe(true);

    const executed = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/erasure/execute`,
      headers: bearer(token),
      payload: {},
    });
    expect(executed.statusCode).toBe(200);
    const report = executed.json();
    expect(report.outcome).toBe('ERASED');
    expect(report.residual).toEqual({});

    // The assertion that matters: counted from the database, not read from the
    // report the code just produced about itself.
    expect(await tenantRowCount(tenant.organisationId)).toBe(0);

    const organisation = await harness.db.withPlatform(async (ctx) =>
      ctx.one<{ id: string }>(`SELECT id FROM organisations WHERE id = $1`, [
        tenant.organisationId,
      ]),
    );
    expect(organisation).toBeNull();
  });

  it('leaves a tombstone that can still prove what was handed over', async () => {
    const tombstone = await harness.db.withPlatform(async (ctx) =>
      ctx.one<{
        slug: string;
        final_export_hash: string;
        erasure_completed_at: string;
        destroyed: Record<string, number>;
        residual: Record<string, number>;
      }>(`SELECT * FROM erased_organisations WHERE organisation_id = $1`, [tenant.organisationId]),
    );
    expect(tombstone).not.toBeNull();
    expect(tombstone?.slug).toBe('erasure-corp');
    // The hash of the bundle the customer holds. Years later they can check
    // what they were given against what Adericel says it gave them.
    expect(tombstone?.final_export_hash).toMatch(/^sha256:/);
    expect(tombstone?.residual).toEqual({});
    // And it says what it destroyed, so "erased" is inspectable rather than
    // believed.
    expect(Object.keys(tombstone?.destroyed ?? {}).length).toBeGreaterThan(3);
  });

  it('holds no name, contact or evidence in the tombstone', async () => {
    const columns = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'adericel' AND table_name = 'erased_organisations'`,
      ),
    );
    const names = columns.map((c) => c.column_name);
    // A tombstone that carried the customer's name would be a record of the
    // customer, which is the thing that was just erased.
    for (const forbidden of ['name', 'contact_email', 'payload', 'settings']) {
      expect(names, `the tombstone carries ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe.skipIf(!available)('the retention sweep', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('deletes what is past its period and leaves what is not', async () => {
    const { sweepRetention } = await import('@adericel/api');

    const userId = await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status)
         VALUES ('retention@test.invalid', 'Retention Subject', 'ACTIVE') RETURNING id`,
        [],
        'User',
      );
      // One session that expired two years ago, one that expired yesterday.
      // The register keeps session addresses for ninety days after expiry.
      await ctx.query(
        `INSERT INTO sessions (user_id, refresh_token_hash, source_ip, user_agent, expires_at)
         VALUES ($1, 'old-hash', '198.51.100.7', 'Old browser', now() - interval '2 years'),
                ($1, 'recent-hash', '198.51.100.8', 'Recent browser', now() - interval '1 day')`,
        [user.id],
      );
      return user.id;
    });

    const report = await sweepRetention({ db: harness.db, clock: harness.clock });
    const sessions = report.outcomes.find((outcome) => outcome.table === 'sessions');
    expect(sessions?.treatment).toBe('DELETE');
    expect(sessions?.retentionDays).toBe(90);
    expect(sessions?.rowsAffected).toBe(1);

    const remaining = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ refresh_token_hash: string }>(
        `SELECT refresh_token_hash FROM sessions WHERE user_id = $1`,
        [userId],
      ),
    );
    expect(remaining.map((row) => row.refresh_token_hash)).toEqual(['recent-hash']);
  });

  it('pseudonymises the audit trail rather than destroying it', async () => {
    const organisationId = (await seedTenant(harness, { slug: 'retention-corp', records: [] }))
      .organisationId;

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(
        `INSERT INTO audit_log
           (organisation_id, actor_type, actor_id, actor_display, action, resource_type,
            outcome, source_ip, user_agent, occurred_at)
         VALUES ($1, 'USER', gen_random_uuid(), 'Someone', 'test:old', 'Test', 'SUCCESS',
                 '198.51.100.9', 'An old browser', now() - interval '3 years')`,
        [organisationId],
      );
    });

    const { sweepRetention } = await import('@adericel/api');
    const report = await sweepRetention({ db: harness.db, clock: harness.clock });

    const network = report.outcomes.find(
      (outcome) => outcome.table === 'audit_log' && outcome.treatment === 'PSEUDONYMISE',
    );
    expect(network?.rowsAffected).toBeGreaterThan(0);

    const row = await harness.db.withPlatform(async (ctx) =>
      ctx.one<{ actor_display: string; source_ip: string | null; user_agent: string | null }>(
        `SELECT actor_display, source_ip, user_agent FROM audit_log
          WHERE organisation_id = $1 AND action = 'test:old'`,
        [organisationId],
      ),
    );
    // Who decided survives; where they were sitting does not. An audit trail
    // that cannot name the decider is not evidence of anything.
    expect(row?.actor_display).toBe('Someone');
    expect(row?.source_ip).toBeNull();
    expect(row?.user_agent).toBeNull();
  });

  it('records every sweep, so the published schedule is answerable with evidence', async () => {
    const runs = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ entry: string; treatment: string; rows_affected: string }>(
        `SELECT entry, treatment, rows_affected FROM retention_runs ORDER BY ran_at DESC`,
      ),
    );
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((run) => run.entry.startsWith('sessions('))).toBe(true);
  });

  it('reports the same row twice only if it is still there to act on', async () => {
    const { sweepRetention } = await import('@adericel/api');
    // A second sweep over the same window must find nothing: pseudonymisation
    // that reported the same rows every night would make the record useless as
    // a measure of anything.
    const second = await sweepRetention({ db: harness.db, clock: harness.clock });
    const network = second.outcomes.find(
      (outcome) => outcome.table === 'audit_log' && outcome.treatment === 'PSEUDONYMISE',
    );
    expect(network?.rowsAffected).toBe(0);
  });
});
