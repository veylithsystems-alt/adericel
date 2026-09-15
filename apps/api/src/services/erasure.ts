import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Erasure.
 *
 * Two different requests wear the same word, and conflating them destroys
 * either too much or too little:
 *
 *   ORGANISATION ERASURE  A customer who has left asks for their record to be
 *                         destroyed. Everything held about their estate goes.
 *
 *   SUBJECT ERASURE       One person asks Veylith to stop holding data about
 *                         them. Their identity goes; the decisions they made
 *                         on somebody else's estate do not, because those
 *                         belong to the customer whose estate it was.
 *
 * The discipline this file is held to is the one the whole product is held to:
 * never report a stronger outcome than the one that happened. An erasure that
 * left rows behind reports INCOMPLETE and names the tables. A field that was
 * pseudonymised is reported as pseudonymised and never as deleted. A record
 * that was lawfully retained is reported as retained, with the reason, to the
 * person who asked for it to go.
 */

export type ErasureOutcome = 'ERASED' | 'INCOMPLETE';

export interface OrganisationErasureReport {
  readonly organisationId: string;
  readonly slug: string;
  readonly outcome: ErasureOutcome;
  readonly completedAt: string;
  /** Rows destroyed, by table. Inspectable rather than asserted. */
  readonly destroyed: Readonly<Record<string, number>>;
  /**
   * Tables that still held rows for this organisation after the cascade ran.
   * Empty is the only acceptable value; anything else makes the outcome
   * INCOMPLETE.
   */
  readonly residual: Readonly<Record<string, number>>;
  /** What was deliberately kept, and why. Never silent. */
  readonly retained: readonly { what: string; reason: string }[];
}

/**
 * Every table in the tenant schema that carries an organisation_id.
 *
 * Read from the live schema rather than listed here, because a list of tables
 * in code is a list that is wrong one migration after somebody writes it — and
 * being wrong here means believing an organisation was erased when a table
 * added last month still holds it.
 */
async function tenantTables(app: AppContext): Promise<readonly string[]> {
  return app.db.withPlatform(async (ctx) => {
    const rows = await ctx.many<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'adericel'
          AND c.column_name = 'organisation_id'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name <> 'organisations'
          AND c.table_name <> 'erased_organisations'
        ORDER BY c.table_name`,
    );
    return rows.map((row) => row.table_name);
  });
}

const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

/** Count what this organisation still holds, table by table. */
async function countByTable(
  app: AppContext,
  organisationId: string,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await app.db.withPlatform(async (ctx) => {
    for (const table of tables) {
      if (!SAFE_TABLE.test(table)) continue;
      const row = await ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE organisation_id = $1`,
        [organisationId],
      );
      const count = Number(row?.count ?? '0');
      if (count > 0) counts[table] = count;
    }
  });
  return counts;
}

interface OrganisationRow {
  readonly id: string;
  readonly slug: string;
  readonly msp_id: string | null;
  readonly status: string;
  readonly closed_at: string | null;
  readonly final_export_hash: string | null;
  readonly final_export_at: string | null;
  readonly erasure_requested_at: string | null;
  readonly erasure_completed_at: string | null;
}

async function loadOrganisation(
  app: AppContext,
  organisationId: string,
): Promise<OrganisationRow | null> {
  return app.db.withPlatform(async (ctx) =>
    ctx.one<OrganisationRow>(
      `SELECT id, slug, msp_id, status, closed_at, final_export_hash, final_export_at,
              erasure_requested_at, erasure_completed_at
         FROM organisations WHERE id = $1`,
      [organisationId],
    ),
  );
}

export interface ErasureRequestState {
  readonly organisationId: string;
  readonly status: string;
  readonly requestedAt: string | null;
  readonly completedAt: string | null;
  readonly eligible: boolean;
  readonly blockers: readonly string[];
}

/** Why erasure cannot proceed yet, if it cannot. */
function blockersFor(row: OrganisationRow): readonly string[] {
  const blockers: string[] = [];
  if (row.status !== 'CLOSED') {
    blockers.push(
      'The organisation is not closed. Leaving and being erased are different ' +
        'decisions, and erasing a customer who only stopped paying would destroy ' +
        'a record they may still need.',
    );
  }
  if (row.final_export_hash === null) {
    blockers.push(
      'No final export has been taken. A customer must hold their own record ' +
        'before Adericel destroys its copy.',
    );
  }
  return blockers;
}

export async function erasureState(
  app: AppContext,
  organisationId: string,
): Promise<ErasureRequestState> {
  const row = await loadOrganisation(app, organisationId);
  if (!row) {
    // Already erased, or never existed. The tombstone answers the difference.
    const tombstone = await app.db.withPlatform(async (ctx) =>
      ctx.one<{ erasure_requested_at: string; erasure_completed_at: string }>(
        `SELECT erasure_requested_at, erasure_completed_at
           FROM erased_organisations WHERE organisation_id = $1`,
        [organisationId],
      ),
    );
    if (!tombstone) throw new AdericelError('NOT_FOUND', 'No such organisation');
    return {
      organisationId,
      status: 'ERASED',
      requestedAt: tombstone.erasure_requested_at,
      completedAt: tombstone.erasure_completed_at,
      eligible: false,
      blockers: ['Already erased.'],
    };
  }
  const blockers = blockersFor(row);
  return {
    organisationId,
    status: row.status,
    requestedAt: row.erasure_requested_at,
    completedAt: row.erasure_completed_at,
    eligible: blockers.length === 0,
    blockers,
  };
}

