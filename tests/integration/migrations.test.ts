import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable, testDatabaseUrl } from '../helpers/harness.js';
import { down, status, up } from '../../scripts/migrate.js';

/**
 * The migration runner, exercised the way a deployment actually uses it.
 *
 * Every test here exists because the runner previously passed a first run and
 * failed a second. Migrations were recorded in a table created through
 * `search_path`, which pointed at `public` on a virgin database and at
 * `adericel` once migration 0001 had created that schema — the deployment's
 * login role being called `adericel` too. So the second `pnpm migrate` read an
 * empty bookkeeping table, concluded nothing had ever been applied, and failed
 * re-applying 0001.
 *
 * Nothing about that is visible from a single run, which is why this suite runs
 * the runner repeatedly against its own scratch database rather than sharing
 * the harness's.
 */

const available = await databaseAvailable();

/** A throwaway database, so this suite cannot disturb the harness's schema. */
const scratchName = `adericel_test_migrations_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function adminUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = '/postgres';
  return url.toString();
}

function scratchUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${scratchName}`;
  return url.toString();
}

const silent = (): void => undefined;

describe.skipIf(!available)('migration runner', () => {
  let client: pg.Client;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratchName}`);
    await admin.end();
    client = new pg.Client({ connectionString: scratchUrl() });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies every migration to a virgin database', async () => {
    const applied = await up(client, silent);
    expect(applied).toBeGreaterThanOrEqual(12);
    const rows = await status(client);
    expect(rows.every((row) => row.applied)).toBe(true);
    expect(rows.every((row) => row.checksumMatches === true)).toBe(true);
  }, 120_000);

  it('is idempotent: a second run applies nothing and does not fail', async () => {
    // This is the test the deployment path needed. Running the migrator against
    // an already-migrated database is what every upgrade does.
    expect(await up(client, silent)).toBe(0);
    expect(await up(client, silent)).toBe(0);
  }, 60_000);

  it('keeps its bookkeeping in exactly one place', async () => {
    const { rows } = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'schema_migrations'`,
    );
    // Two tables of the same name in different schemas is precisely the state
    // that made the runner forget what it had applied.
    expect(rows.map((r) => r.nspname)).toEqual(['public']);
  });

  it('recovers a database whose bookkeeping landed in the wrong schema', async () => {
    // Reproduce the broken state exactly, then prove the runner repairs it
    // rather than requiring somebody to notice and fix it by hand.
    await client.query(`
      CREATE TABLE adericel.schema_migrations (
        id text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL DEFAULT 0)`);
    await client.query(
      `INSERT INTO adericel.schema_migrations (id, checksum) VALUES ('9999_ghost', 'sha256:ghost')`,
    );

    expect(await up(client, silent)).toBe(0);

    const { rows } = await client.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'schema_migrations'`,
    );
    expect(rows.map((r) => r.nspname)).toEqual(['public']);

    // The stray table's contents were adopted, not discarded.
    const adopted = await client.query<{ id: string }>(
      `SELECT id FROM public.schema_migrations WHERE id = '9999_ghost'`,
    );
    expect(adopted.rowCount).toBe(1);
    await client.query(`DELETE FROM public.schema_migrations WHERE id = '9999_ghost'`);
  }, 60_000);

  it('puts application tables in the adericel schema, not in public', async () => {
    // Table placement used to depend on the login role being named `adericel`,
    // because that is what made `"$user"` resolve to the right schema. A
    // deployment connecting as any other role would have built the whole schema
    // in `public`, where the application's pinned search path would not find it.
    const { rows } = await client.query<{ nspname: string; relname: string }>(
      `SELECT n.nspname, c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND c.relname IN
         ('msps', 'organisations', 'evidence', 'claims', 'assessments', 'assessment_inputs')`,
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.nspname === 'adericel')).toBe(true);
  });

  it('reverts the most recent migration and re-applies it cleanly', async () => {
    expect(await down(client, 1, silent)).toBe(1);
    const reverted = await client.query(`SELECT to_regclass('adericel.assessment_inputs') AS t`);
    expect(reverted.rows[0]!.t).toBeNull();

    expect(await up(client, silent)).toBe(1);
    const restored = await client.query<{ forced: boolean; enabled: boolean }>(
      `SELECT relforcerowsecurity AS forced, relrowsecurity AS enabled
       FROM pg_class WHERE relname = 'assessment_inputs'`,
    );
    // Re-applying must restore the tenant policy too, not merely the table.
    expect(restored.rows[0]).toEqual({ forced: true, enabled: true });
    const policies = await client.query(
      `SELECT 1 FROM pg_policies WHERE tablename = 'assessment_inputs'`,
    );
    expect(policies.rowCount).toBe(1);
  }, 60_000);

  it('refuses to apply a migration whose content changed after it was applied', async () => {
    await client.query(
      `UPDATE public.schema_migrations SET checksum = 'sha256:tampered'
       WHERE id = (SELECT id FROM public.schema_migrations ORDER BY id LIMIT 1)`,
    );
    // Published migrations are immutable. Silently re-running an edited one
    // would leave two deployments with differently shaped databases and no
    // record of the difference.
    await expect(up(client, silent)).rejects.toThrow(/checksum has changed/);
  }, 60_000);
});
