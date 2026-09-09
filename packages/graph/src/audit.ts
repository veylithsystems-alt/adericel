import type { AuditEntry } from '@adericel/domain';
import { buildPage, decodeCursor, type Page } from '@adericel/shared';
import type { PlatformContext, Queryable, TenantContext } from './db.js';

/**
 * Audit trail.
 *
 * Denials are recorded with the same weight as successes: "this MSP engineer
 * tried to read a customer they are not authorised for" is precisely the record
 * an incident investigation needs, and it is exactly the record that gets lost
 * when only successful operations are logged.
 */
export interface NewAuditEntry {
  readonly organisationId: string | null;
  readonly mspId?: string | null;
  readonly actorType: string;
  readonly actorId: string;
  readonly actorDisplay: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  readonly reason?: string | null;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export async function recordAudit(
  ctx: Queryable,
  entry: NewAuditEntry,
  occurredAt: string,
): Promise<void> {
  await ctx.query(
    `INSERT INTO audit_log
       (organisation_id, msp_id, actor_type, actor_id, actor_display, action, resource_type,
        resource_id, outcome, reason, request_id, correlation_id, source_ip, user_agent, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::inet, $14, $15::jsonb, $16)`,
    [
      entry.organisationId,
      entry.mspId ?? null,
      entry.actorType,
      entry.actorId,
      entry.actorDisplay,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.outcome,
      entry.reason ?? null,
      entry.requestId ?? null,
      entry.correlationId ?? null,
      entry.sourceIp ?? null,
      entry.userAgent ?? null,
      JSON.stringify(entry.metadata ?? {}),
      occurredAt,
    ],
  );
}

type AuditRow = {
  id: string;
  organisation_id: string | null;
  msp_id: string | null;
  actor_type: string;
  actor_id: string;
  actor_display: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  reason: string | null;
  request_id: string | null;
  correlation_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
};

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    mspId: row.msp_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorDisplay: row.actor_display,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    outcome: row.outcome as AuditEntry['outcome'],
    reason: row.reason,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    metadata: row.metadata,
    occurredAt: row.occurred_at.toISOString(),
  };
}

const AUDIT_COLUMNS = `id, organisation_id, msp_id, actor_type, actor_id, actor_display, action,
  resource_type, resource_id, outcome, reason, request_id, correlation_id,
  host(source_ip) AS source_ip, user_agent, metadata, occurred_at`;

export interface AuditFilter {
  readonly actions?: readonly string[];
  readonly outcomes?: readonly AuditEntry['outcome'][];
  readonly actorId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly since?: string;
}

export async function listAudit(
  ctx: TenantContext,
  filter: AuditFilter,
  limit: number,
  cursor?: string,
): Promise<Page<AuditEntry>> {
  const values: unknown[] = [ctx.organisationId];
  const conditions = ['organisation_id = $1'];

  if (filter.actions?.length) {
    values.push(filter.actions);
    conditions.push(`action = ANY($${values.length}::text[])`);
  }
  if (filter.outcomes?.length) {
    values.push(filter.outcomes);
    conditions.push(`outcome = ANY($${values.length}::text[])`);
  }
  if (filter.actorId) {
    values.push(filter.actorId);
    conditions.push(`actor_id = $${values.length}`);
  }
  if (filter.resourceType) {
    values.push(filter.resourceType);
    conditions.push(`resource_type = $${values.length}`);
  }
  if (filter.resourceId) {
    values.push(filter.resourceId);
    conditions.push(`resource_id = $${values.length}`);
  }
  if (filter.since) {
    values.push(filter.since);
    conditions.push(`occurred_at >= $${values.length}::timestamptz`);
  }
  if (cursor) {
    const { k, i } = decodeCursor(cursor);
    values.push(k, i);
    conditions.push(`(occurred_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(limit + 1);

  const rows = await ctx.many<AuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log
     WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  return buildPage(rows.map(toEntry), limit, (entry) => ({ k: entry.occurredAt, i: entry.id }));
}

/** Platform-scope audit read, used by the MSP control plane and support tooling. */
export async function listAuditPlatform(
  ctx: PlatformContext,
  filter: AuditFilter & { organisationId?: string; mspId?: string },
  limit: number,
): Promise<readonly AuditEntry[]> {
  const values: unknown[] = [];
  const conditions: string[] = [];
  if (filter.organisationId) {
    values.push(filter.organisationId);
    conditions.push(`organisation_id = $${values.length}`);
  }
  if (filter.mspId) {
    values.push(filter.mspId);
    conditions.push(`msp_id = $${values.length}`);
  }
  if (filter.since) {
    values.push(filter.since);
    conditions.push(`occurred_at >= $${values.length}::timestamptz`);
  }
  values.push(limit);
  const rows = await ctx.many<AuditRow>(
    `SELECT ${AUDIT_COLUMNS} FROM audit_log
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  return rows.map(toEntry);
}
