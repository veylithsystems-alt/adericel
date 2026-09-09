import {
  actionStateForVerification,
  assertTransition,
  isTerminalActionState,
  type ActionProposal,
  type ActionRecord,
  type ActionRiskClass,
  type ActionState,
  type ApprovalDecision,
  type AutonomyLevel,
  type NewDomainEvent,
  type Severity,
  type VerificationOutcome,
} from '@adericel/domain';
import { publish, type TenantContext } from '@adericel/graph';
import type { ConnectorRegistry, ExecutionResult } from '@adericel/integrations';
import { evaluatePolicy, type CompiledPolicy, type PolicyDecision } from '@adericel/policy';
import { AdericelError, contentHash, type Clock, type Logger } from '@adericel/shared';

/**
 * Action lifecycle.
 *
 * Four properties are enforced here and asserted by the tests:
 *
 *  1. Nothing executes without a recorded policy decision.
 *  2. An approver is never the proposer, and one person cannot satisfy a
 *     two-approver requirement.
 *  3. Execution is exactly-once. An attempt is recorded BEFORE dispatch, so a
 *     crash between dispatch and response leaves a durable record that a retry
 *     finds instead of repeating the external side effect.
 *  4. An executed action is not a successful action. It moves to VERIFYING and
 *     reaches CONFIRMED only when re-observation supports it.
 */

