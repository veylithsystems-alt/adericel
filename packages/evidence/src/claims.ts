import type { ClaimInput, ClaimOrigin, ClaimRecord, ClaimStatus } from '@adericel/domain';
import type { TenantContext } from '@adericel/graph';
import { AdericelError, buildPage, decodeCursor, type Clock, type Page } from '@adericel/shared';

/**
 * Claim repository.
 *
 * A claim is a structured proposition about the organisation, derived from
 * evidence. Asserting a claim supersedes any live claim with the same
 * (subject, predicate) pair rather than mutating it, so the assertion history
 * survives and the Truth Engine always has exactly one current value to read.
 */

interface ClaimRow {
  id: string;
  organisation_id: string;
  node_id: string;
  predicate: string;
  subject_node_id: string | null;
  subject_external_id: string | null;
  value: unknown;
  origin: string;
  status: string;
  extraction_confidence: string | null;
  supersedes_claim_id: string | null;
  observed_at: Date | null;
  asserted_at: Date;
  valid_until: Date | null;
  created_by_actor: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  evidence_ids: string[] | null;
}

const CLAIM_SELECT = `
  c.id, c.organisation_id, c.node_id, c.predicate, c.subject_node_id, c.subject_external_id,
  c.value, c.origin, c.status, c.extraction_confidence::text AS extraction_confidence,
  c.supersedes_claim_id, c.observed_at, c.asserted_at, c.valid_until, c.created_by_actor,
  c.metadata, c.created_at,
  COALESCE(ARRAY(SELECT ce.evidence_id FROM claim_evidence ce WHERE ce.claim_id = c.id), '{}') AS evidence_ids`;

function toRecord(row: ClaimRow): ClaimRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    nodeId: row.node_id,
    predicate: row.predicate,
    subjectNodeId: row.subject_node_id,
    subjectExternalId: row.subject_external_id,
    value: row.value,
    origin: row.origin as ClaimOrigin,
    status: row.status as ClaimStatus,
    extractionConfidence: row.extraction_confidence === null ? null : Number(row.extraction_confidence),
    evidenceIds: row.evidence_ids ?? [],
    supersedesClaimId: row.supersedes_claim_id,
    observedAt: row.observed_at?.toISOString() ?? null,
    assertedAt: row.asserted_at.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    createdByActor: row.created_by_actor,
    metadata: row.metadata,
  };
}

export interface ClaimFilter {
  readonly predicates?: readonly string[];
  readonly subjectNodeId?: string;
  readonly statuses?: readonly ClaimStatus[];
  readonly origins?: readonly ClaimOrigin[];
}

export interface AssertResult {
  readonly claim: ClaimRecord;
  readonly changed: boolean;
  readonly supersededClaimId: string | null;
  readonly previousValue: unknown;
}

export interface ClaimRepository {
  assert(input: ClaimInput, actor: string, nodeId: string): Promise<AssertResult>;
  getById(id: string): Promise<ClaimRecord | null>;
  requireById(id: string): Promise<ClaimRecord>;
  list(filter: ClaimFilter, limit: number, cursor?: string): Promise<Page<ClaimRecord>>;
  /** Live claims for a set of subjects, restricted to the given predicates. */
  forSubjects(
    nodeIds: readonly string[],
    predicates: readonly string[],
  ): Promise<readonly ClaimRecord[]>;
  organisationClaims(predicates: readonly string[]): Promise<readonly ClaimRecord[]>;
  confirm(id: string, actor: string): Promise<ClaimRecord>;
  reject(id: string, reason: string, actor: string): Promise<ClaimRecord>;
}

