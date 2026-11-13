import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_PLANS,
  checkOrganisationEntitlement,
  organisationCreateSchema,
  resolveControlConfiguration,
  type BaselineControlDefinition,
  type CommercialState,
  type OrganisationControlOverride,
  MFA_DENIAL_PREFIX,
} from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
import { eraseDataSubject } from '../services/erasure.js';
import type { AppContext } from '../context.js';
import { audit, requireMsp, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery } from '../middleware/validation.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { provisionOrganisation } from '../services/onboarding.js';

/**
 * MSP control plane.
 *
 * An MSP is an operator boundary, so these routes deal in authority and
 * portfolio, never in customer data directly — reading a customer's assurance
 * goes through the organisation routes, which apply that organisation's own
 * tenant context.
 */

const mspParam = z.object({ mspId: z.string().uuid() });
const mspMemberParam = z.object({ mspId: z.string().uuid(), userId: z.string().uuid() });

/**
 * Why an erasure was carried out, in somebody's own words.
 *
 * Ten characters is not a formality. An irreversible act on a person needs a
 * sentence a reader can weigh a year later, and "yes" or "ok" is not one. The
 * service enforces the same floor; the schema states it at the edge so the
 * caller is told before anything happens rather than after.
 */
const erasureRequestSchema = z.object({
  reason: z.string().min(10, 'State why this erasure is being carried out.').max(2000),
});

