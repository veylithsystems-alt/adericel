import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHash } from '@adericel/shared';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  testDatabaseUrl,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';
import { verifyRestore, type BackupManifest } from '../../scripts/verify-restore.js';

/**
 * Backup and restore, proven rather than assumed.
 *
 * ADR-0020 asserts that "a backup that has never been restored is not proven",
 * and until this suite existed there was no backup implementation at all: the
 * compose file mounted a `/backup` directory that did not exist, and the ADR
 * described a control nothing implemented.
 *
 * This does the whole cycle against a real database — dump, restore into a
 * scratch database, verify — and the verification is deliberately stronger than
 * "the restore command exited zero":
 *
 *   - every tracked table has the rows it had at dump time;
 *   - tenant isolation survived the round trip;
 *   - every assurance passport still hashes to its recorded hash, which is
 *     derived from content rather than from any database identifier, so a match
 *     proves the bytes came back.
 */

const available = await databaseAvailable();
const pgToolsAvailable = (() => {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const runnable = available && pgToolsAvailable;

describe.skipIf(!runnable)('backup and restore', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let workDir: string;
  let dumpFile: string;
  let manifest: BackupManifest;
  let restoredDatabase: string;
  let passportHash: string;

  const url = new URL(testDatabaseUrl());
  const sourceDatabase = url.pathname.slice(1);

  const psqlEnv = {
    ...process.env,
    PGPASSWORD: url.password,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: url.username,
  };

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'backup-corp',
      records: [
        {
          kind: 'IDENTITY_STATE',
          subjectExternalId: 'backup-user',
          payload: {
            externalId: 'backup-user',
            displayName: 'Person Without MFA',
            enabled: true,
            accountType: 'USER',
            mfaEnforced: false,
            lastSignInAt: '2026-09-08T09:00:00.000Z',
          },
        },
      ],
    });

    // Produce something worth losing: evidence, claims, determinations, a
    // recorded input snapshot and a passport.
    const token = await signIn(harness, 'analyst-backup-corp@test.invalid');
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(token),
    });
    const passport = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/passports`,
      headers: bearer(token),
    });
    expect(passport.statusCode).toBe(201);
    passportHash = (passport.json() as { contentHash: string }).contentHash;

    workDir = mkdtempSync(path.join(tmpdir(), 'adericel-backup-'));
    restoredDatabase = `adericel_restore_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    if (restoredDatabase) {
      const admin = new pg.Client({ connectionString: adminUrl() });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${restoredDatabase} WITH (FORCE)`);
      await admin.end();
    }
  });

  function adminUrl(): string {
    const admin = new URL(testDatabaseUrl());
    admin.pathname = '/postgres';
    return admin.toString();
  }

  function restoredUrl(): string {
    const restored = new URL(testDatabaseUrl());
    restored.pathname = `/${restoredDatabase}`;
    return restored.toString();
  }

  it('takes a dump and records what it should contain', async () => {
    dumpFile = path.join(workDir, 'adericel.dump');
    execFileSync(
      'pg_dump',
      [
        '--dbname',
        sourceDatabase,
        '--format=custom',
        '--compress=6',
        '--clean',
        '--if-exists',
        '--file',
        dumpFile,
      ],
      { env: psqlEnv, stdio: 'pipe' },
    );
    expect(existsSync(dumpFile)).toBe(true);

    // The manifest is what turns "the restore finished" into "the data came
    // back". Without it those are different claims and only the first is
    // observable.
    const source = new pg.Client({ connectionString: testDatabaseUrl() });
    await source.connect();
    const counts: Record<string, number> = {};
    for (const table of [
      'organisations',
      'evidence',
      'claims',
      'assessments',
      'assessment_inputs',
      'assurance_passports',
      'audit_log',
    ]) {
      const { rows } = await source.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM adericel.${table}`,
      );
      counts[table] = Number(rows[0]!.count);
    }
    const version = await source.query<{ max: string }>(
      'SELECT max(id) FROM public.schema_migrations',
    );
    await source.end();

    manifest = { schemaVersion: version.rows[0]!.max, rowCounts: counts };
    expect(counts.assessments).toBeGreaterThan(0);
    expect(counts.assurance_passports).toBeGreaterThan(0);
    expect(counts.evidence).toBeGreaterThan(0);
  }, 120_000);

  it('restores into a clean database', async () => {
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${restoredDatabase} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${restoredDatabase}`);
    await admin.end();

    execFileSync(
      'pg_restore',
      ['--dbname', restoredDatabase, '--no-owner', '--no-privileges', '--exit-on-error', dumpFile],
      { env: psqlEnv, stdio: 'pipe' },
    );

    const restored = new pg.Client({ connectionString: restoredUrl() });
    await restored.connect();
    const { rows } = await restored.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM adericel.organisations',
    );
    await restored.end();
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
  }, 180_000);

  it('verifies the restored data against the manifest', async () => {
    const restored = new pg.Client({ connectionString: restoredUrl() });
    await restored.connect();
    try {
      const result = await verifyRestore(restored, {
        target: restoredDatabase,
        manifest,
      });
      const failed = result.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`);
      expect(failed).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      await restored.end();
    }
  }, 120_000);

  it('brings back the assurance record byte-for-byte, not merely row by row', async () => {
    const restored = new pg.Client({ connectionString: restoredUrl() });
    await restored.connect();
    try {
      const { rows } = await restored.query<{ content: unknown; content_hash: string }>(
        'SELECT content, content_hash FROM adericel.assurance_passports',
      );
      expect(rows.length).toBeGreaterThan(0);
      // The passport hash is derived from content, never from a row id. A match
      // after a dump-and-restore round trip is the strongest available proof
      // that the record survived intact — and it is the artefact customers hand
      // to third parties, so it is the one that must.
      for (const row of rows) {
        expect(contentHash(row.content)).toBe(row.content_hash);
      }
      expect(rows.some((r) => r.content_hash === passportHash)).toBe(true);
    } finally {
      await restored.end();
    }
  }, 120_000);

  it('keeps tenant isolation through the round trip', async () => {
    const restored = new pg.Client({ connectionString: restoredUrl() });
    await restored.connect();
    try {
      const { rows } = await restored.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.columns col
           ON col.table_schema = n.nspname AND col.table_name = c.relname
          AND col.column_name = 'organisation_id'
         WHERE n.nspname = 'adericel' AND c.relkind = 'r'
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      );
      // A restored database that has quietly lost tenant isolation is worse
      // than no restore at all: it works, and it leaks.
      expect(rows.map((r) => r.relname)).toEqual([]);
    } finally {
      await restored.end();
    }
  }, 120_000);

  it('fails verification loudly when the restore is incomplete', async () => {
    // The check must be capable of failing. A verifier that passes whatever it
    // is given is a rubber stamp, and this suite would be one without this.
    const restored = new pg.Client({ connectionString: restoredUrl() });
    await restored.connect();
    try {
      const inflated: BackupManifest = {
        ...manifest,
        rowCounts: {
          ...manifest.rowCounts,
          assessments: (manifest.rowCounts!.assessments ?? 0) + 5,
        },
      };
      const result = await verifyRestore(restored, {
        target: restoredDatabase,
        manifest: inflated,
      });
      expect(result.passed).toBe(false);
      expect(result.checks.find((c) => c.check === 'row-counts')!.detail).toMatch(/assessments/);
    } finally {
      await restored.end();
    }
  }, 120_000);

  it('detects a passport whose content no longer matches its hash', async () => {
    const restored = new pg.Client({ connectionString: restoredUrl() });
    await restored.connect();
    try {
      await restored.query(
        `UPDATE adericel.assurance_passports
         SET content = jsonb_set(content, '{summary,unknown}', '0'::jsonb)`,
      );
      const result = await verifyRestore(restored, { target: restoredDatabase });
      const integrity = result.checks.find((c) => c.check === 'passport-integrity')!;
      expect(integrity.passed).toBe(false);
      expect(integrity.detail).toMatch(/no longer match/i);
    } finally {
      await restored.end();
    }
  }, 120_000);
});
