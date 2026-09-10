import {
  conflictBlocksClaim,
  resolveConflict,
  type ClaimInput,
  type ClaimOrigin,
  type ClaimRecord,
  type ClaimStatus,
  type ConflictOutcome,
  type SourcedValue,
} from '@adericel/domain';
import type { TenantContext } from '@adericel/graph';
import { AdericelError, buildPage, decodeCursor, type Clock, type Page } from '@adericel/shared';
import { createConflictRepository } from './conflicts.js';

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
  source_integration_id: string | null;
  evidence_ids: string[] | null;
}

const CLAIM_SELECT = `
  c.id, c.organisation_id, c.node_id, c.predicate, c.subject_node_id, c.subject_external_id,
  c.value, c.origin, c.status, c.extraction_confidence::text AS extraction_confidence,
  c.supersedes_claim_id, c.observed_at, c.asserted_at, c.valid_until, c.created_by_actor,
  c.metadata, c.created_at, c.source_integration_id,
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
    extractionConfidence:
      row.extraction_confidence === null ? null : Number(row.extraction_confidence),
    evidenceIds: row.evidence_ids ?? [],
    supersedesClaimId: row.supersedes_claim_id,
    observedAt: row.observed_at?.toISOString() ?? null,
    assertedAt: row.asserted_at.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    createdByActor: row.created_by_actor,
    metadata: row.metadata,
    sourceIntegrationId: row.source_integration_id,
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
  /**
   * Set when another source had already spoken to this predicate for this
   * subject. Present whether they agreed or not, because an agreement between
   * two independent systems is itself worth recording.
   */
  readonly conflict: ConflictOutcome | null;
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

  const conflicts = createConflictRepository(ctx, clock);

  async function requireRow(id: string): Promise<ClaimRow> {
    return ctx.oneOrFail<ClaimRow>(
      `SELECT ${CLAIM_SELECT} FROM claims c WHERE c.id = $1 AND c.organisation_id = $2`,
      [id, ctx.organisationId],
      'Claim',
    );
  }

  /** Name an integration as a person would recognise it, for the conflict record. */
  async function displayNameOf(integrationId: string): Promise<string> {
    const row = await ctx.one<{ name: string; connector_key: string }>(
      `SELECT name, connector_key FROM integrations
       WHERE id = $1 AND organisation_id = $2`,
      [integrationId, ctx.organisationId],
    );
    return row?.name ?? row?.connector_key ?? integrationId;
  }

  /**
   * Decide what to believe when a second source speaks.
   *
   * The decision itself is a pure function in the domain; this only assembles
   * its inputs from the database and applies the organisation's configured
   * authority policy. Nothing here may invent an authority a person has not set.
   */
  async function adjudicate(
    existing: ClaimRow,
    input: ClaimInput,
    sourceIntegrationId: string,
    nowIso: string,
  ): Promise<ConflictOutcome> {
    const existingSourceId = existing.source_integration_id as string;
    const sources: SourcedValue[] = [
      {
        integrationId: existingSourceId,
        connectorKey: '',
        displayName: await displayNameOf(existingSourceId),
        value: existing.value,
        observedAt: existing.observed_at?.toISOString() ?? null,
        collectedAt: existing.asserted_at.toISOString(),
      },
      {
        integrationId: sourceIntegrationId,
        connectorKey: '',
        displayName: await displayNameOf(sourceIntegrationId),
        value: input.value,
        observedAt: input.observedAt ?? null,
        collectedAt: nowIso,
      },
    ];
    const policy = await conflicts.authorityFor(input.predicate);
    return resolveConflict(
      input.predicate,
      input.subjectExternalId ?? existing.subject_external_id,
      sources,
      policy,
    );
  }

  async function insertClaim(
    input: ClaimInput,
    actor: string,
    nodeId: string,
    sourceIntegrationId: string | null,
    supersedesClaimId: string | null,
    nowIso: string,
  ): Promise<{ id: string }> {
    const inserted = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO claims
         (organisation_id, node_id, predicate, subject_node_id, subject_external_id, value,
          origin, status, extraction_confidence, supersedes_claim_id, observed_at, asserted_at,
          valid_until, created_by_actor, metadata, source_integration_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)
       RETURNING id`,
      [
        ctx.organisationId,
        nodeId,
        input.predicate,
        input.subjectNodeId ?? null,
        input.subjectExternalId ?? null,
        JSON.stringify(input.value ?? null),
        input.origin,
        input.status,
        input.extractionConfidence ?? null,
        supersedesClaimId,
        input.observedAt ?? null,
        nowIso,
        input.validUntil ?? null,
        actor,
        JSON.stringify(input.metadata),
        sourceIntegrationId,
      ],
      'Claim',
    );
    await linkEvidence(inserted.id, input.evidenceIds);
    return inserted;
  }

  const repository: ClaimRepository = {
    async assert(input, actor, nodeId): Promise<AssertResult> {
      const now = clock.nowIso();
      const subjectKey = input.subjectNodeId ?? null;
      const sourceIntegrationId = input.sourceIntegrationId ?? null;

      const existing = await ctx.one<ClaimRow>(
        `SELECT ${CLAIM_SELECT} FROM claims c
         WHERE c.organisation_id = $1 AND c.predicate = $2
           AND c.subject_node_id IS NOT DISTINCT FROM $3::uuid
           AND c.status IN ('CANDIDATE', 'CONFIRMED')`,
        [ctx.organisationId, input.predicate, subjectKey],
      );

      // Two DIFFERENT sources speaking to one predicate is the case the single
      // live claim per (subject, predicate) cannot represent. Every claim goes
      // through here, so there is no path that can bypass this check.
      const secondSource =
        existing !== null &&
        sourceIntegrationId !== null &&
        existing.source_integration_id !== null &&
        existing.source_integration_id !== sourceIntegrationId;

      // Carried through every return below. An agreement between two
      // independent systems is worth reporting, not only a disagreement.
      let conflictOutcome: ConflictOutcome | null = null;

      if (secondSource && existing) {
        const outcome = await adjudicate(existing, input, sourceIntegrationId, now);
        conflictOutcome = outcome;
        if (conflictBlocksClaim(outcome)) {
          // Adericel refuses to choose. Both positions are marked DISPUTED, no
          // rule can read either, and every control resting on this predicate
          // reports UNKNOWN with the disagreement as its reason.
          await ctx.query(
            `UPDATE claims SET status = 'DISPUTED' WHERE id = $1 AND organisation_id = $2`,
            [existing.id, ctx.organisationId],
          );
          const disputed = await insertClaim(
            { ...input, status: 'DISPUTED' },
            actor,
            nodeId,
            sourceIntegrationId,
            existing.id,
            now,
          );
          await conflicts.record(outcome, subjectKey, disputed.id);
          const row = await requireRow(disputed.id);
          return {
            claim: toRecord(row),
            changed: true,
            supersededClaimId: existing.id,
            previousValue: existing.value,
            conflict: outcome,
          };
        }

        if (outcome.resolution === 'AGREED') {
          // Two independent systems now say the same thing. That is not a
          // conflict to list; any disagreement previously open here is over.
          await conflicts.close(input.predicate, subjectKey, now);
        } else {
          await conflicts.record(outcome, subjectKey, existing.id);
          // A resolved disagreement still means one source was overruled, and
          // the winning value is written as an ordinary claim below only when
          // it is the one being asserted now.
          const assertedWins =
            JSON.stringify(outcome.value ?? null) === JSON.stringify(input.value ?? null);
          if (!assertedWins) {
            // The incoming value lost. The existing claim stands; nothing is
            // superseded, and the conflict record explains why this source's
            // reading was not adopted.
            const row = await requireRow(existing.id);
            return {
              claim: toRecord(row),
              changed: false,
              supersededClaimId: null,
              previousValue: existing.value,
              conflict: outcome,
            };
          }
        }
      } else if (existing) {
        // Same source, or a source that has now become the only one. Any
        // disagreement previously recorded here is over.
        await conflicts.close(input.predicate, subjectKey, now);
      }

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
          const refreshed = await requireRow(existing.id);
          return {
            claim: toRecord(refreshed),
            changed: false,
            supersededClaimId: null,
            previousValue: existing.value,
            conflict: conflictOutcome,
          };
        }

        await ctx.query(
          `UPDATE claims SET status = 'SUPERSEDED' WHERE id = $1 AND organisation_id = $2`,
          [existing.id, ctx.organisationId],
        );
      }

      const inserted = await insertClaim(
        input,
        actor,
        nodeId,
        sourceIntegrationId,
        existing?.id ?? input.supersedesClaimId ?? null,
        now,
      );

      const row = await requireRow(inserted.id);

      return {
        claim: toRecord(row),
        changed: true,
        supersededClaimId: existing?.id ?? null,
        previousValue: existing?.value ?? null,
        conflict: conflictOutcome,
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
      return buildPage(rows.map(toRecord), limit, (claim) => ({
        k: claim.assertedAt,
        i: claim.id,
      }));
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
