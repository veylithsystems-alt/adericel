import type { NewDomainEvent, NodeKind, ObservationRecord } from '@adericel/domain';
import {
  createClaimRepository,
  createEvidenceRepository,
  createObservationRepository,
} from '@adericel/evidence';
import { createNodeRepository, publish, type TenantContext } from '@adericel/graph';
import { normalise, type Connector, type ConnectorRegistry } from '@adericel/integrations';
import { AdericelError, contentHash, errorFields, type Clock, type Logger } from '@adericel/shared';
import type { CredentialUnsealer } from './action-service.js';

/**
 * Collection pipeline.
 *
 * Reality -> observation -> evidence -> claim.
 *
 * Each hop is recorded so an assurance conclusion can be walked back to the API
 * response that produced it. Observations are deduplicated on content, evidence
 * is deduplicated on content hash, and claims supersede rather than mutate — so
 * repeated collection converges rather than accumulating.
 */

export interface CollectionServiceDeps {
  readonly ctx: TenantContext;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly connectors: ConnectorRegistry;
  readonly correlationId: string;
  readonly actor: string;
  readonly unsealCredentials: CredentialUnsealer;
}

export interface CollectionOutcome {
  readonly integrationId: string;
  readonly runId: string;
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly observationsRecorded: number;
  readonly observationsDeduplicated: number;
  readonly evidenceCreated: number;
  readonly claimsChanged: number;
  readonly nodesUpserted: number;
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly events: readonly NewDomainEvent[];
}

export interface IngestOutcome {
  readonly observationsRecorded: number;
  readonly evidenceCreated: number;
  readonly claimsChanged: number;
  readonly nodesUpserted: number;
  readonly events: readonly NewDomainEvent[];
}

export interface CollectionService {
  /** Run a connector and process everything it returns. */
  runIntegration(integrationId: string, trigger: string): Promise<CollectionOutcome>;
  /** Process observations pushed in from outside, e.g. by n8n or a webhook. */
  ingestObservations(
    observations: readonly Parameters<
      ReturnType<typeof createObservationRepository>['record']
    >[0][number][],
    options: { integrationId: string | null; sourceSystem: string },
  ): Promise<IngestOutcome>;
  /** Re-read one predicate for one subject, used by action verification. */
  reobserve(integrationId: string, subjectExternalId: string, predicate: string): Promise<unknown>;
}