export function createClaimRepository(ctx: TenantContext, clock: Clock): ClaimRepository {
  async function linkEvidence(claimId: string, evidenceIds: readonly string[]): Promise<void> {
    if (evidenceIds.length === 0) return;
    await ctx.query(
      `INSERT INTO claim_evidence (claim_id, evidence_id, organisation_id)
       SELECT $1, unnest($2::uuid[]), $3
       ON CONFLICT DO NOTHING`,
      [claimId, evidenceIds, ctx.organisationId],
    );
  }

  const repository: ClaimRepository = {
    async assert(input, actor, nodeId): Promise<AssertResult> {
      const now = clock.nowIso();
      const subjectKey = input.subjectNodeId ?? null;

      const existing = await ctx.one<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c
         WHERE c.organisation_id = $1 AND c.predicate = $2
           AND c.subject_node_id IS NOT DISTINCT FROM $3::uuid
           AND c.status IN ('CANDIDATE', 'CONFIRMED')`,
        [ctx.organisationId, input.predicate, subjectKey],
      );

      if (existing) {
        const unchanged =
          JSON.stringify(existing.value) === JSON.stringify(input.value) &&
          existing.status === input.status &&
          existing.origin === input.origin;

        if (unchanged) {
          // Re-asserting the same value refreshes provenance without creating a
          // new claim; the assurance state has not moved, so nothing downstream
          // should be woken up.
          await ctx.query(
            `UPDATE claims SET asserted_at = $3::timestamptz, valid_until = $4::timestamptz
             WHERE id = $1 AND organisation_id = $2`,
            [existing.id, ctx.organisationId, now, input.validUntil ?? null],
          );
          await linkEvidence(existing.id, input.evidenceIds);
          const refreshed = await ctx.oneOrFail<ClaimRow>(
            `SELECT ${CLAIM_SELECT} FROM claims c WHERE c.id = $1 AND c.organisation_id = $2`,
            [existing.id, ctx.organisationId],
            'Claim',
          );
          return {
            claim: toRecord(refreshed),
            changed: false,
            supersededClaimId: null,
            previousValue: existing.value,
          };
        }

        await ctx.query(
          `UPDATE claims SET status = 'SUPERSEDED' WHERE id = $1 AND organisation_id = $2`,
          [existing.id, ctx.organisationId],
        );
      }

      const inserted = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO claims
           (organisation_id, node_id, predicate, subject_node_id, subject_external_id, value,
            origin, status, extraction_confidence, supersedes_claim_id, observed_at, asserted_at,
            valid_until, created_by_actor, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         RETURNING id`,
        [
          ctx.organisationId,
          nodeId,
          input.predicate,
          subjectKey,
          input.subjectExternalId ?? null,
          JSON.stringify(input.value ?? null),
          input.origin,
          input.status,
          input.extractionConfidence ?? null,
          existing?.id ?? input.supersedesClaimId ?? null,
          input.observedAt ?? null,
          now,
          input.validUntil ?? null,
          actor,
          JSON.stringify(input.metadata),
        ],
        'Claim',
      );

      await linkEvidence(inserted.id, input.evidenceIds);

      const row = await ctx.oneOrFail<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c WHERE c.id = $1 AND c.organisation_id = $2`,
        [inserted.id, ctx.organisationId],
        'Claim',
      );

      return {
        claim: toRecord(row),
        changed: true,
        supersededClaimId: existing?.id ?? null,
        previousValue: existing?.value ?? null,
      };
    },

    async getById(id): Promise<ClaimRecord | null> {
      const row = await ctx.one<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c WHERE c.id = $1 AND c.organisation_id = $2`,
        [id, ctx.organisationId],
      );
      return row ? toRecord(row) : null;
    },

    async requireById(id): Promise<ClaimRecord> {
      const claim = await repository.getById(id);
      if (!claim) throw new AdericelError('NOT_FOUND', 'Claim not found', { safeDetails: { id } });
      return claim;
    },

    async list(filter, limit, cursor): Promise<Page<ClaimRecord>> {
      const values: unknown[] = [ctx.organisationId];
      const conditions = ['c.organisation_id = $1'];
      if (filter.predicates?.length) {
        values.push(filter.predicates);
        conditions.push(`c.predicate = ANY($${values.length}::text[])`);
      }
      if (filter.subjectNodeId) {
        values.push(filter.subjectNodeId);
        conditions.push(`c.subject_node_id = $${values.length}`);
      }
      if (filter.statuses?.length) {
        values.push(filter.statuses);
        conditions.push(`c.status = ANY($${values.length}::text[])`);
      }
      if (filter.origins?.length) {
        values.push(filter.origins);
        conditions.push(`c.origin = ANY($${values.length}::text[])`);
      }
      if (cursor) {
        const { k, i } = decodeCursor(cursor);
        values.push(k, i);
        conditions.push(
          `(c.asserted_at, c.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);

      const rows = await ctx.many<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.asserted_at DESC, c.id DESC
         LIMIT $${values.length}`,
        values,
      );
      return buildPage(rows.map(toRecord), limit, (claim) => ({ k: claim.assertedAt, i: claim.id }));
    },

    async forSubjects(nodeIds, predicates): Promise<readonly ClaimRecord[]> {
      if (nodeIds.length === 0 || predicates.length === 0) return [];
      const rows = await ctx.many<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c
         WHERE c.organisation_id = $1
           AND c.subject_node_id = ANY($2::uuid[])
           AND c.predicate = ANY($3::text[])
           AND c.status IN ('CANDIDATE', 'CONFIRMED')`,
        [ctx.organisationId, nodeIds, predicates],
      );
      return rows.map(toRecord);
    },

    async organisationClaims(predicates): Promise<readonly ClaimRecord[]> {
      if (predicates.length === 0) return [];
      const rows = await ctx.many<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c
         WHERE c.organisation_id = $1
           AND c.subject_node_id IS NULL
           AND c.predicate = ANY($2::text[])
           AND c.status IN ('CANDIDATE', 'CONFIRMED')`,
        [ctx.organisationId, predicates],
      );
      return rows.map(toRecord);
    },

    async confirm(id, actor): Promise<ClaimRecord> {
      const row = await ctx.oneOrFail<{ id: string }>(
        `UPDATE claims
         SET status = 'CONFIRMED',
             metadata = metadata || jsonb_build_object('confirmedBy', $3::text, 'confirmedAt', $4::text)
         WHERE id = $1 AND organisation_id = $2 AND status = 'CANDIDATE'
         RETURNING id`,
        [id, ctx.organisationId, actor, clock.nowIso()],
        'Claim',
      );
      return repository.requireById(row.id);
    },

    async reject(id, reason, actor): Promise<ClaimRecord> {
      const row = await ctx.oneOrFail<{ id: string }>(
        `UPDATE claims
         SET status = 'REJECTED',
             metadata = metadata || jsonb_build_object('rejectedBy', $3::text, 'rejectionReason', $4::text)
         WHERE id = $1 AND organisation_id = $2 AND status IN ('CANDIDATE', 'CONFIRMED')
         RETURNING id`,
        [id, ctx.organisationId, actor, reason],
        'Claim',
      );
      return repository.requireById(row.id);
    },
  };

  return repository;
}