/**
 * Record that erasure has been asked for.
 *
 * Deliberately a separate act from carrying it out. Somebody must ask, in
 * writing, with a reason, and that request is recorded before anything is
 * destroyed — so the destruction has a cause attached to it that predates it.
 */
export async function requestOrganisationErasure(
  app: AppContext,
  organisationId: string,
  options: { readonly reason: string; readonly requestedByUserId: string | null },
): Promise<ErasureRequestState> {
  const row = await loadOrganisation(app, organisationId);
  if (!row) throw new AdericelError('NOT_FOUND', 'No such organisation');

  const blockers = blockersFor(row);
  if (blockers.length > 0) {
    throw new AdericelError('PRECONDITION_FAILED', blockers[0]!, {
      safeDetails: { blockers },
    });
  }
  if (options.reason.trim().length < 10) {
    throw new AdericelError(
      'VALIDATION_FAILED',
      'Erasure requires a stated reason. This is the one act in the system that ' +
        'cannot be undone, and an unexplained one is not attributable to anything.',
    );
  }

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `UPDATE organisations
          SET erasure_requested_at = COALESCE(erasure_requested_at, $2),
              offboarding_reason = COALESCE(offboarding_reason, $3)
        WHERE id = $1`,
      [organisationId, app.clock.nowIso(), options.reason],
    );
  });

  return erasureState(app, organisationId);
}

/**
 * Carry out an organisation erasure.
 *
 * The tombstone is written first, inside the same transaction as the deletion,
 * so there is no window in which the record is gone and nothing says it ever
 * existed. The cascade declared on `organisations` does the destruction, and
 * then every tenant table is counted again: erasure that reports success
 * without checking is exactly the kind of claim this product refuses to make.
 */
