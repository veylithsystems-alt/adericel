import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BREAK_GLASS_REASONS,
  DEFAULT_BREAK_GLASS_MINUTES,
  MAX_BREAK_GLASS_MINUTES,
  PERMISSIONS,
} from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requirePlatform, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import { closeBreakGlass, openBreakGlass } from '../services/break-glass.js';

/**
 * Break-glass routes.
 *
 * Platform-scoped: only a Veylith operator opens emergency access, and only
 * over an organisation they would otherwise have no standing authority over.
 * The organisation can see every grant through its own containment and audit
 * views — emergency access the subject cannot see is a back door with better
 * paperwork.
 */

const openSchema = z.object({
  organisationId: z.string().uuid(),
  reason: z.enum(BREAK_GLASS_REASONS),
  justification: z.string().min(30).max(2000),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_BREAK_GLASS_MINUTES)
    .default(DEFAULT_BREAK_GLASS_MINUTES),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
});

export function registerBreakGlassRoutes(server: FastifyInstance, app: AppContext): void {
  server.post(
    '/v1/system/break-glass',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:read');
      const body = parseBody(request, openSchema);
      const principal = requirePrincipal(request);

      if (principal.principalType !== 'USER') {
        // An API key cannot open emergency access. Break-glass is a decision with
        // a person's name on it, and a key is not a person.
        throw new AdericelError(
          'FORBIDDEN',
          'Break-glass is opened by a named person, not by an API key. The record has to have ' +
            'somebody to ask afterwards.',
        );
      }

      const grant = await openBreakGlass(
        app,
        {
          organisationId: body.organisationId,
          reason: body.reason,
          justification: body.justification,
          minutes: body.minutes,
          permissions: body.permissions,
        },
        {
          userId: principal.principalId,
          displayName: principal.displayName,
          mfaSatisfied: principal.mfaSatisfied,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'break-glass:open',
        resourceType: 'Organisation',
        resourceId: body.organisationId,
        metadata: {
          reason: body.reason,
          minutes: body.minutes,
          permissions: body.permissions,
          mspNotified: grant.mspNotified,
        },
      });

      return reply.status(201).send(grant);
    },
  );

  /** Close early. The only direction available; nothing extends. */
  server.post(
    '/v1/system/break-glass/:id/close',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:read');
      const { id } = parseParams(request, z.object({ id: z.string().uuid() }));
      const principal = requirePrincipal(request);

      await closeBreakGlass(
        app,
        id,
        principal.principalType === 'USER' ? principal.principalId : '',
      );

      await audit(app, request, {
        action: 'break-glass:close',
        resourceType: 'Organisation',
        resourceId: null,
        metadata: { breakGlassId: id },
      });

      return reply.status(200).send({ closed: true });
    },
  );

  /**
   * Every break-glass grant, open and historical.
   *
   * Platform-scoped because it spans organisations. An individual organisation
   * sees its own through its audit trail, which is the view that matters for
   * the promise that this cannot be done quietly.
   */
  server.get(
    '/v1/system/break-glass',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:read');

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          id: string;
          organisation_id: string;
          reason: string;
          justification: string;
          permissions: string[];
          opened_by_label: string;
          opened_at: Date;
          expires_at: Date;
          closed_at: Date | null;
          msp_notified_at: Date | null;
          reviewed_at: Date | null;
        }>(
          `SELECT id, organisation_id, reason, justification, permissions, opened_by_label,
                opened_at, expires_at, closed_at, msp_notified_at, reviewed_at
           FROM break_glass_grants
          ORDER BY opened_at DESC
          LIMIT 200`,
          [],
        ),
      );

      const now = app.clock.nowEpochMs();
      return reply.status(200).send({
        grants: rows.map((row) => ({
          id: row.id,
          organisationId: row.organisation_id,
          reason: row.reason,
          justification: row.justification,
          permissions: row.permissions,
          openedBy: row.opened_by_label,
          openedAt: row.opened_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          live: row.closed_at === null && row.expires_at.getTime() > now,
          // Surfaced rather than buried: a grant whose MSP was never told is the
          // one a review most needs to find.
          mspNotified: row.msp_notified_at !== null,
          awaitingReview: row.reviewed_at === null,
        })),
      });
    },
  );
}
