import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MATERIALITY, UNKNOWN_KINDS, KIND_MEANING } from '@adericel/resolution';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import { buildResolutionQueue, resolutionForControl } from '../services/resolution.js';

/**
 * The resolution queue: what to do about every unknown, ranked.
 *
 * `GET .../unknowns` is the answer to "forty controls are undecided, now
 * what". It reads as assurance data — which controls, and why — so it sits on
 * the tenant-assurance information class like the assurance routes it explains.
 */

const orgParam = z.object({ organisationId: z.string().uuid() });
const controlParam = orgParam.extend({ controlId: z.string().uuid() });

const COMMITMENT_KINDS = [
  'CERTIFICATION_ASSESSMENT',
  'INSURER_RENEWAL',
  'CUSTOMER_QUESTIONNAIRE',
  'AUDIT',
  'CONTRACTUAL_DEADLINE',
  'INTERNAL_TARGET',
] as const;

const commitmentSchema = z
  .object({
    kind: z.enum(COMMITMENT_KINDS),
    label: z.string().min(5).max(300),
    dueAt: z.string().datetime(),
    frameworkKey: z.string().max(100).nullable().default(null),
  })
  .strict();

export function registerResolutionRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * The vocabulary, so an operator can read the queue without a glossary.
   *
   * Reference data, identical for every caller, naming no organisation.
   */
  server.get('/v1/resolution/model', { preHandler: server.authenticate }, async (_req, reply) =>
    reply.status(200).send({
      kinds: UNKNOWN_KINDS.map((kind) => ({ kind, meaning: KIND_MEANING[kind] })),
      materiality: MATERIALITY,
      principle:
        'UNKNOWN is honest and, on its own, moves the cost of finding out rather than removing ' +
        'it. Every material unknown therefore carries why it is unknown, what evidence would ' +
        'resolve it, who can provide that, how material it is, what happens if it is not ' +
        'resolved, the next action, and how many control assessments resolving it would make ' +
        'decidable.',
      uncertaintyCaveat:
        'The uncertainty figures are counts over the assurance graph. They are never a ' +
        'probability and never a confidence level: a percentage there would be a fabrication ' +
        'dressed as precision.',
    }),
  );

  server.get(
    '/v1/organisations/:organisationId/unknowns',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      return reply.status(200).send(await buildResolutionQueue(app, organisationId));
    },
  );

  server.get(
    '/v1/organisations/:organisationId/controls/:controlId/resolution',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId, controlId } = parseParams(request, controlParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      return reply.status(200).send(await resolutionForControl(app, organisationId, controlId));
    },
  );

  /**
   * Record a dated commitment.
   *
   * The date is what turns a ranking by severity into a ranking by consequence.
   * Adericel will not invent one: a queue that assumed a deadline would mark
   * everything blocking, and an operator would learn to ignore the ranking —
   * which is worse than no ranking, because it looks like one.
   */
  server.post(
    '/v1/organisations/:organisationId/commitments',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const body = parseBody(request, commitmentSchema);
      const principal = requirePrincipal(request);

      if (Date.parse(body.dueAt) <= app.clock.nowEpochMs()) {
        // A date in the past cannot make anything urgent, and recording one
        // would silently do nothing — which reads as the feature not working.
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message:
              'A commitment must be in the future. A past date changes no ranking, so recording ' +
              'one would look like the ranking is broken.',
          },
        });
      }

      const row = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.oneOrFail<{ id: string; due_at: Date }>(
          `INSERT INTO organisation_commitments
             (organisation_id, kind, label, due_at, framework_key, recorded_by,
              recorded_by_label, correlation_id)
           VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8)
           RETURNING id, due_at`,
          [
            organisationId,
            body.kind,
            body.label,
            body.dueAt,
            body.frameworkKey,
            principal.principalType === 'USER' ? principal.principalId : null,
            principal.displayName,
            request.adericel.correlationId,
          ],
          'Commitment',
        ),
      );

      await audit(app, request, {
        action: 'commitment:record',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { kind: body.kind, dueAt: body.dueAt },
      });

      return reply.status(201).send({
        id: row.id,
        dueAt: row.due_at.toISOString(),
        effect:
          'Unknowns that block this commitment will now rank as BLOCKING in the resolution ' +
          'queue while it is within thirty days.',
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/commitments',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          kind: string;
          label: string;
          due_at: Date;
          framework_key: string | null;
          recorded_by_label: string;
          cancelled_at: Date | null;
          met_at: Date | null;
        }>(
          `SELECT id, kind, label, due_at, framework_key, recorded_by_label, cancelled_at, met_at
             FROM organisation_commitments
            WHERE organisation_id = $1
            ORDER BY due_at`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        commitments: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          label: row.label,
          dueAt: row.due_at.toISOString(),
          frameworkKey: row.framework_key,
          recordedBy: row.recorded_by_label,
          // Cancelled rather than deleted: a commitment that was dropped is a
          // fact about how the quarter went, and it makes the queue that
          // ranked work against it explicable afterwards.
          cancelledAt: row.cancelled_at?.toISOString() ?? null,
          metAt: row.met_at?.toISOString() ?? null,
        })),
      });
    },
  );
}
