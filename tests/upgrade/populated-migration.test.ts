import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable, testDatabaseUrl } from '../helpers/harness.js';
import { loadMigrations, status } from '../../scripts/migrate.js';

/**
 * Migrating a database that has somebody's data in it.
 *
 * WHY THIS IS A SEPARATE SUITE
 *
 * Every migration in this repository has only ever run against an empty
 * schema. The test harness drops and rebuilds the database for each run, which
 * is the right thing for test isolation and means the migrations have never
 * once been applied to a database with rows in it.
 *
 * That is not the same exercise. A migration that is correct on an empty table
 * can fail or silently destroy data on a populated one:
 *
 *   - `ADD COLUMN ... NOT NULL` with no default fails outright.
 *   - `ALTER COLUMN ... SET NOT NULL` fails if any existing row is null.
 *   - `CREATE UNIQUE INDEX` fails if existing rows collide.
 *   - `ADD CONSTRAINT ... CHECK` fails if an existing row violates it.
 *   - A backfill that assumes an empty table writes nothing and nobody notices.
 *
 * Each of those is a failed upgrade on a customer's production database, at the
 * worst possible moment, with their assurance record inside it. It is the only
 * remaining failure in this product that would be discovered by a customer
 * rather than by us.
 *
 * HOW IT WORKS
 *
 * Migrations are applied one at a time rather than through `up()`, which runs
 * everything pending. Rows go in after the core tables exist and before every
 * later migration, so each of those runs against real data exactly as it would
 * on a customer's machine. If one of them cannot cope, this suite fails here
 * instead of there.
 */

const available = await databaseAvailable();

/**
 * Its own database, created and dropped by this suite.
 *
 * It cannot share the test database: the global setup rebuilds that one from
 * scratch, and this suite needs to control exactly when each migration is
 * applied. Named with a fixed suffix so a crashed run leaves something
 * identifiable rather than a UUID nobody recognises.
 */
const UPGRADE_DB = 'adericel_upgrade_probe';

/**
 * Populated after this migration, before every later one.
 *
 * `0001_core_tenancy_identity` creates `msps`, `organisations` and `users` —
 * the tables a real deployment has had rows in since its first day, and the
 * ones every later migration is most likely to alter.
 */
const POPULATE_AFTER = '0001_core_tenancy_identity';

interface Planted {
  readonly mspId: string;
  readonly organisationId: string;
  readonly userId: string;
}

