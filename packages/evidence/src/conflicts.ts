import type { TenantContext } from '@adericel/graph';
import type { AuthorityPolicy, ConflictOutcome, SourcedValue } from '@adericel/domain';

/**
 * Persisted source disagreements.
 *
 * The decision of what to believe is pure and lives in
 * `@adericel/integrations`; this is only the record of it. Keeping the two
 * apart means a contested determination can be replayed from its inputs, and
 * that the resolution rules can be read without a database in front of you.
 */

export interface ConflictRecord {
  readonly id: string;
  readonly predicate: string;
  readonly subjectNodeId: string | null;
  readonly subjectExternalId: string | null;
  readonly resolution: ConflictOutcome['resolution'];
  readonly resolvedValue: unknown;
  readonly sources: readonly SourcedValue[];
  readonly distinctValues: number;
  readonly detail: string;
  readonly claimId: string | null;
  readonly firstDetectedAt: string;
  readonly lastDetectedAt: string;
  readonly resolvedAt: string | null;
}

interface ConflictRow {
  id: string;
  predicate: string;
  subject_node_id: string | null;
  subject_external_id: string | null;
  resolution: string;
  resolved_value: unknown;
  sources: SourcedValue[];
  distinct_values: number;
  detail: string;
  claim_id: string | null;
  first_detected_at: Date;
  last_detected_at: Date;
  resolved_at: Date | null;
}

const CONFLICT_SELECT = `
  id, predicate, subject_node_id, subject_external_id, resolution, resolved_value, sources,
  distinct_values, detail, claim_id, first_detected_at, last_detected_at, resolved_at`;

function toRecord(row: ConflictRow): ConflictRecord {
  return {
    id: row.id,
    predicate: row.predicate,
    subjectNodeId: row.subject_node_id,
    subjectExternalId: row.subject_external_id,
    resolution: row.resolution as ConflictOutcome['resolution'],
    resolvedValue: row.resolved_value,
    sources: row.sources,
    distinctValues: row.distinct_values,
    detail: row.detail,
    claimId: row.claim_id,
    firstDetectedAt: row.first_detected_at.toISOString(),
    lastDetectedAt: row.last_detected_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

export interface ConflictRepository {
  /**
   * Record a disagreement, or refresh the one already open for this predicate
   * and subject. A disagreement persisting across ten runs is one fact.
   */
  record(
    outcome: ConflictOutcome,
    subjectNodeId: string | null,
    claimId: string | null,
  ): Promise<ConflictRecord>;
  /** Close the open conflict for a predicate and subject, if any. */
  close(predicate: string, subjectNodeId: string | null, nowIso: string): Promise<void>;
  open(): Promise<readonly ConflictRecord[]>;
  forPredicates(predicates: readonly string[]): Promise<readonly ConflictRecord[]>;
  /** The configured authority policy for a predicate; longest pattern wins. */
  authorityFor(predicate: string): Promise<AuthorityPolicy>;
}

export function createConflictRepository(
  ctx: TenantContext,
  clock: { nowIso(): string },
): ConflictRepository {
  return {
    async record(outcome, subjectNodeId, claimId): Promise<ConflictRecord> {
      const now = clock.nowIso();
      const row = await ctx.oneOrFail<ConflictRow>(
        `INSERT INTO claim_conflicts
           (organisation_id, predicate, subject_node_id, subject_external_id, resolution,
            resolved_value, sources, distinct_values, detail, claim_id,
            first_detected_at, last_detected_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $11)
         ON CONFLICT (organisation_id, predicate,
                      COALESCE(subject_node_id, '00000000-0000-0000-0000-000000000000'))
           WHERE resolved_at IS NULL
         DO UPDATE SET
           resolution      = EXCLUDED.resolution,
           resolved_value  = EXCLUDED.resolved_value,
           sources         = EXCLUDED.sources,
           distinct_values = EXCLUDED.distinct_values,
           detail          = EXCLUDED.detail,
           claim_id        = EXCLUDED.claim_id,
           last_detected_at = EXCLUDED.last_detected_at
         RETURNING ${CONFLICT_SELECT}`,
        [
          ctx.organisationId,
          outcome.predicate,
          subjectNodeId,
          outcome.subjectExternalId,
          outcome.resolution,
          JSON.stringify(outcome.value ?? null),
          JSON.stringify(outcome.sources),
          outcome.distinctValues,
          outcome.detail,
          claimId,
          now,
        ],
        'Claim conflict',
      );
      return toRecord(row);
    },

    async close(predicate, subjectNodeId, nowIso): Promise<void> {
      // Kept, not deleted. That a control was contested last quarter is part of
      // the record, and an auditor asking "was this ever disputed?" deserves an
      // answer.
      await ctx.query(
        `UPDATE claim_conflicts SET resolved_at = $4::timestamptz
         WHERE organisation_id = $1 AND predicate = $2
           AND subject_node_id IS NOT DISTINCT FROM $3::uuid
           AND resolved_at IS NULL`,
        [ctx.organisationId, predicate, subjectNodeId, nowIso],
      );
    },

    async open(): Promise<readonly ConflictRecord[]> {
      const rows = await ctx.many<ConflictRow>(
        `SELECT ${CONFLICT_SELECT} FROM claim_conflicts
         WHERE organisation_id = $1 AND resolved_at IS NULL
         ORDER BY last_detected_at DESC, id`,
        [ctx.organisationId],
      );
      return rows.map(toRecord);
    },

    async forPredicates(predicates): Promise<readonly ConflictRecord[]> {
      if (predicates.length === 0) return [];
      const rows = await ctx.many<ConflictRow>(
        `SELECT ${CONFLICT_SELECT} FROM claim_conflicts
         WHERE organisation_id = $1 AND resolved_at IS NULL AND predicate = ANY($2::text[])
         ORDER BY predicate, id`,
        [ctx.organisationId, [...predicates]],
      );
      return rows.map(toRecord);
    },

    async authorityFor(predicate): Promise<AuthorityPolicy> {
      // Longest matching pattern wins, so `device.disk.encrypted` beats
      // `device.`. A specific decision an operator made about one fact must not
      // be overridden by a general one they made about a family.
      const row = await ctx.one<{
        integration_ids: string[];
        freshness_window_hours: number | null;
      }>(
        `SELECT integration_ids, freshness_window_hours
         FROM source_authority_policies
         WHERE organisation_id = $1
           AND ($2 = predicate_pattern
                OR (predicate_pattern LIKE '%.' AND $2 LIKE predicate_pattern || '%'))
         ORDER BY length(predicate_pattern) DESC
         LIMIT 1`,
        [ctx.organisationId, predicate],
      );
      if (!row) return {};
      return {
        ...(row.integration_ids.length > 0
          ? { authoritativeIntegrationIds: row.integration_ids }
          : {}),
        ...(row.freshness_window_hours === null
          ? {}
          : { freshnessWindowHours: row.freshness_window_hours }),
      };
    },
  };
}
