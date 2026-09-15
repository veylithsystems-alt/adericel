import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import {
  audit,
  requireMsp,
  requireOrganisation,
  requirePrincipal,
} from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import { applyBillingEvent, assertBillingConfigured } from '../services/billing.js';

/**
 * Billing routes.
 *
 * The webhook is the interesting one. It is unauthenticated by necessity — a
 * payment provider holds no Adericel credential — so the signature is the whole
 * control, and everything downstream of it assumes the provider retries,
 * duplicates and reorders, because it does.
 */

const orgParam = z.object({ organisationId: z.string().uuid() });
const mspParam = z.object({ mspId: z.string().uuid() });

const checkoutSchema = z.object({
  planKey: z.enum(['assure', 'protect', 'autonomous']),
  quantity: z.number().int().min(1).max(1000).default(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

/**
 * Deliberately generous. A provider that cannot deliver because we throttled it
 * retries into a backlog, and a backlog of billing events is a backlog of
 * customers whose subscriptions are wrong. The signature check is the control;
 * the limit is only there so an unsigned flood cannot fill the log.
 */
const webhookLimit = { config: { rateLimit: { max: 600, timeWindow: 60_000 } } };

export function registerBillingRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * Start a checkout.
   *
   * The subscription being paid for is resolved from the authenticated scope,
   * never from the request body. A caller who could name the subscription could
   * pay a token amount against somebody else's.
   */
  const startCheckout = async (
    request: Parameters<typeof requirePrincipal>[0],
    scope: { readonly mspId: string | null; readonly organisationId: string | null },
  ) => {
    assertBillingConfigured(app);
    const body = parseBody(request, checkoutSchema);
    const principal = requirePrincipal(request);

    const resolved = await app.db.withPlatform(async (ctx) => {
      const subscription = await ctx.one<{ id: string; status: string; msp_id: string | null }>(
        `SELECT id, status, msp_id FROM subscriptions
         WHERE ($1::uuid IS NOT NULL AND msp_id = $1::uuid)
            OR ($2::uuid IS NOT NULL AND organisation_id = $2::uuid)
         ORDER BY created_at DESC LIMIT 1`,
        [scope.mspId, scope.organisationId],
      );
      if (!subscription) throw new AdericelError('NOT_FOUND', 'No subscription for this account');
      if (subscription.status === 'CANCELLED') {
        throw new AdericelError(
          'PRECONDITION_FAILED',
          'This subscription is cancelled. Start a new one rather than paying against it.',
        );
      }
      const plan = await ctx.oneOrFail<{
        key: string;
        price_per_organisation_minor: number;
        currency: string;
      }>(
        `SELECT key, price_per_organisation_minor, currency FROM plans WHERE key = $1`,
        [body.planKey],
        'Plan',
      );
      return { subscription, plan };
    });

    const session = await app.payments.createCheckoutSession({
      mspId: resolved.subscription.msp_id ?? scope.organisationId ?? '',
      subscriptionId: resolved.subscription.id,
      planKey: resolved.plan.key,
      currency: resolved.plan.currency,
      unitAmountMinor: resolved.plan.price_per_organisation_minor,
      quantity: body.quantity,
      customerEmail: principal.email ?? '',
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      // Stable across retries of the same intent, so a double-clicked button
      // does not produce two subscriptions.
      idempotencyKey: `checkout:${resolved.subscription.id}:${body.planKey}:${body.quantity}`,
    });

    return { session, subscriptionId: resolved.subscription.id, planKey: resolved.plan.key };
  };

  server.post(
    '/v1/msps/:mspId/billing/checkout',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:manage');
      const result = await startCheckout(request, { mspId, organisationId: null });
      await audit(app, request, {
        action: 'billing:checkout',
        resourceType: 'Msp',
        resourceId: mspId,
        metadata: { planKey: result.planKey, subscriptionId: result.subscriptionId },
      });
      return reply
        .status(201)
        .send({ checkoutUrl: result.session.url, sessionId: result.session.sessionId });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/billing/checkout',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const result = await startCheckout(request, { mspId: null, organisationId });
      await audit(app, request, {
        action: 'billing:checkout',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { planKey: result.planKey, subscriptionId: result.subscriptionId },
      });
      return reply
        .status(201)
        .send({ checkoutUrl: result.session.url, sessionId: result.session.sessionId });
    },
  );

  /**
   * Provider webhook.
   *
   * Under /v1/webhooks/ so it inherits the raw-body hook: a signature must be
   * computed over exactly the bytes that were sent, and a parsed-and-
   * reserialised body produces a different one.
   */
  server.post('/v1/webhooks/billing', webhookLimit, async (request, reply) => {
    if (app.config.billing.provider === 'manual') {
      throw new AdericelError(
        'NOT_IMPLEMENTED',
        'This deployment does not take online payment, so it accepts no billing webhooks.',
      );
    }

    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new AdericelError('UNAUTHENTICATED', 'Missing signature');
    }
    const raw = (request as { rawBody?: string }).rawBody;
    if (raw === undefined) {
      // Never guess. Verifying a reconstructed body either fails confusingly or,
      // if somebody "fixes" it by skipping verification, accepts anything.
      throw new AdericelError('INTERNAL_ERROR', 'Raw body unavailable for signature verification');
    }

    const event = app.payments.verifyAndParse(raw, signature, app.clock.nowEpochMs());
    const result = await applyBillingEvent(app, event, {
      correlationId: request.adericel.correlationId,
      logger: request.adericel.logger,
    });

    request.adericel.logger.info(
      { eventId: result.eventId, outcome: result.outcome, applied: result.applied },
      'billing event processed',
    );

    // 200 for every verified event, including duplicates and ones that changed
    // nothing. A non-2xx makes the provider retry, and retrying an event that
    // was correctly ignored produces an unbounded redelivery loop.
    return reply.status(200).send({ received: true, outcome: result.outcome });
  });

  /** What the account is paying for, and whether its record is being maintained. */
  server.get(
    '/v1/organisations/:organisationId/billing',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      const state = await app.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{
          assurance_maintained: boolean;
          maintenance_stopped_at: Date | null;
          maintenance_stopped_reason: string | null;
          status: string | null;
          plan_key: string | null;
          trial_ends_at: Date | null;
          grace_ends_at: Date | null;
          current_period_end: Date | null;
        }>(
          `SELECT o.assurance_maintained, o.maintenance_stopped_at, o.maintenance_stopped_reason,
                  s.status, s.plan_key, s.trial_ends_at, s.grace_ends_at, s.current_period_end
           FROM organisations o
           LEFT JOIN subscriptions s
             ON (s.organisation_id = o.id OR (s.msp_id IS NOT NULL AND s.msp_id = o.msp_id))
            AND s.status <> 'CANCELLED'
           WHERE o.id = $1
           ORDER BY s.created_at DESC NULLS LAST
           LIMIT 1`,
          [organisationId],
          'Organisation billing',
        ),
      );

      return reply.status(200).send({
        subscription: {
          status: state.status,
          planKey: state.plan_key,
          trialEndsAt: state.trial_ends_at?.toISOString() ?? null,
          graceEndsAt: state.grace_ends_at?.toISOString() ?? null,
          currentPeriodEnd: state.current_period_end?.toISOString() ?? null,
        },
        // The fact that changes what everything else means. Said plainly, and
        // never as a judgement about the organisation's security.
        assuranceMaintained: state.assurance_maintained,
        maintenanceStoppedAt: state.maintenance_stopped_at?.toISOString() ?? null,
        maintenanceStoppedReason: state.maintenance_stopped_reason,
        note: state.assurance_maintained
          ? null
          : 'Adericel has stopped observing this organisation, so its assurance state describes ' +
            'the last time it was assessed rather than the present. Nothing has been deleted, ' +
            'and no determination has changed. This says nothing about whether the ' +
            "organisation's security is good or bad — only that Adericel is no longer looking.",
      });
    },
  );
}
