import {
  compileAutonomyPolicy,
  evaluateAutonomy,
  mayProceedUnattended,
  type AutonomyDecision,
  type AutonomyQuestion,
  type CompiledAutonomyPolicy,
  type OperationRiskClass,
} from '@adericel/autonomy';
import type { PlatformContext } from '@adericel/graph';
import { AdericelError, contentHash, type Clock, type Logger } from '@adericel/shared';
import {
  createExceptionQueue,
  type ExceptionCategory,
  type OperationalException,
} from './exceptions.js';
import { createBusinessEventLedger, type BusinessEventType } from './events.js';

/**
 * The gate.
 *
 * Every autonomous operation the company performs goes through here. It is the
 * only place that decides whether something may happen unattended, and the only
 * place that records that it did.
 *
 * Putting it in one function is the point. An authority check scattered across
 * twenty workflows is twenty places to forget it, and the failure mode of
 * forgetting is that the operation happens anyway. Here, an operation that does
 * not call `operate` simply does not get its effect run — the effect is a
 * callback this function owns.
 *
 * WHAT HAPPENS WHEN THE ANSWER IS NOT YES
 *
 * Nothing is silently dropped. Every outcome other than PERMIT raises an
 * exception, so a person can see what the company wanted to do and could not.
 * A system that quietly declines is indistinguishable from one that is broken.
 */

export interface OperationRequest<T> {
  readonly processKey: string;
  readonly operation: string;
  readonly riskClass: OperationRiskClass;
  readonly eventType: BusinessEventType;
  readonly subjectKind: string;
  readonly subjectId: string;
  /** Facts the caller has established. An absent fact is not a false one. */
  readonly facts?: Readonly<Record<string, boolean>>;
  readonly payload?: Record<string, unknown>;
  readonly correlationId?: string | null;
  /** Present for operations with an external effect, so a retry is a no-op. */
  readonly idempotencyKey?: string | null;
  /** Plain description of what is about to happen, used in the exception. */
  readonly intent: string;
  readonly organisationId?: string | null;
  /** Whether the effect can be confirmed afterwards. */
  readonly verifiable?: boolean;
  /** The effect. Runs only on PERMIT. */
  readonly effect: () => Promise<T>;
}

/**
 * The identity of one operation, as a content hash.
 *
 * Binds a decision to what it authorised. Without it a decision permitting
 * "send template A to prospect P" is indistinguishable in the record from one
 * permitting "send template B to prospect P", and an audit asking what exactly
 * was authorised can only be answered from whatever code ran next.
 *
 * The payload is included deliberately — it is where the difference between two
 * otherwise identical operations lives. Canonical hashing means key order does
 * not change the digest, so a caller that builds the payload differently on a
 * retry still matches.
 */
export function operationDigest(request: {
  readonly processKey: string;
  readonly operation: string;
  readonly riskClass: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly payload?: Record<string, unknown>;
}): string {
  return contentHash({
    processKey: request.processKey,
    operation: request.operation,
    riskClass: request.riskClass,
    subjectKind: request.subjectKind,
    subjectId: request.subjectId,
    payload: request.payload ?? {},
  });
}

export interface OperationOutcome<T> {
  readonly permitted: boolean;
  readonly decision: AutonomyDecision;
  /** Present only when the effect ran. */
  readonly result: T | null;
  /** Present when the operation was stopped and a person must look at it. */
  readonly exception: OperationalException | null;
  /** True when the idempotency key matched an event already recorded. */
  readonly alreadyPerformed: boolean;
}

/** Which kind of exception each refusal is, so the queue can be triaged. */
const CATEGORY_BY_OUTCOME: Record<string, ExceptionCategory> = {
  REQUIRE_APPROVAL: 'AUTHORITY_REQUIRED',
  ESCALATE: 'AUTHORITY_REQUIRED',
  DENY: 'POLICY_DENIED',
  UNKNOWN: 'AMBIGUOUS',
};

const SEVERITY_BY_OUTCOME: Record<string, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
  REQUIRE_APPROVAL: 'MEDIUM',
  // Escalation exists precisely because approval is not the right question.
  ESCALATE: 'HIGH',
  // A refusal is working as designed, and is still worth a person's attention:
  // repeated denials mean either an automation trying the wrong thing or a
  // policy that no longer matches how the company operates.
  DENY: 'LOW',
  // Not knowing whether we are allowed to act is worse than being told no.
  UNKNOWN: 'HIGH',
};