export function registerMspRoutes(server: FastifyInstance, app: AppContext): void {
  server.get('/v1/msps/:mspId', { preHandler: server.authenticate }, async (request, reply) => {
    const { mspId } = parseParams(request, mspParam);
    await requireMsp(app, request, mspId, 'msp:read');

    const data = await app.db.withPlatform(async (ctx) => {
      const msp = await ctx.oneOrFail<{
        id: string;
        name: string;
        slug: string;
        status: string;
        contact_email: string;
        country_code: string | null;
        created_at: Date;
      }>(
        `SELECT id, name, slug, status, contact_email, country_code, created_at
         FROM msps WHERE id = $1`,
        [mspId],
        'MSP',
      );
      const counts = await ctx.oneOrFail<{ total: string; active: string; onboarding: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status = 'ACTIVE')::text AS active,
                count(*) FILTER (WHERE status = 'ONBOARDING')::text AS onboarding
         FROM organisations WHERE msp_id = $1`,
        [mspId],
        'Organisation counts',
      );
      const subscription = await ctx.one<{
        plan_key: string;
        status: string;
        currency: string;
        price_per_organisation_minor: number;
        organisation_limit: number | null;
        trial_ends_at: Date | null;
        current_period_end: Date;
      }>(
        `SELECT plan_key, status, currency, price_per_organisation_minor, organisation_limit,
                trial_ends_at, current_period_end
         FROM subscriptions WHERE msp_id = $1
            AND status NOT IN ('TERMINATED', 'ARCHIVED')`,
        [mspId],
      );
      return { msp, counts, subscription };
    });

    return reply.status(200).send({
      id: data.msp.id,
      name: data.msp.name,
      slug: data.msp.slug,
      status: data.msp.status,
      contactEmail: data.msp.contact_email,
      countryCode: data.msp.country_code,
      createdAt: data.msp.created_at.toISOString(),
      organisations: {
        total: Number(data.counts.total),
        active: Number(data.counts.active),
        onboarding: Number(data.counts.onboarding),
      },
      subscription: data.subscription
        ? {
            planKey: data.subscription.plan_key,
            status: data.subscription.status,
            currency: data.subscription.currency,
            pricePerOrganisationMinor: data.subscription.price_per_organisation_minor,
            organisationLimit: data.subscription.organisation_limit,
            trialEndsAt: data.subscription.trial_ends_at?.toISOString() ?? null,
            currentPeriodEnd: data.subscription.current_period_end.toISOString(),
          }
        : null,
    });
  });

  server.get(
    '/v1/msps/:mspId/organisations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:organisation:read');
      const query = parseQuery(
        request,
        z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          status: z.string().optional(),
          search: z.string().max(200).optional(),
        }),
      );

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          id: string;
          name: string;
          slug: string;
          status: string;
          onboarded_at: Date | null;
          created_at: Date;
        }>(
          `SELECT id, name, slug, status, onboarded_at, created_at
           FROM organisations
           WHERE msp_id = $1
             AND ($2::text IS NULL OR status = $2)
             AND ($3::text IS NULL OR lower(name) LIKE '%' || lower($3) || '%')
           ORDER BY name
           LIMIT $4`,
          [mspId, query.status ?? null, query.search ?? null, query.limit],
        ),
      );

      return reply.status(200).send({
        organisations: rows.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          onboardedAt: row.onboarded_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
      });
    },
  );

  /**
   * Create and onboard an organisation.
   *
   * Entitlement is checked before anything is written, so an MSP past its plan
   * limit gets a clear commercial answer rather than a half-created tenant.
   */
  server.post(
    '/v1/msps/:mspId/organisations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:organisation:create');
      const body = parseBody(request, organisationCreateSchema);
      const principal = requirePrincipal(request);

      const outcome = await withIdempotency(app, request, async () => {
        const entitlement = await app.db.withPlatform(async (ctx) => {
          const subscription = await ctx.one<{
            status: string;
            trial_ends_at: Date | null;
            organisation_limit: number | null;
          }>(
            `SELECT status, trial_ends_at, organisation_limit
             FROM subscriptions WHERE msp_id = $1
            AND status NOT IN ('TERMINATED', 'ARCHIVED')`,
            [mspId],
          );
          const used = await ctx.oneOrFail<{ count: string }>(
            `SELECT count(*)::text AS count FROM organisations
             WHERE msp_id = $1 AND status <> 'CLOSED'`,
            [mspId],
            'Organisation count',
          );
          if (!subscription) {
            return {
              allowed: false,
              reason: 'No active subscription for this MSP',
              organisationsInUse: Number(used.count),
              organisationLimit: null,
            };
          }
          return checkOrganisationEntitlement(
            {
              status: subscription.status as CommercialState,
              trialEndsAt: subscription.trial_ends_at?.toISOString() ?? null,
            },
            Number(used.count),
            subscription.organisation_limit,
            app.clock.nowIso(),
          );
        });

        if (!entitlement.allowed) {
          throw new AdericelError('PRECONDITION_FAILED', entitlement.reason, {
            safeDetails: {
              organisationsInUse: entitlement.organisationsInUse,
              organisationLimit: entitlement.organisationLimit,
            },
          });
        }

        const created = await provisionOrganisation(app, {
          mspId,
          input: body,
          actor: principal.displayName,
          actorUserId: principal.principalType === 'USER' ? principal.principalId : null,
          correlationId: request.adericel.correlationId,
        });

        return { status: 201, body: created };
      });

      await audit(app, request, {
        action: 'msp:organisation:create',
        resourceType: 'Organisation',
        resourceId: (outcome.body as { id: string }).id,
        metadata: { mspId, replayed: outcome.replayed },
      });

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  /**
   * MSP baseline: the assurance floor applied across the portfolio.
   */
  server.get(
    '/v1/msps/:mspId/baselines',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:read');

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          id: string;
          key: string;
          name: string;
          description: string | null;
          version: number;
          is_default: boolean;
          control_count: string;
        }>(
          `SELECT b.id, b.key, b.name, b.description, b.version, b.is_default,
                  (SELECT count(*)::text FROM msp_baseline_controls c WHERE c.baseline_id = b.id) AS control_count
           FROM msp_baselines b WHERE b.msp_id = $1 ORDER BY b.name`,
          [mspId],
        ),
      );

      return reply.status(200).send({
        baselines: rows.map((row) => ({
          id: row.id,
          key: row.key,
          name: row.name,
          description: row.description,
          version: row.version,
          isDefault: row.is_default,
          controlCount: Number(row.control_count),
        })),
      });
    },
  );

  server.get(
    '/v1/msps/:mspId/baselines/:baselineId',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(
        request,
        z.object({ mspId: z.string().uuid(), baselineId: z.string().uuid() }),
      );
      await requireMsp(app, request, params.mspId, 'msp:read');

      const data = await app.db.withPlatform(async (ctx) => {
        const baseline = await ctx.oneOrFail<{
          id: string;
          key: string;
          name: string;
          description: string | null;
        }>(
          `SELECT id, key, name, description FROM msp_baselines WHERE id = $1 AND msp_id = $2`,
          [params.baselineId, params.mspId],
          'Baseline',
        );
        const controls = await ctx.many<{
          control_key: string;
          title: string;
          description: string | null;
          ruleset_key: string;
          rule_key: string;
          parameters: Record<string, unknown>;
          requirement_keys: string[];
          mandatory: boolean;
        }>(
          `SELECT control_key, title, description, ruleset_key, rule_key, parameters,
                  requirement_keys, mandatory
           FROM msp_baseline_controls WHERE baseline_id = $1 ORDER BY control_key`,
          [params.baselineId],
        );
        return { baseline, controls };
      });

      return reply.status(200).send({
        id: data.baseline.id,
        key: data.baseline.key,
        name: data.baseline.name,
        description: data.baseline.description,
        controls: data.controls.map((c) => ({
          key: c.control_key,
          title: c.title,
          description: c.description,
          rulesetKey: c.ruleset_key,
          ruleKey: c.rule_key,
          parameters: c.parameters,
          requirementKeys: c.requirement_keys,
          mandatory: c.mandatory,
        })),
      });
    },
  );

  /**
   * Show how an organisation's configuration differs from the MSP baseline, and
   * why. An MSP needs to be able to answer "why is this customer different?"
   * without reading two configurations side by side.
   */
  server.get(
    '/v1/msps/:mspId/organisations/:organisationId/baseline-resolution',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(
        request,
        z.object({ mspId: z.string().uuid(), organisationId: z.string().uuid() }),
      );
      await requireMsp(app, request, params.mspId, 'msp:organisation:read');

      const resolution = await app.db.withPlatform(async (ctx) => {
        const owned = await ctx.one<{ id: string }>(
          `SELECT id FROM organisations WHERE id = $1 AND msp_id = $2`,
          [params.organisationId, params.mspId],
        );
        if (!owned) throw new AdericelError('NOT_FOUND', 'Organisation not found for this MSP');

        const baselineControls = await ctx.many<{
          control_key: string;
          title: string;
          description: string | null;
          ruleset_key: string;
          rule_key: string;
          parameters: Record<string, unknown>;
          requirement_keys: string[];
          mandatory: boolean;
        }>(
          `SELECT c.control_key, c.title, c.description, c.ruleset_key, c.rule_key, c.parameters,
                  c.requirement_keys, c.mandatory
           FROM msp_baseline_controls c
           JOIN msp_baselines b ON b.id = c.baseline_id
           WHERE b.msp_id = $1 AND b.is_default`,
          [params.mspId],
        );

        const organisationControls = await ctx.many<{
          key: string;
          title: string;
          ruleset_key: string;
          rule_key: string;
          parameters: Record<string, unknown>;
          enabled: boolean;
          source: string;
        }>(
          `SELECT key, title, ruleset_key, rule_key, parameters, enabled, source
           FROM controls WHERE organisation_id = $1`,
          [params.organisationId],
        );

        const baseline: BaselineControlDefinition[] = baselineControls.map((c) => ({
          key: c.control_key,
          title: c.title,
          description: c.description,
          rulesetKey: c.ruleset_key,
          ruleKey: c.rule_key,
          parameters: c.parameters,
          requirementKeys: c.requirement_keys,
          mandatory: c.mandatory,
        }));

        const baselineKeys = new Set(baseline.map((b) => b.key));
        const overrides: OrganisationControlOverride[] = organisationControls
          .filter((c) => baselineKeys.has(c.key) && c.source === 'OVERRIDDEN')
          .map((c) => ({ key: c.key, enabled: c.enabled, parameters: c.parameters }));

        const local: BaselineControlDefinition[] = organisationControls
          .filter((c) => !baselineKeys.has(c.key))
          .map((c) => ({
            key: c.key,
            title: c.title,
            description: null,
            rulesetKey: c.ruleset_key,
            ruleKey: c.rule_key,
            parameters: c.parameters,
            requirementKeys: [],
            mandatory: false,
          }));

        return resolveControlConfiguration(baseline, overrides, local);
      });

      return reply.status(200).send({ controls: resolution });
    },
  );

  server.get('/v1/plans', { preHandler: server.authenticate }, async (_request, reply) => {
    const plans = await app.db.withPlatform(async (ctx) =>
      ctx.many<{
        key: string;
        tier: string;
        name: string;
        price_per_organisation_minor: number;
        currency: string;
        included_organisations: number;
        volume_tiers: [number, number][];
        features: string[];
      }>(
        `SELECT key, tier, name, price_per_organisation_minor, currency,
                included_organisations, volume_tiers, features
         FROM plans ORDER BY price_per_organisation_minor`,
      ),
    );

    return reply.status(200).send({
      plans:
        plans.length > 0
          ? plans.map((p) => ({
              key: p.key,
              tier: p.tier,
              name: p.name,
              pricePerOrganisationMinor: p.price_per_organisation_minor,
              currency: p.currency,
              includedOrganisations: p.included_organisations,
              volumeTiers: p.volume_tiers,
              features: p.features,
            }))
          : DEFAULT_PLANS,
    });
  });

  /**
   * Erase yourself.
   *
   * The self-service half of the subject's right, and the safety argument is
   * structural rather than procedural: **there is no user identifier in this
   * request.** The subject is `principal.userId` and nothing else, so there is
   * no parameter to tamper with and no path by which this route can erase
   * somebody other than the caller. A route that took a target and checked it
   * matched the caller would be one refactor away from not checking.
   *
   * Veylith Systems is the controller for a platform user's own account data,
   * so acting directly on their request is both lawful and the right thing to
   * do. That is **not** true of a person observed inside a customer's estate:
   * for them Veylith is a processor, the controller is the customer, and
   * `DATA_SUBJECT_KINDS` in the domain says their request is answered by the
   * customer with Adericel's assistance. There is deliberately no self-service
   * route for that case — accepting one would mean acting on an unauthenticated
   * claim to be a named person, outside the processing agreement, and it would
   * let somebody erase the record of a privileged account by claiming to be
   * its owner.
   *
   * A second factor is required. The act cannot be undone, and a stolen
   * session should not be enough to do it.
   */
  server.post('/v1/me/erasure', { preHandler: server.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseBody(request, erasureRequestSchema);

    // A human, personally. A service token that happened to carry a user id
    // must not be able to erase the person it was issued for.
    if (principal.principalType !== 'USER') {
      throw new AdericelError('FORBIDDEN', 'Only a person may erase themselves', {
        safeDetails: { principalType: principal.principalType },
      });
    }
    if (!principal.mfaSatisfied) {
      throw new AdericelError('FORBIDDEN', `${MFA_DENIAL_PREFIX}erasing yourself`, {
        safeDetails: { reason: 'second factor required' },
      });
    }

    /**
     * Audited before, not after.
     *
     * The erasure removes this person's sessions, so the request's own
     * principal stops resolving part-way through. Writing the audit entry
     * first means an interrupted erasure still leaves a record that it was
     * attempted, by whom, and why.
     */
    await audit(app, request, {
      action: 'data_subject.erasure.self',
      resourceType: 'User',
      resourceId: principal.principalId,
      outcome: 'SUCCESS',
      reason: body.reason,
      metadata: { requestedBy: 'self' },
    });

    const report = await eraseDataSubject(app, principal.principalId, { reason: body.reason });
    return reply.status(200).send(report);
  });

  /**
   * Erase a member of this MSP, on their behalf.
   *
   * The other half, and it exists because the self-service route needs a
   * working login. Somebody who has left, lost their access, or never
   * completed signup cannot sign in to exercise a right they still hold.
   *
   * Scoped to this MSP's own members, checked against the database rather than
   * inferred from the caller's token: a target in another MSP is a cross-tenant
   * act and is refused as not found rather than as forbidden, because
   * confirming the person exists would itself disclose something.
   *
   * No four-eyes requirement, deliberately. A one-person MSP is a real and
   * common shape — Veylith Systems is one — and requiring a second approver
   * would make a lawful erasure impossible for exactly the operators least
   * able to work around it. The protections that do apply: a human principal,
   * a second factor, an explicit permission that is not bundled with member
   * management, a stated reason, and an audit entry. The act also preserves
   * rather than destroys the approval trail, pseudonymising the person's
   * identity in it, so erasing somebody cannot be used to hide what they
   * authorised.
   */
  server.post(
    '/v1/msps/:mspId/members/:userId/erasure',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId, userId } = parseParams(request, mspMemberParam);
      await requireMsp(app, request, mspId, 'msp:member:erase');
      const body = parseBody(request, erasureRequestSchema);

      const member = await app.db.withPlatform(async (ctx) =>
        ctx.one<{ id: string }>(`SELECT id FROM users WHERE id = $1 AND msp_id = $2`, [
          userId,
          mspId,
        ]),
      );
      if (!member) {
        throw new AdericelError('NOT_FOUND', 'No such member of this MSP');
      }

      await audit(app, request, {
        action: 'data_subject.erasure.on_behalf',
        resourceType: 'User',
        resourceId: userId,
        outcome: 'SUCCESS',
        reason: body.reason,
        metadata: { requestedBy: 'msp', mspId },
      });

      const report = await eraseDataSubject(app, userId, { reason: body.reason });
      return reply.status(200).send(report);
    },
  );
}
