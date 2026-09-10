import type { PlatformContext } from '@adericel/graph';
import type { Clock } from '@adericel/shared';
import { z } from 'zod';

/**
 * The canonical business event ledger.
 *
 * Adericel's event log is assurance vocabulary about a tenant's estate. This is
 * commercial and operational vocabulary about the company. They are kept apart
 * because mixing them would put pipeline data into a customer's event stream,
 * and because they have different audiences, different retention and different
 * access.
 *
 * `actorKind` and `humanInLoop` are the fields that make autonomy measurable.
 * Without them, "what proportion of our operations happen without a person?" is
 * a guess, and a company optimising for autonomy that cannot measure it will
 * optimise for the appearance of it.
 */

export const BUSINESS_EVENT_TYPES = [
  // Market and pipeline
  'LEAD_CREATED',
  'LEAD_ENRICHED',
  'LEAD_QUALIFIED',
  'LEAD_DISQUALIFIED',
  'OUTREACH_PREPARED',
  'OUTREACH_SENT',
  'OUTREACH_RESPONSE',
  'OPPORTUNITY_CREATED',
  'OPPORTUNITY_STAGE_CHANGED',
  'PROPOSAL_GENERATED',
  'CONTRACT_PREPARED',
  'CONTRACT_SIGNED',
  // Customer lifecycle
  'CUSTOMER_CREATED',
  'ONBOARDING_STARTED',
  'ONBOARDING_STEP_COMPLETED',
  'INTEGRATION_CONNECTED',
  'CUSTOMER_OPERATIONAL',
  'CUSTOMER_HEALTH_CHANGED',
  'RENEWAL_APPROACHING',
  'CUSTOMER_OFFBOARDED',
  // Money
  'SUBSCRIPTION_CREATED',
  'INVOICE_ISSUED',
  'PAYMENT_RECEIVED',
  'PAYMENT_FAILED',
  // Operations
  'SUPPORT_EVENT',
  'SECURITY_EVENT',
  'PRODUCT_EVENT',
  'ENGINEERING_EVENT',
  'INCIDENT_OPENED',
  'INCIDENT_RESOLVED',
  // Authority
  'EXCEPTION_RAISED',
  'EXCEPTION_RESOLVED',
  'APPROVAL_REQUIRED',
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
  'AUTONOMOUS_ACTION_TAKEN',
  'AUTONOMOUS_ACTION_REFUSED',
] as const;
export type BusinessEventType = (typeof BUSINESS_EVENT_TYPES)[number];

