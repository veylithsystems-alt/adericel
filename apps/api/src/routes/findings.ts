import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FINDING_STATUSES,
  SEVERITIES,
  deriveRiskSeverity,
  exceptionRequestSchema,
  type Impact,
  type Likelihood,
} from '@adericel/domain';
import { AdericelError, pageRequestSchema } from '@adericel/shared';
import { publish } from '@adericel/graph';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery, organisationParam } from '../middleware/validation.js';

/**
 * Findings, risks and exceptions.
 *
 * A finding is not deleted when it is dealt with; it is resolved, accepted or
 * marked a false positive, and the record persists. That history is what lets
 * an MSP see "this control has failed four times this year" rather than
 * treating each occurrence as new.
 */

const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

export function registerFindingRoutes(server: FastifyInstance, app: AppContext): void {
  server.get(
    '/v1/organisations/:organisationId/findings',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:finding:read');
      const query = parseQuery(
        request,
        pageRequestSchema.extend({
          status: z.enum(FINDING_STATUSES).optional(),
          severity: z.enum(SEVERITIES).optional(),
          controlId: z.string().uuid().optional(),
          openOnly: z.coerce.boolean().default(true),
        }),
      );

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          title: string;
          description: string;
          severity: string;
          status: string;
          control_id: string | null;
          control_key: string | null;
          subject_label: string | null;
          first_detected_at: Date;
          last_detected_at: Date;
          resolved_at: Date | null;
          age_days: string;
          open_actions: string;
        }>(
          `SELECT f.id, f.title, f.description, f.severity, f.status, f.control_id,
                  c.key AS control_key, n.label AS subject_label,
                  f.first_detected_at, f.last_detected_at, f.resolved_at,
                  EXTRACT(EPOCH FROM (now() - f.first_detected_at))::bigint / 86400 AS age_days,
                  (SELECT count(*)::text FROM actions a
                    WHERE a.finding_id = f.id
                      AND a.state NOT IN ('REJECTED','CANCELLED','FAILED','CONFIRMED')) AS open_actions
           FROM findings f
           LEFT JOIN controls c ON c.id = f.control_id
           LEFT JOIN graph_nodes n ON n.id = f.subject_node_id
           WHERE f.organisation_id = $1
             AND ($2::text IS NULL OR f.status = $2)
             AND ($3::text IS NULL OR f.severity = $3)
             AND ($4::uuid IS NULL OR f.control_id = $4)
             AND ($5 = false OR f.status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION'))
           ORDER BY
             CASE f.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2
                             WHEN 'LOW' THEN 3 ELSE 4 END,
             f.first_detected_at
           LIMIT $6`,
          [
            organisationId,
            query.status ?? null,
            query.severity ?? null,
            query.controlId ?? null,
            query.openOnly,
            query.limit,
          ],
        ),
      );

      return reply.status(200).send({
        findings: rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          severity: row.severity,
          status: row.status,
          control: row.control_id ? { id: row.control_id, key: row.control_key } : null,
          subject: row.subject_label,
          firstDetectedAt: row.first_detected_at.toISOString(),
          lastDetectedAt: row.last_detected_at.toISOString(),
          resolvedAt: row.resolved_at?.toISOString() ?? null,
          // Age from first detection, not from the last reassessment.
          ageDays: Number(row.age_days),
          openActions: Number(row.open_actions),
        })),
      });
    },
  );

  server.patch(
    '/v1/organisations/:organisationId/findings/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:finding:manage');
      const body = parseBody(
        request,
        z.object({
          status: z.enum(['ACKNOWLEDGED', 'IN_REMEDIATION', 'RESOLVED', 'FALSE_POSITIVE', 'ACCEPTED_RISK']),
          reason: z.string().min(3).max(2000),
        }),
      );

      const row = await app.db.withTenant(params.organisationId, async (ctx) =>
        ctx.oneOrFail<{ id: string; status: string }>(
          `UPDATE findings
           SET status = $3,
               resolution_reason = $4,
               resolved_at = CASE WHEN $3 IN ('RESOLVED','FALSE_POSITIVE','ACCEPTED_RISK')
                                  THEN $5::timestamptz ELSE resolved_at END
           WHERE id = $1 AND organisation_id = $2
           RETURNING id, status`,
          [params.id, params.organisationId, body.status, body.reason, app.clock.nowIso()],
          'Finding',
        ),
      );

      await audit(app, request, {
        action: 'finding:update',
        resourceType: 'Finding',
        resourceId: params.id,
        metadata: { status: body.status, reason: body.reason },
      });

      return reply.status(200).send({ id: row.id, status: row.status });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/risks',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:risk:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          title: string;
          description: string | null;
          likelihood: string | null;
          impact: string | null;
          inherent_severity: string;
          residual_severity: string | null;
          status: string;
          treatment: string | null;
          review_due_at: Date | null;
          finding_count: string;
        }>(
          `SELECT r.id, r.title, r.description, r.likelihood, r.impact, r.inherent_severity,
                  r.residual_severity, r.status, r.treatment, r.review_due_at,
                  (SELECT count(*)::text FROM risk_findings rf WHERE rf.risk_id = r.id) AS finding_count
           FROM risks r WHERE r.organisation_id = $1
           ORDER BY CASE r.inherent_severity
                      WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2
                      WHEN 'LOW' THEN 3 ELSE 4 END, r.created_at DESC`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        risks: rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          likelihood: row.likelihood,
          impact: row.impact,
          inherentSeverity: row.inherent_severity,
          residualSeverity: row.residual_severity,
          status: row.status,
          treatment: row.treatment,
          reviewDueAt: row.review_due_at?.toISOString() ?? null,
          findingCount: Number(row.finding_count),
        })),
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/risks',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:risk:manage');
      const body = parseBody(
        request,
        z.object({
          title: z.string().min(3).max(300),
          description: z.string().max(4000).nullable().optional(),
          likelihood: z
            .enum(['RARE', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'ALMOST_CERTAIN'])
            .nullable()
            .optional(),
          impact: z
            .enum(['NEGLIGIBLE', 'MINOR', 'MODERATE', 'MAJOR', 'SEVERE'])
            .nullable()
            .optional(),
          treatment: z.enum(['MITIGATE', 'ACCEPT', 'TRANSFER', 'AVOID']).nullable().optional(),
          findingIds: z.array(z.string().uuid()).default([]),
          reviewDueAt: z.string().datetime().nullable().optional(),
        }),
      );

      // An unassessed risk has no derived severity. Recording it as LOW would
      // be a fabricated judgement, so it is stored as INFO and the missing axes
      // stay visible.
      const derived = deriveRiskSeverity(
        (body.likelihood ?? null) as Likelihood | null,
        (body.impact ?? null) as Impact | null,
      );

      const risk = await app.db.withTenant(organisationId, async (ctx) => {
        const rootNode = await ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
          [organisationId],
          'Organisation node',
        );
        const inserted = await ctx.oneOrFail<{ id: string; inherent_severity: string; status: string }>(
          `INSERT INTO risks
             (organisation_id, node_id, title, description, likelihood, impact,
              inherent_severity, status, treatment, review_due_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, inherent_severity, status`,
          [
            organisationId,
            rootNode.id,
            body.title,
            body.description ?? null,
            body.likelihood ?? null,
            body.impact ?? null,
            derived ?? 'INFO',
            derived === null ? 'IDENTIFIED' : 'ASSESSED',
            body.treatment ?? null,
            body.reviewDueAt ?? null,
          ],
          'Risk',
        );
        if (body.findingIds.length > 0) {
          await ctx.query(
            `INSERT INTO risk_findings (risk_id, finding_id, organisation_id)
             SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING`,
            [inserted.id, body.findingIds, organisationId],
          );
        }
        await publish(
          ctx,
          {
            type: 'RiskChanged',
            organisationId,
            subjectType: 'Risk',
            subjectId: inserted.id,
            payload: { title: body.title, severity: inserted.inherent_severity, created: true },
            correlationId: request.adericel.correlationId,
            actor: request.adericel.principal?.displayName ?? 'api',
          },
          app.clock.nowIso(),
        );
        return inserted;
      });

      await audit(app, request, {
        action: 'risk:create',
        resourceType: 'Risk',
        resourceId: risk.id,
        metadata: { severity: risk.inherent_severity },
      });

      return reply.status(201).send({
        id: risk.id,
        inherentSeverity: risk.inherent_severity,
        status: risk.status,
        severityDerived: derived !== null,
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/exceptions',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:exception:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          control_key: string | null;
          justification: string;
          compensating_controls: string | null;
          status: string;
          requested_by: string;
          approved_by: string | null;
          effective_from: Date;
          expires_at: Date;
          subject_label: string | null;
          days_remaining: string;
        }>(
          `SELECT e.id, c.key AS control_key, e.justification, e.compensating_controls, e.status,
                  ru.display_name AS requested_by, au.display_name AS approved_by,
                  e.effective_from, e.expires_at, n.label AS subject_label,
                  EXTRACT(EPOCH FROM (e.expires_at - now()))::bigint / 86400 AS days_remaining
           FROM exceptions e
           LEFT JOIN controls c ON c.id = e.control_id
           LEFT JOIN graph_nodes n ON n.id = e.subject_node_id
           JOIN users ru ON ru.id = e.requested_by_user_id
           LEFT JOIN users au ON au.id = e.approved_by_user_id
           WHERE e.organisation_id = $1
           ORDER BY e.expires_at`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        exceptions: rows.map((row) => ({
          id: row.id,
          controlKey: row.control_key,
          subject: row.subject_label,
          justification: row.justification,
          compensatingControls: row.compensating_controls,
          status: row.status,
          requestedBy: row.requested_by,
          approvedBy: row.approved_by,
          effectiveFrom: row.effective_from.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          daysRemaining: Number(row.days_remaining),
        })),
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/exceptions',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:exception:request');
      const body = parseBody(request, exceptionRequestSchema);
      const principal = requirePrincipal(request);

      if (principal.principalType !== 'USER') {
        throw new AdericelError(
          'FORBIDDEN',
          'Only a signed-in user may request an exception; an exception is a human judgement about accepting risk.',
        );
      }

      const exception = await app.db.withTenant(organisationId, async (ctx) => {
        const rootNode = await ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
          [organisationId],
          'Organisation node',
        );
        const inserted = await ctx.oneOrFail<{ id: string; status: string; expires_at: Date }>(
          `INSERT INTO exceptions
             (organisation_id, node_id, control_id, requirement_id, finding_id, subject_node_id,
              justification, compensating_controls, status, requested_by_user_id,
              effective_from, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'REQUESTED', $9, $10, $11)
           RETURNING id, status, expires_at`,
          [
            organisationId,
            rootNode.id,
            body.controlId ?? null,
            body.requirementId ?? null,
            body.findingId ?? null,
            body.subjectNodeId ?? null,
            body.justification,
            body.compensatingControls ?? null,
            principal.principalId,
            body.effectiveFrom ?? app.clock.nowIso(),
            body.expiresAt,
          ],
          'Exception',
        );
        await publish(
          ctx,
          {
            type: 'ExceptionCreated',
            organisationId,
            subjectType: 'Exception',
            subjectId: inserted.id,
            payload: {
              controlId: body.controlId ?? null,
              expiresAt: body.expiresAt,
              requestedBy: principal.principalId,
            },
            correlationId: request.adericel.correlationId,
            actor: principal.displayName,
          },
          app.clock.nowIso(),
        );
        return inserted;
      });

      await audit(app, request, {
        action: 'exception:request',
        resourceType: 'Exception',
        resourceId: exception.id,
        metadata: { controlId: body.controlId, expiresAt: body.expiresAt },
      });

      return reply.status(201).send({
        id: exception.id,
        status: exception.status,
        expiresAt: exception.expires_at.toISOString(),
      });
    },
  );

  /**
   * Approve an exception.
   *
   * The database enforces that the approver is not the requester, so the
   * four-eyes rule holds even if a future code path forgets to check it.
   */
  server.post(
    '/v1/organisations/:organisationId/exceptions/:id/approve',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:exception:approve');
      const principal = requirePrincipal(request);

      if (principal.principalType !== 'USER') {
        throw new AdericelError('FORBIDDEN', 'Only a signed-in user may approve an exception');
      }

      const exception = await app.db.withTenant(params.organisationId, async (ctx) => {
        const row = await ctx.one<{ requested_by_user_id: string }>(
          `SELECT requested_by_user_id FROM exceptions
           WHERE id = $1 AND organisation_id = $2 AND status = 'REQUESTED'`,
          [params.id, params.organisationId],
        );
        if (!row) throw new AdericelError('NOT_FOUND', 'No pending exception with that id');
        if (row.requested_by_user_id === principal.principalId) {
          throw new AdericelError(
            'FORBIDDEN',
            'The requester of an exception may not approve it',
          );
        }
        const approved = await ctx.oneOrFail<{ id: string; status: string; expires_at: Date }>(
          `UPDATE exceptions
           SET status = 'APPROVED', approved_by_user_id = $3, approved_at = $4::timestamptz
           WHERE id = $1 AND organisation_id = $2 AND status = 'REQUESTED'
           RETURNING id, status, expires_at`,
          [params.id, params.organisationId, principal.principalId, app.clock.nowIso()],
          'Exception',
        );
        await publish(
          ctx,
          {
            type: 'ExceptionApproved',
            organisationId: params.organisationId,
            subjectType: 'Exception',
            subjectId: params.id,
            payload: { approvedBy: principal.principalId, expiresAt: approved.expires_at.toISOString() },
            correlationId: request.adericel.correlationId,
            actor: principal.displayName,
          },
          app.clock.nowIso(),
        );
        return approved;
      });

      await audit(app, request, {
        action: 'exception:approve',
        resourceType: 'Exception',
        resourceId: params.id,
      });

      return reply.status(200).send({
        id: exception.id,
        status: exception.status,
        expiresAt: exception.expires_at.toISOString(),
      });
    },
  );
}