export interface OperatorDeps {
  readonly ctx: PlatformContext;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policy: CompiledAutonomyPolicy;
  /** Identifies the automation, for the ledger. */
  readonly actor: string;
}

export interface Operator {
  /** Run an operation if, and only if, policy permits it unattended. */
  operate<T>(request: OperationRequest<T>): Promise<OperationOutcome<T>>;
  /** Ask without doing. Used by the control room to show what would happen. */
  wouldPermit(
    request: Pick<OperationRequest<unknown>, 'processKey' | 'operation' | 'riskClass' | 'facts'>,
  ): Promise<AutonomyDecision>;
}

export function createOperator(deps: OperatorDeps): Operator {
  const { ctx, clock, logger, policy, actor } = deps;
  const events = createBusinessEventLedger(ctx, clock);
  const exceptions = createExceptionQueue(ctx, clock);

  /** The registered maturity, or null when the process is not registered. */
  async function processMaturity(processKey: string): Promise<number | null> {
    const row = await ctx.one<{ current_maturity: number; enabled: boolean }>(
      `SELECT current_maturity, enabled FROM veylith.company_processes WHERE key = $1`,
      [processKey],
    );
    if (!row) return null;
    // A disabled process is not a zero-maturity one. Someone turned it off, and
    // the honest answer to "may this run?" is that nobody has said it may.
    if (!row.enabled) return null;
    return row.current_maturity;
  }

  /** Operations of this kind already performed in the trailing hour. */
  async function recentOperations(processKey: string, operation: string): Promise<number> {
    const row = await ctx.one<{ count: string }>(
      `SELECT count(*)::text AS count FROM veylith.business_events
       WHERE process_key = $1
         AND payload->>'operation' = $2
         AND occurred_at > $3::timestamptz - interval '1 hour'`,
      [processKey, operation, clock.nowIso()],
    );
    return Number(row?.count ?? 0);
  }

  async function decide(
    request: Pick<OperationRequest<unknown>, 'processKey' | 'operation' | 'riskClass' | 'facts'>,
  ): Promise<{ decision: AutonomyDecision; question: AutonomyQuestion }> {
    const question: AutonomyQuestion = {
      processKey: request.processKey,
      operation: request.operation,
      riskClass: request.riskClass,
      processMaturity: await processMaturity(request.processKey),
      recentOperations: await recentOperations(request.processKey, request.operation),
      utcHour: new Date(clock.nowIso()).getUTCHours(),
      facts: request.facts ?? {},
    };
    return { decision: evaluateAutonomy(policy, question), question };
  }

  async function recordDecision(
    request: Pick<
      OperationRequest<unknown>,
      'processKey' | 'operation' | 'subjectKind' | 'subjectId' | 'correlationId'
    >,
    decision: AutonomyDecision,
    question: AutonomyQuestion,
    digest: string,
  ): Promise<string> {
    // Recorded whatever the outcome. A system that logs only what it did cannot
    // answer "what did it decline to do, and why", which is the first question
    // both an auditor and an operator ask.
    const row = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO veylith.policy_decisions
         (process_key, operation, outcome, reason, matched_rule_id, policy_key, policy_hash,
          question, evaluation, subject_kind, subject_id, correlation_id, decided_at,
          operation_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        request.processKey,
        request.operation,
        decision.outcome,
        decision.reason,
        decision.matchedRuleId,
        decision.policyKey,
        decision.policyHash,
        JSON.stringify(question),
        JSON.stringify(decision.evaluation),
        request.subjectKind,
        request.subjectId,
        request.correlationId ?? null,
        clock.nowIso(),
        digest,
      ],
      'Policy decision',
    );
    return row.id;
  }

  return {
    async wouldPermit(request): Promise<AutonomyDecision> {
      const { decision } = await decide(request);
      return decision;
    },

    async operate<T>(request: OperationRequest<T>): Promise<OperationOutcome<T>> {
      const { decision, question } = await decide(request);
      const digest = operationDigest(request);
      const policyDecisionId = await recordDecision(request, decision, question, digest);

      if (!mayProceedUnattended(decision.outcome)) {
        const exception = await exceptions.raise(
          {
            processKey: request.processKey,
            category: CATEGORY_BY_OUTCOME[decision.outcome] ?? 'AMBIGUOUS',
            severity: SEVERITY_BY_OUTCOME[decision.outcome] ?? 'MEDIUM',
            title: request.intent,
            attempted: `${request.operation} on ${request.subjectKind} ${request.subjectId}`,
            failureReason: decision.reason,
            recommendedAction:
              decision.outcome === 'REQUIRE_APPROVAL'
                ? 'Review the prepared operation and authorise it, or reject it.'
                : decision.outcome === 'DENY'
                  ? 'No action needed unless the policy is wrong. Repeated denials mean either ' +
                    'an automation attempting the wrong thing or a policy that no longer ' +
                    'matches how the company operates.'
                  : 'Decide what should happen, then either extend the policy to cover this ' +
                    'case or handle it by hand.',
            requiredAuthority: decision.requiredAuthority,
            evidence: {
              operation: request.operation,
              riskClass: request.riskClass,
              outcome: decision.outcome,
              policyKey: decision.policyKey,
              policyHash: decision.policyHash,
              matchedRuleId: decision.matchedRuleId,
              evaluation: decision.evaluation,
              payload: request.payload ?? {},
            },
            organisationId: request.organisationId ?? null,
            subjectKind: request.subjectKind,
            subjectId: request.subjectId,
            correlationId: request.correlationId ?? null,
            escalationPath: decision.requiredAuthority,
          },
          actor,
        );

        await events.record(
          {
            eventType: 'AUTONOMOUS_ACTION_REFUSED',
            processKey: request.processKey,
            subjectKind: request.subjectKind,
            subjectId: request.subjectId,
            payload: {
              operation: request.operation,
              outcome: decision.outcome,
              exceptionId: exception.id,
            },
            actorKind: 'SYSTEM',
            actor,
            humanInLoop: false,
            authority: decision.policyKey,
            reason: decision.reason,
            correlationId: request.correlationId ?? null,
            result: 'RECORDED',
          },
          { policyDecisionId, operationDigest: digest },
        );

        logger.info(
          { operation: request.operation, outcome: decision.outcome, exceptionId: exception.id },
          'operation not permitted unattended',
        );
        return { permitted: false, decision, result: null, exception, alreadyPerformed: false };
      }

      // Permitted. Claim the idempotency key BEFORE running the effect, so a
      // concurrent retry cannot run it twice while the first is still in
      // flight. Recording afterwards would leave a window in which two workers
      // both see no prior event.
      const claim = await events.record(
        {
          eventType: request.eventType,
          processKey: request.processKey,
          subjectKind: request.subjectKind,
          subjectId: request.subjectId,
          payload: { operation: request.operation, ...(request.payload ?? {}) },
          actorKind: 'SYSTEM',
          actor,
          humanInLoop: false,
          authority: decision.policyKey,
          reason: decision.reason,
          correlationId: request.correlationId ?? null,
          idempotencyKey: request.idempotencyKey ?? null,
          result: 'RECORDED',
          verification: request.verifiable === true ? 'PENDING' : 'NOT_REQUIRED',
        },
        { policyDecisionId, operationDigest: digest },
      );

      if (!claim.recorded) {
        // The key was already present: this operation has run before. Not an
        // error, and emphatically not a reason to run it again.
        logger.info(
          { operation: request.operation, idempotencyKey: request.idempotencyKey },
          'operation already performed; not repeating the effect',
        );
        return { permitted: true, decision, result: null, exception: null, alreadyPerformed: true };
      }

      try {
        const result = await request.effect();
        await ctx.query(`UPDATE veylith.business_events SET result = 'SUCCEEDED' WHERE id = $1`, [
          claim.id,
        ]);
        return { permitted: true, decision, result, exception: null, alreadyPerformed: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // UNKNOWN_OUTCOME, not FAILED. The effect may or may not have happened —
        // a timeout after a request was accepted looks exactly like one that
        // never arrived, and calling that "failed" would invite a retry that
        // duplicates a real effect.
        await ctx.query(
          `UPDATE veylith.business_events SET result = 'UNKNOWN_OUTCOME' WHERE id = $1`,
          [claim.id],
        );
        const exception = await exceptions.raise(
          {
            processKey: request.processKey,
            category: 'AUTOMATION_FAILED',
            severity: 'HIGH',
            title: `${request.intent} did not complete`,
            attempted: `${request.operation} on ${request.subjectKind} ${request.subjectId}`,
            failureReason: message.slice(0, 2000),
            recommendedAction:
              'Establish whether the effect happened before retrying. The operation was ' +
              'permitted and dispatched, so a failure here does not mean nothing changed.',
            requiredAuthority: 'The owner of this process',
            evidence: {
              operation: request.operation,
              eventId: claim.id,
              error: message.slice(0, 1000),
            },
            organisationId: request.organisationId ?? null,
            subjectKind: request.subjectKind,
            subjectId: request.subjectId,
            correlationId: request.correlationId ?? null,
          },
          actor,
        );
        logger.error(
          { operation: request.operation, exceptionId: exception.id },
          'permitted operation failed',
        );
        return { permitted: true, decision, result: null, exception, alreadyPerformed: false };
      }
    },
  };
}