export const ACTOR_KINDS = ['SYSTEM', 'HUMAN', 'AI', 'EXTERNAL'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const businessEventSchema = z.object({
  eventType: z.enum(BUSINESS_EVENT_TYPES),
  processKey: z.string().max(200).nullable().default(null),
  subjectKind: z.string().min(1).max(120),
  subjectId: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).default({}),
  actorKind: z.enum(ACTOR_KINDS),
  actor: z.string().min(1).max(200),
  /**
   * Whether a person made or confirmed this.
   *
   * An AI actor with `humanInLoop` true is a human decision the AI drafted; one
   * with it false is an autonomous decision. That distinction is the entire
   * autonomy metric, so it is required rather than defaulted — a default would
   * quietly decide which way the number goes.
   */
  humanInLoop: z.boolean(),
  policyDecisionId: z.string().uuid().nullable().default(null),
  authority: z.string().max(200).default(''),
  reason: z.string().max(2000).default(''),
  correlationId: z.string().uuid().nullable().default(null),
  /** Set for events representing an effect on the world, so a retry is a no-op. */
  idempotencyKey: z.string().max(200).nullable().default(null),
  result: z.enum(['RECORDED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME']).default('RECORDED'),
  verification: z
    .enum(['NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'REFUTED', 'INCONCLUSIVE'])
    .default('NOT_REQUIRED'),
});
export type BusinessEventInput = z.input<typeof businessEventSchema>;

export interface BusinessEventRecord {
  readonly id: string;
  readonly sequence: number;
  readonly eventType: BusinessEventType;
  readonly processKey: string | null;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  readonly actorKind: ActorKind;
  readonly actor: string;
  readonly humanInLoop: boolean;
  readonly authority: string;
  readonly reason: string;
  readonly result: string;
  readonly verification: string;
  readonly occurredAt: string;
  /** False when this event already existed and was recognised by its key. */
  readonly recorded: boolean;
}

export interface BusinessEventLedger {
  record(
    input: BusinessEventInput,
    options?: { policyDecisionId?: string | null; operationDigest?: string },
  ): Promise<BusinessEventRecord>;
  recent(options?: { limit?: number; eventTypes?: readonly BusinessEventType[] }): Promise<readonly BusinessEventRecord[]>;
  forSubject(subjectKind: string, subjectId: string): Promise<readonly BusinessEventRecord[]>;
}

interface EventRow {
  id: string;
  sequence: string;
  event_type: string;
  process_key: string | null;
  subject_kind: string;
  subject_id: string;
  payload: Record<string, unknown>;
  actor_kind: string;
  actor: string;
  human_in_loop: boolean;
  authority: string;
  reason: string;
  result: string;
  verification: string;
  occurred_at: Date;
}

const SELECT = `
  id, sequence, event_type, process_key, subject_kind, subject_id, payload,
  actor_kind, actor, human_in_loop, authority, reason, result, verification, occurred_at`;

function toRecord(row: EventRow, recorded: boolean): BusinessEventRecord {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    eventType: row.event_type as BusinessEventType,
    processKey: row.process_key,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    payload: row.payload,
    actorKind: row.actor_kind as ActorKind,
    actor: row.actor,
    humanInLoop: row.human_in_loop,
    authority: row.authority,
    reason: row.reason,
    result: row.result,
    verification: row.verification,
    occurredAt: row.occurred_at.toISOString(),
    recorded,
  };
}

export function createBusinessEventLedger(
  ctx: PlatformContext,
  clock: Clock,
): BusinessEventLedger {
  return {
    async record(rawInput, options = {}): Promise<BusinessEventRecord> {
      const input = businessEventSchema.parse(rawInput);
      const now = clock.nowIso();

      // An event carrying an idempotency key represents an effect on the world.
      // A redelivered webhook or a retried job must not produce a second one, so
      // the conflict returns the original rather than writing again — and says
      // so, because a caller that thinks it just sent an email when it did not
      // will go on to make worse decisions.
      if (input.idempotencyKey !== null) {
        const existing = await ctx.one<EventRow>(
          `SELECT ${SELECT} FROM veylith.business_events
           WHERE event_type = $1 AND idempotency_key = $2`,
          [input.eventType, input.idempotencyKey],
        );
        if (existing) return toRecord(existing, false);
      }

      const row = await ctx.oneOrFail<EventRow>(
        `INSERT INTO veylith.business_events
           (event_type, process_key, subject_kind, subject_id, payload, actor_kind, actor,
            human_in_loop, policy_decision_id, authority, reason, correlation_id,
            idempotency_key, result, verification, occurred_at, operation_digest)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${SELECT}`,
        [
          input.eventType,
          input.processKey,
          input.subjectKind,
          input.subjectId,
          JSON.stringify(input.payload),
          input.actorKind,
          input.actor,
          input.humanInLoop,
          options.policyDecisionId ?? input.policyDecisionId,
          input.authority,
          input.reason,
          input.correlationId,
          input.idempotencyKey,
          input.result,
          input.verification,
          now,
          options.operationDigest ?? 'unbound:pre-0020',
        ],
        'Business event',
      );
      return toRecord(row, true);
    },

    async recent(options = {}): Promise<readonly BusinessEventRecord[]> {
      const rows = await ctx.many<EventRow>(
        `SELECT ${SELECT} FROM veylith.business_events
         WHERE ($2::text[] IS NULL OR event_type = ANY($2::text[]))
         ORDER BY sequence DESC LIMIT $1`,
        [options.limit ?? 100, options.eventTypes ? [...options.eventTypes] : null],
      );
      return rows.map((row) => toRecord(row, true));
    },

    async forSubject(subjectKind, subjectId): Promise<readonly BusinessEventRecord[]> {
      const rows = await ctx.many<EventRow>(
        `SELECT ${SELECT} FROM veylith.business_events
         WHERE subject_kind = $1 AND subject_id = $2 ORDER BY sequence`,
        [subjectKind, subjectId],
      );
      return rows.map((row) => toRecord(row, true));
    },
  };
}
