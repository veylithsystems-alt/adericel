import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ACTION_STATES,
  actionProposalSchema,
  approvalDecisionSchema,
  organisationSettingsSchema,
  type AutonomyLevel,
  type Severity,
} from '@adericel/domain';
import { createActionService, createCollectionService } from '@adericel/actions';
import { AdericelError } from '@adericel/shared';
import { compilePolicy } from '@adericel/policy';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery, organisationParam } from '../middleware/validation.js';
import { withIdempotency } from '../middleware/idempotency.js';

/**
 * Action, approval and verification routes.
 *
 * The route layer does no policy reasoning of its own — it authenticates,
 * authorises, and delegates to the action service, which holds the lifecycle
 * invariants. Keeping the rules in one place is what makes them testable and
 * what stops a new endpoint accidentally introducing a path around them.
 */

const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

async function serviceDeps(app: AppContext, request: Parameters<typeof requirePrincipal>[0], organisationId: string) {
  const principal = requirePrincipal(request);
  const { policy, policyId, autonomyLevel } = await app.db.withPlatform(async (ctx) => {
    const row = await ctx.one<{ id: string; definition: Record<string, unknown> }>(
      `SELECT p.id, p.definition FROM policies p
       WHERE p.enabled
         AND (p.organisation_id = $1
              OR (p.msp_id IS NOT NULL
                  AND p.msp_id = (SELECT msp_id FROM organisations WHERE id = $1)))
       ORDER BY (p.organisation_id IS NOT NULL) DESC, p.version DESC
       LIMIT 1`,
      [organisationId],
    );
    const org = await ctx.oneOrFail<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM organisations WHERE id = $1`,
      [organisationId],
      'Organisation',
    );
    const settings = organisationSettingsSchema.parse(org.settings ?? {});
    return {
      // An organisation-specific policy wins over the MSP's; the shipped
      // deny-by-default policy applies when neither exists.
      policy: row ? compilePolicy(row.definition) : app.defaultPolicy,
      policyId: row?.id ?? null,
      autonomyLevel: settings.defaultAutonomyLevel as AutonomyLevel,
    };
  });

  return {
    clock: app.clock,
    logger: request.adericel.logger,
    connectors: app.connectors,
    policy,
    policyId,
    organisationAutonomyLevel: autonomyLevel,
    correlationId: request.adericel.correlationId,
    actor: principal.displayName,
    actorUserId: principal.principalType === 'USER' ? principal.principalId : null,
    unsealCredentials: app.unsealCredentials,
  };
}

export function registerActionRoutes(server: FastifyInstance, app: AppContext): void {
  server.get(
    '/v1/organisations/:organisationId/actions',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:action:read');
      const query = parseQuery(
        request,
        z.object({
          state: z.enum(ACTION_STATES).optional(),
          awaitingApproval: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      );

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          action_type: string;
          risk_class: string;
          state: string;
          target_external_id: string | null;
          target_label: string | null;
          proposal_rationale: string;
          proposed_by_actor: string;
          autonomy_level: number | null;
          finding_id: string | null;
          finding_title: string | null;
          required_approvals: number | null;
          approvals_recorded: string | null;
          proposed_at: Date;
          executed_at: Date | null;
          verified_at: Date | null;
          expires_at: Date | null;
          last_error: string | null;
        }>(
          `SELECT a.id, a.action_type, a.risk_class, a.state, a.target_external_id,
                  n.label AS target_label, a.proposal_rationale, a.proposed_by_actor,
                  a.autonomy_level, a.finding_id, f.title AS finding_title,
                  ap.required_approvals,
                  (SELECT count(*)::text FROM approval_decisions d
                    WHERE d.approval_id = ap.id AND d.decision = 'APPROVED') AS approvals_recorded,
                  a.proposed_at, a.executed_at, a.verified_at, a.expires_at, a.last_error
           FROM actions a
           LEFT JOIN graph_nodes n ON n.id = a.target_node_id
           LEFT JOIN findings f ON f.id = a.finding_id
           LEFT JOIN approvals ap ON ap.id = a.approval_id
           WHERE a.organisation_id = $1
             AND ($2::text IS NULL OR a.state = $2)
             AND ($3 = false OR a.state = 'AWAITING_APPROVAL')
           ORDER BY a.proposed_at DESC, a.id DESC
           LIMIT $4`,
          [organisationId, query.state ?? null, query.awaitingApproval, query.limit],
        ),
      );

      return reply.status(200).send({
        actions: rows.map((row) => ({
          id: row.id,
          actionType: row.action_type,
          riskClass: row.risk_class,
          state: row.state,
          target: row.target_label ?? row.target_external_id,
          rationale: row.proposal_rationale,
          proposedBy: row.proposed_by_actor,
          autonomyLevel: row.autonomy_level,
          finding: row.finding_id ? { id: row.finding_id, title: row.finding_title } : null,
          approvals:
            row.required_approvals === null
              ? null
              : {
                  required: row.required_approvals,
                  recorded: Number(row.approvals_recorded ?? 0),
                },
          proposedAt: row.proposed_at.toISOString(),
          executedAt: row.executed_at?.toISOString() ?? null,
          verifiedAt: row.verified_at?.toISOString() ?? null,
          expiresAt: row.expires_at?.toISOString() ?? null,
          lastError: row.last_error,
        })),
      });
    },
  );

  /** One action with its complete lifecycle history. */
  server.get(
    '/v1/organisations/:organisationId/actions/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:action:read');

      const data = await app.db.withTenant(params.organisationId, async (ctx) => {
        const action = await ctx.oneOrFail<Record<string, unknown>>(
          `SELECT a.*, n.label AS target_label
           FROM actions a LEFT JOIN graph_nodes n ON n.id = a.target_node_id
           WHERE a.id = $1 AND a.organisation_id = $2`,
          [params.id, params.organisationId],
          'Action',
        );
        const transitions = await ctx.many<{
          from_state: string | null;
          to_state: string;
          actor: string;
          reason: string | null;
          occurred_at: Date;
        }>(
          `SELECT from_state, to_state, actor, reason, occurred_at
           FROM action_transitions WHERE action_id = $1 ORDER BY seq`,
          [params.id],
        );
        const executions = await ctx.many<{
          attempt: number;
          status: string;
          external_operation_ref: string | null;
          error_code: string | null;
          error_detail: string | null;
          started_at: Date;
          finished_at: Date | null;
        }>(
          `SELECT attempt, status, external_operation_ref, error_code, error_detail, started_at, finished_at
           FROM action_executions WHERE action_id = $1 ORDER BY attempt`,
          [params.id],
        );
        const decisions = await ctx.many<{
          approver_user_id: string;
          approver_name: string;
          decision: string;
          note: string | null;
          decided_at: Date;
        }>(
          `SELECT d.approver_user_id, u.display_name AS approver_name, d.decision, d.note, d.decided_at
           FROM approval_decisions d
           JOIN approvals ap ON ap.id = d.approval_id
           JOIN users u ON u.id = d.approver_user_id
           WHERE ap.action_id = $1 ORDER BY d.decided_at`,
          [params.id],
        );
        const verifications = await ctx.many<{
          id: string;
          method: string;
          outcome: string;
          detail: string;
          attempt: number;
          verified_at: Date;
        }>(
          `SELECT id, method, outcome, detail, attempt, verified_at
           FROM verifications WHERE action_id = $1 ORDER BY verified_at`,
          [params.id],
        );
        return { action, transitions, executions, decisions, verifications };
      });

      const a = data.action as Record<string, unknown>;
      return reply.status(200).send({
        id: a.id,
        actionType: a.action_type,
        riskClass: a.risk_class,
        state: a.state,
        parameters: a.parameters,
        target: a.target_label ?? a.target_external_id,
        rationale: a.proposal_rationale,
        proposedBy: a.proposed_by_actor,
        idempotencyKey: a.idempotency_key,
        externalOperationRef: a.external_operation_ref,
        autonomyLevel: a.autonomy_level,
        // The full policy decision, so an auditor can see exactly why this was
        // permitted and which rule matched.
        policyDecision: a.policy_decision,
        proposedAt: (a.proposed_at as Date).toISOString(),
        history: data.transitions.map((t) => ({
          from: t.from_state,
          to: t.to_state,
          actor: t.actor,
          reason: t.reason,
          at: t.occurred_at.toISOString(),
        })),
        executions: data.executions.map((e) => ({
          attempt: e.attempt,
          status: e.status,
          externalOperationRef: e.external_operation_ref,
          errorCode: e.error_code,
          errorDetail: e.error_detail,
          startedAt: e.started_at.toISOString(),
          finishedAt: e.finished_at?.toISOString() ?? null,
        })),
        approvals: data.decisions.map((d) => ({
          approverUserId: d.approver_user_id,
          approverName: d.approver_name,
          decision: d.decision,
          note: d.note,
          decidedAt: d.decided_at.toISOString(),
        })),
        verifications: data.verifications.map((v) => ({
          id: v.id,
          method: v.method,
          outcome: v.outcome,
          detail: v.detail,
          attempt: v.attempt,
          verifiedAt: v.verified_at.toISOString(),
        })),
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/actions',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:action:propose');
      const body = parseBody(request, actionProposalSchema);
      const deps = await serviceDeps(app, request, organisationId);

      const outcome = await withIdempotency(app, request, async () => {
        const result = await app.db.withTenant(organisationId, async (ctx) => {
          const severity = body.findingId
            ? (
                await ctx.one<{ severity: string }>(
                  `SELECT severity FROM findings WHERE id = $1 AND organisation_id = $2`,
                  [body.findingId, organisationId],
                )
              )?.severity ?? null
            : null;
          return createActionService({ ctx, ...deps }).propose(body, severity as Severity | null);
        });

        return {
          status: 201,
          body: {
            action: {
              id: result.action.id,
              actionType: result.action.actionType,
              state: result.action.state,
              riskClass: result.action.riskClass,
              autonomyLevel: result.action.autonomyLevel,
              idempotencyKey: result.action.idempotencyKey,
              expiresAt: result.action.expiresAt,
            },
            // The decision is returned in full so the caller — a person or a
            // workflow — sees why approval is or is not required.
            decision: result.decision,
          },
        };
      });

      await audit(app, request, {
        action: 'action:propose',
        resourceType: 'Action',
        resourceId: (outcome.body as { action: { id: string } }).action.id,
        metadata: { actionType: body.actionType, replayed: outcome.replayed },
      });

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  /**
   * Approve or reject. Restricted to signed-in users: an approval recorded
   * against an API key or a workflow would be an approval by the same system
   * that proposed the change.
   */
  server.post(
    '/v1/organisations/:organisationId/actions/:id/decision',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:action:approve');
      const body = parseBody(request, approvalDecisionSchema);
      const principal = requirePrincipal(request);

      if (principal.principalType !== 'USER') {
        throw new AdericelError(
          'FORBIDDEN',
          'Only a signed-in user may approve an action. Four-eyes control cannot be satisfied by an API key or a workflow.',
        );
      }

      const deps = await serviceDeps(app, request, params.organisationId);
      const result = await app.db.withTenant(params.organisationId, async (ctx) =>
        createActionService({ ctx, ...deps }).decide(
          params.id,
          body.decision,
          body.note,
          principal.principalId,
        ),
      );

      await audit(app, request, {
        action: `action:${body.decision.toLowerCase()}`,
        resourceType: 'Action',
        resourceId: params.id,
        metadata: {
          approvalsRecorded: result.approvalsRecorded,
          approvalsRequired: result.approvalsRequired,
        },
      });

      return reply.status(200).send({
        actionId: params.id,
        state: result.action.state,
        approvalsRecorded: result.approvalsRecorded,
        approvalsRequired: result.approvalsRequired,
        fullyApproved: result.fullyApproved,
      });
    },
  );

  /** Dispatch an authorised action. Idempotent by construction. */
  server.post(
    '/v1/organisations/:organisationId/actions/:id/execute',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:action:execute');
      const deps = await serviceDeps(app, request, params.organisationId);

      const result = await app.db.withTenant(params.organisationId, async (ctx) =>
        createActionService({ ctx, ...deps }).execute(params.id),
      );

      await audit(app, request, {
        action: 'action:execute',
        resourceType: 'Action',
        resourceId: params.id,
        outcome: result.execution.status === 'SUCCEEDED' ? 'SUCCESS' : 'FAILURE',
        reason: result.execution.detail,
        metadata: {
          externalOperationRef: result.execution.externalOperationRef,
          alreadyExecuted: result.alreadyExecuted,
        },
      });

      return reply.status(200).send({
        actionId: params.id,
        state: result.action.state,
        executionStatus: result.execution.status,
        detail: result.execution.detail,
        externalOperationRef: result.execution.externalOperationRef,
        alreadyExecuted: result.alreadyExecuted,
        // EXECUTED is not success. The action is not done until verification.
        verificationRequired: result.action.state === 'VERIFYING',
      });
    },
  );

  /**
   * Verify an executed action by re-observing the external system.
   *
   * The observed value is re-collected through the integration rather than
   * accepted from the caller, so a verification cannot be satisfied by simply
   * asserting success.
   */
  server.post(
    '/v1/organisations/:organisationId/actions/:id/verify',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:action:execute');
      const deps = await serviceDeps(app, request, params.organisationId);

      const result = await app.db.withTenant(params.organisationId, async (ctx) => {
        const service = createActionService({ ctx, ...deps });
        const action = await service.requireById(params.id);
        const capability = app.connectors.capabilityFor(action.actionType);
        if (!capability) {
          throw new AdericelError('INTERNAL_ERROR', 'No capability for this action type');
        }
        if (!action.integrationId || !action.targetExternalId) {
          return service.verify(params.id, undefined);
        }

        const collection = createCollectionService({
          ctx,
          clock: app.clock,
          logger: request.adericel.logger,
          connectors: app.connectors,
          correlationId: request.adericel.correlationId,
          actor: deps.actor,
          unsealCredentials: app.unsealCredentials,
        });
        const observed = await collection.reobserve(
          action.integrationId,
          action.targetExternalId,
          capability.verification.predicate,
        );
        return service.verify(params.id, observed);
      });

      await audit(app, request, {
        action: 'action:verify',
        resourceType: 'Action',
        resourceId: params.id,
        outcome: result.outcome === 'CONFIRMED' ? 'SUCCESS' : 'FAILURE',
        reason: result.detail,
        metadata: { outcome: result.outcome },
      });

      return reply.status(200).send({
        actionId: params.id,
        outcome: result.outcome,
        state: result.action.state,
        detail: result.detail,
        verificationId: result.verificationId,
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/actions/:id/cancel',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:action:propose');
      const body = parseBody(request, z.object({ reason: z.string().min(3).max(1000) }));
      const deps = await serviceDeps(app, request, params.organisationId);

      const action = await app.db.withTenant(params.organisationId, async (ctx) =>
        createActionService({ ctx, ...deps }).cancel(params.id, body.reason),
      );

      await audit(app, request, {
        action: 'action:cancel',
        resourceType: 'Action',
        resourceId: params.id,
        metadata: { reason: body.reason },
      });

      return reply.status(200).send({ actionId: params.id, state: action.state });
    },
  );

  /** The executable capabilities available in this deployment. */
  server.get('/v1/capabilities', { preHandler: server.authenticate }, async (_request, reply) =>
    reply.status(200).send({
      capabilities: app.connectors.capabilities().map((capability) => ({
        actionType: capability.actionType,
        connectorKey: capability.connectorKey,
        title: capability.title,
        description: capability.description,
        riskClass: capability.riskClass,
        verification: {
          method: capability.verification.method,
          description: capability.verification.description,
          predicate: capability.verification.predicate,
        },
      })),
    }),
  );
}
