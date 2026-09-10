import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  compileAutonomyPolicy,
  type OperationRiskClass,
} from '@adericel/autonomy';
import {
  createBusinessEventLedger,
  createExceptionQueue,
  createMetricsService,
  createOperator,
  DEFAULT_COMPANY_POLICY,
} from '@adericel/vaol';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requirePlatform } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery } from '../middleware/validation.js';

/**
 * The internal control room.
 *
 * Answers one question, which is the question a person governing an autonomous
 * company needs answered without interrogating five systems:
 *
 *   What is the company doing right now, why is it doing it, what has failed,
 *   and what requires my attention?
 *
 * Every route here is platform scope. None of it is customer data and none of
 * it is reachable by a customer session — the schema enforces that
 * independently, and these permission checks are the second lock rather than
 * the only one.
 */

const idParam = z.object({ id: z.string().uuid() });

export function registerVeylithRoutes(server: FastifyInstance, app: AppContext): void {
  const compiled = compileAutonomyPolicy(DEFAULT_COMPANY_POLICY);

  /** The queue a person actually opens: what is stuck and who must unstick it. */
  server.get('/v1/veylith/exceptions', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const query = parseQuery(
      request,
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        overdueOnly: z.coerce.boolean().default(false),
      }),
    );

    const { exceptions, overdue } = await app.db.withPlatform(async (ctx) => {
      const queue = createExceptionQueue(ctx, app.clock);
      return {
        exceptions: query.overdueOnly ? await queue.overdue() : await queue.open({ limit: query.limit }),
        overdue: await queue.overdue(),
      };
    });

    return reply.status(200).send({
      exceptions,
      // Surfaced separately because an overdue count is the one number that
      // tells a person whether the company is keeping up with itself.
      overdueCount: overdue.length,
    });
  });

  server.get('/v1/veylith/exceptions/:id', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const { id } = parseParams(request, idParam);
    const detail = await app.db.withPlatform(async (ctx) => {
      const queue = createExceptionQueue(ctx, app.clock);
      const exception = await queue.get(id);
      if (!exception) return null;
      return { exception, transitions: await queue.transitions(id) };
    });
    if (!detail) throw new AdericelError('NOT_FOUND', 'Operational exception not found');
    return reply.status(200).send(detail);
  });

  server.post(
    '/v1/veylith/exceptions/:id/acknowledge',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:admin');
      const { id } = parseParams(request, idParam);
      const owner = request.adericel.principal?.displayName ?? 'operator';
      const exception = await app.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, app.clock).acknowledge(id, owner),
      );
      await audit(app, request, {
        action: 'veylith:exception:acknowledge',
        resourceType: 'OperationalException',
        resourceId: id,
      });
      return reply.status(200).send(exception);
    },
  );

  server.post(
    '/v1/veylith/exceptions/:id/resolve',
    { preHandler: server.authenticate },
    async (request, reply) => {
      await requirePlatform(app, request, 'platform:admin');
      const { id } = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          resolution: z.string().min(1).max(4000),
          // Defaults to PENDING, not NOT_REQUIRED: a resolution nobody
          // confirmed is a claim rather than a fact, and the person resolving
          // it has to say which.
          verification: z
            .enum(['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'REFUTED', 'INCONCLUSIVE'])
            .default('PENDING'),
        }),
      );
      const actor = request.adericel.principal?.displayName ?? 'operator';
      const exception = await app.db.withPlatform(async (ctx) =>
        createExceptionQueue(ctx, app.clock).resolve(id, body.resolution, actor, {
          verification: body.verification,
        }),
      );
      await audit(app, request, {
        action: 'veylith:exception:resolve',
        resourceType: 'OperationalException',
        resourceId: id,
        metadata: { verification: body.verification },
      });
      return reply.status(200).send(exception);
    },
  );

  /** How autonomous the company actually is, measured rather than asserted. */
  server.get('/v1/veylith/autonomy', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const query = parseQuery(
      request,
      z.object({ windowHours: z.coerce.number().int().min(1).max(24 * 365).default(24 * 30) }),
    );

    const { metrics, processes } = await app.db.withPlatform(async (ctx) => {
      const service = createMetricsService(ctx, app.clock);
      return {
        metrics: await service.autonomy(query.windowHours),
        processes: await service.byProcess(query.windowHours),
      };
    });

    // The gap between what the company plans and what it does. Reported
    // explicitly because a maturity model kept only as a plan drifts from
    // reality the week after it is written.
    const overstated = processes.filter(
      (p) => p.observedMaturity !== null && p.observedMaturity < p.currentMaturity,
    );

    return reply.status(200).send({
      metrics,
      processes,
      overstatedProcesses: overstated.map((p) => ({
        processKey: p.processKey,
        recorded: p.currentMaturity,
        observed: p.observedMaturity,
      })),
      policy: { key: compiled.key, hash: compiled.hash, rules: compiled.rules.length },
    });
  });

  /** The process registry and its maturity model. */
  server.get('/v1/veylith/processes', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const rows = await app.db.withPlatform(async (ctx) =>
      ctx.many<{
        key: string;
        domain: string;
        title: string;
        description: string;
        current_maturity: number;
        target_maturity: number;
        human_boundary: string;
        risk: string;
        automation_candidate: boolean;
        enabled: boolean;
      }>(
        `SELECT key, domain, title, description, current_maturity, target_maturity,
                human_boundary, risk, automation_candidate, enabled
         FROM veylith.company_processes ORDER BY domain, key`,
        [],
      ),
    );
    return reply.status(200).send({
      processes: rows.map((row) => ({
        key: row.key,
        domain: row.domain,
        title: row.title,
        description: row.description,
        currentMaturity: row.current_maturity,
        targetMaturity: row.target_maturity,
        humanBoundary: row.human_boundary,
        risk: row.risk,
        automationCandidate: row.automation_candidate,
        enabled: row.enabled,
        // The backlog, derived rather than maintained by hand.
        automationGap: row.automation_candidate
          ? Math.max(0, row.target_maturity - row.current_maturity)
          : 0,
      })),
    });
  });

  /**
   * Ask what the policy would decide, without doing anything.
   *
   * The route that makes the authority model inspectable. An operator can find
   * out why an automation is not running before it next tries, rather than
   * reading the rules and guessing.
   */
  server.post('/v1/veylith/autonomy/simulate', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const body = parseBody(
      request,
      z.object({
        processKey: z.string().min(1).max(200),
        operation: z.string().min(1).max(200),
        riskClass: z.enum([
          'INTERNAL',
          'OUTWARD_FACING',
          'FINANCIAL',
          'CONTRACTUAL',
          'OPERATIONAL_CHANGE',
          'IRREVERSIBLE',
        ]),
        facts: z.record(z.string(), z.boolean()).default({}),
      }),
    );

    const decision = await app.db.withPlatform(async (ctx) =>
      createOperator({
        ctx,
        clock: app.clock,
        logger: app.logger,
        policy: compiled,
        actor: 'simulation',
      }).wouldPermit({
        processKey: body.processKey,
        operation: body.operation,
        riskClass: body.riskClass as OperationRiskClass,
        facts: body.facts,
      }),
    );

    return reply.status(200).send({ decision });
  });

  /** The ledger. What the company did, who decided, and whether a person was involved. */
  server.get('/v1/veylith/events', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const query = parseQuery(
      request,
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
    );
    const events = await app.db.withPlatform(async (ctx) =>
      createBusinessEventLedger(ctx, app.clock).recent({ limit: query.limit }),
    );
    return reply.status(200).send({ events });
  });

  /** Every decision, including the refusals — which are the more useful half. */
  server.get('/v1/veylith/decisions', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:read');
    const query = parseQuery(
      request,
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        refusalsOnly: z.coerce.boolean().default(false),
      }),
    );
    const rows = await app.db.withPlatform(async (ctx) =>
      ctx.many<{
        id: string;
        process_key: string;
        operation: string;
        outcome: string;
        reason: string;
        matched_rule_id: string | null;
        subject_kind: string | null;
        subject_id: string | null;
        decided_at: Date;
      }>(
        `SELECT id, process_key, operation, outcome, reason, matched_rule_id,
                subject_kind, subject_id, decided_at
         FROM veylith.policy_decisions
         WHERE ($2::boolean IS NOT TRUE OR outcome <> 'PERMIT')
         ORDER BY decided_at DESC, id DESC LIMIT $1`,
        [query.limit, query.refusalsOnly],
      ),
    );
    return reply.status(200).send({
      decisions: rows.map((row) => ({
        id: row.id,
        processKey: row.process_key,
        operation: row.operation,
        outcome: row.outcome,
        reason: row.reason,
        matchedRuleId: row.matched_rule_id,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        decidedAt: row.decided_at.toISOString(),
      })),
    });
  });
}