/** Load the active policy, or fail loudly. */
export async function loadActivePolicy(
  ctx: PlatformContext,
  key: string,
): Promise<CompiledAutonomyPolicy> {
  const row = await ctx.one<{ definition: unknown }>(
    `SELECT definition FROM veylith.autonomy_policies WHERE key = $1 AND active`,
    [key],
  );
  if (!row) {
    // Not a case for a permissive default. With no policy loaded the company
    // has no authority model, and continuing would mean operating under
    // whatever the code happened to do.
    throw new AdericelError(
      'PRECONDITION_FAILED',
      `No active autonomy policy for ${key}. The company has no authority model loaded, so ` +
        'nothing may run unattended.',
    );
  }
  return compileAutonomyPolicy(row.definition);
}

/**
 * Ensure the company has an authority model loaded.
 *
 * Idempotent, and deliberately conservative: it installs the built-in policy
 * only when no version of that key exists at all. Once a policy is in the
 * database it is the company's, possibly edited, possibly deliberately
 * narrowed — and a deployment silently overwriting it with the shipped default
 * would be a privilege escalation performed by an upgrade.
 */
export async function ensureAutonomyPolicy(
  ctx: PlatformContext,
  definition: Parameters<typeof compileAutonomyPolicy>[0],
  actor: string,
  clock: Clock,
): Promise<{ installed: boolean; hash: string }> {
  const compiled = compileAutonomyPolicy(definition);
  const existing = await ctx.one<{ id: string; policy_hash: string }>(
    `SELECT id, policy_hash FROM veylith.autonomy_policies WHERE key = $1
     ORDER BY version DESC LIMIT 1`,
    [compiled.key],
  );
  if (existing) return { installed: false, hash: existing.policy_hash };

  const now = clock.nowIso();
  await ctx.query(
    `INSERT INTO veylith.autonomy_policies
       (key, version, policy_hash, definition, active, created_by_actor, created_at, activated_at)
     VALUES ($1, 1, $2, $3::jsonb, true, $4, $5, $5)`,
    [compiled.key, compiled.hash, JSON.stringify(compiled), actor, now],
  );
  return { installed: true, hash: compiled.hash };
}