export function createCollectionService(deps: CollectionServiceDeps): CollectionService {
  const { ctx, clock, logger, connectors, correlationId, actor } = deps;
  const nodes = createNodeRepository(ctx);
  const observations = createObservationRepository(ctx, clock);
  const evidence = createEvidenceRepository(ctx, clock);
  const claims = createClaimRepository(ctx, clock);

  async function loadIntegration(integrationId: string): Promise<{
    id: string;
    connectorKey: string;
    connector: Connector;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    cursor: string | null;
  }> {
    const row = await ctx.oneOrFail<{
      id: string;
      connector_key: string;
      configuration: Record<string, unknown>;
      sealed_credentials: string | null;
      status: string;
    }>(
      `SELECT id, connector_key, configuration, sealed_credentials, status
       FROM integrations WHERE id = $1 AND organisation_id = $2`,
      [integrationId, ctx.organisationId],
      'Integration',
    );
    if (row.status === 'DISABLED') {
      throw new AdericelError('PRECONDITION_FAILED', 'Integration is disabled');
    }
    const cursorRow = await ctx.one<{ cursor: string | null }>(
      `SELECT configuration->>'cursor' AS cursor FROM integrations WHERE id = $1`,
      [integrationId],
    );
    return {
      id: row.id,
      connectorKey: row.connector_key,
      connector: connectors.get(row.connector_key),
      config: row.configuration,
      credentials: row.sealed_credentials
        ? await deps.unsealCredentials(row.sealed_credentials, row.id, ctx.organisationId)
        : {},
      cursor: cursorRow?.cursor ?? null,
    };
  }

  /**
   * Turn recorded observations into evidence, subjects and claims.
   *
   * Evidence is created per observation so provenance stays one-to-one: a claim
   * cites the exact artefact it came from, and revoking that artefact
   * invalidates exactly the claims it supported and no others.
   */
  async function process(
    recorded: readonly ObservationRecord[],
    integrationId: string | null,
    sourceSystem: string,
  ): Promise<IngestOutcome> {
    const now = clock.nowIso();
    const events: NewDomainEvent[] = [];
    let evidenceCreated = 0;
    let claimsChanged = 0;
    let nodesUpserted = 0;

    // Group by subject so one evidence artefact per observation still yields a
    // single upserted node per subject.
    const nodeIdByExternalId = new Map<string, string>();

    for (const observation of recorded) {
      const normalisation = normalise(observation);

      for (const subject of normalisation.subjects) {
        if (!subject.externalId) continue;
        const node = await nodes.upsert({
          kind: subject.kind as NodeKind,
          externalId: subject.externalId,
          label: subject.label,
          attributes: subject.attributes,
          sourceIntegrationId: integrationId,
          observedAt: observation.observedAt ?? observation.collectedAt,
        });
        nodeIdByExternalId.set(subject.externalId, node.id);
        nodesUpserted += 1;
      }

      const organisationNode = await ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM graph_nodes WHERE organisation_id = $1 AND kind = 'Organisation' LIMIT 1`,
        [ctx.organisationId],
        'Organisation node',
      );

      const subjectNodeIds = normalisation.subjects
        .map((s) => nodeIdByExternalId.get(s.externalId))
        .filter((id): id is string => id !== undefined);

      const ingest = await evidence.ingest(
        {
          sourceType: 'INTEGRATION_API',
          collectionMethod: 'AUTOMATED_PULL',
          integrationId,
          sourceSystem,
          sourceReference: observation.subjectExternalId,
          title: `${observation.kind} from ${sourceSystem}`,
          contentType: 'application/json',
          payload: observation.payload,
          integrityLevel: 'SOURCE_AUTHENTICATED',
          observedAt: observation.observedAt,
          collectedAt: observation.collectedAt,
          subjectNodeIds,
          metadata: { observationId: observation.id, observationKind: observation.kind },
        },
        actor,
        subjectNodeIds[0] ?? organisationNode.id,
      );

      if (!ingest.deduplicated) {
        evidenceCreated += 1;
        events.push({
          type: 'EvidenceCreated',
          organisationId: ctx.organisationId,
          subjectType: 'Evidence',
          subjectId: ingest.evidence.id,
          payload: {
            sourceSystem,
            sourceType: 'INTEGRATION_API',
            observationKind: observation.kind,
            subjectNodeIds,
          },
          correlationId,
          actor,
        });
      }
      await observations.linkEvidence([observation.id], ingest.evidence.id);

      for (const claimInput of normalisation.claims) {
        const subjectNodeId = claimInput.subjectExternalId
          ? (nodeIdByExternalId.get(claimInput.subjectExternalId) ??
            (
              await nodes.findByExternalId(
                inferKind(claimInput.predicate),
                claimInput.subjectExternalId,
              )
            )?.id ??
            null)
          : null;

        // A claim whose subject we cannot resolve would be unattributable, and
        // an unattributable claim can never be assessed. Skipping it keeps the
        // control UNKNOWN, which is the honest outcome.
        if (claimInput.subjectExternalId && subjectNodeId === null) {
          logger.debug(
            { predicate: claimInput.predicate, subject: claimInput.subjectExternalId },
            'skipping claim with unresolved subject',
          );
          continue;
        }

        const result = await claims.assert(
          {
            predicate: claimInput.predicate,
            subjectNodeId,
            subjectExternalId: claimInput.subjectExternalId,
            value: claimInput.value,
            origin: 'DETERMINISTIC_NORMALISATION',
            // Deterministic normalisation is checkable by reading the
            // normaliser, so its output is confirmed rather than candidate.
            status: 'CONFIRMED',
            extractionConfidence: null,
            evidenceIds: [ingest.evidence.id],
            observedAt: claimInput.observedAt,
            validUntil: claimInput.validUntil,
            supersedesClaimId: null,
            metadata: {},
          },
          actor,
          subjectNodeId ?? organisationNode.id,
        );

        if (result.changed) {
          claimsChanged += 1;
          events.push({
            type: 'ClaimChanged',
            organisationId: ctx.organisationId,
            subjectType: 'Claim',
            subjectId: result.claim.id,
            payload: {
              predicate: result.claim.predicate,
              subjectNodeId,
              previousValue: result.previousValue,
              value: result.claim.value,
              evidenceId: ingest.evidence.id,
            },
            correlationId,
            actor,
          });
        }
      }
    }

    for (const event of events) await publish(ctx, event, now);

    return {
      observationsRecorded: recorded.length,
      evidenceCreated,
      claimsChanged,
      nodesUpserted,
      events,
    };
  }

  const service: CollectionService = {
    async runIntegration(integrationId, trigger): Promise<CollectionOutcome> {
      const now = clock.nowIso();
      const integration = await loadIntegration(integrationId);

      const run = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO integration_runs
           (organisation_id, integration_id, trigger, status, correlation_id, started_at)
         VALUES ($1, $2, $3, 'RUNNING', $4, $5)
         RETURNING id`,
        [ctx.organisationId, integrationId, trigger, correlationId, now],
        'Integration run',
      );

      try {
        const config = integration.connector.configSchema.parse(integration.config);
        const credentials = integration.connector.credentialSchema.parse(integration.credentials);

        const result = await integration.connector.collect(config, credentials, {
          organisationId: ctx.organisationId,
          integrationId: integration.id,
          logger,
          correlationId,
          nowIso: now,
          cursor: integration.cursor,
        });

        const recorded = await observations.record(result.observations, {
          integrationId: integration.id,
          integrationRunId: run.id,
          correlationId,
        });

        const processed = await process(
          recorded.recorded,
          integration.id,
          integration.connector.key,
        );

        // Only an explicit partial signal degrades the integration. Advisory
        // warnings are recorded but do not imply the collection was incomplete.
        const status = result.partial === true ? 'PARTIAL' : 'SUCCEEDED';

        await ctx.query(
          `UPDATE integration_runs
           SET status = $2, observations_count = $3, evidence_count = $4, finished_at = now()
           WHERE id = $1`,
          [run.id, status, recorded.recorded.length, processed.evidenceCreated],
        );
        await ctx.query(
          `UPDATE integrations
           SET status = $2, last_run_at = $3::timestamptz, last_success_at = $3::timestamptz,
               consecutive_failures = 0, last_error = NULL,
               configuration = configuration || jsonb_build_object('cursor', $4::text)
           WHERE id = $1`,
          [integration.id, status === 'PARTIAL' ? 'DEGRADED' : 'CONNECTED', now, result.cursor],
        );

        return {
          integrationId: integration.id,
          runId: run.id,
          status,
          observationsRecorded: recorded.recorded.length,
          observationsDeduplicated: recorded.duplicates,
          evidenceCreated: processed.evidenceCreated,
          claimsChanged: processed.claimsChanged,
          nodesUpserted: processed.nodesUpserted,
          warnings: result.warnings,
          error: null,
          events: processed.events,
        };
      } catch (error) {
        const message = (error as Error).message;
        logger.error({ integrationId, ...errorFields(error) }, 'integration collection failed');

        await ctx.query(
          `UPDATE integration_runs
           SET status = 'FAILED', error_detail = $2, finished_at = now()
           WHERE id = $1`,
          [run.id, message.slice(0, 2000)],
        );
        await ctx.query(
          `UPDATE integrations
           SET status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'FAILED' ELSE 'DEGRADED' END,
               last_run_at = $2::timestamptz,
               consecutive_failures = consecutive_failures + 1,
               last_error = $3
           WHERE id = $1`,
          [integration.id, now, message.slice(0, 2000)],
        );

        const event: NewDomainEvent = {
          type: 'IntegrationCollectionFailed',
          organisationId: ctx.organisationId,
          subjectType: 'Integration',
          subjectId: integration.id,
          payload: { connectorKey: integration.connectorKey, error: message.slice(0, 500) },
          correlationId,
          actor,
        };
        await publish(ctx, event, now);

        return {
          integrationId: integration.id,
          runId: run.id,
          status: 'FAILED',
          observationsRecorded: 0,
          observationsDeduplicated: 0,
          evidenceCreated: 0,
          claimsChanged: 0,
          nodesUpserted: 0,
          warnings: [],
          error: message,
          events: [event],
        };
      }
    },

    async ingestObservations(input, options): Promise<IngestOutcome> {
      const recorded = await observations.record(input, {
        integrationId: options.integrationId,
        integrationRunId: null,
        correlationId,
      });
      return process(recorded.recorded, options.integrationId, options.sourceSystem);
    },

    async reobserve(integrationId, subjectExternalId, predicate): Promise<unknown> {
      // Verification re-runs the connector and reads the claim that results.
      // It deliberately goes back to the source rather than trusting the
      // execution's own report of success.
      await service.runIntegration(integrationId, 'VERIFICATION');
      const row = await ctx.one<{ value: unknown }>(
        `SELECT c.value FROM claims c
         JOIN graph_nodes n ON n.id = c.subject_node_id
         WHERE c.organisation_id = $1 AND c.predicate = $2 AND n.external_id = $3
           AND c.status IN ('CANDIDATE', 'CONFIRMED')
         ORDER BY c.asserted_at DESC LIMIT 1`,
        [ctx.organisationId, predicate, subjectExternalId],
      );
      return row?.value;
    },
  };

  return service;
}

/**
 * Infer the node kind a predicate speaks about, used only to resolve a subject
 * that was upserted by an earlier observation in the same run.
 */
function inferKind(predicate: string): NodeKind {
  const [namespace] = predicate.split('.');
  switch (namespace) {
    case 'identity':
      return 'Identity';
    case 'device':
      return 'Device';
    case 'cloud':
      return 'CloudResource';
    case 'data':
      return 'DataAsset';
    case 'policy':
      return 'Policy';
    case 'supplier':
      return 'Supplier';
    default:
      return 'Application';
  }
}

export { contentHash };