type ActionRow = {
  id: string;
  organisation_id: string;
  node_id: string;
  action_type: string;
  integration_id: string | null;
  target_node_id: string | null;
  target_external_id: string | null;
  parameters: Record<string, unknown>;
  risk_class: string;
  state: string;
  finding_id: string | null;
  risk_id: string | null;
  proposed_by_actor: string;
  proposed_by_user_id: string | null;
  proposal_rationale: string;
  policy_id: string | null;
  policy_decision: Record<string, unknown> | null;
  autonomy_level: number | null;
  approval_id: string | null;
  idempotency_key: string;
  external_operation_ref: string | null;
  attempt_count: number;
  last_error: string | null;
  verification_id: string | null;
  correlation_id: string | null;
  proposed_at: Date;
  authorised_at: Date | null;
  executed_at: Date | null;
  verified_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const ACTION_COLUMNS = `
  id, organisation_id, node_id, action_type, integration_id, target_node_id, target_external_id,
  parameters, risk_class, state, finding_id, risk_id, proposed_by_actor, proposed_by_user_id,
  proposal_rationale, policy_id, policy_decision, autonomy_level, approval_id, idempotency_key,
  external_operation_ref, attempt_count, last_error, verification_id, correlation_id,
  proposed_at, authorised_at, executed_at, verified_at, expires_at, created_at, updated_at`;

function toRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    nodeId: row.node_id,
    actionType: row.action_type,
    integrationId: row.integration_id,
    targetNodeId: row.target_node_id,
    targetExternalId: row.target_external_id,
    parameters: row.parameters,
    riskClass: row.risk_class as ActionRiskClass,
    state: row.state as ActionState,
    findingId: row.finding_id,
    riskId: row.risk_id,
    proposedByActor: row.proposed_by_actor,
    proposalRationale: row.proposal_rationale,
    policyId: row.policy_id,
    policyDecision: row.policy_decision,
    autonomyLevel: row.autonomy_level,
    approvalId: row.approval_id,
    idempotencyKey: row.idempotency_key,
    externalOperationRef: row.external_operation_ref,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    verificationId: row.verification_id,
    correlationId: row.correlation_id,
    proposedAt: row.proposed_at.toISOString(),
    authorisedAt: row.authorised_at?.toISOString() ?? null,
    executedAt: row.executed_at?.toISOString() ?? null,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ActionServiceDeps {
  readonly ctx: TenantContext;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly connectors: ConnectorRegistry;
  readonly policy: CompiledPolicy;
  readonly policyId: string | null;
  readonly organisationAutonomyLevel: AutonomyLevel;
  readonly correlationId: string;
  readonly actor: string;
  readonly actorUserId: string | null;
  /**
   * Decrypts an integration's sealed credentials. Injected so that this module
   * never holds an encryption key and so a test can run without one.
   */
  readonly unsealCredentials: CredentialUnsealer;
}

export interface ProposeResult {
  readonly action: ActionRecord;
  readonly decision: PolicyDecision;
  readonly events: readonly NewDomainEvent[];
}

export interface ApproveResult {
  readonly action: ActionRecord;
  readonly approvalsRecorded: number;
  readonly approvalsRequired: number;
  readonly fullyApproved: boolean;
}

export interface ExecuteResult {
  readonly action: ActionRecord;
  readonly execution: ExecutionResult;
  readonly alreadyExecuted: boolean;
}

export interface VerifyResult {
  readonly action: ActionRecord;
  readonly outcome: VerificationOutcome;
  readonly verificationId: string;
  readonly detail: string;
}

export interface ActionService {
  propose(proposal: ActionProposal, severity: Severity | null): Promise<ProposeResult>;
  decide(actionId: string, decision: ApprovalDecision, note: string | undefined, approverUserId: string): Promise<ApproveResult>;
  execute(actionId: string): Promise<ExecuteResult>;
  verify(actionId: string, observedValue: unknown): Promise<VerifyResult>;
  cancel(actionId: string, reason: string): Promise<ActionRecord>;
  getById(actionId: string): Promise<ActionRecord | null>;
  requireById(actionId: string): Promise<ActionRecord>;
  expireOverdueApprovals(): Promise<readonly string[]>;
}

export function createActionService(deps: ActionServiceDeps): ActionService {
  const { ctx, clock, connectors, policy, correlationId, actor } = deps;

  async function transition(
    actionId: string,
    from: ActionState,
    to: ActionState,
    reason: string,
    patch: Record<string, unknown> = {},
  ): Promise<ActionRecord> {
    assertTransition(from, to);
    const setClauses = ['state = $3', 'updated_at = now()'];
    const values: unknown[] = [actionId, ctx.organisationId, to];
    for (const [column, value] of Object.entries(patch)) {
      values.push(value);
      setClauses.push(`${column} = $${values.length}`);
    }

    // The state guard in the WHERE clause makes the transition atomic: two
    // concurrent workers cannot both move the same action out of AUTHORISED.
    const row = await ctx.one<ActionRow>(
      `UPDATE actions SET ${setClauses.join(', ')}
       WHERE id = $1 AND organisation_id = $2 AND state = $${values.length + 1}
       RETURNING ${ACTION_COLUMNS}`,
      [...values, from],
    );
    if (!row) {
      throw new AdericelError('CONFLICT', `Action is no longer in state ${from}`, {
        safeDetails: { actionId, expectedState: from, targetState: to },
      });
    }

    await ctx.query(
      `INSERT INTO action_transitions
         (organisation_id, action_id, from_state, to_state, actor, reason, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.organisationId, actionId, from, to, actor, reason, correlationId],
    );

    return toRecord(row);
  }

  const service: ActionService = {
    async getById(actionId): Promise<ActionRecord | null> {
      const row = await ctx.one<ActionRow>(
        `SELECT ${ACTION_COLUMNS} FROM actions WHERE id = $1 AND organisation_id = $2`,
        [actionId, ctx.organisationId],
      );
      return row ? toRecord(row) : null;
    },

    async requireById(actionId): Promise<ActionRecord> {
      const action = await service.getById(actionId);
      if (!action) {
        throw new AdericelError('NOT_FOUND', 'Action not found', { safeDetails: { actionId } });
      }
      return action;
    },

    async propose(proposal, severity): Promise<ProposeResult> {
      const now = clock.nowIso();
      const capability = connectors.capabilityFor(proposal.actionType);
      if (!capability) {
        throw new AdericelError(
          'VALIDATION_FAILED',
          `No connector provides the capability ${proposal.actionType}`,
          { safeDetails: { actionType: proposal.actionType } },
        );
      }

      const parameters = capability.parameterSchema.parse(proposal.parameters);

      // A derived key makes the same remediation for the same target converge on
      // one action, so two schedulers reacting to the same finding do not
      // dispatch two changes.
      const idempotencyKey =
        proposal.idempotencyKey ??
        contentHash({
          actionType: proposal.actionType,
          targetExternalId: proposal.targetExternalId ?? null,
          targetNodeId: proposal.targetNodeId ?? null,
          findingId: proposal.findingId ?? null,
          parameters,
        });

      const existing = await ctx.one<ActionRow>(
        `SELECT ${ACTION_COLUMNS} FROM actions
         WHERE organisation_id = $1 AND idempotency_key = $2`,
        [ctx.organisationId, idempotencyKey],
      );
      if (existing && !isTerminalActionState(existing.state as ActionState)) {
        return {
          action: toRecord(existing),
          decision: (existing.policy_decision as unknown as PolicyDecision) ?? {
            outcome: 'REQUIRE_APPROVAL',
            reason: 'Existing in-flight action reused',
            matchedRuleId: null,
            effectiveAutonomyLevel: (existing.autonomy_level ?? 1) as AutonomyLevel,
            requiredApprovals: 1,
            approvalWindowHours: 72,
            policyKey: policy.key,
            policyHash: policy.hash,
            evaluation: [],
          },
          events: [],
        };
      }

      const recent = await ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM action_executions ae
         JOIN actions a ON a.id = ae.action_id
         WHERE ae.organisation_id = $1 AND a.action_type = $2
           AND ae.started_at > $3::timestamptz - interval '1 hour'`,
        [ctx.organisationId, proposal.actionType, now],
      );

      const decision = evaluatePolicy(policy, {
        actionType: proposal.actionType,
        riskClass: capability.riskClass,
        findingSeverity: severity,
        organisationAutonomyLevel: deps.organisationAutonomyLevel,
        recentExecutions: Number(recent?.count ?? 0),
        utcHour: new Date(now).getUTCHours(),
        proposerUserId: deps.actorUserId,
      });

      const controlNode = await ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
        [ctx.organisationId],
        'Organisation node',
      );

      const expiresAt =
        proposal.expiresAt ??
        new Date(Date.parse(now) + decision.approvalWindowHours * 3_600_000).toISOString();

      const inserted = await ctx.oneOrFail<ActionRow>(
        `INSERT INTO actions
           (organisation_id, node_id, action_type, integration_id, target_node_id, target_external_id,
            parameters, risk_class, state, finding_id, risk_id, proposed_by_actor, proposed_by_user_id,
            proposal_rationale, policy_id, policy_decision, autonomy_level, idempotency_key,
            correlation_id, proposed_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'PROPOSED', $9, $10, $11, $12, $13, $14,
                 $15::jsonb, $16, $17, $18, $19, $20)
         RETURNING ${ACTION_COLUMNS}`,
        [
          ctx.organisationId,
          controlNode.id,
          proposal.actionType,
          proposal.integrationId ?? null,
          proposal.targetNodeId ?? null,
          proposal.targetExternalId ?? null,
          JSON.stringify(parameters),
          capability.riskClass,
          proposal.findingId ?? null,
          proposal.riskId ?? null,
          actor,
          deps.actorUserId,
          proposal.rationale,
          deps.policyId,
          JSON.stringify(decision),
          decision.effectiveAutonomyLevel,
          idempotencyKey,
          correlationId,
          now,
          expiresAt,
        ],
        'Action',
      );

      await ctx.query(
        `INSERT INTO action_transitions (organisation_id, action_id, from_state, to_state, actor, reason, correlation_id)
         VALUES ($1, $2, NULL, 'PROPOSED', $3, $4, $5)`,
        [ctx.organisationId, inserted.id, actor, proposal.rationale, correlationId],
      );

      const events: NewDomainEvent[] = [
        {
          type: 'ActionProposed',
          organisationId: ctx.organisationId,
          subjectType: 'Action',
          subjectId: inserted.id,
          payload: {
            actionType: proposal.actionType,
            riskClass: capability.riskClass,
            findingId: proposal.findingId ?? null,
            rationale: proposal.rationale,
          },
          correlationId,
          actor,
        },
      ];

      let action = await transition(inserted.id, 'PROPOSED', 'POLICY_EVALUATED', decision.reason);
      events.push({
        type: 'ActionPolicyEvaluated',
        organisationId: ctx.organisationId,
        subjectType: 'Action',
        subjectId: action.id,
        payload: {
          outcome: decision.outcome,
          matchedRuleId: decision.matchedRuleId,
          autonomyLevel: decision.effectiveAutonomyLevel,
          policyHash: decision.policyHash,
        },
        correlationId,
        actor,
      });

      if (decision.outcome === 'DENY') {
        action = await transition(action.id, 'POLICY_EVALUATED', 'REJECTED', decision.reason);
        events.push({
          type: 'ActionRejected',
          organisationId: ctx.organisationId,
          subjectType: 'Action',
          subjectId: action.id,
          payload: { reason: decision.reason, matchedRuleId: decision.matchedRuleId },
          correlationId,
          actor,
        });
      } else if (decision.outcome === 'REQUIRE_APPROVAL') {
        const approval = await ctx.oneOrFail<{ id: string }>(
          `INSERT INTO approvals (organisation_id, action_id, required_approvals, expires_at)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [ctx.organisationId, action.id, decision.requiredApprovals, expiresAt],
          'Approval',
        );
        action = await transition(
          action.id,
          'POLICY_EVALUATED',
          'AWAITING_APPROVAL',
          `Requires ${decision.requiredApprovals} approval(s)`,
          { approval_id: approval.id },
        );
        events.push({
          type: 'ActionApprovalRequested',
          organisationId: ctx.organisationId,
          subjectType: 'Action',
          subjectId: action.id,
          payload: {
            approvalId: approval.id,
            requiredApprovals: decision.requiredApprovals,
            expiresAt,
            actionType: proposal.actionType,
            rationale: proposal.rationale,
          },
          correlationId,
          actor,
        });
      } else {
        action = await transition(
          action.id,
          'POLICY_EVALUATED',
          'AUTHORISED',
          decision.reason,
          { authorised_at: now },
        );
      }

      for (const event of events) await publish(ctx, event, now);
      return { action, decision, events };
    },

    async decide(actionId, decision, note, approverUserId): Promise<ApproveResult> {
      const now = clock.nowIso();
      const action = await service.requireById(actionId);
      if (action.state !== 'AWAITING_APPROVAL') {
        throw new AdericelError('PRECONDITION_FAILED', `Action is ${action.state}, not awaiting approval`);
      }
      if (!action.approvalId) {
        throw new AdericelError('INTERNAL_ERROR', 'Action is awaiting approval but has no approval record');
      }

      // Four-eyes. A person who proposed a change may not also approve it, and
      // the database enforces one decision per approver so a single person
      // cannot satisfy a two-approver requirement.
      const proposerRow = await ctx.one<{ proposed_by_user_id: string | null }>(
        `SELECT proposed_by_user_id FROM actions WHERE id = $1 AND organisation_id = $2`,
        [actionId, ctx.organisationId],
      );
      if (proposerRow?.proposed_by_user_id === approverUserId) {
        throw new AdericelError('FORBIDDEN', 'The proposer of an action may not approve it', {
          safeDetails: { actionId },
        });
      }

      const approval = await ctx.oneOrFail<{ id: string; required_approvals: number; expires_at: Date }>(
        `SELECT id, required_approvals, expires_at FROM approvals
         WHERE id = $1 AND organisation_id = $2 AND decision IS NULL`,
        [action.approvalId, ctx.organisationId],
        'Approval',
      );
      if (approval.expires_at.getTime() <= Date.parse(now)) {
        throw new AdericelError('PRECONDITION_FAILED', 'The approval window has expired');
      }

      await ctx.query(
        `INSERT INTO approval_decisions
           (organisation_id, approval_id, approver_user_id, decision, note, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.organisationId, approval.id, approverUserId, decision, note ?? null, now],
      );

      if (decision === 'REJECTED') {
        await ctx.query(
          `UPDATE approvals SET decision = 'REJECTED', decided_at = $2::timestamptz WHERE id = $1`,
          [approval.id, now],
        );
        const rejected = await transition(
          actionId,
          'AWAITING_APPROVAL',
          'REJECTED',
          note ?? 'Rejected by approver',
        );
        await publish(
          ctx,
          {
            type: 'ActionRejected',
            organisationId: ctx.organisationId,
            subjectType: 'Action',
            subjectId: actionId,
            payload: { approverUserId, note: note ?? null },
            correlationId,
            actor,
          },
          now,
        );
        return {
          action: rejected,
          approvalsRecorded: 0,
          approvalsRequired: approval.required_approvals,
          fullyApproved: false,
        };
      }

      const countRow = await ctx.oneOrFail<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_decisions
         WHERE approval_id = $1 AND decision = 'APPROVED'`,
        [approval.id],
        'Approval decisions',
      );
      const recorded = Number(countRow.count);

      if (recorded < approval.required_approvals) {
        return {
          action,
          approvalsRecorded: recorded,
          approvalsRequired: approval.required_approvals,
          fullyApproved: false,
        };
      }

      await ctx.query(
        `UPDATE approvals SET decision = 'APPROVED', decided_at = $2::timestamptz WHERE id = $1`,
        [approval.id, now],
      );
      const approved = await transition(
        actionId,
        'AWAITING_APPROVAL',
        'APPROVED',
        `Approved by ${recorded} approver(s)`,
      );
      const authorised = await transition(approved.id, 'APPROVED', 'AUTHORISED', 'Approval satisfied', {
        authorised_at: now,
      });

      await publish(
        ctx,
        {
          type: 'ActionApproved',
          organisationId: ctx.organisationId,
          subjectType: 'Action',
          subjectId: actionId,
          payload: { approvals: recorded, actionType: action.actionType },
          correlationId,
          actor,
        },
        now,
      );

      return {
        action: authorised,
        approvalsRecorded: recorded,
        approvalsRequired: approval.required_approvals,
        fullyApproved: true,
      };
    },

    async execute(actionId): Promise<ExecuteResult> {
      const now = clock.nowIso();
      const action = await service.requireById(actionId);

      // Reconciliation before dispatch. If a prior attempt reached the external
      // system, we must not repeat the side effect — we adopt its outcome
      // instead. This is the difference between at-least-once and exactly-once.
      const priorAttempt = await ctx.one<{
        id: string;
        status: string;
        external_operation_ref: string | null;
        detail: string | null;
      }>(
        `SELECT id, status, external_operation_ref, error_detail AS detail
         FROM action_executions
         WHERE organisation_id = $1 AND idempotency_key = $2
         ORDER BY attempt DESC LIMIT 1`,
        [ctx.organisationId, action.idempotencyKey],
      );

      if (priorAttempt && priorAttempt.status === 'SUCCEEDED') {
        return {
          action,
          execution: {
            status: 'SUCCEEDED',
            externalOperationRef: priorAttempt.external_operation_ref,
            detail: 'Adopted the outcome of a previous successful attempt (idempotent replay).',
          },
          alreadyExecuted: true,
        };
      }
      if (priorAttempt && priorAttempt.status === 'UNKNOWN_OUTCOME') {
        // Retrying here could duplicate a side effect we cannot see. The action
        // stays UNVERIFIED and a human or a verification pass resolves it.
        throw new AdericelError(
          'CONFLICT',
          'A previous execution attempt had an unknown outcome. Reconcile it before retrying.',
          { safeDetails: { actionId, executionId: priorAttempt.id } },
        );
      }

      if (action.state !== 'AUTHORISED') {
        throw new AdericelError('PRECONDITION_FAILED', `Action is ${action.state}, not authorised`, {
          safeDetails: { actionId, state: action.state },
        });
      }
      if (action.expiresAt && Date.parse(action.expiresAt) <= Date.parse(now)) {
        await transition(actionId, 'AUTHORISED', 'CANCELLED', 'Authorisation expired before execution');
        throw new AdericelError('PRECONDITION_FAILED', 'Authorisation expired before execution');
      }

      const executing = await transition(actionId, 'AUTHORISED', 'EXECUTING', 'Dispatching', {
        attempt_count: action.attemptCount + 1,
      });

      const attempt = action.attemptCount + 1;
      const executionRow = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO action_executions
           (organisation_id, action_id, attempt, idempotency_key, status, request_digest, correlation_id)
         VALUES ($1, $2, $3, $4, 'DISPATCHED', $5, $6)
         RETURNING id`,
        [
          ctx.organisationId,
          actionId,
          attempt,
          action.idempotencyKey,
          contentHash({ actionType: action.actionType, parameters: action.parameters }),
          correlationId,
        ],
        'Action execution',
      );

      const capability = connectors.capabilityFor(action.actionType);
      if (!capability) {
        await ctx.query(
          `UPDATE action_executions SET status = 'FAILED', error_code = 'NO_CAPABILITY',
             error_detail = 'No connector provides this capability', finished_at = now()
           WHERE id = $1`,
          [executionRow.id],
        );
        const failed = await transition(executing.id, 'EXECUTING', 'FAILED', 'No connector capability');
        return {
          action: failed,
          execution: {
            status: 'FAILED',
            externalOperationRef: null,
            detail: 'No connector provides this capability',
            retryable: false,
          },
          alreadyExecuted: false,
        };
      }

      const runtime = await loadIntegrationRuntime(ctx, action.integrationId, deps.unsealCredentials);
      let result: ExecutionResult;
      try {
        const connector = connectors.get(runtime.connectorKey);
        if (!connector.execute) {
          throw new AdericelError('NOT_IMPLEMENTED', `Connector ${connector.key} cannot execute actions`);
        }
        result = await connector.execute(
          connector.configSchema.parse(runtime.config),
          connector.credentialSchema.parse(runtime.credentials),
          {
            actionType: action.actionType,
            targetExternalId: action.targetExternalId,
            parameters: action.parameters,
            idempotencyKey: action.idempotencyKey,
            correlationId,
          },
          {
            organisationId: ctx.organisationId,
            integrationId: runtime.integrationId,
            logger: deps.logger,
            correlationId,
            nowIso: now,
            cursor: null,
          },
        );
      } catch (error) {
        // A thrown error means we do not know whether the external system acted.
        // UNKNOWN_OUTCOME is the honest record, and it blocks blind retries.
        result = {
          status: 'UNKNOWN_OUTCOME',
          externalOperationRef: null,
          detail: (error as Error).message,
          errorCode: 'DISPATCH_ERROR',
          retryable: false,
        };
      }

      await ctx.query(
        `UPDATE action_executions
         SET status = $2, external_operation_ref = $3, error_code = $4, error_detail = $5,
             finished_at = now()
         WHERE id = $1`,
        [
          executionRow.id,
          result.status,
          result.externalOperationRef,
          result.errorCode ?? null,
          result.detail.slice(0, 2000),
        ],
      );

      let finalAction: ActionRecord;
      if (result.status === 'SUCCEEDED') {
        const executed = await transition(executing.id, 'EXECUTING', 'EXECUTED', result.detail, {
          executed_at: now,
          external_operation_ref: result.externalOperationRef,
        });
        finalAction = await transition(executed.id, 'EXECUTED', 'VERIFYING', 'Awaiting verification');
        await publish(
          ctx,
          {
            type: 'ActionExecuted',
            organisationId: ctx.organisationId,
            subjectType: 'Action',
            subjectId: actionId,
            payload: {
              actionType: action.actionType,
              externalOperationRef: result.externalOperationRef,
              verificationMethod: capability.verification.method,
              verificationPredicate: capability.verification.predicate,
              targetExternalId: action.targetExternalId,
            },
            correlationId,
            actor,
          },
          now,
        );
        await publish(
          ctx,
          {
            type: 'VerificationRequested',
            organisationId: ctx.organisationId,
            subjectType: 'Action',
            subjectId: actionId,
            payload: {
              method: capability.verification.method,
              predicate: capability.verification.predicate,
              expectedValue: capability.verification.expectedValue,
              targetNodeId: action.targetNodeId,
              integrationId: runtime.integrationId,
            },
            correlationId,
            actor,
          },
          now,
        );
      } else {
        const to: ActionState = result.status === 'UNKNOWN_OUTCOME' ? 'ROLLBACK_REQUIRED' : 'FAILED';
        finalAction = await transition(executing.id, 'EXECUTING', to, result.detail, {
          last_error: result.detail.slice(0, 2000),
        });
        await publish(
          ctx,
          {
            type: 'ActionFailed',
            organisationId: ctx.organisationId,
            subjectType: 'Action',
            subjectId: actionId,
            payload: { status: result.status, detail: result.detail, errorCode: result.errorCode ?? null },
            correlationId,
            actor,
          },
          now,
        );
      }

      return { action: finalAction, execution: result, alreadyExecuted: false };
    },

    async verify(actionId, observedValue): Promise<VerifyResult> {
      const now = clock.nowIso();
      const action = await service.requireById(actionId);
      if (action.state !== 'VERIFYING') {
        throw new AdericelError('PRECONDITION_FAILED', `Action is ${action.state}, not verifying`);
      }
      const capability = connectors.capabilityFor(action.actionType);
      if (!capability) {
        throw new AdericelError('INTERNAL_ERROR', 'Capability disappeared between execution and verification');
      }

      const expected = capability.verification.expectedValue;
      const outcome: VerificationOutcome =
        observedValue === undefined || observedValue === null
          ? 'INCONCLUSIVE'
          : JSON.stringify(observedValue) === JSON.stringify(expected)
            ? 'CONFIRMED'
            : 'REFUTED';

      const detail =
        outcome === 'CONFIRMED'
          ? `Re-observation of ${capability.verification.predicate} returned the expected value.`
          : outcome === 'REFUTED'
            ? `Re-observation of ${capability.verification.predicate} returned ${JSON.stringify(observedValue)}, expected ${JSON.stringify(expected)}. The action did not achieve the intended state.`
            : `Re-observation of ${capability.verification.predicate} produced no value. The outcome cannot be confirmed.`;

      const verification = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO verifications
           (organisation_id, node_id, action_id, method, outcome, detail, attempt, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          ctx.organisationId,
          action.nodeId,
          actionId,
          capability.verification.method,
          outcome,
          detail,
          action.attemptCount,
          now,
        ],
        'Verification',
      );

      const nextState = actionStateForVerification(outcome);
      const verified = await transition(actionId, 'VERIFYING', nextState, detail, {
        verification_id: verification.id,
        verified_at: now,
      });

      await publish(
        ctx,
        {
          type: 'VerificationCompleted',
          organisationId: ctx.organisationId,
          subjectType: 'Action',
          subjectId: actionId,
          payload: {
            verificationId: verification.id,
            outcome,
            detail,
            actionState: nextState,
            predicate: capability.verification.predicate,
          },
          correlationId,
          actor,
        },
        now,
      );

      return { action: verified, outcome, verificationId: verification.id, detail };
    },

    async cancel(actionId, reason): Promise<ActionRecord> {
      const action = await service.requireById(actionId);
      if (isTerminalActionState(action.state)) {
        throw new AdericelError('PRECONDITION_FAILED', `Action is already ${action.state}`);
      }
      return transition(actionId, action.state, 'CANCELLED', reason);
    },

    async expireOverdueApprovals(): Promise<readonly string[]> {
      const now = clock.nowIso();
      const rows = await ctx.many<{ id: string }>(
        `SELECT id FROM actions
         WHERE organisation_id = $1 AND state = 'AWAITING_APPROVAL' AND expires_at <= $2::timestamptz`,
        [ctx.organisationId, now],
      );
      const expired: string[] = [];
      for (const row of rows) {
        await transition(row.id, 'AWAITING_APPROVAL', 'TIMED_OUT', 'Approval window elapsed');
        expired.push(row.id);
      }
      return expired;
    },
  };

  return service;
}

