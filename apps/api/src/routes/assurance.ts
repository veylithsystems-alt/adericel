import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  aggregateAssurance,
  assessmentRequestSchema,
  assuranceSeverityRank,
  summarise,
  type AssuranceState,
} from '@adericel/domain';
import { createAssessmentService } from '@adericel/actions';
import { referencedPredicates } from '@adericel/truth-engine';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery, organisationParam } from '../middleware/validation.js';
import { explainEvidenceGaps } from '../services/observation-coverage.js';

/**
 * Assurance routes.
 *
 * These endpoints answer the product's core question — what is the assurance
 * state, and why — and they always return the "why" alongside the state. A
 * response that gave only a state would push interpretation onto the caller,
 * which is exactly the failure mode of a traffic-light dashboard.
 */

const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

export function registerAssuranceRoutes(server: FastifyInstance, app: AppContext): void {
  /** Organisation-level assurance summary, with unknowns kept separate. */
  server.get(
    '/v1/organisations/:organisationId/assurance',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      const data = await app.db.withTenant(organisationId, async (ctx) => {
        // Driven from `controls`, not from `assurance_states`.
        //
        // A control that has never been assessed has no state row, and reading
        // the state table first meant a freshly onboarded tenant saw an empty
        // assurance page. An empty page is read as "nothing wrong" — the same
        // claim a green dashboard makes, only quieter, and at the exact moment
        // a customer is deciding what this product is. A control Adericel has
        // never assessed is UNKNOWN with no evidence, and it must say so.
        const controlStates = await ctx.many<{
          subject_id: string;
          state: string;
          unknown_reason: string | null;
          since: Date | null;
          last_assessed_at: Date | null;
          key: string;
          title: string;
        }>(
          `SELECT c.id AS subject_id,
                  COALESCE(a.state, 'UNKNOWN') AS state,
                  CASE WHEN a.state IS NULL THEN 'NO_EVIDENCE' ELSE a.unknown_reason END
                    AS unknown_reason,
                  a.since,
                  a.last_assessed_at,
                  c.key, c.title
           FROM controls c
           LEFT JOIN assurance_states a
             ON a.organisation_id = c.organisation_id
            AND a.subject_kind = 'CONTROL'
            AND a.subject_id = c.id
           WHERE c.organisation_id = $1 AND c.enabled`,
          [organisationId],
        );

        const frameworks = await ctx.many<{
          framework_id: string;
          key: string;
          name: string;
          state: string | null;
        }>(
          `SELECT f.id AS framework_id, f.key, f.name, a.state
           FROM organisation_frameworks orgf
           JOIN frameworks f ON f.id = orgf.framework_id
           LEFT JOIN assurance_states a
             ON a.organisation_id = orgf.organisation_id
            AND a.subject_kind = 'FRAMEWORK' AND a.subject_id = f.id
           WHERE orgf.organisation_id = $1
           ORDER BY f.name`,
          [organisationId],
        );

        const findings = await ctx.oneOrFail<{
          critical: string;
          high: string;
          medium: string;
          low: string;
          total: string;
          oldest: Date | null;
        }>(
          `SELECT
             count(*) FILTER (WHERE severity = 'CRITICAL')::text AS critical,
             count(*) FILTER (WHERE severity = 'HIGH')::text AS high,
             count(*) FILTER (WHERE severity = 'MEDIUM')::text AS medium,
             count(*) FILTER (WHERE severity = 'LOW')::text AS low,
             count(*)::text AS total,
             min(first_detected_at) AS oldest
           FROM findings
           WHERE organisation_id = $1 AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION')`,
          [organisationId],
          'Finding counts',
        );

        const evidenceAges = await ctx.oneOrFail<{
          total: string;
          expiring: string;
          expired: string;
        }>(
          `SELECT count(*)::text AS total,
                  count(*) FILTER (WHERE valid_until IS NOT NULL
                                     AND valid_until BETWEEN now() AND now() + interval '7 days')::text AS expiring,
                  count(*) FILTER (WHERE status = 'EXPIRED'
                                     OR (valid_until IS NOT NULL AND valid_until < now()))::text AS expired
           FROM evidence WHERE organisation_id = $1 AND status IN ('ACTIVE', 'EXPIRED')`,
          [organisationId],
          'Evidence counts',
        );

        const actions = await ctx.oneOrFail<{ awaiting: string; unverified: string }>(
          `SELECT count(*) FILTER (WHERE state = 'AWAITING_APPROVAL')::text AS awaiting,
                  count(*) FILTER (WHERE state = 'UNVERIFIED')::text AS unverified
           FROM actions WHERE organisation_id = $1`,
          [organisationId],
          'Action counts',
        );

        return { controlStates, frameworks, findings, evidenceAges, actions };
      });

      const states = data.controlStates.map((row) => row.state as AssuranceState);
      const summary = summarise(states);

      // Whether Adericel is still observing this organisation. Read before the
      // state is presented, because a state nobody is maintaining means
      // something different from one that is current, and the reader cannot
      // tell them apart from the state alone.
      const maintenance = await app.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{
          assurance_maintained: boolean;
          maintenance_stopped_at: Date | null;
          maintenance_stopped_reason: string | null;
        }>(
          `SELECT assurance_maintained, maintenance_stopped_at, maintenance_stopped_reason
           FROM organisations WHERE id = $1`,
          [organisationId],
          'Organisation',
        ),
      );

      return reply.status(200).send({
        organisationId,
        // The headline state, and never a score. See docs/product/brand.
        state: summary.state,
        maintenance: {
          maintained: maintenance.assurance_maintained,
          stoppedAt: maintenance.maintenance_stopped_at?.toISOString() ?? null,
          reason: maintenance.maintenance_stopped_reason,
          note: maintenance.assurance_maintained
            ? null
            : 'Adericel has stopped observing this organisation, so this describes the last ' +
              'assessment rather than the present. Nothing has been deleted and no ' +
              'determination has changed.',
        },
        counts: summary.counts,
        inScope: summary.inScope,
        coverage: summary.coverage,
        satisfactionOfKnown: summary.satisfactionOfKnown,
        frameworks: data.frameworks.map((f) => ({
          id: f.framework_id,
          key: f.key,
          name: f.name,
          state: f.state ?? 'UNKNOWN',
        })),
        controls: data.controlStates
          .map((row) => ({
            id: row.subject_id,
            key: row.key,
            title: row.title,
            state: row.state as AssuranceState,
            unknownReason: row.unknown_reason,
            since: row.since?.toISOString() ?? null,
            // Null rather than a timestamp: this control has never been
            // assessed, and inventing a time would imply it had.
            lastAssessedAt: row.last_assessed_at?.toISOString() ?? null,
          }))
          .sort(
            (a, b) =>
              assuranceSeverityRank(a.state) - assuranceSeverityRank(b.state) ||
              a.key.localeCompare(b.key),
          ),
        openFindings: {
          total: Number(data.findings.total),
          critical: Number(data.findings.critical),
          high: Number(data.findings.high),
          medium: Number(data.findings.medium),
          low: Number(data.findings.low),
          oldestDetectedAt: data.findings.oldest?.toISOString() ?? null,
        },
        evidence: {
          total: Number(data.evidenceAges.total),
          expiringWithin7Days: Number(data.evidenceAges.expiring),
          expired: Number(data.evidenceAges.expired),
        },
        actions: {
          awaitingApproval: Number(data.actions.awaiting),
          unverified: Number(data.actions.unverified),
        },
      });
    },
  );

  /**
   * Full explanation for one control.
   *
   * State, rationale, the rule that ran, the ruleset version and hash, every
   * subject outcome, and the evidence behind them. This endpoint is the
   * product's answer to "why does it say that?".
   */
  server.get(
    '/v1/organisations/:organisationId/controls/:id/explanation',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:assessment:read');

      const data = await app.db.withTenant(params.organisationId, async (ctx) => {
        const control = await ctx.oneOrFail<{
          id: string;
          key: string;
          title: string;
          description: string | null;
          ruleset_key: string;
          rule_key: string;
          parameters: Record<string, unknown>;
          enabled: boolean;
        }>(
          `SELECT id, key, title, description, ruleset_key, rule_key, parameters, enabled
           FROM controls WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
          'Control',
        );

        const assessment = await ctx.one<{
          id: string;
          state: string;
          unknown_reason: string | null;
          rationale: string;
          reasoning: unknown;
          trigger: string;
          engine_version: string;
          ruleset_key: string;
          ruleset_version: string;
          ruleset_hash: string;
          rule_key: string;
          input_digest: string;
          evidence_ids: string[];
          claim_ids: string[];
          assessed_at: Date;
          state_changed: boolean;
        }>(
          `SELECT id, state, unknown_reason, rationale, reasoning, trigger, engine_version,
                  ruleset_key, ruleset_version, ruleset_hash, rule_key, input_digest,
                  evidence_ids, claim_ids, assessed_at, state_changed
           FROM assessments
           WHERE organisation_id = $1 AND subject_kind = 'CONTROL' AND subject_id = $2
           ORDER BY assessed_at DESC LIMIT 1`,
          [params.organisationId, params.id],
        );

        const evidence = assessment
          ? await ctx.many<{
              id: string;
              title: string;
              source_system: string;
              source_type: string;
              integrity_level: string;
              status: string;
              observed_at: Date | null;
              collected_at: Date;
              valid_until: Date | null;
              content_hash: string;
            }>(
              `SELECT id, title, source_system, source_type, integrity_level, status,
                      observed_at, collected_at, valid_until, content_hash
               FROM evidence WHERE organisation_id = $1 AND id = ANY($2::uuid[])
               ORDER BY collected_at DESC`,
              [params.organisationId, assessment.evidence_ids],
            )
          : [];

        const claims = assessment
          ? await ctx.many<{
              id: string;
              predicate: string;
              value: unknown;
              origin: string;
              status: string;
              asserted_at: Date;
              subject_label: string | null;
            }>(
              `SELECT c.id, c.predicate, c.value, c.origin, c.status, c.asserted_at, n.label AS subject_label
               FROM claims c LEFT JOIN graph_nodes n ON n.id = c.subject_node_id
               WHERE c.organisation_id = $1 AND c.id = ANY($2::uuid[])`,
              [params.organisationId, assessment.claim_ids],
            )
          : [];

        const openFindings = await ctx.many<{
          id: string;
          title: string;
          severity: string;
          status: string;
          first_detected_at: Date;
        }>(
          `SELECT id, title, severity, status, first_detected_at
           FROM findings
           WHERE organisation_id = $1 AND control_id = $2
             AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION')
           ORDER BY first_detected_at`,
          [params.organisationId, params.id],
        );

        const exceptions = await ctx.many<{
          id: string;
          justification: string;
          status: string;
          expires_at: Date;
          subject_node_id: string | null;
        }>(
          `SELECT id, justification, status, expires_at, subject_node_id
           FROM exceptions WHERE organisation_id = $1 AND control_id = $2 AND status = 'APPROVED'`,
          [params.organisationId, params.id],
        );

        const requirements = await ctx.many<{
          id: string;
          key: string;
          title: string;
          framework: string;
        }>(
          `SELECT r.id, r.key, r.title, f.name AS framework
           FROM control_requirements cr
           JOIN requirements r ON r.id = cr.requirement_id
           JOIN frameworks f ON f.id = r.framework_id
           WHERE cr.organisation_id = $1 AND cr.control_id = $2`,
          [params.organisationId, params.id],
        );

        return { control, assessment, evidence, claims, openFindings, exceptions, requirements };
      });

      const ruleset = app.rulesets.tryGet(
        data.control.ruleset_key,
        data.assessment?.ruleset_version,
      );
      const rule = ruleset?.rules.find((r) => r.key === data.control.rule_key) ?? null;

      // Why this control cannot be assessed, in terms a person can act on.
      //
      // "No evidence recorded" is true and useless. Computed only when the
      // determination is actually UNKNOWN, because a passing control does not
      // need its evidence supply explained, and only over the predicates this
      // rule genuinely reads.
      const state = data.assessment?.state ?? 'UNKNOWN';
      const rulePredicates = rule
        ? [
            ...referencedPredicates(rule.expression),
            ...(rule.applicability ? referencedPredicates(rule.applicability) : []),
          ]
        : [];
      const answered = new Set(
        data.claims
          .filter((claim) => claim.status === 'CANDIDATE' || claim.status === 'CONFIRMED')
          .map((claim) => claim.predicate),
      );
      const evidenceGaps =
        state === 'UNKNOWN' && rulePredicates.length > 0
          ? await app.db.withTenant(params.organisationId, async (ctx) =>
              explainEvidenceGaps(
                ctx,
                app.connectors,
                rulePredicates.filter((predicate) => !answered.has(predicate)),
              ),
            )
          : [];

      return reply.status(200).send({
        control: {
          id: data.control.id,
          key: data.control.key,
          title: data.control.title,
          description: data.control.description,
          enabled: data.control.enabled,
          parameters: data.control.parameters,
        },
        state: data.assessment?.state ?? 'UNKNOWN',
        unknownReason: data.assessment?.unknown_reason ?? 'NOT_YET_ASSESSED',
        rationale:
          data.assessment?.rationale ??
          'This control has not yet been assessed. Adericel holds no determination for it.',
        reasoning: data.assessment?.reasoning ?? [],
        /**
         * Present only when the control is UNKNOWN. Each entry says which of
         * three things is true — nothing supplies this evidence, something
         * supplies it and is currently failing, or two systems disagree — and
         * what would fix it.
         */
        evidenceGaps,
        assessment: data.assessment
          ? {
              id: data.assessment.id,
              trigger: data.assessment.trigger,
              assessedAt: data.assessment.assessed_at.toISOString(),
              stateChanged: data.assessment.state_changed,
              // Everything needed to reproduce the determination.
              provenance: {
                engineVersion: data.assessment.engine_version,
                rulesetKey: data.assessment.ruleset_key,
                rulesetVersion: data.assessment.ruleset_version,
                rulesetHash: data.assessment.ruleset_hash,
                ruleKey: data.assessment.rule_key,
                inputDigest: data.assessment.input_digest,
              },
            }
          : null,
        rule: rule
          ? {
              key: rule.key,
              title: rule.title,
              description: rule.description,
              severity: rule.severity,
              aggregation: rule.aggregation,
              subjectKinds: rule.subjectKinds,
              maxEvidenceAgeDays: rule.maxEvidenceAgeDays,
              requiredWhenFailing: rule.failureDescription,
              remediation: rule.remediation,
            }
          : null,
        evidence: data.evidence.map((e) => ({
          id: e.id,
          title: e.title,
          sourceSystem: e.source_system,
          sourceType: e.source_type,
          integrityLevel: e.integrity_level,
          status: e.status,
          observedAt: e.observed_at?.toISOString() ?? null,
          collectedAt: e.collected_at.toISOString(),
          validUntil: e.valid_until?.toISOString() ?? null,
          contentHash: e.content_hash,
        })),
        claims: data.claims.map((c) => ({
          id: c.id,
          predicate: c.predicate,
          value: c.value,
          origin: c.origin,
          status: c.status,
          subject: c.subject_label,
          assertedAt: c.asserted_at.toISOString(),
        })),
        openFindings: data.openFindings.map((f) => ({
          id: f.id,
          title: f.title,
          severity: f.severity,
          status: f.status,
          firstDetectedAt: f.first_detected_at.toISOString(),
        })),
        activeExceptions: data.exceptions.map((e) => ({
          id: e.id,
          justification: e.justification,
          expiresAt: e.expires_at.toISOString(),
          subjectNodeId: e.subject_node_id,
        })),
        requirements: data.requirements,
      });
    },
  );

  /** Run an assessment now. */
  server.post(
    '/v1/organisations/:organisationId/assessments',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:assessment:run');
      const body = parseBody(request, assessmentRequestSchema);
      const principal = request.adericel.principal;

      const result = await app.db.withTenant(organisationId, async (ctx) => {
        const service = createAssessmentService({
          ctx,
          clock: app.clock,
          logger: request.adericel.logger,
          rulesets: app.rulesets,
          actor: principal?.displayName ?? 'system',
          correlationId: request.adericel.correlationId,
        });

        switch (body.subjectKind) {
          case 'CONTROL':
            return service.assessControl(body.subjectId, body.trigger, body.asOf);
          case 'REQUIREMENT':
            return service.rollUpRequirement(body.subjectId, body.asOf);
          case 'FRAMEWORK':
            return service.rollUpFramework(body.subjectId, body.asOf);
          case 'ORGANISATION':
            return service.rollUpOrganisation(body.asOf);
        }
      });

      if (!result) throw new AdericelError('NOT_FOUND', 'Assessment subject not found');

      await audit(app, request, {
        action: 'assessment:run',
        resourceType: body.subjectKind,
        resourceId: body.subjectId,
        metadata: { state: result.assessment.state, changed: result.stateChanged },
      });

      return reply.status(201).send({
        assessment: {
          id: result.assessment.id,
          subjectKind: result.assessment.subjectKind,
          subjectId: result.assessment.subjectId,
          state: result.assessment.state,
          unknownReason: result.assessment.unknownReason,
          rationale: result.assessment.rationale,
          reasoning: result.assessment.reasoning,
          provenance: result.assessment.provenance,
          assessedAt: result.assessment.provenance.assessedAt,
        },
        stateChanged: result.stateChanged,
        previousState: result.previousState,
        findingsOpened: result.findingsOpened.length,
        findingsResolved: result.findingsResolved.length,
      });
    },
  );

  /** Reassess every control in the organisation. */
  server.post(
    '/v1/organisations/:organisationId/assessments/run-all',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:assessment:run');
      const principal = request.adericel.principal;

      const results = await app.db.withTenant(organisationId, async (ctx) => {
        const service = createAssessmentService({
          ctx,
          clock: app.clock,
          logger: request.adericel.logger,
          rulesets: app.rulesets,
          actor: principal?.displayName ?? 'system',
          correlationId: request.adericel.correlationId,
        });
        const controlOutputs = await service.assessAllControls('MANUAL');
        // Roll up in dependency order so each level aggregates fresh children.
        const requirementIds = await ctx.many<{ requirement_id: string }>(
          `SELECT DISTINCT requirement_id FROM control_requirements WHERE organisation_id = $1`,
          [organisationId],
        );
        for (const row of requirementIds) await service.rollUpRequirement(row.requirement_id);
        const frameworkIds = await ctx.many<{ framework_id: string }>(
          `SELECT framework_id FROM organisation_frameworks WHERE organisation_id = $1`,
          [organisationId],
        );
        for (const row of frameworkIds) await service.rollUpFramework(row.framework_id);
        await service.rollUpOrganisation();
        return controlOutputs;
      });

      await audit(app, request, {
        action: 'assessment:run-all',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { controlsAssessed: results.length },
      });

      const states = results.map((r) => r.assessment.state);
      return reply.status(201).send({
        controlsAssessed: results.length,
        statesChanged: results.filter((r) => r.stateChanged).length,
        findingsOpened: results.reduce((n, r) => n + r.findingsOpened.length, 0),
        findingsResolved: results.reduce((n, r) => n + r.findingsResolved.length, 0),
        summary: aggregateAssurance(states),
      });
    },
  );

  /** Assessment history for a subject. */
  server.get(
    '/v1/organisations/:organisationId/assessments',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:assessment:read');
      const query = parseQuery(
        request,
        z.object({
          subjectId: z.string().uuid().optional(),
          subjectKind: z.enum(['CONTROL', 'REQUIREMENT', 'FRAMEWORK', 'ORGANISATION']).optional(),
          onlyChanges: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      );

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          subject_kind: string;
          subject_id: string;
          state: string;
          unknown_reason: string | null;
          rationale: string;
          trigger: string;
          ruleset_key: string;
          ruleset_version: string;
          state_changed: boolean;
          assessed_at: Date;
        }>(
          `SELECT id, subject_kind, subject_id, state, unknown_reason, rationale, trigger,
                  ruleset_key, ruleset_version, state_changed, assessed_at
           FROM assessments
           WHERE organisation_id = $1
             AND ($2::uuid IS NULL OR subject_id = $2)
             AND ($3::text IS NULL OR subject_kind = $3)
             AND ($4 = false OR state_changed)
           ORDER BY assessed_at DESC, id DESC
           LIMIT $5`,
          [
            organisationId,
            query.subjectId ?? null,
            query.subjectKind ?? null,
            query.onlyChanges,
            query.limit,
          ],
        ),
      );

      return reply.status(200).send({
        assessments: rows.map((row) => ({
          id: row.id,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          state: row.state,
          unknownReason: row.unknown_reason,
          rationale: row.rationale,
          trigger: row.trigger,
          rulesetKey: row.ruleset_key,
          rulesetVersion: row.ruleset_version,
          stateChanged: row.state_changed,
          assessedAt: row.assessed_at.toISOString(),
        })),
      });
    },
  );

  /**
   * Replay a historical assessment.
   *
   * Reports honestly when the inputs have moved on: the original record remains
   * authoritative for its instant, and Adericel says so rather than implying a
   * reproduction it cannot perform.
   */
  server.post(
    '/v1/organisations/:organisationId/assessments/:id/replay',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:assessment:read');

      const result = await app.db.withTenant(params.organisationId, async (ctx) =>
        createAssessmentService({
          ctx,
          clock: app.clock,
          logger: request.adericel.logger,
          rulesets: app.rulesets,
          actor: request.adericel.principal?.displayName ?? 'system',
          correlationId: request.adericel.correlationId,
        }).replay(params.id),
      );

      await audit(app, request, {
        action: 'assessment:replay',
        resourceType: 'Assessment',
        resourceId: params.id,
        metadata: { reproduced: result.reproduced },
      });

      return reply.status(200).send(result);
    },
  );

  /** The rulesets this build can run, with their hashes. */
  server.get('/v1/rulesets', { preHandler: server.authenticate }, async (_request, reply) =>
    reply.status(200).send({
      engineRulesets: app.rulesets.list().map((ruleset) => ({
        key: ruleset.key,
        version: ruleset.version,
        name: ruleset.name,
        description: ruleset.description,
        hash: ruleset.hash,
        engineVersion: ruleset.engineVersion,
        rules: ruleset.rules.map((rule) => ({
          key: rule.key,
          title: rule.title,
          severity: rule.severity,
          subjectKinds: rule.subjectKinds,
          aggregation: rule.aggregation,
          hasRemediation: rule.remediation !== null,
        })),
      })),
    }),
  );
}