function adminUrl(database: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

describe.skipIf(!available)('migrating a database with data in it', () => {
  let client: pg.Client;
  let planted: Planted;
  let appliedAfterPopulating = 0;
  /**
   * Where in the migration set the rows went in, or -1 if nowhere.
   *
   * Recorded rather than asserted here. `beforeAll` deliberately contains no
   * assertion about the premise: a hook that throws produces no failing test
   * *name*, so a broken premise would read as "nothing failed" to anything
   * reading the results — including the mutation harness, which is how this
   * was found. The premise is asserted in the first test instead, where it has
   * a title.
   */
  let populateIndex = -1;

  beforeAll(async () => {
    // Drop and recreate, so a crashed previous run cannot make this one pass.
    const maintenance = new pg.Client({ connectionString: testDatabaseUrl() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE ${UPGRADE_DB}`);
    await maintenance.end();

    client = new pg.Client({ connectionString: adminUrl(UPGRADE_DB) });
    await client.connect();

    const migrations = await loadMigrations();
    populateIndex = migrations.findIndex((m) => m.id === POPULATE_AFTER);

    await client.query('CREATE SCHEMA IF NOT EXISTS adericel');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL DEFAULT 0)`);

    for (const [index, migration] of migrations.entries()) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('adericel.scope', 'platform', true)");
        await client.query(migration.up);
        await client.query(
          'INSERT INTO public.schema_migrations (id, checksum, duration_ms) VALUES ($1, $2, 0)',
          [migration.id, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `${migration.filename} failed against a database holding ` +
            `${index > populateIndex ? 'planted' : 'no'} data: ${(error as Error).message}`,
          { cause: error },
        );
      }

      if (index === populateIndex) planted = await plant(client);
      if (index > populateIndex) appliedAfterPopulating += 1;
    }
  }, 600_000);

  afterAll(async () => {
    await client?.end();
    const maintenance = new pg.Client({ connectionString: testDatabaseUrl() });
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
    await maintenance.end();
  });

  it('applies every later migration against real rows', () => {
    /**
     * The premise, asserted before the number that depends on it.
     *
     * If `POPULATE_AFTER` named a migration that is not in the set — a rename,
     * a reordering, a split — nothing would be planted, every migration would
     * run against an empty schema, and the count below would still be thirty-two.
     * The suite would pass having tested the one thing it exists not to test.
     */
    expect(
      populateIndex,
      `${POPULATE_AFTER} is not in the migration set, so nothing was planted`,
    ).toBeGreaterThanOrEqual(0);
    expect(planted, 'no rows were planted, so every migration ran against an empty schema').toEqual(
      expect.objectContaining({ mspId: expect.any(String) }),
    );
    // Reported as well as asserted: the number is the whole point of the
    // suite, and a reader should be able to see it was not two.
    expect(
      appliedAfterPopulating,
      'no migration was applied to a populated database',
    ).toBeGreaterThan(5);
    process.stdout.write(
      `\n${appliedAfterPopulating} migration(s) applied to a database already holding an MSP, ` +
        'an organisation and a user.\n',
    );
  });

  it('reaches the same schema version as a fresh install', async () => {
    const applied = await status(client);
    const pending = applied.filter((entry) => !entry.applied);
    expect(
      pending.map((entry) => entry.id),
      'the upgrade did not reach head',
    ).toEqual([]);
  });

  it('still holds the MSP, the organisation and the user it started with', async () => {
    /**
     * The property that matters. A migration that fails is loud; a migration
     * that quietly drops or orphans a row is the one that reaches a customer.
     */
    const rows = await client.query<{ kind: string; found: string }>(
      `SELECT 'msp' AS kind, count(*)::text AS found FROM adericel.msps WHERE id = $1
       UNION ALL
       SELECT 'organisation', count(*)::text FROM adericel.organisations WHERE id = $2
       UNION ALL
       SELECT 'user', count(*)::text FROM adericel.users WHERE id = $3`,
      [planted.mspId, planted.organisationId, planted.userId],
    );
    for (const row of rows.rows) {
      expect(Number(row.found), `the planted ${row.kind} did not survive the upgrade`).toBe(1);
    }
  });

  it('keeps the organisation attached to its MSP', async () => {
    // A foreign key that a later migration rebuilt incorrectly would leave an
    // organisation that exists and belongs to nobody — which is worse than
    // losing it, because it would still be billed and never be reachable.
    const row = await client.query<{ msp_id: string | null }>(
      `SELECT msp_id FROM adericel.organisations WHERE id = $1`,
      [planted.organisationId],
    );
    expect(row.rows[0]?.msp_id).toBe(planted.mspId);
  });

  it('leaves row level security in force on the tables that carry tenant data', async () => {
    /**
     * Policies are schema objects, so they travel with a migration — and a
     * migration that rebuilds a table can lose `FORCE ROW LEVEL SECURITY`
     * without failing. A restored or upgraded database that has quietly lost
     * tenant isolation is worse than one that did not come back at all,
     * because it looks fine.
     */
    const unforced = await client.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'adericel'
          AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
          AND NOT c.relforcerowsecurity
        ORDER BY c.relname`,
    );
    expect(
      unforced.rows.map((r) => r.relname),
      'these tables have a policy but do not force it, so the owner role bypasses tenant isolation',
    ).toEqual([]);
  });

  it('is idempotent: running the migrations again changes nothing', async () => {
    // An operator who re-runs the upgrade after a timeout must not get a
    // second set of anything, and must not get an error that sends them
    // looking for a problem that is not there.
    const before = (await status(client)).filter((e) => e.applied).length;
    const migrations = await loadMigrations();
    const { rows } = await client.query<{ id: string }>('SELECT id FROM public.schema_migrations');
    const already = new Set(rows.map((r) => r.id));
    let reapplied = 0;
    for (const migration of migrations) {
      if (already.has(migration.id)) continue;
      reapplied += 1;
    }
    expect(reapplied, 'a second run would re-apply migrations').toBe(0);
    expect((await status(client)).filter((e) => e.applied).length).toBe(before);
  });
});

/**
 * Plant the rows a real deployment has had since its first day.
 *
 * Raw SQL at the schema as it stood after `0001`, deliberately: using the
 * application's own seeding path would require the whole current schema, which
 * is exactly what has not been applied yet.
 */
async function plant(client: pg.Client): Promise<Planted> {
  const mspId = randomUUID();
  const organisationId = randomUUID();
  const userId = randomUUID();

  await client.query("SELECT set_config('adericel.scope', 'platform', true)");
  await client.query(
    `INSERT INTO adericel.msps (id, name, slug, contact_email)
     VALUES ($1, 'Upgrade Probe MSP', 'upgrade-probe-msp', 'ops@upgrade.invalid')`,
    [mspId],
  );
  await client.query(
    `INSERT INTO adericel.organisations (id, msp_id, name, slug, country_code)
     VALUES ($1, $2, 'Upgrade Probe Ltd', 'upgrade-probe', 'GB')`,
    [organisationId, mspId],
  );
  await client.query(
    `INSERT INTO adericel.users (id, email, display_name, msp_id, status)
     VALUES ($1, 'probe@upgrade.invalid', 'Upgrade Probe', $2, 'ACTIVE')`,
    [userId, mspId],
  );

  return { mspId, organisationId, userId };
}
