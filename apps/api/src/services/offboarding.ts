import { AdericelError } from '@adericel/shared';
import { publish } from '@adericel/graph';
import type { AppContext } from '../context.js';
import { exportOrganisation } from './export.js';

/**
 * Offboarding.
 *
 * The end of the customer lifecycle, which previously did not exist: the status
 * enum could express OFFBOARDING and CLOSED and nothing could reach them.
 *
 * The order below is the whole design, and it is deliberately the opposite of
 * the convenient one. Convenience says: stop the work, revoke the access, tidy
 * up, and produce an export if anybody asks. This does export first and refuses
 * closure without it, because the moment a customer is least able to argue
 * about their record is exactly when it is most likely to be destroyed.
 */

export const OFFBOARDING_TASKS = [
  {
    key: 'export',
    title: 'Hand the customer their record',
    description:
      'A complete export of everything Adericel holds — evidence, determinations, actions and ' +
      'history. Taken before anything is revoked, and closure is refused without it.',
    required: true,
    position: 1,
  },
  {
    key: 'stop-asserting',
    title: 'Stop asserting current assurance',
    description:
      'Collection and assessment stop. Existing determinations stand as statements about the ' +
      'instants they were made; nothing new is claimed about an estate Adericel no longer sees.',
    required: true,
    position: 2,
  },
  {
    key: 'revoke-passports',
    title: 'Revoke every shared Assurance Passport',
    description:
      'Anyone holding a share link is told the record is no longer maintained, rather than ' +
      'continuing to receive an answer about an estate nobody is observing.',
    required: true,
    position: 3,
  },
  {
    key: 'destroy-credentials',
    title: 'Destroy the stored credentials',
    description:
      'Sealed credentials for the customer’s systems are deleted, not disabled. Nothing will ' +
      'legitimately use them again, so keeping them is a liability with no benefit.',
    required: true,
    position: 4,
  },
  {
    key: 'cancel-billing',
    title: 'Close the subscription',
    description: 'No further charges. A cancelled subscription is terminal.',
    required: true,
    position: 5,
  },
  {
    key: 'revoke-access',
    title: 'Revoke sessions held for this organisation',
    description:
      'Access ends when the relationship does. Sessions belonging to users granted access to ' +
      'this organisation alone are revoked. API keys are deliberately untouched: they belong ' +
      'to the MSP, not to one of its customers, and cutting them would take out every other ' +
      'customer that MSP manages.',
    required: true,
    position: 6,
  },
] as const;

export interface OffboardingTask {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly state: 'PENDING' | 'BLOCKED' | 'COMPLETED' | 'SKIPPED';
  readonly required: boolean;
  readonly position: number;
  readonly detail: string | null;
}

export interface OffboardingStatus {
  readonly organisationId: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly reason: string | null;
  readonly closedAt: string | null;
  readonly finalExportHash: string | null;
  readonly tasks: readonly OffboardingTask[];
  /** Whether closure may proceed. */
  readonly readyToClose: boolean;
  readonly blockers: readonly string[];
}

/**
 * Begin offboarding.
 *
 * Stops assurance immediately. Everything else is a task the ledger tracks,
 * because each one can fail independently and a customer's departure must not
 * be blocked by, say, a billing provider being unreachable.
 */
export async function beginOffboarding(
  app: AppContext,
  organisationId: string,
  options: { reason: string; actor: string; correlationId: string },
): Promise<OffboardingStatus> {
  const now = app.clock.nowIso();

  await app.db.withPlatform(async (ctx) => {
    const row = await ctx.oneOrFail<{ status: string }>(
      `SELECT status FROM organisations WHERE id = $1`,
      [organisationId],
      'Organisation',
    );
    if (row.status === 'CLOSED') {
      throw new AdericelError('PRECONDITION_FAILED', 'This organisation is already closed');
    }

    await ctx.query(
      `UPDATE organisations
       SET status = 'OFFBOARDING',
           offboarding_started_at = COALESCE(offboarding_started_at, $2::timestamptz),
           offboarding_reason = COALESCE(offboarding_reason, $3),
           -- Assurance stops now, not at closure. The customer has left; every
           -- further determination would be about an estate nobody is watching.
           assurance_maintained = false,
           maintenance_stopped_at = COALESCE(maintenance_stopped_at, $2::timestamptz),
           updated_at = $2::timestamptz
       WHERE id = $1`,
      [organisationId, now, options.reason],
    );

    for (const task of OFFBOARDING_TASKS) {
      await ctx.query(
        `INSERT INTO offboarding_tasks
           (organisation_id, key, title, description, required, position, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (organisation_id, key) DO NOTHING`,
        [organisationId, task.key, task.title, task.description, task.required, task.position, now],
      );
    }
  });

  await app.db.withTenant(organisationId, async (ctx) => {
    await publish(
      ctx,
      {
        type: 'AssuranceMaintenanceStopped',
        organisationId,
        subjectType: 'Organisation',
        subjectId: organisationId,
        payload: { cause: 'OFFBOARDING', reason: options.reason },
        correlationId: options.correlationId,
        actor: options.actor,
      },
      now,
    );
  });

  return offboardingStatus(app, organisationId);
}

