import { publish } from '@adericel/graph';
import { statusForEvent, type BillingEvent } from '@adericel/billing';
import { AdericelError, type Logger } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Billing lifecycle.
 *
 * Three properties, in descending order of how badly they go wrong.
 *
 *   Adericel stops asserting currency when the money stops, and keeps the
 *   record. A lapsed subscriber's Assurance Passport must not go on telling an
 *   insurer that an estate is satisfied when Adericel stopped observing it
 *   weeks ago. Equally, their evidence is not deleted because a card expired —
 *   a system of record that discards records over a failed payment is not one.
 *
 *   Events apply once. Providers retry, and a retried `SUBSCRIPTION_CANCELLED`
 *   that ran twice would be harmless while a retried renewal that extended the
 *   period twice would not.
 *
 *   Events apply in the provider's order, not ours. Webhooks arrive out of
 *   order routinely — a cancellation queued behind a renewal is ordinary — and
 *   last-write-wins would resurrect a cancelled subscription.
 */

/** How long a failed payment is a grace period rather than a lapse. */
export const GRACE_PERIOD_DAYS = 14;

export interface BillingApplication {
  readonly eventId: string;
  readonly applied: boolean;
  readonly outcome: string;
  readonly subscriptionId: string | null;
  readonly status: string | null;
}

/**
 * Apply a verified provider event.
 *
 * Runs entirely under platform scope: subscriptions belong to MSPs as often as
 * to organisations, and an MSP is not inside a tenant.
 */
