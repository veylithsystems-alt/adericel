import {
  COMMERCIAL_CAPABILITY,
  assuranceImpactOf,
  transitionCommercial,
  type CommercialState,
} from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Moving an account's commercial position.
 *
 * The decision logic is pure and lives in `packages/domain/src/commercial.ts`.
 * This layer does the three things a pure decision cannot: establish that the
 * caller is entitled to make it, write the append-only record of why, and move
 * the status the rest of the system reads.
 *
 * It deliberately knows nothing about containment. A commercial state is not a
 * security state (§16), there is no function between them, and
 * `tests/security/commercial-separation.test.ts` asserts that none appears.
 */

export type DecidedByKind = 'PROVIDER' | 'OPERATOR' | 'SYSTEM';

export interface CommercialTransitionRequestInput {
  readonly subscriptionId: string;
  readonly to: CommercialState;
  readonly reason: string;
  readonly customerNotified: boolean;
  readonly decidedByKind: DecidedByKind;
  readonly decidedBy: string | null;
  readonly decidedByLabel: string;
  readonly correlationId: string | null;
}

export interface CommercialTransitionRecord {
  readonly id: string;
  readonly subscriptionId: string;
  readonly from: CommercialState;
  readonly to: CommercialState;
  readonly reason: string;
  readonly customerNotified: boolean;
  readonly occurredAt: string;
  /** What the customer will actually experience. Said on every response. */
  readonly customerImpact: string;
  /** Stated every time: a commercial move changes no assurance outcome. */
  readonly assuranceImpact: ReturnType<typeof assuranceImpactOf>;
}

/**
 * Events a provider webhook is allowed to cause.
 *
 * A webhook is a fact about a payment. Restriction and suspension are decisions
 * about a relationship, and suspension is the one that stops a customer's
 * assurance being maintained — so neither is reachable from a provider, at this
 * layer as well as in `statusForEvent`. Two places, because this is the
 * boundary where an automated system could otherwise quietly restrict a
 * customer nobody has spoken to.
 */
const PROVIDER_MAY_SET: readonly CommercialState[] = [
  'ACTIVE',
  'PAST_DUE',
  'TERMINATED',
  'UNKNOWN',
];

export async function moveCommercialState(
  app: AppContext,
  request: CommercialTransitionRequestInput,
): Promise<CommercialTransitionRecord> {
  if (request.decidedByKind === 'PROVIDER' && !PROVIDER_MAY_SET.includes(request.to)) {
    throw new AdericelError(
      'FORBIDDEN',
      `A billing provider cannot set ${request.to}. That is a decision about a relationship, ` +
        'and somebody has to make it.',
    );
  }

  if (request.decidedByKind === 'OPERATOR' && request.decidedBy === null) {
    throw new AdericelError(
      'VALIDATION_FAILED',
      'An operator decision must name the operator who made it.',
    );
  }

  const subscription = await app.db.withPlatform(async (ctx) =>
    ctx.one<{
      id: string;
      status: string;
      msp_id: string | null;
      organisation_id: string | null;
    }>(`SELECT id, status, msp_id, organisation_id FROM subscriptions WHERE id = $1`, [
      request.subscriptionId,
    ]),
  );
  if (!subscription) throw new AdericelError('NOT_FOUND', 'No such subscription');

  const from = subscription.status as CommercialState;
  const decision = transitionCommercial({
    from,
    to: request.to,
    reason: request.reason,
    customerNotified: request.customerNotified,
  });
  if (!decision.permitted) {
    // PRECONDITION_FAILED rather than VALIDATION_FAILED: the request is
    // well-formed, the account is simply not somewhere that move is legal from.
    throw new AdericelError('PRECONDITION_FAILED', decision.reason);
  }

  const now = app.clock.nowIso();
  const record = await app.db.withPlatform(async (ctx) => {
    /**
     * Guarded by `status = $3` rather than read-then-write.
     *
     * Two operators acting on the same account during a dunning conversation is
     * not a hypothetical, and the loser of that race must not have their
     * transition recorded against a state the account had already left.
     */
    const updated = await ctx.one<{ id: string }>(
      `UPDATE subscriptions SET status = $2, updated_at = now()
        WHERE id = $1 AND status = $3
        RETURNING id`,
      [request.subscriptionId, request.to, from],
    );
    if (!updated) {
      throw new AdericelError(
        'CONFLICT',
        'The account moved while this was being decided. Read it again and decide from where ' +
          'it actually is.',
      );
    }

    return ctx.oneOrFail<{ id: string; occurred_at: Date }>(
      `INSERT INTO commercial_transitions
         (subscription_id, msp_id, organisation_id, from_state, to_state, reason,
          customer_notified, decided_by_kind, decided_by, decided_by_label, occurred_at,
          correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12)
       RETURNING id, occurred_at`,
      [
        request.subscriptionId,
        subscription.msp_id,
        subscription.organisation_id,
        from,
        request.to,
        request.reason,
        request.customerNotified,
        request.decidedByKind,
        request.decidedBy,
        request.decidedByLabel,
        now,
        request.correlationId,
      ],
      'Commercial transition',
    );
  });

  return {
    id: record.id,
    subscriptionId: request.subscriptionId,
    from,
    to: request.to,
    reason: request.reason,
    customerNotified: request.customerNotified,
    occurredAt: record.occurred_at.toISOString(),
    customerImpact: decision.customerImpact,
    assuranceImpact: assuranceImpactOf(request.to),
  };
}

/**
 * The commercial position of one account, and what it means.
 *
 * Returned with the capability table rather than the bare status, because
 * "COMMERCIAL_RESTRICTION" tells an operator on a call with a customer nothing
 * at all, and "no new chargeable commitments; everything already running
 * continues" tells them what to say.
 */
export async function commercialPosition(
  app: AppContext,
  subscriptionId: string,
): Promise<{
  readonly state: CommercialState;
  readonly capability: (typeof COMMERCIAL_CAPABILITY)[CommercialState];
  readonly assuranceImpact: ReturnType<typeof assuranceImpactOf>;
  readonly history: readonly {
    readonly from: CommercialState;
    readonly to: CommercialState;
    readonly reason: string;
    readonly decidedByLabel: string;
    readonly occurredAt: string;
  }[];
}> {
  return app.db.withPlatform(async (ctx) => {
    const subscription = await ctx.one<{ status: string }>(
      `SELECT status FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    if (!subscription) throw new AdericelError('NOT_FOUND', 'No such subscription');

    const rows = await ctx.many<{
      from_state: string;
      to_state: string;
      reason: string;
      decided_by_label: string;
      occurred_at: Date;
    }>(
      `SELECT from_state, to_state, reason, decided_by_label, occurred_at
         FROM commercial_transitions WHERE subscription_id = $1
        ORDER BY occurred_at DESC LIMIT 50`,
      [subscriptionId],
    );

    const state = subscription.status as CommercialState;
    return {
      state,
      capability: COMMERCIAL_CAPABILITY[state],
      assuranceImpact: assuranceImpactOf(state),
      history: rows.map((row) => ({
        from: row.from_state as CommercialState,
        to: row.to_state as CommercialState,
        reason: row.reason,
        decidedByLabel: row.decided_by_label,
        occurredAt: row.occurred_at.toISOString(),
      })),
    };
  });
}
