import {
  DEFAULT_FRESHNESS_BY_SOURCE_TYPE,
  evaluateEvidenceUsability,
  type CollectionMethod,
  type EvidenceIngestInput,
  type EvidenceRecord,
  type EvidenceSourceType,
  type EvidenceStatus,
  type FreshnessState,
  type IntegrityLevel,
} from '@adericel/domain';
import type { TenantContext } from '@adericel/graph';
import {
  AdericelError,
  buildPage,
  contentHash,
  decodeCursor,
  type Clock,
  type Page,
} from '@adericel/shared';

/**
 * Evidence repository.
 *
 * Evidence is append-only. There is no `update` here by design: a correction is
 * a new record that supersedes the old one, and a withdrawal is a revocation.
 * Historical assessments therefore remain explicable, because the evidence they
 * cited is still readable exactly as it was.
 */

interface EvidenceRow {
  id: string;
  organisation_id: string;
  node_id: string;
  source_type: string;
  collection_method: string;
  integration_id: string | null;
  source_system: string;
  source_reference: string | null;
  title: string;
  content_hash: string;
  content_type: string;
  content_size_bytes: string | null;
  storage_key: string | null;
  payload: Record<string, unknown> | null;
  integrity_level: string;
  status: string;
  supersedes_evidence_id: string | null;
  revocation_reason: string | null;
  observed_at: Date | null;
  collected_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  revoked_at: Date | null;
  superseded_at: Date | null;
  collected_by_actor: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const COLUMN_NAMES = [
  'id',
  'organisation_id',
  'node_id',
  'source_type',
  'collection_method',
  'integration_id',
  'source_system',
  'source_reference',
  'title',
  'content_hash',
  'content_type',
  'content_size_bytes',
  'storage_key',
  'payload',
  'integrity_level',
  'status',
  'supersedes_evidence_id',
  'revocation_reason',
  'observed_at',
  'collected_at',
  'valid_from',
  'valid_until',
  'revoked_at',
  'superseded_at',
  'collected_by_actor',
  'metadata',
  'created_at',
] as const;

/**
 * Select list, optionally table-qualified. `content_size_bytes` is a bigint and
 * is cast to text so that a value beyond Number.MAX_SAFE_INTEGER cannot be
 * silently truncated by the driver on its way into JavaScript.
 */
function columns(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return COLUMN_NAMES.map((name) =>
    name === 'content_size_bytes' ? `${p}${name}::text AS ${name}` : `${p}${name}`,
  ).join(', ');
}

const COLUMNS = columns();

function toRecord(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    nodeId: row.node_id,
    sourceType: row.source_type as EvidenceSourceType,
    collectionMethod: row.collection_method as CollectionMethod,
    integrationId: row.integration_id,
    sourceSystem: row.source_system,
    sourceReference: row.source_reference,
    title: row.title,
    contentHash: row.content_hash,
    contentType: row.content_type,
    contentSizeBytes: row.content_size_bytes === null ? null : Number(row.content_size_bytes),
    storageKey: row.storage_key,
    payload: row.payload,
    integrityLevel: row.integrity_level as IntegrityLevel,
    status: row.status as EvidenceStatus,
    supersedesEvidenceId: row.supersedes_evidence_id,
    revocationReason: row.revocation_reason,
    observedAt: row.observed_at?.toISOString() ?? null,
    collectedAt: row.collected_at.toISOString(),
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
    collectedByActor: row.collected_by_actor,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

export interface EvidenceView extends EvidenceRecord {
  readonly freshness: FreshnessState;
  readonly usable: boolean;
  readonly usabilityReason: string | null;
  readonly ageDays: number;
}

export function withUsability(record: EvidenceRecord, atIso: string): EvidenceView {
  const usability = evaluateEvidenceUsability(record, atIso);
  return {
    ...record,
    freshness: usability.freshness,
    usable: usability.usable,
    usabilityReason: usability.reason,
    ageDays: usability.ageDays,
  };
}

export interface EvidenceFilter {
  readonly statuses?: readonly EvidenceStatus[];
  readonly sourceTypes?: readonly EvidenceSourceType[];
  readonly integrationId?: string;
  readonly subjectNodeId?: string;
  readonly search?: string;
  readonly since?: string;
  readonly onlyUsable?: boolean;
}

export interface IngestResult {
  readonly evidence: EvidenceRecord;
  /** True when an identical artefact already existed and was reused. */
  readonly deduplicated: boolean;
  readonly supersededEvidenceId: string | null;
}

export interface EvidenceRepository {
  ingest(input: EvidenceIngestInput, actor: string, nodeId: string): Promise<IngestResult>;
  getById(id: string): Promise<EvidenceRecord | null>;
  requireById(id: string): Promise<EvidenceRecord>;
  list(filter: EvidenceFilter, limit: number, cursor?: string): Promise<Page<EvidenceView>>;
  forSubjects(nodeIds: readonly string[]): Promise<readonly EvidenceRecord[]>;
  forClaims(claimIds: readonly string[]): Promise<readonly EvidenceRecord[]>;
  revoke(id: string, reason: string, actor: string): Promise<EvidenceRecord>;
  /** Mark ACTIVE evidence past its validity window as EXPIRED. Returns ids. */
  expireOverdue(limit: number): Promise<readonly string[]>;
  /** Evidence approaching or past its freshness limit, for MSP chasing. */
  staleSummary(): Promise<{ stale: number; ageing: number; expired: number }>;
  attachSubjects(evidenceId: string, nodeIds: readonly string[]): Promise<void>;
}

export function createEvidenceRepository(ctx: TenantContext, clock: Clock): EvidenceRepository {
  const repository: EvidenceRepository = {
    async ingest(input, actor, nodeId): Promise<IngestResult> {
      const now = clock.nowIso();
      const collectedAt = input.collectedAt ?? now;
      const validFrom = input.validFrom ?? input.observedAt ?? collectedAt;

      // Identity is content-based. Two collections of the same configuration
      // snapshot are the same evidence; recording both would inflate the
      // evidence base without adding assurance.
      const digest =
        input.contentHash ??
        contentHash({
          sourceSystem: input.sourceSystem,
          sourceType: input.sourceType,
          payload: input.payload ?? null,
          storageKey: input.storageKey ?? null,
        });

      const validUntil =
        input.validUntil ?? defaultValidUntil(input.sourceType, input.observedAt ?? collectedAt);

      const existing = await ctx.one<EvidenceRow>(
        `SELECT ${COLUMNS} FROM evidence
         WHERE organisation_id = $1 AND content_hash = $2 AND status = 'ACTIVE'
         ORDER BY collected_at DESC
         LIMIT 1`,
        [ctx.organisationId, digest],
      );

      if (existing) {
        // Refresh the collection timestamp so freshness reflects that we have
        // just re-observed the same fact, without creating a duplicate record.
        const refreshed = await ctx.oneOrFail<EvidenceRow>(
          `UPDATE evidence
           SET collected_at = GREATEST(collected_at, $3::timestamptz),
               valid_until = COALESCE($4::timestamptz, valid_until),
               metadata = metadata || jsonb_build_object('recollectedAt', $3::text)
           WHERE id = $1 AND organisation_id = $2
           RETURNING ${COLUMNS}`,
          [existing.id, ctx.organisationId, collectedAt, validUntil],
          'Evidence',
        );
        if (input.subjectNodeIds.length > 0) {
          await repository.attachSubjects(existing.id, input.subjectNodeIds);
        }
        return {
          evidence: toRecord(refreshed),
          deduplicated: true,
          supersededEvidenceId: null,
        };
      }

      const inserted = await ctx.oneOrFail<EvidenceRow>(
        `INSERT INTO evidence
           (organisation_id, node_id, source_type, collection_method, integration_id, source_system,
            source_reference, title, content_hash, content_type, content_size_bytes, storage_key,
            payload, integrity_level, supersedes_evidence_id, observed_at, collected_at,
            valid_from, valid_until, collected_by_actor, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15,
                 $16, $17, $18, $19, $20, $21::jsonb)
         RETURNING ${COLUMNS}`,
        [
          ctx.organisationId,
          nodeId,
          input.sourceType,
          input.collectionMethod,
          input.integrationId ?? null,
          input.sourceSystem,
          input.sourceReference ?? null,
          input.title,
          digest,
          input.contentType,
          input.contentSizeBytes ?? null,
          input.storageKey ?? null,
          input.payload === null || input.payload === undefined
            ? null
            : JSON.stringify(input.payload),
          input.integrityLevel,
          input.supersedesEvidenceId ?? null,
          input.observedAt ?? null,
          collectedAt,
          validFrom,
          validUntil,
          actor,
          JSON.stringify(input.metadata),
        ],
        'Evidence',
      );

      let supersededId: string | null = null;
      if (input.supersedesEvidenceId) {
        const { rowCount } = await ctx.query(
          `UPDATE evidence
           SET status = 'SUPERSEDED', superseded_at = $3::timestamptz
           WHERE id = $1 AND organisation_id = $2 AND status = 'ACTIVE'`,
          [input.supersedesEvidenceId, ctx.organisationId, now],
        );
        if (rowCount > 0) supersededId = input.supersedesEvidenceId;
      }

      if (input.subjectNodeIds.length > 0) {
        await repository.attachSubjects(inserted.id, input.subjectNodeIds);
      }

      return {
        evidence: toRecord(inserted),
        deduplicated: false,
        supersededEvidenceId: supersededId,
      };
    },

    async attachSubjects(evidenceId, nodeIds): Promise<void> {
      if (nodeIds.length === 0) return;
      await ctx.query(
        `INSERT INTO evidence_subjects (evidence_id, node_id, organisation_id)
         SELECT $1, unnest($2::uuid[]), $3
         ON CONFLICT DO NOTHING`,
        [evidenceId, nodeIds, ctx.organisationId],
      );
    },

    async getById(id): Promise<EvidenceRecord | null> {
      const row = await ctx.one<EvidenceRow>(
        `SELECT ${COLUMNS} FROM evidence WHERE id = $1 AND organisation_id = $2`,
        [id, ctx.organisationId],
      );
      return row ? toRecord(row) : null;
    },

    async requireById(id): Promise<EvidenceRecord> {
      const record = await repository.getById(id);
      if (!record) {
        throw new AdericelError('NOT_FOUND', 'Evidence not found', { safeDetails: { id } });
      }
      return record;
    },

    async list(filter, limit, cursor): Promise<Page<EvidenceView>> {
      const values: unknown[] = [ctx.organisationId];
      const conditions = ['e.organisation_id = $1'];

      if (filter.statuses?.length) {
        values.push(filter.statuses);
        conditions.push(`e.status = ANY($${values.length}::text[])`);
      }
      if (filter.sourceTypes?.length) {
        values.push(filter.sourceTypes);
        conditions.push(`e.source_type = ANY($${values.length}::text[])`);
      }
      if (filter.integrationId) {
        values.push(filter.integrationId);
        conditions.push(`e.integration_id = $${values.length}`);
      }
      if (filter.subjectNodeId) {
        values.push(filter.subjectNodeId);
        conditions.push(
          `EXISTS (SELECT 1 FROM evidence_subjects s WHERE s.evidence_id = e.id AND s.node_id = $${values.length})`,
        );
      }
      if (filter.search) {
        values.push(`%${filter.search.toLowerCase()}%`);
        conditions.push(`lower(e.title) LIKE $${values.length}`);
      }
      if (filter.since) {
        values.push(filter.since);
        conditions.push(`e.collected_at >= $${values.length}::timestamptz`);
      }
      if (cursor) {
        const { k, i } = decodeCursor(cursor);
        values.push(k, i);
        conditions.push(
          `(e.collected_at, e.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);

      const rows = await ctx.many<EvidenceRow>(
        `SELECT ${columns('e')}
         FROM evidence e
         WHERE ${conditions.join(' AND ')}
         ORDER BY e.collected_at DESC, e.id DESC
         LIMIT $${values.length}`,
        values,
      );

      const now = clock.nowIso();
      const views = rows.map((row) => withUsability(toRecord(row), now));
      const filtered = filter.onlyUsable ? views.filter((v) => v.usable) : views;
      return buildPage(filtered, limit, (item) => ({ k: item.collectedAt, i: item.id }));
    },

    async forSubjects(nodeIds): Promise<readonly EvidenceRecord[]> {
      if (nodeIds.length === 0) return [];
      const rows = await ctx.many<EvidenceRow>(
        `SELECT DISTINCT ${columns('e')}
         FROM evidence e
         JOIN evidence_subjects s ON s.evidence_id = e.id
         WHERE e.organisation_id = $1 AND s.node_id = ANY($2::uuid[])`,
        [ctx.organisationId, nodeIds],
      );
      return rows.map(toRecord);
    },

    async forClaims(claimIds): Promise<readonly EvidenceRecord[]> {
      if (claimIds.length === 0) return [];
      const rows = await ctx.many<EvidenceRow>(
        `SELECT DISTINCT ${columns('e')}
         FROM evidence e
         JOIN claim_evidence ce ON ce.evidence_id = e.id
         WHERE e.organisation_id = $1 AND ce.claim_id = ANY($2::uuid[])`,
        [ctx.organisationId, claimIds],
      );
      return rows.map(toRecord);
    },

    async revoke(id, reason, actor): Promise<EvidenceRecord> {
      const row = await ctx.oneOrFail<EvidenceRow>(
        `UPDATE evidence
         SET status = 'REVOKED', revoked_at = $4::timestamptz, revocation_reason = $3,
             metadata = metadata || jsonb_build_object('revokedBy', $5::text)
         WHERE id = $1 AND organisation_id = $2 AND status <> 'REVOKED'
         RETURNING ${COLUMNS}`,
        [id, ctx.organisationId, reason, clock.nowIso(), actor],
        'Evidence',
      );
      return toRecord(row);
    },

    async expireOverdue(limit): Promise<readonly string[]> {
      const rows = await ctx.many<{ id: string }>(
        `UPDATE evidence
         SET status = 'EXPIRED'
         WHERE id IN (
           SELECT id FROM evidence
           WHERE organisation_id = $1 AND status = 'ACTIVE'
             AND valid_until IS NOT NULL AND valid_until <= $2::timestamptz
           ORDER BY valid_until
           LIMIT $3
         )
         RETURNING id`,
        [ctx.organisationId, clock.nowIso(), limit],
      );
      return rows.map((r) => r.id);
    },

    async staleSummary(): Promise<{ stale: number; ageing: number; expired: number }> {
      const rows = await ctx.many<EvidenceRow>(
        `SELECT ${COLUMNS} FROM evidence WHERE organisation_id = $1 AND status IN ('ACTIVE', 'EXPIRED')`,
        [ctx.organisationId],
      );
      const now = clock.nowIso();
      let stale = 0;
      let ageing = 0;
      let expired = 0;
      for (const row of rows) {
        const view = withUsability(toRecord(row), now);
        if (view.freshness === 'STALE') stale += 1;
        else if (view.freshness === 'AGEING') ageing += 1;
        else if (view.freshness === 'EXPIRED') expired += 1;
      }
      return { stale, ageing, expired };
    },
  };

  return repository;
}

/**
 * Default validity window derived from the source type's freshness policy.
 *
 * Making this explicit at ingest means an assessment never has to guess how
 * long a piece of evidence remains meaningful, and evidence expiry can be swept
 * on a schedule rather than recomputed on every read.
 */
function defaultValidUntil(sourceType: EvidenceSourceType, anchorIso: string): string {
  const policy = DEFAULT_FRESHNESS_BY_SOURCE_TYPE[sourceType];
  return new Date(Date.parse(anchorIso) + policy.maxAgeDays * 86_400_000).toISOString();
}