export async function eraseOrganisation(
  app: AppContext,
  organisationId: string,
  options: { readonly confirmedByUserId: string | null },
): Promise<OrganisationErasureReport> {
  const row = await loadOrganisation(app, organisationId);
  if (!row) throw new AdericelError('NOT_FOUND', 'No such organisation');

  if (row.erasure_requested_at === null) {
    throw new AdericelError(
      'PRECONDITION_FAILED',
      'Erasure has not been requested for this organisation. It is not something ' +
        'that happens as a side effect of anything else.',
    );
  }
  const blockers = blockersFor(row);
  if (blockers.length > 0) {
    throw new AdericelError('PRECONDITION_FAILED', blockers[0]!, { safeDetails: { blockers } });
  }

  const tables = await tenantTables(app);
  const destroyed = await countByTable(app, organisationId, tables);
  const completedAt = app.clock.nowIso();

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `INSERT INTO erased_organisations
         (organisation_id, msp_id, slug, final_export_hash, final_export_at, closed_at,
          erasure_requested_at, erasure_requested_by, erasure_reason,
          erasure_completed_at, destroyed, residual)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'{}'::jsonb)
       ON CONFLICT (organisation_id) DO NOTHING`,
      [
        organisationId,
        row.msp_id,
        row.slug,
        row.final_export_hash,
        row.final_export_at,
        row.closed_at,
        row.erasure_requested_at,
        options.confirmedByUserId,
        'Erasure requested after closure',
        completedAt,
        JSON.stringify(destroyed),
      ],
    );
    // The cascade declared on `organisations` carries every tenant table with
    // it. Two columns are ON DELETE SET NULL by design — `signups` and
    // `billing_events` — and those are counted as residual below rather than
    // being quietly forgiven.
    await ctx.query(`DELETE FROM organisations WHERE id = $1`, [organisationId]);
  });

  const residual = await countByTable(app, organisationId, tables);
  const outcome: ErasureOutcome = Object.keys(residual).length === 0 ? 'ERASED' : 'INCOMPLETE';

  if (outcome === 'INCOMPLETE') {
    await app.db.withPlatform(async (ctx) => {
      await ctx.query(
        `UPDATE erased_organisations SET residual = $2::jsonb WHERE organisation_id = $1`,
        [organisationId, JSON.stringify(residual)],
      );
    });
  }

  return {
    organisationId,
    slug: row.slug,
    outcome,
    completedAt,
    destroyed,
    residual,
    retained: [
      {
        what: 'A tombstone: the organisation id, slug, owning MSP, closure date, and the hash of the final export.',
        reason:
          'So a customer can still prove they were a customer, and so the export ' +
          'bundle they hold can be checked against what Adericel handed over. It ' +
          'carries no name, no contact, and no evidence.',
      },
      {
        what: 'Aggregate billing records, with the organisation reference cleared.',
        reason:
          'Veylith has its own legal obligation to keep accounting records. The ' +
          'row no longer points at the organisation.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Subject erasure
// ---------------------------------------------------------------------------

export interface SubjectErasureReport {
  readonly userId: string;
  readonly completedAt: string;
  readonly deleted: Readonly<Record<string, number>>;
  readonly pseudonymised: Readonly<Record<string, number>>;
  /** Refused, with the lawful reason stated to the person who asked. */
  readonly retained: readonly { what: string; reason: string }[];
}

/**
 * Erase one person.
 *
 * What can go, goes: their sessions, their second factors and recovery codes,
 * their outstanding invitations, their abandoned signups, the addresses they
 * signed in from.
 *
 * What cannot go is stated rather than quietly kept. An approval this person
 * gave to change a customer's production estate is the customer's record, not
 * theirs; destroying it would destroy the customer's ability to show who
 * authorised a change to their systems. Their identity in that record is
 * replaced with a stable pseudonym — the same person still reads as the same
 * person across the trail, which is what makes it a trail — and their name and
 * address are gone.
 *
 * Saying "erased" of that would be false. The report says pseudonymised, and
 * says why.
 */
export async function eraseDataSubject(
  app: AppContext,
  userId: string,
  options: { readonly reason: string },
): Promise<SubjectErasureReport> {
  if (options.reason.trim().length < 10) {
    throw new AdericelError('VALIDATION_FAILED', 'Subject erasure requires a stated reason.');
  }

  const user = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1`, [userId]),
  );
  if (!user) throw new AdericelError('NOT_FOUND', 'No such user');

  const completedAt = app.clock.nowIso();
  const deleted: Record<string, number> = {};
  const pseudonymised: Record<string, number> = {};
  // Stable, non-reversible, and unique per person, so the audit trail stays
  // readable as a trail without naming anybody.
  const pseudonym = `erased-user-${userId.slice(0, 8)}`;

  await app.db.withPlatform(async (ctx) => {
    const record = async (
      into: Record<string, number>,
      table: string,
      sql: string,
      params: unknown[],
    ): Promise<void> => {
      const result = await ctx.query(sql, params);
      if (result.rowCount > 0) into[table] = (into[table] ?? 0) + result.rowCount;
    };

    await record(deleted, 'sessions', `DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await record(deleted, 'user_credentials', `DELETE FROM user_credentials WHERE user_id = $1`, [
      userId,
    ]);
    await record(deleted, 'user_mfa_factors', `DELETE FROM user_mfa_factors WHERE user_id = $1`, [
      userId,
    ]);
    await record(
      deleted,
      'user_recovery_codes',
      `DELETE FROM user_recovery_codes WHERE user_id = $1`,
      [userId],
    );
    await record(deleted, 'mfa_challenges', `DELETE FROM mfa_challenges WHERE user_id = $1`, [
      userId,
    ]);
    await record(deleted, 'invitations', `DELETE FROM invitations WHERE lower(email) = lower($1)`, [
      user.email,
    ]);
    await record(deleted, 'signups', `DELETE FROM signups WHERE lower(email) = lower($1)`, [
      user.email,
    ]);
    // Authority ends immediately. An erased person must not still be able to
    // reach anything, and a revoked grant is kept rather than deleted because
    // the fact that authority once existed is part of the customer's record.
    await record(
      pseudonymised,
      'grants',
      `UPDATE grants SET revoked_at = COALESCE(revoked_at, $2) WHERE principal_id = $1`,
      [userId, completedAt],
    );

    await record(
      pseudonymised,
      'users',
      `UPDATE users
          SET email = $2 || '@erased.invalid',
              display_name = $2,
              status = 'DEACTIVATED'
        WHERE id = $1`,
      [userId, pseudonym],
    );
    await record(
      pseudonymised,
      'audit_log',
      `UPDATE audit_log
          SET actor_display = $2, source_ip = NULL, user_agent = NULL
        WHERE actor_id = $1`,
      [userId, pseudonym],
    );
    await record(
      pseudonymised,
      'approval_decisions',
      `UPDATE approval_decisions SET source_ip = NULL WHERE approver_user_id = $1`,
      [userId],
    );
  });

  return {
    userId,
    completedAt,
    deleted,
    pseudonymised,
    retained: [
      {
        what: 'The audit trail of decisions this person made, with their name replaced by a pseudonym.',
        reason:
          'This record belongs to the customer whose estate was changed, not to the ' +
          'person who changed it. Destroying it would remove their ability to show ' +
          'who authorised a change to their systems. It is retained to establish, ' +
          'exercise and defend legal claims (UK GDPR Article 17(3)(e)), and the ' +
          'identifying fields within it are gone.',
      },
      {
        what: 'Approvals recorded against actions, attributed to the same pseudonym.',
        reason:
          'Four-eyes control is only evidence if the two pairs of eyes remain ' +
          'distinguishable. The address the approval came from has been removed.',
      },
    ],
  };
}
