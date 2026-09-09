import type { FastifyInstance } from 'fastify';
// Imported for its module augmentation, which adds `request.file()`.
import '@fastify/multipart';
import { z } from 'zod';
import {
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_STATUSES,
  claimInputSchema,
  evidenceIngestSchema,
  observationBatchSchema,
} from '@adericel/domain';
import {
  createClaimRepository,
  createEvidenceRepository,
  withUsability,
  type EvidenceView,
} from '@adericel/evidence';
import { createCollectionService } from '@adericel/actions';
import { publish } from '@adericel/graph';
import { AdericelError, bytesHash, pageRequestSchema } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery, organisationParam } from '../middleware/validation.js';
import { withIdempotency } from '../middleware/idempotency.js';

/**
 * Evidence, observation and claim routes.
 *
 * Evidence has no update endpoint. Correcting evidence means submitting a new
 * record that supersedes the old one; withdrawing it means revoking it. Both
 * leave the original readable, which is what keeps a historical assessment
 * explicable.
 */

const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

export function registerEvidenceRoutes(server: FastifyInstance, app: AppContext): void {
  server.get(
    '/v1/organisations/:organisationId/evidence',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:evidence:read');
      const query = parseQuery(
        request,
        pageRequestSchema.extend({
          status: z.array(z.enum(EVIDENCE_STATUSES)).or(z.enum(EVIDENCE_STATUSES)).optional(),
          sourceType: z.enum(EVIDENCE_SOURCE_TYPES).optional(),
          integrationId: z.string().uuid().optional(),
          subjectNodeId: z.string().uuid().optional(),
          search: z.string().max(200).optional(),
          onlyUsable: z.coerce.boolean().default(false),
        }),
      );

      const page = await app.db.withTenant(organisationId, async (ctx) =>
        createEvidenceRepository(ctx, app.clock).list(
          {
            ...(query.status
              ? { statuses: Array.isArray(query.status) ? query.status : [query.status] }
              : {}),
            ...(query.sourceType ? { sourceTypes: [query.sourceType] } : {}),
            ...(query.integrationId ? { integrationId: query.integrationId } : {}),
            ...(query.subjectNodeId ? { subjectNodeId: query.subjectNodeId } : {}),
            ...(query.search ? { search: query.search } : {}),
            onlyUsable: query.onlyUsable,
          },
          query.limit,
          query.cursor,
        ),
      );

      return reply.status(200).send({
        evidence: page.items.map((item) => ({
          id: item.id,
          title: item.title,
          sourceSystem: item.sourceSystem,
          sourceType: item.sourceType,
          collectionMethod: item.collectionMethod,
          integrityLevel: item.integrityLevel,
          status: item.status,
          // Usability is what a rule actually consults, so it is returned
          // alongside status rather than left for the caller to derive.
          usable: item.usable,
          usabilityReason: item.usabilityReason,
          freshness: item.freshness,
          ageDays: Number(item.ageDays.toFixed(2)),
          contentHash: item.contentHash,
          contentType: item.contentType,
          contentSizeBytes: item.contentSizeBytes,
          hasStoredArtefact: item.storageKey !== null,
          observedAt: item.observedAt,
          collectedAt: item.collectedAt,
          validFrom: item.validFrom,
          validUntil: item.validUntil,
          collectedByActor: item.collectedByActor,
        })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/evidence/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:evidence:read');

      const data = await app.db.withTenant(params.organisationId, async (ctx) => {
        const record = await createEvidenceRepository(ctx, app.clock).requireById(params.id);
        const subjects = await ctx.many<{ id: string; kind: string; label: string }>(
          `SELECT n.id, n.kind, n.label FROM evidence_subjects s
           JOIN graph_nodes n ON n.id = s.node_id
           WHERE s.evidence_id = $1 AND s.organisation_id = $2`,
          [params.id, params.organisationId],
        );
        const claims = await ctx.many<{
          id: string;
          predicate: string;
          value: unknown;
          status: string;
        }>(
          `SELECT c.id, c.predicate, c.value, c.status FROM claim_evidence ce
           JOIN claims c ON c.id = ce.claim_id
           WHERE ce.evidence_id = $1 AND ce.organisation_id = $2`,
          [params.id, params.organisationId],
        );
        const observations = await ctx.many<{ id: string; kind: string; collected_at: Date }>(
          `SELECT o.id, o.kind, o.collected_at FROM evidence_observations eo
           JOIN observations o ON o.id = eo.observation_id
           WHERE eo.evidence_id = $1 AND eo.organisation_id = $2`,
          [params.id, params.organisationId],
        );
        const supersession = await ctx.many<{ id: string; direction: string; collected_at: Date }>(
          `SELECT id, 'SUPERSEDED_BY' AS direction, collected_at FROM evidence
           WHERE organisation_id = $2 AND supersedes_evidence_id = $1
           UNION ALL
           SELECT supersedes_evidence_id AS id, 'SUPERSEDES' AS direction, collected_at FROM evidence
           WHERE organisation_id = $2 AND id = $1 AND supersedes_evidence_id IS NOT NULL`,
          [params.id, params.organisationId],
        );
        return { record, subjects, claims, observations, supersession };
      });

      const view: EvidenceView = withUsability(data.record, app.clock.nowIso());

      return reply.status(200).send({
        ...view,
        ageDays: Number(view.ageDays.toFixed(2)),
        subjects: data.subjects,
        claims: data.claims,
        observations: data.observations.map((o) => ({
          id: o.id,
          kind: o.kind,
          collectedAt: o.collected_at.toISOString(),
        })),
        lineage: data.supersession.map((s) => ({
          evidenceId: s.id,
          direction: s.direction,
          collectedAt: s.collected_at.toISOString(),
        })),
      });
    },
  );

  /** Download the stored artefact, verifying its hash before returning it. */
  server.get(
    '/v1/organisations/:organisationId/evidence/:id/content',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:evidence:read');

      const record = await app.db.withTenant(params.organisationId, async (ctx) =>
        createEvidenceRepository(ctx, app.clock).requireById(params.id),
      );

      if (!record.storageKey) {
        if (record.payload) {
          return reply.status(200).type('application/json').send(record.payload);
        }
        throw new AdericelError('NOT_FOUND', 'Evidence has no stored artefact');
      }

      const bytes = await app.storage.get(record.storageKey);
      const actualHash = bytesHash(bytes);
      if (actualHash !== record.contentHash) {
        // Integrity failure means the record and the artefact disagree. Serving
        // it anyway would let corrupted or tampered evidence support a claim.
        request.adericel.logger.error(
          { evidenceId: record.id, expected: record.contentHash, actual: actualHash },
          'evidence integrity check failed',
        );
        await audit(app, request, {
          action: 'evidence:integrity-failure',
          resourceType: 'Evidence',
          resourceId: record.id,
          outcome: 'FAILURE',
          reason: 'Stored artefact does not match its recorded hash',
        });
        throw new AdericelError(
          'EVIDENCE_UNAVAILABLE',
          'Stored artefact failed its integrity check and will not be served',
        );
      }

      await audit(app, request, {
        action: 'evidence:download',
        resourceType: 'Evidence',
        resourceId: record.id,
      });

      return reply
        .status(200)
        .type(record.contentType)
        .header('content-disposition', `attachment; filename="evidence-${record.id}"`)
        .header('x-content-hash', record.contentHash)
        .send(bytes);
    },
  );

  /** Record evidence supplied directly, e.g. an uploaded report or attestation. */
  server.post(
    '/v1/organisations/:organisationId/evidence',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:evidence:write');
      const body = parseBody(request, evidenceIngestSchema);
      const principal = request.adericel.principal;

      if (!app.config.security.allowedEvidenceMimeTypes.includes(body.contentType)) {
        throw new AdericelError('VALIDATION_FAILED', 'Content type is not permitted for evidence', {
          safeDetails: {
            contentType: body.contentType,
            allowed: app.config.security.allowedEvidenceMimeTypes,
          },
        });
      }

      const outcome = await withIdempotency(app, request, async () => {
        const result = await app.db.withTenant(organisationId, async (ctx) => {
          const rootNode = await ctx.oneOrFail<{ id: string }>(
            `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
            [organisationId],
            'Organisation node',
          );
          const ingest = await createEvidenceRepository(ctx, app.clock).ingest(
            body,
            principal?.displayName ?? 'api',
            body.subjectNodeIds[0] ?? rootNode.id,
          );

          if (!ingest.deduplicated) {
            await publish(
              ctx,
              {
                type: 'EvidenceCreated',
                organisationId,
                subjectType: 'Evidence',
                subjectId: ingest.evidence.id,
                payload: {
                  sourceSystem: body.sourceSystem,
                  sourceType: body.sourceType,
                  title: body.title,
                },
                correlationId: request.adericel.correlationId,
                actor: principal?.displayName ?? 'api',
              },
              app.clock.nowIso(),
            );
          }
          return ingest;
        });

        return {
          status: result.deduplicated ? 200 : 201,
          body: {
            id: result.evidence.id,
            contentHash: result.evidence.contentHash,
            deduplicated: result.deduplicated,
            supersededEvidenceId: result.supersededEvidenceId,
            validUntil: result.evidence.validUntil,
          },
        };
      });

      await audit(app, request, {
        action: 'evidence:create',
        resourceType: 'Evidence',
        resourceId: (outcome.body as { id: string }).id,
        metadata: { sourceSystem: body.sourceSystem, replayed: outcome.replayed },
      });

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  /** Upload a file as evidence: stored, hashed and linked in one operation. */
  server.post(
    '/v1/organisations/:organisationId/evidence/upload',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:evidence:write');
      const principal = request.adericel.principal;

      const file = await request.file({ limits: { fileSize: app.config.storage.maxUploadBytes } });
      if (!file) throw new AdericelError('VALIDATION_FAILED', 'No file was supplied');

      const contentType = file.mimetype || 'application/octet-stream';
      if (!app.config.security.allowedEvidenceMimeTypes.includes(contentType)) {
        throw new AdericelError('VALIDATION_FAILED', 'Content type is not permitted for evidence', {
          safeDetails: { contentType },
        });
      }

      const buffer = await file.toBuffer();
      const fields = file.fields as Record<string, { value?: string } | undefined>;
      const title = fields.title?.value ?? file.filename;
      const sourceSystem = fields.sourceSystem?.value ?? 'manual-upload';
      const subjectNodeIds = (fields.subjectNodeIds?.value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f-]{36}$/i.test(s));

      const stored = await app.storage.put(organisationId, buffer, {
        contentType,
        filename: file.filename,
      });

      const result = await app.db.withTenant(organisationId, async (ctx) => {
        const rootNode = await ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
          [organisationId],
          'Organisation node',
        );
        const ingest = await createEvidenceRepository(ctx, app.clock).ingest(
          {
            sourceType: 'DOCUMENT_UPLOAD',
            collectionMethod: 'HUMAN_UPLOAD',
            integrationId: null,
            sourceSystem,
            sourceReference: file.filename,
            title,
            contentType,
            payload: null,
            storageKey: stored.key,
            contentHash: stored.contentHash,
            contentSizeBytes: stored.sizeBytes,
            // A file we stored ourselves and hashed on the way in is
            // hash-verified, not source-authenticated: we can prove it has not
            // changed since upload, not that its contents are true.
            integrityLevel: 'HASH_VERIFIED',
            observedAt: null,
            subjectNodeIds,
            metadata: {
              originalFilename: file.filename,
              uploadedBy: principal?.displayName ?? 'api',
            },
          },
          principal?.displayName ?? 'api',
          subjectNodeIds[0] ?? rootNode.id,
        );

        await publish(
          ctx,
          {
            type: 'EvidenceCreated',
            organisationId,
            subjectType: 'Evidence',
            subjectId: ingest.evidence.id,
            payload: { sourceType: 'DOCUMENT_UPLOAD', title, sizeBytes: stored.sizeBytes },
            correlationId: request.adericel.correlationId,
            actor: principal?.displayName ?? 'api',
          },
          app.clock.nowIso(),
        );
        return ingest;
      });

      await audit(app, request, {
        action: 'evidence:upload',
        resourceType: 'Evidence',
        resourceId: result.evidence.id,
        metadata: { filename: file.filename, sizeBytes: stored.sizeBytes },
      });

      return reply.status(201).send({
        id: result.evidence.id,
        contentHash: result.evidence.contentHash,
        sizeBytes: stored.sizeBytes,
        deduplicated: result.deduplicated,
      });
    },
  );

  /** Revoke evidence. Assessments that relied on it become UNKNOWN, not false. */
  server.post(
    '/v1/organisations/:organisationId/evidence/:id/revoke',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:evidence:revoke');
      const body = parseBody(request, z.object({ reason: z.string().min(5).max(1000) }));
      const principal = request.adericel.principal;

      const record = await app.db.withTenant(params.organisationId, async (ctx) => {
        const revoked = await createEvidenceRepository(ctx, app.clock).revoke(
          params.id,
          body.reason,
          principal?.displayName ?? 'api',
        );
        await publish(
          ctx,
          {
            type: 'EvidenceRevoked',
            organisationId: params.organisationId,
            subjectType: 'Evidence',
            subjectId: params.id,
            payload: { reason: body.reason },
            correlationId: request.adericel.correlationId,
            actor: principal?.displayName ?? 'api',
          },
          app.clock.nowIso(),
        );
        return revoked;
      });

      await audit(app, request, {
        action: 'evidence:revoke',
        resourceType: 'Evidence',
        resourceId: params.id,
        metadata: { reason: body.reason },
      });

      return reply
        .status(200)
        .send({ id: record.id, status: record.status, revokedAt: record.revokedAt });
    },
  );

  /**
   * Push observations in from outside — an n8n workflow, a customer script, an
   * MSP platform. They travel the same pipeline as connector output, so pushed
   * data gets the same provenance and normalisation as pulled data.
   */
  server.post(
    '/v1/organisations/:organisationId/observations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:evidence:write');
      const body = parseBody(request, observationBatchSchema);
      const principal = request.adericel.principal;

      const outcome = await withIdempotency(app, request, async () => {
        const result = await app.db.withTenant(organisationId, async (ctx) =>
          createCollectionService({
            ctx,
            clock: app.clock,
            logger: request.adericel.logger,
            connectors: app.connectors,
            correlationId: request.adericel.correlationId,
            actor: principal?.displayName ?? 'api',
            unsealCredentials: app.unsealCredentials,
          }).ingestObservations(body.observations, {
            integrationId: body.integrationId ?? null,
            sourceSystem: body.observations[0]?.sourceSystem ?? 'external',
          }),
        );
        return {
          status: 201,
          body: {
            observationsRecorded: result.observationsRecorded,
            evidenceCreated: result.evidenceCreated,
            claimsChanged: result.claimsChanged,
            nodesUpserted: result.nodesUpserted,
          },
        };
      });

      await audit(app, request, {
        action: 'observation:ingest',
        resourceType: 'Observation',
        metadata: { count: body.observations.length, replayed: outcome.replayed },
      });

      return reply.status(outcome.status).send(outcome.body);
    },
  );

  server.get(
    '/v1/organisations/:organisationId/claims',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:claim:read');
      const query = parseQuery(
        request,
        pageRequestSchema.extend({
          predicate: z.string().max(200).optional(),
          subjectNodeId: z.string().uuid().optional(),
          origin: z
            .enum([
              'DETERMINISTIC_NORMALISATION',
              'INTEGRATION_ASSERTED',
              'HUMAN_ASSERTED',
              'AI_SUGGESTED',
              'VERIFICATION_DERIVED',
            ])
            .optional(),
          status: z
            .enum(['CANDIDATE', 'CONFIRMED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN'])
            .optional(),
        }),
      );

      const page = await app.db.withTenant(organisationId, async (ctx) =>
        createClaimRepository(ctx, app.clock).list(
          {
            ...(query.predicate ? { predicates: [query.predicate] } : {}),
            ...(query.subjectNodeId ? { subjectNodeId: query.subjectNodeId } : {}),
            ...(query.origin ? { origins: [query.origin] } : {}),
            ...(query.status ? { statuses: [query.status] } : {}),
          },
          query.limit,
          query.cursor,
        ),
      );

      return reply.status(200).send({
        claims: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );

  /**
   * Assert a claim directly.
   *
   * AI-suggested claims are accepted here but enter as CANDIDATE, and the Truth
   * Engine will not consume a candidate AI claim. Promotion to CONFIRMED is a
   * separate, audited human decision.
   */
  server.post(
    '/v1/organisations/:organisationId/claims',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:claim:write');
      const body = parseBody(request, claimInputSchema);
      const principal = request.adericel.principal;

      if (body.origin === 'AI_SUGGESTED' && body.status === 'CONFIRMED') {
        throw new AdericelError(
          'VALIDATION_FAILED',
          'An AI-suggested claim cannot be created as CONFIRMED. Create it as a candidate and confirm it explicitly.',
        );
      }

      const result = await app.db.withTenant(organisationId, async (ctx) => {
        const rootNode = await ctx.oneOrFail<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
          [organisationId],
          'Organisation node',
        );
        const asserted = await createClaimRepository(ctx, app.clock).assert(
          body,
          principal?.displayName ?? 'api',
          body.subjectNodeId ?? rootNode.id,
        );
        if (asserted.changed) {
          await publish(
            ctx,
            {
              type: 'ClaimChanged',
              organisationId,
              subjectType: 'Claim',
              subjectId: asserted.claim.id,
              payload: {
                predicate: asserted.claim.predicate,
                value: asserted.claim.value,
                previousValue: asserted.previousValue,
                origin: asserted.claim.origin,
              },
              correlationId: request.adericel.correlationId,
              actor: principal?.displayName ?? 'api',
            },
            app.clock.nowIso(),
          );
        }
        return asserted;
      });

      await audit(app, request, {
        action: 'claim:assert',
        resourceType: 'Claim',
        resourceId: result.claim.id,
        metadata: { predicate: body.predicate, origin: body.origin, changed: result.changed },
      });

      return reply.status(result.changed ? 201 : 200).send({
        claim: result.claim,
        changed: result.changed,
        supersededClaimId: result.supersededClaimId,
      });
    },
  );

  /** Confirm an AI-suggested or candidate claim. This is the AI/truth gate. */
  server.post(
    '/v1/organisations/:organisationId/claims/:id/confirm',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:claim:write');
      const principal = request.adericel.principal;

      if (principal?.principalType !== 'USER') {
        // Confirming a claim is what allows AI output to influence truth. Only
        // a person may do it; a workflow or API key cannot self-certify.
        throw new AdericelError(
          'FORBIDDEN',
          'Only a signed-in user may confirm a claim. This is the boundary that stops AI output becoming truth without human judgement.',
        );
      }

      const claim = await app.db.withTenant(params.organisationId, async (ctx) => {
        const confirmed = await createClaimRepository(ctx, app.clock).confirm(
          params.id,
          principal.displayName,
        );
        await publish(
          ctx,
          {
            type: 'ClaimConfirmed',
            organisationId: params.organisationId,
            subjectType: 'Claim',
            subjectId: params.id,
            payload: { predicate: confirmed.predicate, confirmedBy: principal.principalId },
            correlationId: request.adericel.correlationId,
            actor: principal.displayName,
          },
          app.clock.nowIso(),
        );
        return confirmed;
      });

      await audit(app, request, {
        action: 'claim:confirm',
        resourceType: 'Claim',
        resourceId: params.id,
        metadata: { predicate: claim.predicate, origin: claim.origin },
      });

      return reply.status(200).send({ claim });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/claims/:id/reject',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:claim:write');
      const body = parseBody(request, z.object({ reason: z.string().min(3).max(1000) }));
      const principal = request.adericel.principal;

      const claim = await app.db.withTenant(params.organisationId, async (ctx) =>
        createClaimRepository(ctx, app.clock).reject(
          params.id,
          body.reason,
          principal?.displayName ?? 'api',
        ),
      );

      await audit(app, request, {
        action: 'claim:reject',
        resourceType: 'Claim',
        resourceId: params.id,
        metadata: { reason: body.reason },
      });

      return reply.status(200).send({ claim });
    },
  );
}
