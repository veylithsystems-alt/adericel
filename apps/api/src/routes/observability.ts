import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVENT_TYPES } from '@adericel/domain';
import { listAudit, listEvents, outboxStats } from '@adericel/graph';
import { pageRequestSchema } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { requireOrganisation } from '../middleware/request-context.js';
import { parseParams, parseQuery, organisationParam } from '../middleware/validation.js';
import { collectHealth } from '../services/health.js';

/**
 * Audit, events and health.
 *
 * The health endpoints exist so that Adericel can distinguish "this customer
 * has an assurance problem" from "Adericel has an operational problem" — a
 * distinction the product is worthless without, because an integration that
 * silently stopped collecting looks exactly like a customer that has gone
 * quiet.
 */

export function registerObservabilityRoutes(server: FastifyInstance, app: AppContext): void {
  server.get(
    '/v1/organisations/:organisationId/audit',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:audit:read');
      const query = parseQuery(
        request,
        pageRequestSchema.extend({
          action: z.string().max(120).optional(),
          outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
          actorId: z.string().max(200).optional(),
          resourceType: z.string().max(120).optional(),
          resourceId: z.string().max(200).optional(),
          since: z.string().datetime().optional(),
        }),
      );

      const page = await app.db.withTenant(organisationId, async (ctx) =>
        listAudit(
          ctx,
          {
            ...(query.action ? { actions: [query.action] } : {}),
            ...(query.outcome ? { outcomes: [query.outcome] } : {}),
            ...(query.actorId ? { actorId: query.actorId } : {}),
            ...(query.resourceType ? { resourceType: query.resourceType } : {}),
            ...(query.resourceId ? { resourceId: query.resourceId } : {}),
            ...(query.since ? { since: query.since } : {}),
          },
          query.limit,
          query.cursor,
        ),
      );

      return reply.status(200).send({
        entries: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/events',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:audit:read');
      const query = parseQuery(
        request,
        z.object({
          type: z.enum(EVENT_TYPES).optional(),
          correlationId: z.string().uuid().optional(),
          since: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      );

      const events = await app.db.withTenant(organisationId, async (ctx) =>
        listEvents(
          ctx,
          {
            ...(query.type ? { types: [query.type] } : {}),
            ...(query.correlationId ? { correlationId: query.correlationId } : {}),
            ...(query.since ? { since: query.since } : {}),
          },
          query.limit,
        ),
      );

      return reply.status(200).send({ events });
    },
  );

  /**
   * Follow one operation end to end.
   *
   * A correlation id links an API request, the events it produced, the
   * assessments that followed, the action taken and its verification — across
   * the API, the worker, n8n and the external system. This endpoint assembles
   * that trace, which is the difference between "something happened" and
   * "here is exactly what happened".
   */
  server.get(
    '/v1/organisations/:organisationId/trace/:correlationId',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(
        request,
        z.object({ organisationId: z.string().uuid(), correlationId: z.string().uuid() }),
      );
      await requireOrganisation(app, request, params.organisationId, 'org:audit:read');

      const trace = await app.db.withTenant(params.organisationId, async (ctx) => {
        const events = await ctx.many<{
          id: string;
          type: string;
          subject_type: string;
          subject_id: string;
          payload: Record<string, unknown>;
          actor: string;
          occurred_at: Date;
        }>(
          `SELECT id, type, subject_type, subject_id, payload, actor, occurred_at
           FROM event_log WHERE organisation_id = $1 AND correlation_id = $2
           ORDER BY seq`,
          [params.organisationId, params.correlationId],
        );
        const audits = await ctx.many<{
          action: string;
          resource_type: string;
          resource_id: string | null;
          outcome: string;
          actor_display: string;
          occurred_at: Date;
        }>(
          `SELECT action, resource_type, resource_id, outcome, actor_display, occurred_at
           FROM audit_log WHERE organisation_id = $1 AND correlation_id = $2
           ORDER BY seq`,
          [params.organisationId, params.correlationId],
        );
        const assessments = await ctx.many<{
          id: string;
          subject_kind: string;
          subject_id: string;
          state: string;
          assessed_at: Date;
        }>(
          `SELECT id, subject_kind, subject_id, state, assessed_at
           FROM assessments WHERE organisation_id = $1 AND correlation_id = $2
           ORDER BY seq`,
          [params.organisationId, params.correlationId],
        );
        // Correlation ids are per-request, so a multi-step operation — propose,
        // approve, execute, verify — spans several. An action is therefore
        // included when it was proposed under this correlation OR when any event
        // in this correlation is about it, which is what makes the trace follow
        // the whole operation rather than one request of it.
        const actions = await ctx.many<{ id: string; action_type: string; state: string }>(
          `SELECT DISTINCT a.id, a.action_type, a.state
           FROM actions a
           WHERE a.organisation_id = $1
             AND (a.correlation_id = $2
                  OR a.id::text IN (
                    SELECT subject_id FROM event_log
                    WHERE organisation_id = $1 AND correlation_id = $2 AND subject_type = 'Action'
                  ))`,
          [params.organisationId, params.correlationId],
        );
        return { events, audits, assessments, actions };
      });

      const timeline = [
        ...trace.events.map((e) => ({
          at: e.occurred_at.toISOString(),
          kind: 'EVENT' as const,
          detail: e.type,
          subject: `${e.subject_type}:${e.subject_id}`,
          actor: e.actor,
          payload: e.payload,
        })),
        ...trace.audits.map((a) => ({
          at: a.occurred_at.toISOString(),
          kind: 'AUDIT' as const,
          detail: `${a.action} (${a.outcome})`,
          subject: `${a.resource_type}:${a.resource_id ?? '-'}`,
          actor: a.actor_display,
          payload: {},
        })),
        ...trace.assessments.map((a) => ({
          at: a.assessed_at.toISOString(),
          kind: 'ASSESSMENT' as const,
          detail: `${a.subject_kind} assessed ${a.state}`,
          subject: `${a.subject_kind}:${a.subject_id}`,
          actor: 'truth-engine',
          payload: {},
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));

      return reply.status(200).send({
        correlationId: params.correlationId,
        timeline,
        actions: trace.actions,
        eventCount: trace.events.length,
      });
    },
  );

  /** Liveness: is the process running? Deliberately dependency-free. */
  server.get('/health/live', async (_request, reply) =>
    reply.status(200).send({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }),
  );

  /** Readiness: can this instance serve traffic? Checks dependencies. */
  server.get('/health/ready', async (_request, reply) => {
    const health = await collectHealth(app, { deep: false });
    const ready = health.components.every((c) => c.status === 'HEALTHY' || c.status === 'DEGRADED');
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      components: health.components,
    });
  });

  /**
   * Full system health.
   *
   * Requires authentication because component detail is operationally
   * sensitive, and reports Adericel's own state separately from customers'.
   */
  server.get('/v1/system/health', { preHandler: server.authenticate }, async (_request, reply) => {
    const health = await collectHealth(app, { deep: true });
    return reply.status(200).send(health);
  });

  /** Dead-letter visibility. Events are never dropped, so this must be watched. */
  server.get('/v1/system/outbox', { preHandler: server.authenticate }, async (_request, reply) => {
    const stats = await app.db.withPlatform(async (ctx) => outboxStats(ctx));
    return reply.status(200).send({
      ...stats,
      // A growing pending queue means the dashboard is falling behind reality.
      healthy: stats.deadLetter === 0 && (stats.oldestPendingAgeSeconds ?? 0) < 300,
    });
  });

  server.get('/v1/system/version', async (_request, reply) =>
    reply.status(200).send({
      service: app.config.serviceName,
      release: app.config.releaseVersion,
      apiVersion: 'v1',
      engineVersion: app.rulesets.list()[0]?.engineVersion ?? 'unknown',
      rulesets: app.rulesets.list().map((r) => ({
        key: r.key,
        version: r.version,
        hash: r.hash,
      })),
      startedAt: app.startedAtIso,
    }),
  );
}
