import { randomUUID } from 'node:crypto';
import {
  EVENT_SCHEMA_VERSIONS,
  type DomainEvent,
  type EventType,
  type NewDomainEvent,
  type OutboxState,
} from '@adericel/domain';
import type { PlatformContext, Queryable, TenantContext } from './db.js';

/**
 * Transactional outbox.
 *
 * `publish` writes to both `outbox_events` (for delivery) and `event_log` (for
 * history) using the caller's transaction. That is the whole point: the event
 * and the state change it describes commit or roll back together, so a consumer
 * — including n8n — can never observe an event for work that was rolled back.
 */
export async function publish(
  ctx: Queryable,
  event: NewDomainEvent,
  occurredAt: string,
): Promise<DomainEvent> {
  const id = randomUUID();
  const schemaVersion = EVENT_SCHEMA_VERSIONS[event.type];
  const values = [
    id,
    event.type,
    schemaVersion,
    event.organisationId,
    event.mspId ?? null,
    event.subjectType,
    event.subjectId,
    JSON.stringify(event.payload),
    event.correlationId,
    event.causationId ?? null,
    event.actor,
    occurredAt,
  ];

  await ctx.query(
    `INSERT INTO outbox_events
       (id, type, schema_version, organisation_id, msp_id, subject_type, subject_id,
        payload, correlation_id, causation_id, actor, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
    values,
  );
  await ctx.query(
    `INSERT INTO event_log
       (id, type, schema_version, organisation_id, msp_id, subject_type, subject_id,
        payload, correlation_id, causation_id, actor, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
    values,
  );

  return {
    id,
    type: event.type,
    schemaVersion,
    organisationId: event.organisationId,
    mspId: event.mspId ?? null,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    payload: event.payload,
    correlationId: event.correlationId,
    causationId: event.causationId ?? null,
    actor: event.actor,
    occurredAt,
  };
}

export interface ClaimedEvent extends DomainEvent {
  readonly attempts: number;
  readonly state: OutboxState;
}

type OutboxRow = {
  id: string;
  type: string;
  schema_version: number;
  organisation_id: string | null;
  msp_id: string | null;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  causation_id: string | null;
  actor: string;
  attempts: number;
  state: string;
  occurred_at: Date;
};

function toEvent(row: OutboxRow): ClaimedEvent {
  return {
    id: row.id,
    type: row.type as EventType,
    schemaVersion: row.schema_version,
    organisationId: row.organisation_id,
    mspId: row.msp_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actor: row.actor,
    occurredAt: row.occurred_at.toISOString(),
    attempts: row.attempts,
    state: row.state as OutboxState,
  };
}

/**
 * Claim a batch of due events for delivery.
 *
 * `FOR UPDATE SKIP LOCKED` lets several worker replicas run concurrently
 * without coordination or duplicate delivery. Claimed rows get a visibility
 * deadline via `available_at`, so a worker that dies mid-batch releases its work
 * automatically instead of stranding it.
 */
export async function claimBatch(
  ctx: PlatformContext,
  workerId: string,
  batchSize: number,
  visibilityTimeoutMs: number,
): Promise<readonly ClaimedEvent[]> {
  const rows = await ctx.many<OutboxRow>(
    `WITH claimed AS (
       SELECT id FROM outbox_events
       WHERE state IN ('PENDING', 'IN_FLIGHT') AND available_at <= now()
       ORDER BY available_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE outbox_events o
     SET state = 'IN_FLIGHT',
         attempts = o.attempts + 1,
         claimed_at = now(),
         claimed_by = $1,
         available_at = now() + ($3::bigint || ' milliseconds')::interval
     FROM claimed
     WHERE o.id = claimed.id
     RETURNING o.id, o.type, o.schema_version, o.organisation_id, o.msp_id, o.subject_type,
               o.subject_id, o.payload, o.correlation_id, o.causation_id, o.actor,
               o.attempts, o.state, o.occurred_at`,
    [workerId, batchSize, visibilityTimeoutMs],
  );
  return rows.map(toEvent);
}

export async function markDelivered(ctx: PlatformContext, eventId: string): Promise<void> {
  await ctx.query(
    `UPDATE outbox_events SET state = 'DELIVERED', delivered_at = now(), last_error = NULL
     WHERE id = $1`,
    [eventId],
  );
}

/**
 * Record a delivery failure. Once attempts are exhausted the event moves to
 * DEAD_LETTER, where it stays visible to operators and to the health endpoint.
 * Nothing is ever discarded.
 */
export async function markFailed(
  ctx: PlatformContext,
  eventId: string,
  error: string,
  maxAttempts: number,
  nextDelayMs: number,
): Promise<'RETRY' | 'DEAD_LETTER'> {
  const row = await ctx.one<{ state: string }>(
    `UPDATE outbox_events
     SET state = CASE WHEN attempts >= $3 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
         last_error = $2,
         available_at = CASE WHEN attempts >= $3 THEN available_at
                             ELSE now() + ($4::bigint || ' milliseconds')::interval END
     WHERE id = $1
     RETURNING state`,
    [eventId, error.slice(0, 2000), maxAttempts, nextDelayMs],
  );
  return row?.state === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'RETRY';
}

export async function replayDeadLetter(ctx: PlatformContext, eventId: string): Promise<boolean> {
  const { rowCount } = await ctx.query(
    `UPDATE outbox_events
     SET state = 'PENDING', attempts = 0, available_at = now(), last_error = NULL
     WHERE id = $1 AND state = 'DEAD_LETTER'`,
    [eventId],
  );
  return rowCount > 0;
}

export interface OutboxStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly deadLetter: number;
  readonly oldestPendingAgeSeconds: number | null;
}

