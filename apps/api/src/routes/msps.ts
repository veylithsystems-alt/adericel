import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_PLANS,
  checkOrganisationEntitlement,
  organisationCreateSchema,
  resolveControlConfiguration,
  type BaselineControlDefinition,
  type OrganisationControlOverride,
} from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
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
         FROM subscriptions WHERE msp_id = $1 AND status <> 'CANCELLED'`,
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
             FROM subscriptions WHERE msp_id = $1 AND status <> 'CANCELLED'`,
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
              status: subscription.status as
                'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED',
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
}
