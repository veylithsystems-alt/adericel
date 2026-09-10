#!/usr/bin/env tsx
/**
 * Migration runner.
 *
 * Migrations are plain SQL with `-- migrate:up` and `-- migrate:down`
 * sections, applied in filename order inside a transaction, and recorded with a
 * checksum. A file whose checksum changes after it has been applied is a hard
 * error: silently re-interpreting an applied migration is how production
 * schemas drift away from what the code expects.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../database/migrations', import.meta.url));

interface Migration {
  readonly id: string;
  readonly filename: string;
  readonly up: string;
  readonly down: string;
  readonly checksum: string;
}

function splitDirections(sql: string, filename: string): { up: string; down: string } {
  const upMarker = /^--\s*migrate:up\s*$/m;
  const downMarker = /^--\s*migrate:down\s*$/m;
  const upIndex = sql.search(upMarker);
  const downIndex = sql.search(downMarker);
  if (upIndex === -1) throw new Error(`${filename}: missing "-- migrate:up" marker`);
  if (downIndex === -1) throw new Error(`${filename}: missing "-- migrate:down" marker`);
  if (downIndex < upIndex)
    throw new Error(`${filename}: "-- migrate:down" precedes "-- migrate:up"`);
  const up = sql.slice(sql.indexOf('\n', upIndex) + 1, downIndex).trim();
  const down = sql.slice(sql.indexOf('\n', downIndex) + 1).trim();
  if (up === '') throw new Error(`${filename}: empty up migration`);
  return { up, down };
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const filename of entries) {
    const sql = await readFile(path.join(dir, filename), 'utf8');
    const { up, down } = splitDirections(sql, filename);
    const id = filename.replace(/\.sql$/, '');
    migrations.push({
      id,
      filename,
      up,
      down,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    });
  }
  return migrations;
}

/**
 * Prepare the migration bookkeeping, deterministically.
 *
 * Both halves of this matter, and the first cost a production upgrade path.
 *
 * The bookkeeping table is qualified. It used to be created unqualified, which
 * resolved through `search_path` — `"$user", public` by default. On a virgin
 * database the `adericel` schema does not exist yet, so it landed in `public`.
 * Once migration 0001 created the schema, the same unqualified name resolved to
 * `adericel` instead, because the deployment's login role is also called
 * `adericel` and `"$user"` comes first. The next run therefore created a second,
 * empty bookkeeping table, concluded that no migrations had ever been applied,
 * and tried to re-run 0001 — which failed on `relation "msps" already exists`.
 * The first deployment of a database worked and every upgrade after it did not.
 * A database that has landed in that state is repaired here rather than
 * requiring a manual fix.
 *
 * The search path is then pinned, so where a migration's unqualified `CREATE
 * TABLE` lands is a property of the migration runner rather than of what the
 * connecting role happens to be called.
 */
const BOOTSTRAP = `
CREATE SCHEMA IF NOT EXISTS adericel;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  id           text PRIMARY KEY,
  checksum     text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms  integer NOT NULL DEFAULT 0
);

DO $bootstrap$
BEGIN
  IF to_regclass('adericel.schema_migrations') IS NOT NULL THEN
    -- Adopt anything the stray table recorded before discarding it, so a
    -- database that recorded its history there does not lose it.
    INSERT INTO public.schema_migrations (id, checksum, applied_at, duration_ms)
    SELECT id, checksum, applied_at, duration_ms FROM adericel.schema_migrations
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE adericel.schema_migrations;
  END IF;
END;
$bootstrap$;

SET search_path TO adericel, public;`;

export interface MigrationStatus {
  readonly id: string;
  readonly applied: boolean;
  readonly checksumMatches: boolean | null;
  readonly appliedAt: string | null;
}

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

export async function status(client: pg.Client): Promise<MigrationStatus[]> {
  await client.query(BOOTSTRAP);
  const migrations = await loadMigrations();
  const { rows } = await client.query<{ id: string; checksum: string; applied_at: Date }>(
    'SELECT id, checksum, applied_at FROM public.schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.id, r]));
  return migrations.map((migration) => {
    const record = applied.get(migration.id);
    return {
      id: migration.id,
      applied: record !== undefined,
      checksumMatches: record ? record.checksum === migration.checksum : null,
      appliedAt: record ? record.applied_at.toISOString() : null,
    };
  });
}

export async function up(
  client: pg.Client,
  log: (m: string) => void = console.log,
): Promise<number> {
  await client.query(BOOTSTRAP);
  const migrations = await loadMigrations();
  const { rows } = await client.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM public.schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.id, r.checksum]));

  for (const migration of migrations) {
    const existing = applied.get(migration.id);
    if (existing !== undefined && existing !== migration.checksum) {
      throw new Error(
        `Migration ${migration.id} has already been applied but its checksum has changed. ` +
          'Applied migrations are immutable — add a new migration instead of editing this one.',
      );
    }
  }

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const started = Date.now();
    log(`applying ${migration.filename}`);
    await client.query('BEGIN');
    try {
      // Migrations perform DDL and seed platform-level rows, both of which need
      // to bypass tenant policies.
      await client.query("SELECT set_config('adericel.scope', 'platform', true)");
      await client.query(migration.up);
      await client.query(
        'INSERT INTO public.schema_migrations (id, checksum, duration_ms) VALUES ($1, $2, $3)',
        [migration.id, migration.checksum, Date.now() - started],
      );
      await client.query('COMMIT');
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${migration.filename} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return count;
}

export async function down(
  client: pg.Client,
  steps: number,
  log: (m: string) => void = console.log,
): Promise<number> {
  await client.query(BOOTSTRAP);
  const migrations = await loadMigrations();
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM public.schema_migrations ORDER BY id DESC LIMIT $1',
    [steps],
  );
  let count = 0;
  for (const row of rows) {
    const migration = byId.get(row.id);
    if (!migration) throw new Error(`Applied migration ${row.id} has no file on disk`);
    log(`reverting ${migration.filename}`);
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('adericel.scope', 'platform', true)");
      await client.query(migration.down);
      await client.query('DELETE FROM public.schema_migrations WHERE id = $1', [migration.id]);
      await client.query('COMMIT');
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Reverting ${migration.filename} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return count;
}

/** Drop everything and re-apply. Refuses to run against a production database. */
export async function reset(
  client: pg.Client,
  log: (m: string) => void = console.log,
): Promise<void> {
  if (process.env.NODE_ENV === 'production' || process.env.ADERICEL_ALLOW_RESET !== 'yes') {
    throw new Error(
      'Refusing to reset: set ADERICEL_ALLOW_RESET=yes and ensure NODE_ENV is not production.',
    );
  }
  log('dropping schema');
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('DROP SCHEMA IF EXISTS adericel CASCADE');
  await up(client, log);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const client = await connect();
  try {
    switch (command) {
      case 'up': {
        const applied = await up(client);
        console.log(applied === 0 ? 'database is up to date' : `applied ${applied} migration(s)`);
        break;
      }
      case 'down': {
        const steps = Number(process.argv[3] ?? '1');
        const reverted = await down(client, steps);
        console.log(`reverted ${reverted} migration(s)`);
        break;
      }
      case 'status': {
        for (const row of await status(client)) {
          const state = row.applied
            ? row.checksumMatches
              ? 'applied'
              : 'APPLIED (CHECKSUM MISMATCH)'
            : 'pending';
          console.log(`${row.id.padEnd(40)} ${state}`);
        }
        break;
      }
      case 'reset': {
        await reset(client);
        console.log('database reset');
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}. Use up | down | status | reset.`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
