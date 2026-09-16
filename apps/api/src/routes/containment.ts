import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CONTAINMENT_DEFINITIONS,
  CONTAINMENT_LEVELS,
  CONTAINMENT_TRIGGERS,
  RESOLUTION_KINDS,
  leastDisruptiveLevel,
  profileOf,
} from '@adericel/containment';
import type { AppContext } from '../context.js';
import {
  audit,
  requireOrganisation,
  requirePlatform,
  requirePrincipal,
} from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import { contain, recover } from '../services/containment.js';

/**
 * Containment routes.
 *
 * Every route here restricts something, so every route is authenticated and
 * every decision is recorded with a name against it. The authority check lives
 * in the service, resolved from grants — a caller asserting authority over an
 * estate is a caller, not an authority.
 */

const orgParam = z.object({ organisationId: z.string().uuid() });

const containSchema = z.object({
  level: z.enum(CONTAINMENT_LEVELS),
  trigger: z.enum(CONTAINMENT_TRIGGERS),
  integrationId: z.string().uuid().nullable().default(null),
  justification: z.string().min(20).max(2000),
});

const recoverSchema = z.object({
  toLevel: z.enum(CONTAINMENT_LEVELS),
  integrationId: z.string().uuid().nullable().default(null),
  resolution: z.enum(RESOLUTION_KINDS),
  findings: z.string().min(30).max(4000),
  reObserved: z.boolean(),
  evidencePreserved: z.boolean(),
  riskAcceptedBy: z.string().min(2).max(200).nullable().default(null),
});