/**
 * Take the final export and record its hash.
 *
 * Separate from closure so it can be taken more than once — a customer may want
 * a fresh copy while offboarding is in progress — and so that the hash Adericel
 * records is the one it actually handed over.
 */
export async function takeFinalExport(
  app: AppContext,
  organisationId: string,
): Promise<{ bundle: Awaited<ReturnType<typeof exportOrganisation>>; complete: boolean }> {
  const bundle = await exportOrganisation(app, organisationId);

  if (!bundle.complete) {
    // A truncated bundle must never become the final record. The customer would
    // be handed a document that says it is everything and is not.
    throw new AdericelError(
      'PRECONDITION_FAILED',
      `The export was truncated (${bundle.truncatedTables.join(', ')}), so it cannot be the ` +
        'final record. Raise the row limit or export in parts before closing this organisation.',
      { safeDetails: { truncatedTables: bundle.truncatedTables } },
    );
  }

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `UPDATE organisations SET final_export_hash = $2, final_export_at = $3::timestamptz
       WHERE id = $1`,
      [organisationId, bundle.bundleHash, app.clock.nowIso()],
    );
  });

  return { bundle, complete: bundle.complete };
}

/**
 * Perform the revocations.
 *
 * Idempotent, and safe to call repeatedly: each step is a state assertion
 * rather than a transition, so a partial run followed by a retry converges.
 */
