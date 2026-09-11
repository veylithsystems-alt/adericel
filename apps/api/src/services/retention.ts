import {
  PERSONAL_DATA_REGISTRY,
  timeLimitedEntries,
  type PersonalDataEntry,
} from '@adericel/domain';
import type { Database } from '@adericel/graph';
import { AdericelError, type Clock } from '@adericel/shared';

/**
 * The sweep needs a database and a clock, and nothing else.
 *
 * Declared narrowly so the worker can run it without constructing an HTTP
 * application context, and so nothing here can quietly start depending on a
 * request, a principal, or a tenant.
 */
export interface RetentionDeps {
  readonly db: Database;
  readonly clock: Clock;
}

/**
 * The retention sweep.
 *
 * Every fixed period in the register of personal data
 * (`packages/domain/src/personal-data.ts`) is enforced here, from the register
 * itself rather than from a second copy of the same decisions. A period that
 * changes in the register changes what this does, and there is nowhere for the
 * two to disagree.
 *
 * Two treatments, and the difference between them is never blurred:
 *
 *   DELETE        the row goes.
 *   PSEUDONYMISE  the row stays and the identifying columns are set to NULL,
 *                 because destroying the row would destroy a record somebody
 *                 else is entitled to — an audit entry, an approval, the fact
 *                 that a shared passport was opened.
 *
 * Every sweep writes what it did to `retention_runs`, so "addresses are removed
 * after thirteen months" is answerable with evidence rather than with the
 * policy that says so.
 */

/** What the sweep did, or would do, for one register entry. */
export interface RetentionOutcome {
  readonly entry: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly treatment: 'DELETE' | 'PSEUDONYMISE';
  readonly retentionDays: number;
  readonly cutoff: string;
  readonly rowsAffected: number;
  readonly applied: boolean;
}

export interface RetentionReport {
  readonly ranAt: string;
  readonly applied: boolean;
  readonly outcomes: readonly RetentionOutcome[];
  readonly totalRowsAffected: number;
}

/**
 * Identifiers are interpolated into SQL, so they are checked first.
 *
 * They come from a constant in this repository rather than from a request, and
 * `tests/security/personal-data.test.ts` proves each one exists in
 * `information_schema`. This is the third lock: a register entry that somehow
 * carried a quote or a semicolon would fail here rather than reach the parser.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function checkedIdentifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new AdericelError(
      'CONFIGURATION_INVALID',
      `Unsafe ${what} in the personal data register`,
      {
        safeDetails: { value },
      },
    );
  }
  return value;
}

/** How a register entry is named in the run record and in the report. */
export function entryName(entry: PersonalDataEntry): string {
  return `${entry.table}(${[...entry.columns].sort().join(', ')})`;
}

/**
 * The treatment the sweep applies when a retention period expires.
 *
 * `RETAIN_FOR_LEGAL_CLAIMS` describes what erasure does when a person asks for
 * it, not what happens when the period ends. When the period ends the basis for
 * holding the data has ended too, so the row goes.
 */
function sweepTreatment(entry: PersonalDataEntry): 'DELETE' | 'PSEUDONYMISE' {
  return entry.erasure === 'PSEUDONYMISE' ? 'PSEUDONYMISE' : 'DELETE';
}

/**
 * Run the sweep.
 *
 * `dryRun` asks what it would do without doing it. The counts are real — the
 * statements run inside a transaction that is rolled back — so a dry run is a
 * measurement rather than an estimate.
 */
export async function sweepRetention(
  app: RetentionDeps,
  options: { readonly dryRun?: boolean } = {},
): Promise<RetentionReport> {
  const applied = options.dryRun !== true;
  const ranAt = app.clock.nowIso();
  const nowMs = app.clock.nowEpochMs();
  const outcomes: RetentionOutcome[] = [];

  for (const entry of timeLimitedEntries()) {
    const days = entry.retention.days;
    const timestampColumn = entry.retention.timestampColumn;
    if (days === null || timestampColumn === null) continue;

    const table = checkedIdentifier(entry.table, 'table name');
    const clock = checkedIdentifier(timestampColumn, 'timestamp column');
    const columns = entry.columns.map((column) => checkedIdentifier(column, 'column name'));
    const treatment = sweepTreatment(entry);
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();

    const rowsAffected = await app.db.withPlatform(async (ctx) => {
      if (treatment === 'DELETE') {
        const result = await ctx.query(`DELETE FROM ${table} WHERE ${clock} < $1`, [cutoff]);
        return result.rowCount;
      }
      // Only rows that still carry one of the identifiers, so a second sweep
      // over the same window reports nothing rather than reporting the same
      // rows again.
      const assignments = columns.map((column) => `${column} = NULL`).join(', ');
      const anyStillSet = columns.map((column) => `${column} IS NOT NULL`).join(' OR ');
      const result = await ctx.query(
        `UPDATE ${table} SET ${assignments} WHERE ${clock} < $1 AND (${anyStillSet})`,
        [cutoff],
      );
      return result.rowCount;
    });

    outcomes.push({
      entry: entryName(entry),
      table: entry.table,
      columns: entry.columns,
      treatment,
      retentionDays: days,
      cutoff,
      rowsAffected,
      applied,
    });
  }

  // Written whether or not the sweep applied anything, because "we checked and
  // there was nothing past its date" is itself the answer to the question.
  await app.db.withPlatform(async (ctx) => {
    for (const outcome of outcomes) {
      await ctx.query(
        `INSERT INTO retention_runs
           (ran_at, entry, table_name, treatment, retention_days, cutoff, rows_affected, applied)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ranAt,
          outcome.entry,
          outcome.table,
          outcome.treatment,
          outcome.retentionDays,
          outcome.cutoff,
          outcome.rowsAffected,
          applied,
        ],
      );
    }
  });

  return {
    ranAt,
    applied,
    outcomes,
    totalRowsAffected: outcomes.reduce((total, outcome) => total + outcome.rowsAffected, 0),
  };
}

/**
 * The register, as an answer to "what do you hold about me, and for how long".
 *
 * Read straight from the same constant the sweep runs from, so a published
 * retention schedule cannot describe a policy the code does not implement.
 */
export function retentionSchedule(): readonly {
  entry: string;
  subject: string;
  role: string;
  purpose: string;
  lawfulBasis: string;
  policy: string;
  days: number | null;
  rationale: string;
  onErasure: string;
}[] {
  return PERSONAL_DATA_REGISTRY.map((entry) => ({
    entry: entryName(entry),
    subject: entry.subject,
    role: entry.role,
    purpose: entry.purpose,
    lawfulBasis: entry.lawfulBasis,
    policy: entry.retention.policy,
    days: entry.retention.days,
    rationale: entry.retention.rationale,
    onErasure: entry.erasure,
  }));
}