export function registerContainmentRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * The containment vocabulary, so an operator deciding under pressure can see
   * what each level costs before choosing one.
   *
   * Reference data, identical for every caller, naming no organisation.
   */
  server.get('/v1/containment/levels', { preHandler: server.authenticate }, async (_req, reply) =>
    reply.status(200).send({
      levels: CONTAINMENT_LEVELS.map((level) => CONTAINMENT_DEFINITIONS[level]),
      triggers: CONTAINMENT_TRIGGERS.map((trigger) => ({
        ...profileOf(trigger),
        leastDisruptiveLevel: leastDisruptiveLevel(trigger),
      })),
      invariant:
        'No containment level withholds an organisation’s own assurance record. Containment ' +
        'stops Adericel doing things; it does not stop customers knowing things.',
      separation:
        'Containment is a security state and is separate from commercial entitlement. ' +
        'Non-payment is never a containment, and a containment is never a termination.',
    }),
  );

  /**
   * Platform-scale containment: C4 and C5.
   *
   * Separate from the organisation route, and it has to be. Veylith operators
   * hold no standing authority over an individual organisation (§29) — support
   * access is explicit, scoped and time-limited — so the organisation-scoped
   * route correctly refuses them. Without this route the two highest levels
   * would be defined and unreachable, which is the kind of gap that is only
   * discovered during the incident it exists for.
   *
   * Platform-scoped: it stops every estate, so it is Veylith's alone.
   */
  server.post(
    '/v1/system/containment',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:admin');
      const body = parseBody(request, containSchema);
      const principal = requirePrincipal(request);

      const record = await contain(
        app,
        {
          scope: 'PLATFORM',
          organisationId: null,
          integrationId: null,
          level: body.level,
          trigger: body.trigger,
          justification: body.justification,
        },
        {
          isPlatform: true,
          mspId: principal.mspId,
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          displayName: principal.displayName,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'containment:apply:platform',
        resourceType: 'System',
        resourceId: null,
        metadata: { level: record.toLevel, from: record.fromLevel, trigger: record.trigger },
      });

      return reply.status(201).send(record);
    },
  );

  /** Lift platform-scale containment. */
  server.post(
    '/v1/system/containment/recover',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:admin');
      const body = parseBody(request, recoverSchema);
      const principal = requirePrincipal(request);

      const record = await recover(
        app,
        {
          scope: 'PLATFORM',
          organisationId: null,
          integrationId: null,
          toLevel: body.toLevel,
          resolution: body.resolution,
          findings: body.findings,
          reObserved: body.reObserved,
          evidencePreserved: body.evidencePreserved,
          riskAcceptedBy: body.riskAcceptedBy,
        },
        {
          isPlatform: true,
          mspId: principal.mspId,
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          displayName: principal.displayName,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'containment:recover:platform',
        resourceType: 'System',
        resourceId: null,
        metadata: { from: record.fromLevel, to: record.toLevel, resolution: body.resolution },
      });

      return reply.status(201).send(record);
    },
  );

  /** Contain an organisation, or one of its integrations. */
  server.post(
    '/v1/organisations/:organisationId/containment',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const body = parseBody(request, containSchema);
      const principal = requirePrincipal(request);

      const record = await contain(
        app,
        {
          scope: body.integrationId ? 'INTEGRATION' : 'ORGANISATION',
          organisationId,
          integrationId: body.integrationId,
          level: body.level,
          trigger: body.trigger,
          justification: body.justification,
        },
        {
          // Read from grants, which are resolved server-side on every request.
          // There is no principal field a caller could shape into this.
          isPlatform: principal.grants.some((g) => g.scopeType === 'PLATFORM'),
          mspId: principal.mspId,
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          displayName: principal.displayName,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'containment:apply',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: {
          level: record.toLevel,
          from: record.fromLevel,
          trigger: record.trigger,
          scope: record.scope,
          reviewRequired: record.reviewRequired,
        },
      });

      return reply.status(201).send(record);
    },
  );

  /** Lift containment, in part or in full. */
  server.post(
    '/v1/organisations/:organisationId/containment/recover',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const body = parseBody(request, recoverSchema);
      const principal = requirePrincipal(request);

      const record = await recover(
        app,
        {
          scope: body.integrationId ? 'INTEGRATION' : 'ORGANISATION',
          organisationId,
          integrationId: body.integrationId,
          toLevel: body.toLevel,
          resolution: body.resolution,
          findings: body.findings,
          reObserved: body.reObserved,
          evidencePreserved: body.evidencePreserved,
          riskAcceptedBy: body.riskAcceptedBy,
        },
        {
          isPlatform: principal.grants.some((g) => g.scopeType === 'PLATFORM'),
          mspId: principal.mspId,
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          displayName: principal.displayName,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'containment:recover',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: {
          from: record.fromLevel,
          to: record.toLevel,
          resolution: body.resolution,
          scope: record.scope,
        },
      });

      return reply.status(201).send(record);
    },
  );

  /**
   * The containment history for an organisation.
   *
   * Append-only and complete. An organisation is entitled to see every
   * restriction placed on it, who placed it and why — a containment somebody
   * cannot see is indistinguishable from a system quietly failing.
   */
  server.get(
    '/v1/organisations/:organisationId/containment',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          scope: string;
          transition: string;
          from_level: string;
          to_level: string;
          trigger: string | null;
          actor_kind: string;
          actor_label: string;
          justification: string;
          resolution: string | null;
          findings: string | null;
          review_required: boolean;
          reviewed_at: Date | null;
          occurred_at: Date;
        }>(
          `SELECT id, scope, transition, from_level, to_level, trigger, actor_kind, actor_label,
                  justification, resolution, findings, review_required, reviewed_at, occurred_at
             FROM containment_events
            WHERE organisation_id = $1
            ORDER BY occurred_at DESC
            LIMIT 200`,
          [organisationId],
        ),
      );

      const current = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.one<{ containment_level: string; contained_since: Date | null }>(
          `SELECT containment_level, contained_since FROM organisations WHERE id = $1`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        currentLevel: current?.containment_level ?? 'C0',
        containedSince: current?.contained_since?.toISOString() ?? null,
        evidenceRemainsReadable: true,
        history: rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          transition: row.transition,
          fromLevel: row.from_level,
          toLevel: row.to_level,
          trigger: row.trigger,
          actorKind: row.actor_kind,
          actorLabel: row.actor_label,
          justification: row.justification,
          resolution: row.resolution,
          findings: row.findings,
          awaitingReview: row.review_required && row.reviewed_at === null,
          occurredAt: row.occurred_at.toISOString(),
        })),
      });
    },
  );
}