export async function revokeAccess(
  app: AppContext,
  organisationId: string,
  options: { reason: string; actor: string },
): Promise<{ passports: number; integrations: number; sessions: number }> {
  const now = app.clock.nowIso();

  return app.db.withPlatform(async (ctx) => {
    const passports = await ctx.many<{ id: string }>(
      `UPDATE passport_shares
       SET revoked_at = $2::timestamptz, revoked_reason = $3
       WHERE organisation_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [organisationId, now, options.reason],
    );

    // Deleted, not nulled to an empty string: the ciphertext is the liability.
    const integrations = await ctx.many<{ id: string }>(
      `UPDATE integrations
       SET status = 'DISABLED', sealed_credentials = NULL, credential_updated_at = NULL
       WHERE organisation_id = $1 AND sealed_credentials IS NOT NULL
       RETURNING id`,
      [organisationId],
    );

    const sessions = await ctx.many<{ id: string }>(
      `UPDATE sessions SET revoked_at = $2::timestamptz
       WHERE revoked_at IS NULL
         AND user_id IN (
           SELECT DISTINCT g.principal_id FROM grants g
           WHERE g.principal_type = 'USER' AND g.scope_type = 'ORGANISATION'
             AND g.scope_id = $1 AND g.revoked_at IS NULL
         )
       RETURNING id`,
      [organisationId, now],
    );

    // API keys are NOT revoked here, and that is deliberate.
    //
    // A key belongs to an MSP, not to one of its customers. Revoking an
    // organisation's keys would in fact revoke its MSP's keys and take out
    // every other customer that MSP manages — an outage caused by one
    // customer choosing to leave. Withdrawing an MSP's keys is an MSP-level
    // decision with an MSP-level blast radius, and it belongs there.
    return {
      passports: passports.length,
      integrations: integrations.length,
      sessions: sessions.length,
    };
  });
}

/**
 * The ledger, recomputed from real state.
 *
 * Never ticked off. A task marked complete because somebody believed it was is
 * how a checklist becomes decoration.
 */
export async function offboardingStatus(
  app: AppContext,
  organisationId: string,
): Promise<OffboardingStatus> {
  const state = await app.db.withPlatform(async (ctx) => {
    const organisation = await ctx.oneOrFail<{
      status: string;
      offboarding_started_at: Date | null;
      offboarding_reason: string | null;
      closed_at: Date | null;
      final_export_hash: string | null;
      assurance_maintained: boolean;
    }>(
      `SELECT status, offboarding_started_at, offboarding_reason, closed_at,
              final_export_hash, assurance_maintained
       FROM organisations WHERE id = $1`,
      [organisationId],
      'Organisation',
    );

    const facts = await ctx.oneOrFail<{
      live_shares: string;
      sealed_integrations: string;
      live_sessions: string;
      live_subscriptions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM passport_shares
          WHERE organisation_id = $1 AND revoked_at IS NULL) AS live_shares,
         (SELECT count(*)::text FROM integrations
          WHERE organisation_id = $1 AND sealed_credentials IS NOT NULL) AS sealed_integrations,
         (SELECT count(*)::text FROM sessions s
          WHERE s.revoked_at IS NULL AND s.user_id IN (
            SELECT g.principal_id FROM grants g
            WHERE g.principal_type = 'USER' AND g.scope_type = 'ORGANISATION'
              AND g.scope_id = $1 AND g.revoked_at IS NULL)) AS live_sessions,
         (SELECT count(*)::text FROM subscriptions
          WHERE organisation_id = $1 AND status <> 'CANCELLED') AS live_subscriptions`,
      [organisationId],
      'Organisation offboarding facts',
    );

    const tasks = await ctx.many<{
      key: string;
      title: string;
      description: string;
      required: boolean;
      position: number;
      detail: string | null;
    }>(
      `SELECT key, title, description, required, position, detail
       FROM offboarding_tasks WHERE organisation_id = $1 ORDER BY position`,
      [organisationId],
    );

    return { organisation, facts, tasks };
  });

  // Each task's state read from what is true now, not from what was recorded.
  const completed: Record<string, boolean> = {
    export: state.organisation.final_export_hash !== null,
    'stop-asserting': state.organisation.assurance_maintained === false,
    'revoke-passports': Number(state.facts.live_shares) === 0,
    'destroy-credentials': Number(state.facts.sealed_integrations) === 0,
    'cancel-billing': Number(state.facts.live_subscriptions) === 0,
    'revoke-access': Number(state.facts.live_sessions) === 0,
  };

  const tasks: OffboardingTask[] = state.tasks.map((task) => ({
    key: task.key,
    title: task.title,
    description: task.description,
    required: task.required,
    position: task.position,
    detail: task.detail,
    state: completed[task.key] === true ? 'COMPLETED' : 'PENDING',
  }));

  const blockers = tasks
    .filter((task) => task.required && task.state !== 'COMPLETED')
    .map((task) => task.title);

  return {
    organisationId,
    status: state.organisation.status,
    startedAt: state.organisation.offboarding_started_at?.toISOString() ?? null,
    reason: state.organisation.offboarding_reason,
    closedAt: state.organisation.closed_at?.toISOString() ?? null,
    finalExportHash: state.organisation.final_export_hash,
    tasks,
    readyToClose: blockers.length === 0,
    blockers,
  };
}

/**
 * Close the organisation.
 *
 * Refused while any required step is outstanding. The database enforces the
 * export requirement independently, so a bug here still cannot produce a closed
 * organisation whose customer never received their record.
 */
export async function closeOrganisation(
  app: AppContext,
  organisationId: string,
  options: { actor: string; correlationId: string },
): Promise<OffboardingStatus> {
  const status = await offboardingStatus(app, organisationId);
  if (status.status !== 'OFFBOARDING') {
    throw new AdericelError(
      'PRECONDITION_FAILED',
      `Offboarding has not been started for this organisation (it is ${status.status})`,
    );
  }
  if (!status.readyToClose) {
    throw new AdericelError('PRECONDITION_FAILED', 'Offboarding is not complete', {
      safeDetails: { blockers: status.blockers },
    });
  }

  const now = app.clock.nowIso();
  await app.db.withTenant(organisationId, async (ctx) => {
    // Published before the status change, while the organisation is still
    // reachable through a tenant context.
    await publish(
      ctx,
      {
        type: 'OrganisationUpdated',
        organisationId,
        subjectType: 'Organisation',
        subjectId: organisationId,
        payload: { status: 'CLOSED', finalExportHash: status.finalExportHash },
        correlationId: options.correlationId,
        actor: options.actor,
      },
      now,
    );
  });

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `UPDATE organisations SET status = 'CLOSED', closed_at = $2::timestamptz,
              updated_at = $2::timestamptz
       WHERE id = $1`,
      [organisationId, now],
    );
  });

  return offboardingStatus(app, organisationId);
}