interface IntegrationRuntime {
  readonly integrationId: string;
  readonly connectorKey: string;
  readonly config: Record<string, unknown>;
  readonly credentials: Record<string, unknown>;
}

/**
 * Decrypts an integration's sealed credentials.
 *
 * Supplied by the application layer, which owns the key material. Passing it in
 * rather than reaching for a module-level singleton keeps the action service
 * free of ambient key state and makes credential access explicit at every call
 * site that needs it.
 */
export type CredentialUnsealer = (sealed: string, integrationId: string) => Record<string, unknown>;

/** Unsealer for contexts that never touch credentials, such as unit tests. */
export const noCredentials: CredentialUnsealer = () => ({});

async function loadIntegrationRuntime(
  ctx: TenantContext,
  integrationId: string | null,
  unsealCredentials: CredentialUnsealer,
): Promise<IntegrationRuntime> {
  if (!integrationId) {
    throw new AdericelError('PRECONDITION_FAILED', 'Action has no integration to execute through');
  }
  const row = await ctx.oneOrFail<{
    id: string;
    connector_key: string;
    configuration: Record<string, unknown>;
    sealed_credentials: string | null;
    status: string;
  }>(
    `SELECT id, connector_key, configuration, sealed_credentials, status
     FROM integrations WHERE id = $1 AND organisation_id = $2`,
    [integrationId, ctx.organisationId],
    'Integration',
  );
  if (row.status === 'DISABLED') {
    throw new AdericelError('PRECONDITION_FAILED', 'Integration is disabled');
  }
  return {
    integrationId: row.id,
    connectorKey: row.connector_key,
    config: row.configuration,
    credentials: row.sealed_credentials ? unsealCredentials(row.sealed_credentials, row.id) : {},
  };
}