export async function outboxStats(ctx: PlatformContext): Promise<OutboxStats> {
  const row = await ctx.one<{
    pending: string;
    in_flight: string;
    dead_letter: string;
    oldest_age: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE state = 'PENDING')::text AS pending,
       count(*) FILTER (WHERE state = 'IN_FLIGHT')::text AS in_flight,
       count(*) FILTER (WHERE state = 'DEAD_LETTER')::text AS dead_letter,
       EXTRACT(EPOCH FROM (now() - min(occurred_at) FILTER (WHERE state = 'PENDING')))::text AS oldest_age
     FROM outbox_events`,
  );
  return {
    pending: Number(row?.pending ?? 0),
    inFlight: Number(row?.in_flight ?? 0),
    deadLetter: Number(row?.dead_letter ?? 0),
    oldestPendingAgeSeconds: row?.oldest_age === null || row?.oldest_age === undefined ? null : Number(row.oldest_age),
  };
}

/** Read the event history for one organisation, newest first. */
export async function listEvents(
  ctx: TenantContext,
  filter: { types?: readonly EventType[]; correlationId?: string; since?: string },
  limit: number,
): Promise<readonly DomainEvent[]> {
  const rows = await ctx.many<OutboxRow>(
    `SELECT id, type, schema_version, organisation_id, msp_id, subject_type, subject_id,
            payload, correlation_id, causation_id, actor, 0 AS attempts, 'DELIVERED' AS state, occurred_at
     FROM event_log
     WHERE organisation_id = $1
       AND ($2::text[] IS NULL OR type = ANY($2::text[]))
       AND ($3::uuid IS NULL OR correlation_id = $3::uuid)
       AND ($4::timestamptz IS NULL OR occurred_at >= $4::timestamptz)
     ORDER BY occurred_at DESC, id DESC
     LIMIT $5`,
    [
      ctx.organisationId,
      filter.types ?? null,
      filter.correlationId ?? null,
      filter.since ?? null,
      limit,
    ],
  );
  return rows.map(toEvent);
}