/**
 * Every event whose authorising decision does not match it.
 *
 * A binding nobody checks is a column, not a control. This is the check: it
 * walks the ledger and returns any event whose recorded decision authorised a
 * different operation — which, if the gate is the only path, should never
 * happen, and is therefore exactly the thing worth alarming on.
 *
 * Events predating the binding are excluded rather than reported. They are not
 * evidence of anything; nothing was recording a digest when they were written,
 * and reporting them would bury a real finding under history.
 */
export async function findUnboundEvents(
  ctx: PlatformContext,
  options: { readonly limit?: number } = {},
): Promise<
  readonly {
    readonly eventId: string;
    readonly eventType: string;
    readonly eventDigest: string;
    readonly decisionDigest: string;
    readonly operation: string;
    readonly occurredAt: string;
  }[]
> {
  const rows = await ctx.many<{
    id: string;
    event_type: string;
    event_digest: string;
    decision_digest: string;
    operation: string;
    occurred_at: Date;
  }>(
    `SELECT e.id, e.event_type, e.operation_digest AS event_digest,
            d.operation_digest AS decision_digest, d.operation, e.occurred_at
     FROM veylith.business_events e
     JOIN veylith.policy_decisions d ON d.id = e.policy_decision_id
     WHERE e.operation_digest <> 'unbound:pre-0020'
       AND d.operation_digest <> 'unbound:pre-0020'
       AND e.operation_digest <> d.operation_digest
     ORDER BY e.occurred_at DESC
     LIMIT $1`,
    [options.limit ?? 100],
  );
  return rows.map((row) => ({
    eventId: row.id,
    eventType: row.event_type,
    eventDigest: row.event_digest,
    decisionDigest: row.decision_digest,
    operation: row.operation,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
