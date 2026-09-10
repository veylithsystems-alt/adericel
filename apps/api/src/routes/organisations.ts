import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { organisationCreateSchema, organisationSettingsSchema } from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import {
  audit,
  requireOrganisation,
  requirePlatform,
  requirePrincipal,
} from '../middleware/request-context.js';
import { parseBody, parseParams, organisationParam } from '../middleware/validation.js';
import { provisionOrganisation } from '../services/onboarding.js';
import { exportOrganisation } from '../services/export.js';
import {
  beginOffboarding,
  closeOrganisation,
  offboardingStatus,
  revokeAccess,
  takeFinalExport,
} from '../services/offboarding.js';

/**
 * Organisation routes.
 *
 * Including a complete export. A customer's assurance record is theirs, and the
 * moat is meant to be the product's value — not the difficulty of leaving.
 */

export function registerOrganisationRoutes(server: FastifyInstance, app: AppContext): void {
  server.get(
    '/v1/organisations/:organisationId',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      const data = await app.db.withPlatform(async (ctx) => {
        const org = await ctx.oneOrFail<{
          id: string;
          msp_id: string | null;
          name: string;
          slug: string;
          status: string;
          country_code: string | null;
          industry: string | null;
          size_band: string | null;
          settings: Record<string, unknown>;
          onboarded_at: Date | null;
          created_at: Date;
        }>(
          `SELECT id, msp_id, name, slug, status, country_code, industry, size_band,
                  settings, onboarded_at, created_at
           FROM organisations WHERE id = $1`,
          [organisationId],
          'Organisation',
        );
        const msp = org.msp_id
          ? await ctx.one<{ id: string; name: string }>(`SELECT id, name FROM msps WHERE id = $1`, [
              org.msp_id,
            ])
          : null;
        return { org, msp };
      });

      return reply.status(200).send({
        id: data.org.id,
        name: data.org.name,
        slug: data.org.slug,
        status: data.org.status,
        countryCode: data.org.country_code,
        industry: data.org.industry,
        sizeBand: data.org.size_band,
        settings: organisationSettingsSchema.parse(data.org.settings ?? {}),
        msp: data.msp,
        onboardedAt: data.org.onboarded_at?.toISOString() ?? null,
        createdAt: data.org.created_at.toISOString(),
      });
    },
  );

  server.patch(
    '/v1/organisations/:organisationId',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(200).optional(),
          industry: z.string().max(120).nullable().optional(),
          sizeBand: z.enum(['1-9', '10-49', '50-249', '250-999', '1000+']).nullable().optional(),
          settings: organisationSettingsSchema.partial().optional(),
        }),
      );

      const updated = await app.db.withPlatform(async (ctx) => {
        const current = await ctx.oneOrFail<{ settings: Record<string, unknown> }>(
          `SELECT settings FROM organisations WHERE id = $1`,
          [organisationId],
          'Organisation',
        );
        // Settings merge rather than replace, so a partial update cannot
        // silently reset an autonomy level or a retention period.
        const settings = organisationSettingsSchema.parse({
          ...organisationSettingsSchema.parse(current.settings ?? {}),
          ...(body.settings ?? {}),
        });
        return ctx.oneOrFail<{ id: string; name: string; settings: Record<string, unknown> }>(
          `UPDATE organisations
           SET name = COALESCE($2, name),
               industry = COALESCE($3, industry),
               size_band = COALESCE($4, size_band),
               settings = $5::jsonb
           WHERE id = $1
           RETURNING id, name, settings`,
          [
            organisationId,
            body.name ?? null,
            body.industry ?? null,
            body.sizeBand ?? null,
            JSON.stringify(settings),
          ],
          'Organisation',
        );
      });

      await audit(app, request, {
        action: 'organisation:update',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { fields: Object.keys(body) },
      });

      return reply.status(200).send({
        id: updated.id,
        name: updated.name,
        settings: organisationSettingsSchema.parse(updated.settings),
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/controls',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:control:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          key: string;
          title: string;
          description: string | null;
          ruleset_key: string;
          rule_key: string;
          parameters: Record<string, unknown>;
          source: string;
          enabled: boolean;
          state: string | null;
          unknown_reason: string | null;
          since: Date | null;
          last_assessed_at: Date | null;
        }>(
          `SELECT c.id, c.key, c.title, c.description, c.ruleset_key, c.rule_key, c.parameters,
                  c.source, c.enabled, a.state, a.unknown_reason, a.since, a.last_assessed_at
           FROM controls c
           LEFT JOIN assurance_states a
             ON a.organisation_id = c.organisation_id
            AND a.subject_kind = 'CONTROL' AND a.subject_id = c.id
           WHERE c.organisation_id = $1
           ORDER BY c.key`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        controls: rows.map((row) => ({
          id: row.id,
          key: row.key,
          title: row.title,
          description: row.description,
          rulesetKey: row.ruleset_key,
          ruleKey: row.rule_key,
          parameters: row.parameters,
          // Where this control came from: the MSP baseline, a local addition,
          // or a local override of the baseline.
          source: row.source,
          enabled: row.enabled,
          state: row.state ?? 'UNKNOWN',
          unknownReason: row.unknown_reason ?? (row.state ? null : 'NOT_YET_ASSESSED'),
          since: row.since?.toISOString() ?? null,
          lastAssessedAt: row.last_assessed_at?.toISOString() ?? null,
        })),
      });
    },
  );

  server.patch(
    '/v1/organisations/:organisationId/controls/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(
        request,
        z.object({ organisationId: z.string().uuid(), id: z.string().uuid() }),
      );
      await requireOrganisation(app, request, params.organisationId, 'org:control:manage');
      const body = parseBody(
        request,
        z.object({
          enabled: z.boolean().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
          reason: z.string().min(3).max(1000),
        }),
      );

      const control = await app.db.withTenant(params.organisationId, async (ctx) => {
        const current = await ctx.oneOrFail<{
          id: string;
          key: string;
          source: string;
          baseline_control_id: string | null;
          parameters: Record<string, unknown>;
        }>(
          `SELECT id, key, source, baseline_control_id, parameters
           FROM controls WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
          'Control',
        );

        // A mandatory baseline control cannot be weakened locally. This is what
        // stops a customer administrator quietly removing the MSP's floor.
        if (current.baseline_control_id) {
          const baseline = await ctx.one<{ mandatory: boolean }>(
            `SELECT mandatory FROM msp_baseline_controls WHERE id = $1`,
            [current.baseline_control_id],
          );
          if (baseline?.mandatory) {
            throw new AdericelError(
              'POLICY_DENIED',
              `Control ${current.key} is mandatory in the MSP baseline and cannot be changed locally.`,
              { safeDetails: { controlKey: current.key } },
            );
          }
        }

        return ctx.oneOrFail<{
          id: string;
          enabled: boolean;
          parameters: Record<string, unknown>;
          source: string;
        }>(
          `UPDATE controls
           SET enabled = COALESCE($3, enabled),
               parameters = COALESCE($4::jsonb, parameters),
               source = CASE WHEN baseline_control_id IS NOT NULL THEN 'OVERRIDDEN' ELSE source END
           WHERE id = $1 AND organisation_id = $2
           RETURNING id, enabled, parameters, source`,
          [
            params.id,
            params.organisationId,
            body.enabled ?? null,
            body.parameters ? JSON.stringify({ ...current.parameters, ...body.parameters }) : null,
          ],
          'Control',
        );
      });

      await audit(app, request, {
        action: 'control:update',
        resourceType: 'Control',
        resourceId: params.id,
        reason: body.reason,
        metadata: { enabled: body.enabled, parameters: body.parameters },
      });

      return reply.status(200).send({
        id: control.id,
        enabled: control.enabled,
        parameters: control.parameters,
        source: control.source,
      });
    },
  );

  /**
   * Complete organisation export.
   *
   * A customer can take their model, assurance state, evidence metadata,
   * assessments, findings, actions and history with them. The commercial moat
   * is the product, not hostage data.
   */

  /**
   * Offboarding.
   *
   * Deliberately several steps rather than one. A single "close this customer"
   * button would either do the destructive parts before the export, or hide a
   * partial failure behind a success — and the moment a customer is least able
   * to argue about their record is exactly when it must not be lost.
   */
  server.post(
    '/v1/organisations/:organisationId/offboarding',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const body = parseBody(request, z.object({ reason: z.string().min(1).max(1000) }));

      const status = await beginOffboarding(app, organisationId, {
        reason: body.reason,
        actor: request.adericel.principal?.displayName ?? 'api',
        correlationId: request.adericel.correlationId,
      });

      await audit(app, request, {
        action: 'organisation:offboarding:begin',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { reason: body.reason },
      });

      return reply.status(200).send(status);
    },
  );

  server.get(
    '/v1/organisations/:organisationId/offboarding',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      return reply.status(200).send(await offboardingStatus(app, organisationId));
    },
  );

  /** Take the record the customer leaves with, and record what was handed over. */
  server.post(
    '/v1/organisations/:organisationId/offboarding/export',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:export');

      const { bundle } = await takeFinalExport(app, organisationId);

      await audit(app, request, {
        action: 'organisation:offboarding:export',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { bundleHash: bundle.bundleHash, counts: bundle.counts },
      });

      return reply
        .status(200)
        .header(
          'content-disposition',
          `attachment; filename="adericel-final-export-${bundle.organisation.slug}.json"`,
        )
        .send(bundle);
    },
  );

  /** Revoke everything. Idempotent, so a partial run can simply be repeated. */
  server.post(
    '/v1/organisations/:organisationId/offboarding/revoke',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');
      const body = parseBody(
        request,
        z.object({ reason: z.string().min(1).max(500).default('The organisation is offboarding') }),
      );

      const revoked = await revokeAccess(app, organisationId, {
        reason: body.reason,
        actor: request.adericel.principal?.displayName ?? 'api',
      });

      await audit(app, request, {
        action: 'organisation:offboarding:revoke',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: revoked,
      });

      return reply
        .status(200)
        .send({ revoked, status: await offboardingStatus(app, organisationId) });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/offboarding/close',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:manage');

      const status = await closeOrganisation(app, organisationId, {
        actor: request.adericel.principal?.displayName ?? 'api',
        correlationId: request.adericel.correlationId,
      });

      await audit(app, request, {
        action: 'organisation:offboarding:close',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { finalExportHash: status.finalExportHash },
      });

      return reply.status(200).send(status);
    },
  );

  server.get(
    '/v1/organisations/:organisationId/export',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:export');

      const bundle = await exportOrganisation(app, organisationId);

      await audit(app, request, {
        action: 'organisation:export',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { counts: bundle.counts },
      });

      return reply
        .status(200)
        .header(
          'content-disposition',
          `attachment; filename="adericel-export-${bundle.organisation.slug}-${bundle.exportedAt.slice(0, 10)}.json"`,
        )
        .send(bundle);
    },
  );

  /** Create a direct (non-MSP) organisation. Platform administrators only. */
  server.post('/v1/organisations', { preHandler: server.authenticate }, async (request, reply) => {
    await requirePlatform(app, request, 'platform:admin');
    const body = parseBody(request, organisationCreateSchema);
    const principal = requirePrincipal(request);

    const created = await provisionOrganisation(app, {
      mspId: null,
      input: body,
      actor: principal.displayName,
      actorUserId: principal.principalType === 'USER' ? principal.principalId : null,
      correlationId: request.adericel.correlationId,
    });

    await audit(app, request, {
      action: 'organisation:create',
      resourceType: 'Organisation',
      resourceId: created.id,
      metadata: { direct: true },
    });

    return reply.status(201).send(created);
  });
}
