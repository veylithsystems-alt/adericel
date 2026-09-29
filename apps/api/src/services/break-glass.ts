import {
  authoriseBreakGlass,
  DEFAULT_BREAK_GLASS_MINUTES,
  isLive,
  type BreakGlassReason,
  type Permission,
} from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Opening and closing emergency access.
 *
 * The grant is an ordinary row in `grants` with an expiry — the same authority
 * path everything else uses, so there is no second place where access is
 * decided. This service records why it exists, tells the MSP, and makes sure it
 * comes back.
 */

export interface OpenBreakGlassRequest {
  readonly organisationId: string;
  readonly reason: BreakGlassReason;
  readonly justification: string;
  readonly minutes?: number;
  readonly permissions: readonly Permission[];
}

export interface BreakGlassGrant {
  readonly id: string;
  readonly organisationId: string;
  readonly reason: BreakGlassReason;
  readonly justification: string;
  readonly permissions: readonly string[];
  readonly openedBy: string;
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly mspNotified: boolean;
  readonly reviewRequired: true;
  /** Said on every response: this was announced, not slipped through. */
  readonly visibility: string;
}

export async function openBreakGlass(
  app: AppContext,
  request: OpenBreakGlassRequest,
  principal: {
    readonly userId: string;
    readonly displayName: string;
    readonly mfaSatisfied: boolean;
  },
  correlationId: string,
): Promise<BreakGlassGrant> {
  const minutes = request.minutes ?? DEFAULT_BREAK_GLASS_MINUTES;

  const decision = authoriseBreakGlass({
    organisationId: request.organisationId,
    reason: request.reason,
    justification: request.justification,
    minutes,
    permissions: request.permissions,
    mfaSatisfied: principal.mfaSatisfied,
  });

  if (!decision.permitted) throw new AdericelError('FORBIDDEN', decision.reason);

  const organisation = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ msp_id: string | null; name: string }>(
      `SELECT msp_id, name FROM organisations WHERE id = $1`,
      [request.organisationId],
    ),
  );
  if (!organisation) throw new AdericelError('NOT_FOUND', 'No such organisation');

  const now = app.clock.nowIso();
  const expiresAt = new Date(app.clock.nowEpochMs() + minutes * 60_000).toISOString();

  const record = await app.db.withPlatform(async (ctx) => {
    /**
     * Clear the way for a second window.
     *
     * `grants_unique_live` permits one live row per principal per scope, and a
     * grant that has expired still has `revoked_at IS NULL` — expiry is not
     * revocation. So an operator whose window ran out during an incident would
     * have hit a unique-violation and a 500 on the attempt to open another,
     * which is precisely the step the design tells them to take.
     *
     * An expired grant conveys nothing, so retiring it changes no authority.
     * A grant that is still live is a different matter: that is answered below
     * rather than swept aside, because silently replacing live emergency access
     * would lose the record of the first one.
     */
    await ctx.query(
      `UPDATE grants SET revoked_at = $4::timestamptz
        WHERE principal_type = 'USER' AND principal_id = $1
          AND scope_type = 'ORGANISATION' AND scope_id = $2
          AND revoked_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= $3::timestamptz`,
      [principal.userId, request.organisationId, now, now],
    );

    const existing = await ctx.one<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM grants
        WHERE principal_type = 'USER' AND principal_id = $1
          AND scope_type = 'ORGANISATION' AND scope_id = $2
          AND revoked_at IS NULL`,
      [principal.userId, request.organisationId],
    );
    if (existing) {
      throw new AdericelError(
        'CONFLICT',
        'You already hold live access to this organisation, expiring at ' +
          `${existing.expires_at.toISOString()}. Close it before opening another, so the ` +
          'record shows two decisions rather than one blurred into the next.',
      );
    }

    /**
     * The grant does the work. Scoped to one organisation, expiring on its own,
     * and attenuated to exactly the permissions asked for.
     *
     * The attenuation is not decoration. BREAK_GLASS is the ceiling — it can
     * read an estate and write evidence and claims, because some incidents need
     * that — but an operator who asked for `org:read` receives `org:read`. The
     * database enforces that this narrowing can afterwards only narrow further.
     *
     * Without it, `permissions` below would be a record of what somebody typed
     * rather than a statement of what they got, and the two would diverge in
     * precisely the situation where the difference matters.
     */
    const grant = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO grants
         (principal_type, principal_id, scope_type, scope_id, roles, expires_at, attenuated_to)
       VALUES ('USER', $1, 'ORGANISATION', $2, $3::text[], $4::timestamptz, $5::text[])
       RETURNING id`,
      [
        principal.userId,
        request.organisationId,
        ['BREAK_GLASS'],
        expiresAt,
        [...request.permissions],
      ],
      'Break-glass grant',
    );

    return ctx.oneOrFail<{ id: string; opened_at: Date; expires_at: Date }>(
      `INSERT INTO break_glass_grants
         (grant_id, organisation_id, msp_id, opened_by, opened_by_label, reason, justification,
          permissions, opened_at, expires_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::timestamptz,$10::timestamptz,$11)
       RETURNING id, opened_at, expires_at`,
      [
        grant.id,
        request.organisationId,
        organisation.msp_id,
        principal.userId,
        principal.displayName,
        request.reason,
        request.justification,
        [...request.permissions],
        now,
        expiresAt,
        correlationId,
      ],
      'Break-glass',
    );
  });

  /**
   * Tell the MSP now, not later.
   *
   * The MSP owns this customer relationship and is entitled to know that their
   * supplier went into their customer's estate — at the time. Finding out from
   * an audit log afterwards is a relationship problem, and a supplier who does
   * it twice does not get a third time.
   *
   * A failure to notify does not fail the access: somebody is working an
   * incident. It is recorded as un-notified, which the review will see.
   */
  let notified = false;
  if (organisation.msp_id) {
    try {
      await notifyMsp(app, organisation.msp_id, {
        organisationName: organisation.name,
        openedBy: principal.displayName,
        reason: request.reason,
        justification: request.justification,
        expiresAt,
      });
      await app.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE break_glass_grants SET msp_notified_at = $2::timestamptz WHERE id = $1`,
          [record.id, app.clock.nowIso()],
        );
      });
      notified = true;
    } catch (error) {
      app.logger.error(
        { breakGlassId: record.id, error: String(error) },
        'break-glass opened but the MSP could not be notified; recorded as un-notified',
      );
    }
  }

  return {
    id: record.id,
    organisationId: request.organisationId,
    reason: request.reason,
    justification: request.justification,
    permissions: [...request.permissions],
    openedBy: principal.displayName,
    openedAt: record.opened_at.toISOString(),
    expiresAt: record.expires_at.toISOString(),
    mspNotified: notified,
    reviewRequired: true,
    visibility:
      'This access is visible to the organisation it concerns and to their MSP, expires on its ' +
      'own, cannot be extended, and will be reviewed whether or not it turns out to have been ' +
      'warranted.',
  };
}

async function notifyMsp(
  app: AppContext,
  mspId: string,
  detail: {
    readonly organisationName: string;
    readonly openedBy: string;
    readonly reason: string;
    readonly justification: string;
    readonly expiresAt: string;
  },
): Promise<void> {
  const owner = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ email: string; display_name: string }>(
      `SELECT u.email, u.display_name
         FROM users u
         JOIN grants g ON g.principal_id = u.id AND g.principal_type = 'USER'
        WHERE g.scope_type = 'MSP' AND g.scope_id = $1 AND g.revoked_at IS NULL
          AND 'MSP_OWNER' = ANY(g.roles) AND u.status = 'ACTIVE'
        ORDER BY u.created_at LIMIT 1`,
      [mspId],
    ),
  );
  if (!owner) throw new Error('no active MSP owner to notify');

  await app.notifier.send({
    kind: 'break-glass-opened',
    to: owner.email,
    subject: `Emergency access opened on ${detail.organisationName}`,
    text: [
      `${detail.openedBy} at Veylith has opened emergency access to ${detail.organisationName}.`,
      '',
      `Reason given: ${detail.reason}`,
      `Stated justification: ${detail.justification}`,
      `It expires automatically at ${detail.expiresAt} and cannot be extended.`,
      '',
      'You are being told at the time rather than afterwards because this is your customer. ',
      'Every action taken under this access is recorded against it, the organisation can see ',
      'it, and it will be reviewed whether or not it turns out to have been warranted.',
      '',
      'If you did not expect this, reply to this message and say so.',
    ].join('\n'),
  });
}

/** Close early. Encouraged, recorded, and the only direction that is possible. */
export async function closeBreakGlass(
  app: AppContext,
  id: string,
  closedByUserId: string,
): Promise<void> {
  await app.db.withPlatform(async (ctx) => {
    const row = await ctx.one<{ grant_id: string | null; closed_at: Date | null }>(
      `SELECT grant_id, closed_at FROM break_glass_grants WHERE id = $1`,
      [id],
    );
    if (!row) throw new AdericelError('NOT_FOUND', 'No such break-glass grant');
    if (row.closed_at) return;

    if (row.grant_id) {
      await ctx.query(`UPDATE grants SET revoked_at = $2::timestamptz WHERE id = $1`, [
        row.grant_id,
        app.clock.nowIso(),
      ]);
    }
    await ctx.query(
      `UPDATE break_glass_grants SET closed_at = $2::timestamptz, closed_by = $3 WHERE id = $1`,
      [id, app.clock.nowIso(), closedByUserId],
    );
  });
}

/**
 * Grants that are open, and grants that are closed but unreviewed.
 *
 * Both matter operationally. The first is access live right now; the second is
 * a promise nobody has kept yet, and letting those accumulate quietly is how a
 * mandatory review becomes a formality.
 */
export async function outstandingBreakGlass(app: AppContext): Promise<{
  open: number;
  awaitingReview: number;
  oldestUnreviewedDays: number | null;
}> {
  const now = app.clock.nowIso();
  const row = await app.db.withPlatform(async (ctx) =>
    ctx.oneOrFail<{ open: string; awaiting: string; oldest: Date | null }>(
      `SELECT count(*) FILTER (WHERE closed_at IS NULL AND expires_at > $1::timestamptz)::text AS open,
              count(*) FILTER (WHERE review_required AND reviewed_at IS NULL)::text AS awaiting,
              min(opened_at) FILTER (WHERE review_required AND reviewed_at IS NULL) AS oldest
         FROM break_glass_grants`,
      [now],
      'Break-glass summary',
    ),
  );

  return {
    open: Number(row.open),
    awaitingReview: Number(row.awaiting),
    oldestUnreviewedDays: row.oldest
      ? Math.floor((Date.parse(now) - row.oldest.getTime()) / 86_400_000)
      : null,
  };
}

export { isLive };