export async function applyBillingEvent(
  app: AppContext,
  event: BillingEvent,
  context: { readonly correlationId: string; readonly logger: Logger },
): Promise<BillingApplication> {
  const now = app.clock.nowIso();

  return app.db.withPlatform(async (ctx) => {
    // The ledger insert is the idempotency gate, and it comes first. A
    // conflicting insert means this event has been seen, and the correct
    // response is to report success without acting: the provider retried
    // because it did not get our 200, not because anything changed.
    const claimed = await ctx.one<{ id: string }>(
      `INSERT INTO billing_events
         (id, provider, event_type, raw_type, occurred_at, outcome, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        event.id,
        app.payments.key,
        event.type,
        event.rawType,
        event.occurredAtIso,
        context.correlationId,
      ],
    );
    if (!claimed) {
      return {
        eventId: event.id,
        applied: false,
        outcome: 'DUPLICATE',
        subscriptionId: null,
        status: null,
      };
    }

    const finish = async (
      outcome: string,
      applied: boolean,
      subscriptionId: string | null,
      status: string | null,
    ): Promise<BillingApplication> => {
      await ctx.query(
        `UPDATE billing_events
         SET outcome = $2, applied = $3, subscription_id = $4,
             msp_id = (SELECT msp_id FROM subscriptions WHERE id = $4),
             organisation_id = (SELECT organisation_id FROM subscriptions WHERE id = $4)
         WHERE id = $1`,
        [event.id, outcome, applied, subscriptionId],
      );
      return { eventId: event.id, applied, outcome, subscriptionId, status };
    };

    const status = statusForEvent(event);
    if (status === null) return finish('IGNORED_TYPE', false, null, null);

    // Match on Adericel's own id first — it round-trips through provider
    // metadata and is unambiguous — then fall back to the provider's
    // subscription reference for events that predate metadata being set.
    const subscription = await ctx.one<{
      id: string;
      status: string;
      last_event_at: Date | null;
      msp_id: string | null;
      organisation_id: string | null;
    }>(
      `SELECT id, status, last_event_at, msp_id, organisation_id
       FROM subscriptions
       WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
          OR ($2::text IS NOT NULL AND external_subscription_ref = $2::text)
       LIMIT 1`,
      [event.subscriptionId, event.externalSubscriptionRef],
    );
    if (!subscription) {
      // Recorded rather than rejected. An event for a subscription Adericel has
      // never heard of is a real signal — a provider misconfiguration, or a
      // checkout that completed after the record was cleaned up — and losing it
      // makes that undiagnosable.
      context.logger.warn(
        { eventId: event.id, rawType: event.rawType },
        'billing event matched no subscription',
      );
      return finish('NO_MATCHING_SUBSCRIPTION', false, null, null);
    }

    // Ordering. An event the provider stamped earlier than the last one applied
    // is stale, whatever order it arrived in.
    if (
      subscription.last_event_at !== null &&
      Date.parse(event.occurredAtIso) < subscription.last_event_at.getTime()
    ) {
      return finish('SUPERSEDED', false, subscription.id, null);
    }

    // A cancellation is terminal. A renewal that arrives afterwards — a
    // final-period invoice settling, say — must not reactivate it.
    if (subscription.status === 'CANCELLED' && status !== 'CANCELLED') {
      return finish('SUBSCRIPTION_CANCELLED', false, subscription.id, 'CANCELLED');
    }

    const graceEndsAt =
      status === 'PAST_DUE'
        ? new Date(app.clock.nowEpochMs() + GRACE_PERIOD_DAYS * 86_400_000).toISOString()
        : null;

    await ctx.query(
      `UPDATE subscriptions
       SET status = $2,
           current_period_end = COALESCE($3::timestamptz, current_period_end),
           external_customer_ref = COALESCE($4, external_customer_ref),
           external_subscription_ref = COALESCE($5, external_subscription_ref),
           last_event_at = $6::timestamptz,
           last_event_id = $7,
           -- A payment that succeeds clears the grace period and the lapse.
           grace_ends_at = CASE WHEN $2 = 'PAST_DUE' THEN $8::timestamptz ELSE NULL END,
           lapsed_at = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE lapsed_at END,
           lapse_reason = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE lapse_reason END,
           cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN $9::timestamptz ELSE cancelled_at END,
           updated_at = now()
       WHERE id = $1`,
      [
        subscription.id,
        status,
        event.currentPeriodEndIso,
        event.externalCustomerRef,
        event.externalSubscriptionRef,
        event.occurredAtIso,
        event.id,
        graceEndsAt,
        now,
      ],
    );

    // A cancellation lapses immediately. There is no grace period for a
    // deliberate cancellation: the customer has said stop.
    if (status === 'CANCELLED') {
      await stopMaintaining(ctx, subscription.id, now, 'Subscription cancelled');
    } else if (status === 'ACTIVE') {
      await resumeMaintaining(ctx, subscription.id, now);
    }

    await publishBillingEvent(app, ctx, subscription, event, status, context.correlationId, now);
    return finish('APPLIED', true, subscription.id, status);
  });
}

type PlatformCtx = Parameters<Parameters<AppContext['db']['withPlatform']>[0]>[0];

/**
 * Stop maintaining the assurance record for everything this subscription pays
 * for.
 *
 * Nothing is deleted and nothing is reassessed. The organisations stop being
 * observed, and everything that reads their state — the assurance view, a
 * scheduled collection, a shared passport — learns that from one flag.
 */
export async function stopMaintaining(
  ctx: PlatformCtx,
  subscriptionId: string,
  nowIso: string,
  reason: string,
): Promise<number> {
  const affected = await ctx.many<{ id: string }>(
    `UPDATE organisations o
     SET assurance_maintained = false,
         maintenance_stopped_at = COALESCE(o.maintenance_stopped_at, $2::timestamptz),
         maintenance_stopped_reason = $3
     FROM subscriptions s
     WHERE s.id = $1
       AND o.status <> 'CLOSED'
       AND ((s.organisation_id IS NOT NULL AND o.id = s.organisation_id)
            OR (s.msp_id IS NOT NULL AND o.msp_id = s.msp_id))
       AND o.assurance_maintained
     RETURNING o.id`,
    [subscriptionId, nowIso, reason],
  );
  await ctx.query(
    `UPDATE subscriptions SET lapsed_at = COALESCE(lapsed_at, $2::timestamptz), lapse_reason = $3
     WHERE id = $1`,
    [subscriptionId, nowIso, reason],
  );
  return affected.length;
}

export async function resumeMaintaining(
  ctx: PlatformCtx,
  subscriptionId: string,
  _nowIso: string,
): Promise<number> {
  const affected = await ctx.many<{ id: string }>(
    `UPDATE organisations o
     SET assurance_maintained = true,
         maintenance_stopped_at = NULL,
         maintenance_stopped_reason = NULL
     FROM subscriptions s
     WHERE s.id = $1
       AND ((s.organisation_id IS NOT NULL AND o.id = s.organisation_id)
            OR (s.msp_id IS NOT NULL AND o.msp_id = s.msp_id))
       AND NOT o.assurance_maintained
     RETURNING o.id`,
    [subscriptionId],
  );
  return affected.length;
}

/**
 * Lapse subscriptions whose grace period has run out.
 *
 * Run from the worker. Deliberately separate from webhook handling: a customer
 * whose card fails and who then hears nothing from their provider must still
 * lapse, and an event that never arrives cannot trigger anything.
 */
export async function lapseExpiredGracePeriods(
  app: AppContext,
  logger: Logger,
): Promise<readonly string[]> {
  const now = app.clock.nowIso();
  return app.db.withPlatform(async (ctx) => {
    const due = await ctx.many<{ id: string; status: string }>(
      `SELECT id, status FROM subscriptions
       WHERE lapsed_at IS NULL
         AND ((grace_ends_at IS NOT NULL AND grace_ends_at <= $1::timestamptz)
              OR (status = 'TRIAL' AND trial_ends_at IS NOT NULL
                  AND trial_ends_at <= $1::timestamptz))`,
      [now],
    );
    const lapsed: string[] = [];
    for (const row of due) {
      const reason =
        row.status === 'TRIAL' ? 'Trial ended without a subscription' : 'Payment overdue';
      const count = await stopMaintaining(ctx, row.id, now, reason);
      logger.warn(
        { subscriptionId: row.id, organisations: count, reason },
        'stopped maintaining assurance for a lapsed subscription',
      );
      lapsed.push(row.id);
    }
    return lapsed;
  });
}

async function publishBillingEvent(
  app: AppContext,
  ctx: PlatformCtx,
  subscription: { id: string; msp_id: string | null; organisation_id: string | null },
  event: BillingEvent,
  status: string,
  correlationId: string,
  nowIso: string,
): Promise<void> {
  // Only organisation-scoped subscriptions can publish into a tenant's event
  // stream; an MSP-level one has no tenant to publish into, and the ledger row
  // is its record.
  if (!subscription.organisation_id) return;
  await app.db.withTenant(subscription.organisation_id, async (tenantCtx) => {
    await publish(
      tenantCtx,
      {
        type: 'SubscriptionChanged',
        organisationId: subscription.organisation_id!,
        mspId: subscription.msp_id,
        subjectType: 'Subscription',
        subjectId: subscription.id,
        payload: { status, providerEventId: event.id, rawType: event.rawType },
        correlationId,
        actor: 'billing',
      },
      nowIso,
    );
  });
  void ctx;
}

export function assertBillingConfigured(app: AppContext): void {
  if (app.payments.key === 'manual') {
    throw new AdericelError(
      'NOT_IMPLEMENTED',
      'Online payment is not configured for this deployment. Set BILLING_PROVIDER=stripe with ' +
        'BILLING_STRIPE_SECRET_KEY and BILLING_STRIPE_WEBHOOK_SECRET.',
    );
  }
}
