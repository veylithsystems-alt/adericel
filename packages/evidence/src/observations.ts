import { contentHash, type Clock } from '@adericel/shared';
import type { ObservationInput, ObservationKind, ObservationRecord } from '@adericel/domain';
import type { TenantContext } from '@adericel/graph';

/**
 * Observation repository.
 *
 * Observations are the raw material: what a connector saw, normalised into
 * Adericel's vocabulary but not yet given evidential standing. They are
 * deduplicated on content, so a connector polling every fifteen minutes does
 * not multiply storage by ninety-six for an environment that has not changed.
 */

interface ObservationRow {
  id: string;
  organisation_id: string;
  integration_id: string | null;
  kind: string;
  source_system: string;
  subject_external_id: string | null;
  subject_node_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  observed_at: Date | null;
  collected_at: Date;
  evidence_id: string | null;
  correlation_id: string | null;
  created_at: Date;
}

const COLUMNS = `
  id, organisation_id, integration_id, kind, source_system, subject_external_id, subject_node_id,
  payload, payload_hash, observed_at, collected_at, evidence_id, correlation_id, created_at`;

function toRecord(row: ObservationRow): ObservationRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    integrationId: row.integration_id,
    kind: row.kind as ObservationKind,
    sourceSystem: row.source_system,
    subjectExternalId: row.subject_external_id,
    subjectNodeId: row.subject_node_id,
    payload: row.payload,
    payloadHash: row.payload_hash,
    observedAt: row.observed_at?.toISOString() ?? null,
    collectedAt: row.collected_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    correlationId: row.correlation_id,
    evidenceId: row.evidence_id,
  };
}

export interface RecordObservationsResult {
  readonly recorded: readonly ObservationRecord[];
  readonly duplicates: number;
}

export interface ObservationRepository {
  record(
    observations: readonly ObservationInput[],
    options: {
      integrationId: string | null;
      integrationRunId: string | null;
      correlationId: string;
      subjectNodeIdByExternalId?: ReadonlyMap<string, string>;
    },
  ): Promise<RecordObservationsResult>;
  listRecent(limit: number, kind?: ObservationKind): Promise<readonly ObservationRecord[]>;
  linkEvidence(observationIds: readonly string[], evidenceId: string): Promise<void>;
  purgeOlderThan(cutoffIso: string, limit: number): Promise<number>;
}

export function createObservationRepository(
  ctx: TenantContext,
  clock: Clock,
): ObservationRepository {
  return {
    async record(observations, options): Promise<RecordObservationsResult> {
      const recorded: ObservationRecord[] = [];
      let duplicates = 0;

      for (const observation of observations) {
        const payloadHash = contentHash(observation.payload);
        const subjectNodeId =
          observation.subjectNodeId ??
          (observation.subjectExternalId
            ? (options.subjectNodeIdByExternalId?.get(observation.subjectExternalId) ?? null)
            : null);

        const row = await ctx.one<ObservationRow>(
          `INSERT INTO observations
             (organisation_id, integration_id, integration_run_id, kind, source_system,
              subject_external_id, subject_node_id, payload, payload_hash, observed_at, collected_at,
              correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
           ON CONFLICT (organisation_id, kind, COALESCE(subject_external_id, ''), payload_hash)
           DO NOTHING
           RETURNING ${COLUMNS}`,
          [
            ctx.organisationId,
            options.integrationId,
            options.integrationRunId,
            observation.kind,
            observation.sourceSystem,
            observation.subjectExternalId ?? null,
            subjectNodeId,
            JSON.stringify(observation.payload),
            payloadHash,
            observation.observedAt ?? null,
            observation.collectedAt ?? clock.nowIso(),
            options.correlationId,
          ],
        );

        if (row) recorded.push(toRecord(row));
        else duplicates += 1;
      }

      return { recorded, duplicates };
    },

    async listRecent(limit, kind): Promise<readonly ObservationRecord[]> {
      const rows = await ctx.many<ObservationRow>(
        `SELECT ${COLUMNS} FROM observations
         WHERE organisation_id = $1 AND ($2::text IS NULL OR kind = $2)
         ORDER BY collected_at DESC, id DESC
         LIMIT $3`,
        [ctx.organisationId, kind ?? null, limit],
      );
      return rows.map(toRecord);
    },

    async linkEvidence(observationIds, evidenceId): Promise<void> {
      if (observationIds.length === 0) return;
      await ctx.query(
        `UPDATE observations SET evidence_id = $3
         WHERE organisation_id = $1 AND id = ANY($2::uuid[])`,
        [ctx.organisationId, observationIds, evidenceId],
      );
      await ctx.query(
        `INSERT INTO evidence_observations (evidence_id, observation_id, organisation_id)
         SELECT $1, unnest($2::uuid[]), $3
         ON CONFLICT DO NOTHING`,
        [evidenceId, observationIds, ctx.organisationId],
      );
    },

    async purgeOlderThan(cutoffIso, limit): Promise<number> {
      // Observations that have been promoted to evidence are retained via the
      // evidence retention policy instead; purging them here would break the
      // provenance chain behind historical assessments.
      const { rowCount } = await ctx.query(
        `DELETE FROM observations
         WHERE id IN (
           SELECT id FROM observations
           WHERE organisation_id = $1 AND collected_at < $2::timestamptz AND evidence_id IS NULL
           ORDER BY collected_at
           LIMIT $3
         )`,
        [ctx.organisationId, cutoffIso, limit],
      );
      return rowCount;
    },
  };
}
