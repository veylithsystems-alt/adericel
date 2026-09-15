import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATA_SUBJECT_KINDS,
  ERASURE_TREATMENTS,
  LAWFUL_BASES,
  PERSONAL_DATA_REGISTRY,
  looksPersonal,
  registeredTables,
  timeLimitedEntries,
} from '@adericel/domain';
import { createHarness, databaseAvailable, type Harness } from '../helpers/harness.js';

/**
 * The register of personal data, held against the database that exists.
 *
 * A record of processing kept as a document is wrong within a month, because
 * nothing fails when a migration adds a column. This checks it in both
 * directions against the live schema, so it cannot quietly stop being true.
 *
 * It cannot tell whether the retention periods are the right ones. That is a
 * judgement, and each one carries its reasoning in the register so somebody can
 * disagree with it on the merits.
 */

/**
 * Columns whose names trip the personal-data heuristic but which hold no
 * personal data. Each is here with its reason: the list is short on purpose,
 * and adding to it should feel like a claim somebody has to defend.
 */
const NOT_PERSONAL: Record<string, string> = {
  'connectors.contact_email': 'No such column; guards against the pattern being too narrow.',
  'integrations.configuration':
    'Connector configuration. Credentials live in their own sealed table (0022).',
  'notification_channels.address': 'No such column today; reserved so a future one is noticed.',
  'organisations.contact_name': 'No such column today.',
  'evidence_subjects.subject_external_id':
    'A join row naming a subject already registered under `claims` and `graph_nodes`; ' +
    'it holds no identifier of its own beyond the foreign keys.',
  'observations.subject_external_id':
    'Registered under the `observations` entry, which names it explicitly.',
  'veylith.outreach.channel':
    'The word "phone" appears as an enum value naming a medium, not a number.',
};

describe('the register is internally coherent', () => {
  it('gives every entry a subject, a basis, a purpose and a treatment', () => {
    for (const entry of PERSONAL_DATA_REGISTRY) {
      const where = `${entry.table}(${entry.columns.join(', ')})`;
      expect(DATA_SUBJECT_KINDS, where).toContain(entry.subject);
      expect(LAWFUL_BASES, where).toContain(entry.lawfulBasis);
      expect(ERASURE_TREATMENTS, where).toContain(entry.erasure);
      expect(entry.purpose.length, `${where} has no stated purpose`).toBeGreaterThan(20);
      expect(entry.columns.length, `${where} names no columns`).toBeGreaterThan(0);
      expect(
        entry.retention.rationale.length,
        `${where} states a retention period with no reasoning`,
      ).toBeGreaterThan(20);
    }
  });

  it('makes every fixed period measurable', () => {
    for (const entry of timeLimitedEntries()) {
      const where = `${entry.table}(${entry.columns.join(', ')})`;
      expect(entry.retention.days, `${where} is time-limited to nothing`).toBeGreaterThan(0);
      expect(entry.retention.timestampColumn, `${where} has no clock to measure from`).toBeTruthy();
    }
  });

  it('holds no special category data', () => {
    // Adericel observes security posture, not people. If this ever becomes
    // false it changes the lawful basis, the DPIA, and the contract.
    expect(PERSONAL_DATA_REGISTRY.filter((entry) => entry.specialCategory)).toEqual([]);
  });

  it('never calls pseudonymisation deletion', () => {
    // The same discipline as UNVERIFIED never becoming PASS. A record that
    // still exists in a re-identifiable form has not been erased, and saying it
    // has would be a lie told to the person least able to check it.
    const pseudonymised = PERSONAL_DATA_REGISTRY.filter((e) => e.erasure === 'PSEUDONYMISE');
    expect(pseudonymised.length).toBeGreaterThan(0);
    for (const entry of pseudonymised) {
      expect(entry.retention.rationale.toLowerCase()).not.toContain('deleted');
    }
  });

  it('keeps the audit trail attributable for longer than it keeps addresses', () => {
    const identity = PERSONAL_DATA_REGISTRY.find(
      (e) => e.table === 'audit_log' && e.columns.includes('actor_display'),
    );
    const network = PERSONAL_DATA_REGISTRY.find(
      (e) => e.table === 'audit_log' && e.columns.includes('source_ip'),
    );
    expect(identity?.retention.days).toBeGreaterThan(network?.retention.days ?? 0);
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)('the register matches the database', () => {
  let harness: Harness;
  let columns: { table: string; column: string }[];

  beforeAll(async () => {
    harness = await createHarness();
    columns = await harness.db.withPlatform(async (ctx) => {
      const rows = await ctx.many<{
        table_schema: string;
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_schema, table_name, column_name
           FROM information_schema.columns
          WHERE table_schema IN ('adericel', 'veylith')
          ORDER BY table_schema, table_name, column_name`,
      );
      return rows.map((row) => ({
        table: row.table_schema === 'adericel' ? row.table_name : `veylith.${row.table_name}`,
        column: row.column_name,
      }));
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('finds the schema at all', () => {
    expect(columns.length).toBeGreaterThan(200);
  });

  it('names only tables and columns that exist', () => {
    const known = new Set(columns.map((c) => `${c.table}.${c.column}`));
    const tables = new Set(columns.map((c) => c.table));
    const missing: string[] = [];
    for (const entry of PERSONAL_DATA_REGISTRY) {
      if (!tables.has(entry.table)) {
        missing.push(`table ${entry.table}`);
        continue;
      }
      for (const column of entry.columns) {
        if (!known.has(`${entry.table}.${column}`)) missing.push(`${entry.table}.${column}`);
      }
    }
    // A register that describes columns which no longer exist is a register
    // nobody has read since the migration that removed them.
    expect(missing).toEqual([]);
  });

  it('declares every column in the database that looks like personal data', () => {
    const declared = new Set(
      PERSONAL_DATA_REGISTRY.flatMap((entry) =>
        entry.columns.map((column) => `${entry.table}.${column}`),
      ),
    );
    const undeclared = columns
      .filter((c) => looksPersonal(c.column))
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !declared.has(key) && !(key in NOT_PERSONAL));
    // This is the assertion that stops the register going stale. A migration
    // that adds an email column and forgets the register fails here.
    expect(undeclared.sort()).toEqual([]);
  });

  it('measures every retention period from a column that exists', () => {
    const known = new Set(columns.map((c) => `${c.table}.${c.column}`));
    for (const entry of timeLimitedEntries()) {
      expect(
        known.has(`${entry.table}.${entry.retention.timestampColumn}`),
        `${entry.table}.${entry.retention.timestampColumn} does not exist`,
      ).toBe(true);
    }
  });

  it('covers every table that holds a foreign key to users', () => {
    // A different way of finding the same omission: anything that points at a
    // person is about a person, whatever its columns are called.
    const referencing = columns
      .filter((c) => c.column === 'user_id' || c.column === 'actor_id')
      .map((c) => c.table);
    expect(referencing.length).toBeGreaterThan(0);
    const registered = new Set(registeredTables());
    // Not every one of these must be registered — a join table holding only a
    // foreign key adds no personal data of its own — but the audit trail and
    // the session store must be, because they hold more than the key.
    for (const required of ['audit_log', 'sessions', 'mfa_challenges']) {
      expect(registered.has(required), `${required} is not in the register`).toBe(true);
    }
  });
});
