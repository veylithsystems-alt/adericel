import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCollectionService } from '@adericel/actions';
import { publish } from '@adericel/graph';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation } from '../middleware/request-context.js';
import { parseBody, parseParams, organisationParam } from '../middleware/validation.js';

/**
 * Integration management.
 *
 * Credentials go in and never come out. There is no endpoint that returns a
 * credential, and the sealed blob is never included in any response — the only
 * thing a caller can learn is whether the connection currently works.
 */

const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

export function registerIntegrationRoutes(server: FastifyInstance, app: AppContext): void {
  /** The connectors this deployment can run, and what each one requires. */
  server.get('/v1/connectors', { preHandler: server.authenticate }, async (_request, reply) =>
    reply.status(200).send({
      connectors: app.connectors.list().map((connector) => ({
        key: connector.key,
        name: connector.name,
        vendor: connector.vendor,
        category: connector.category,
        description: connector.description,
        authKind: connector.authKind,
        defaultSchedule: connector.defaultSchedule,
        // Documented up front so an MSP can raise the access request before
        // starting the connection, rather than discovering it half way through.
        requiredPermissions: connector.requiredPermissions,
        capabilities: connector.capabilities.map((c) => ({
          actionType: c.actionType,
          title: c.title,
          riskClass: c.riskClass,
          verification: c.verification.description,
        })),
        configSchema: safeJsonSchema(connector.configSchema),
        credentialFields: safeJsonSchema(connector.credentialSchema),
      })),
    }),
  );

  server.get(
    '/v1/organisations/:organisationId/integrations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:integration:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          connector_key: string;
          name: string;
          status: string;
          configuration: Record<string, unknown>;
          schedule_cron: string | null;
          last_run_at: Date | null;
          last_success_at: Date | null;
          last_error: string | null;
          consecutive_failures: number;
          credential_updated_at: Date | null;
          observation_count: string;
        }>(
          `SELECT i.id, i.connector_key, i.name, i.status, i.configuration, i.schedule_cron,
                  i.last_run_at, i.last_success_at, i.last_error, i.consecutive_failures,
                  i.credential_updated_at,
                  (SELECT count(*)::text FROM observations o WHERE o.integration_id = i.id) AS observation_count
           FROM integrations i WHERE i.organisation_id = $1 ORDER BY i.name`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        integrations: rows.map((row) => ({
          id: row.id,
          connectorKey: row.connector_key,
          name: row.name,
          status: row.status,
          // The cursor is internal bookkeeping, not configuration.
          configuration: redactConfiguration(row.configuration),
          scheduleCron: row.schedule_cron,
          lastRunAt: row.last_run_at?.toISOString() ?? null,
          lastSuccessAt: row.last_success_at?.toISOString() ?? null,
          lastError: row.last_error,
          consecutiveFailures: row.consecutive_failures,
          credentialsConfigured: row.credential_updated_at !== null,
          observationCount: Number(row.observation_count),
        })),
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/integrations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:integration:manage');
      const body = parseBody(
        request,
        z.object({
          connectorKey: z.string().min(1).max(120),
          name: z.string().min(1).max(200),
          configuration: z.record(z.string(), z.unknown()).default({}),
          credentials: z.record(z.string(), z.unknown()).default({}),
          scheduleCron: z.string().max(120).nullable().optional(),
        }),
      );

      const connector = app.connectors.tryGet(body.connectorKey);
      if (!connector) {
        throw new AdericelError('VALIDATION_FAILED', `Unknown connector ${body.connectorKey}`, {
          safeDetails: { available: app.connectors.list().map((c) => c.key) },
        });
      }

      // Validate before storing, so a misconfigured integration fails at
      // creation rather than at 3am during a scheduled run.
      const config = connector.configSchema.parse(body.configuration);
      const credentials = connector.credentialSchema.parse(body.credentials);

      const created = await app.db.withTenant(organisationId, async (ctx) => {
        const node = await ctx.oneOrFail<{ id: string }>(
          `INSERT INTO graph_nodes (organisation_id, kind, external_id, label, attributes)
           VALUES ($1, 'Integration', $2, $3, $4::jsonb)
           ON CONFLICT (organisation_id, kind, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET label = EXCLUDED.label
           RETURNING id`,
          [
            organisationId,
            `integration:${body.connectorKey}:${body.name}`,
            body.name,
            JSON.stringify({ connectorKey: body.connectorKey }),
          ],
          'Integration node',
        );

        const row = await ctx.oneOrFail<{ id: string; status: string }>(
          `INSERT INTO integrations
             (organisation_id, node_id, connector_key, name, status, configuration, schedule_cron)
           VALUES ($1, $2, $3, $4, 'CONFIGURED', $5::jsonb, $6)
           RETURNING id, status`,
          [
            organisationId,
            node.id,
            body.connectorKey,
            body.name,
            JSON.stringify(config),
            body.scheduleCron ?? connector.defaultSchedule,
          ],
          'Integration',
        );

        // The integration id is the AAD for the sealed credentials, so a blob
        // copied to a different integration row simply fails to decrypt.
        const sealed = app.credentials.encrypt(JSON.stringify(credentials), row.id);
        await ctx.query(
          `UPDATE integrations SET sealed_credentials = $2, credential_updated_at = now() WHERE id = $1`,
          [row.id, sealed],
        );

        await publish(
          ctx,
          {
            type: 'IntegrationConnected',
            organisationId,
            subjectType: 'Integration',
            subjectId: row.id,
            payload: { connectorKey: body.connectorKey, name: body.name },
            correlationId: request.adericel.correlationId,
            actor: request.adericel.principal?.displayName ?? 'api',
          },
          app.clock.nowIso(),
        );
        return row;
      });

      await audit(app, request, {
        action: 'integration:create',
        resourceType: 'Integration',
        resourceId: created.id,
        metadata: { connectorKey: body.connectorKey, name: body.name },
      });

      return reply.status(201).send({ id: created.id, status: created.status });
    },
  );

  /** Check the connection and report what the credentials can actually do. */
  server.post(
    '/v1/organisations/:organisationId/integrations/:id/check',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:integration:manage');

      const result = await app.db.withTenant(params.organisationId, async (ctx) => {
        const row = await ctx.oneOrFail<{
          id: string;
          connector_key: string;
          configuration: Record<string, unknown>;
          sealed_credentials: string | null;
        }>(
          `SELECT id, connector_key, configuration, sealed_credentials
           FROM integrations WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
          'Integration',
        );

        const connector = app.connectors.get(row.connector_key);
        const check = await connector.checkConnection(
          connector.configSchema.parse(row.configuration),
          connector.credentialSchema.parse(
            row.sealed_credentials ? app.unsealCredentials(row.sealed_credentials, row.id) : {},
          ),
          {
            organisationId: params.organisationId,
            integrationId: row.id,
            logger: request.adericel.logger,
            correlationId: request.adericel.correlationId,
            nowIso: app.clock.nowIso(),
            cursor: null,
          },
        );

        await ctx.query(`UPDATE integrations SET status = $2, last_error = $3 WHERE id = $1`, [
          row.id,
          check.connected ? 'CONNECTED' : 'FAILED',
          check.connected ? null : check.detail,
        ]);
        return check;
      });

      await audit(app, request, {
        action: 'integration:check',
        resourceType: 'Integration',
        resourceId: params.id,
        outcome: result.connected ? 'SUCCESS' : 'FAILURE',
        reason: result.detail,
      });

      return reply.status(200).send({
        connected: result.connected,
        detail: result.detail,
        grantedScopes: result.grantedScopes ?? [],
        // Missing permissions are surfaced rather than hidden, because they
        // determine which controls will report UNKNOWN.
        missingScopes: result.missingScopes ?? [],
      });
    },
  );

  /**
   * Run a collection now.
   *
   * Gated on evidence:write rather than integration:manage. Triggering a
   * collection produces evidence; it does not change how the integration is
   * configured or what credentials it holds. An analyst who can record evidence
   * by hand should not need elevated rights to refresh it from the source.
   */
  server.post(
    '/v1/organisations/:organisationId/integrations/:id/collect',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:evidence:write');

      const outcome = await app.db.withTenant(params.organisationId, async (ctx) =>
        createCollectionService({
          ctx,
          clock: app.clock,
          logger: request.adericel.logger,
          connectors: app.connectors,
          correlationId: request.adericel.correlationId,
          actor: request.adericel.principal?.displayName ?? 'api',
          unsealCredentials: app.unsealCredentials,
        }).runIntegration(params.id, 'MANUAL'),
      );

      await audit(app, request, {
        action: 'integration:collect',
        resourceType: 'Integration',
        resourceId: params.id,
        outcome: outcome.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
        reason: outcome.error,
        metadata: {
          observations: outcome.observationsRecorded,
          evidence: outcome.evidenceCreated,
          claims: outcome.claimsChanged,
        },
      });

      return reply.status(outcome.status === 'FAILED' ? 502 : 200).send({
        runId: outcome.runId,
        status: outcome.status,
        observationsRecorded: outcome.observationsRecorded,
        observationsDeduplicated: outcome.observationsDeduplicated,
        evidenceCreated: outcome.evidenceCreated,
        claimsChanged: outcome.claimsChanged,
        nodesUpserted: outcome.nodesUpserted,
        warnings: outcome.warnings,
        error: outcome.error,
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/integrations/:id/runs',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:integration:read');

      const rows = await app.db.withTenant(params.organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          trigger: string;
          status: string;
          observations_count: number;
          evidence_count: number;
          error_detail: string | null;
          started_at: Date;
          finished_at: Date | null;
        }>(
          `SELECT id, trigger, status, observations_count, evidence_count, error_detail,
                  started_at, finished_at
           FROM integration_runs
           WHERE integration_id = $1 AND organisation_id = $2
           ORDER BY started_at DESC LIMIT 50`,
          [params.id, params.organisationId],
        ),
      );

      return reply.status(200).send({
        runs: rows.map((row) => ({
          id: row.id,
          trigger: row.trigger,
          status: row.status,
          observationsCount: row.observations_count,
          evidenceCount: row.evidence_count,
          errorDetail: row.error_detail,
          startedAt: row.started_at.toISOString(),
          finishedAt: row.finished_at?.toISOString() ?? null,
          durationMs: row.finished_at ? row.finished_at.getTime() - row.started_at.getTime() : null,
        })),
      });
    },
  );

  /** Rotate credentials. The previous value is overwritten, never returned. */
  server.put(
    '/v1/organisations/:organisationId/integrations/:id/credentials',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:integration:manage');
      const body = parseBody(request, z.object({ credentials: z.record(z.string(), z.unknown()) }));

      await app.db.withTenant(params.organisationId, async (ctx) => {
        const row = await ctx.oneOrFail<{ id: string; connector_key: string }>(
          `SELECT id, connector_key FROM integrations WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
          'Integration',
        );
        const connector = app.connectors.get(row.connector_key);
        const parsed = connector.credentialSchema.parse(body.credentials);
        const sealed = app.credentials.encrypt(JSON.stringify(parsed), row.id);
        await ctx.query(
          `UPDATE integrations
           SET sealed_credentials = $2, credential_updated_at = now(),
               status = 'CONFIGURED', consecutive_failures = 0, last_error = NULL
           WHERE id = $1`,
          [row.id, sealed],
        );
      });

      await audit(app, request, {
        action: 'integration:rotate-credentials',
        resourceType: 'Integration',
        resourceId: params.id,
      });

      return reply.status(204).send();
    },
  );

  server.delete(
    '/v1/organisations/:organisationId/integrations/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:integration:manage');

      await app.db.withTenant(params.organisationId, async (ctx) => {
        // Disabled, not deleted. The evidence this integration collected must
        // stay attributable to its source for as long as it is retained.
        await ctx.query(
          `UPDATE integrations
           SET status = 'DISABLED', sealed_credentials = NULL, credential_updated_at = NULL
           WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
        );
        await publish(
          ctx,
          {
            type: 'IntegrationDisconnected',
            organisationId: params.organisationId,
            subjectType: 'Integration',
            subjectId: params.id,
            payload: {},
            correlationId: request.adericel.correlationId,
            actor: request.adericel.principal?.displayName ?? 'api',
          },
          app.clock.nowIso(),
        );
      });

      await audit(app, request, {
        action: 'integration:disable',
        resourceType: 'Integration',
        resourceId: params.id,
      });

      return reply.status(204).send();
    },
  );
}

/** Configuration is returned for display; internal bookkeeping keys are not. */
function redactConfiguration(configuration: Record<string, unknown>): Record<string, unknown> {
  const { cursor: _cursor, ...rest } = configuration;
  return rest;
}

/** Describe a schema for the UI without exposing internals or executing it. */
function safeJsonSchema(schema: unknown): unknown {
  try {
    return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object', description: 'Schema could not be represented as JSON Schema.' };
  }
}
