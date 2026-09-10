import pg from 'pg';
import { up as migrateUp } from '../scripts/migrate.js';

/**
 * Rebuild the test schema exactly once per run.
 *
 * This used to happen lazily, in whichever suite reached the database first,
 * guarded by a module-level flag. That worked only while the runner kept every
 * test file in one module registry — and when it stopped doing so, several
 * workers dropped and rebuilt the schema underneath each other, producing
 * failures that pointed at migrations rather than at the harness.
 *
 * A global setup runs once in the parent process before any worker starts,
 * which removes the race rather than synchronising it. The schema is still
 * rebuilt on every run: that exercises the migrations themselves each time, and
 * a schema left behind by an interrupted run can never make a suite pass for
 * the wrong reason.
 */

function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://adericel:adericel@localhost:5432/adericel_test'
  );
}

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to rebuild the schema of a database whose name does not contain "test": ${url}`,
    );
  }

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    // No database. The suites that need one skip themselves; the ones that do
    // not still run, and failing here would take the whole run down with them.
    return;
  }

  try {
    // Every non-system schema, enumerated from the catalogue rather than listed
    // here. A hard-coded list silently stops being complete the moment a
    // migration introduces a schema.
    const schemas = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
    );
    for (const { nspname } of schemas.rows) {
      await client.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
    await client.query('CREATE SCHEMA public');
    await migrateUp(client, () => undefined);
  } finally {
    await client.end();
  }
}
