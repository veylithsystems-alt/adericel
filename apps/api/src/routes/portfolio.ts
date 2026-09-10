import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assuranceSeverityRank, summarise, type AssuranceState } from '@adericel/domain';
import { ASSURANCE_TASKS, effortFor, modelCompleteness } from '@adericel/value';
import type { AppContext } from '../context.js';
import { audit, requireMsp, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery } from '../middleware/validation.js';
import {
  buildValueReport,
  loadEffortModel,
  recordTaskEffort,
  retainValueReport,
} from '../services/value.js';

/**
 * Portfolio intelligence.
 *
 * The MSP operates at two levels: "what is happening across all customers?" and
 * "why is this happening in this one?". These endpoints serve the first, and
 * every row links to the second.
 *
 * Portfolio queries deliberately run under platform scope: they aggregate
 * across organisations by definition, so tenant context cannot apply. Access is
 * gated on an MSP grant first, and every query is constrained to organisations
 * that MSP owns — the SQL never takes an organisation id from the caller.
 */

const mspParam = z.object({ mspId: z.string().uuid() });

export function registerPortfolioRoutes(server: FastifyInstance, app: AppContext): void {
  /** Portfolio overview: one row per organisation, worst first. */
  server.get(
    '/v1/msps/:mspId/portfolio',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:read');

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          organisation_id: string;
          name: string;
          slug: string;
          status: string;
          satisfied: string;
          not_satisfied: string;
          partially: string;
          unknown: string;
          excepted: string;
          not_applicable: string;
          critical_findings: string;
          high_findings: string;
          open_findings: string;
          oldest_finding_days: string | null;
          stale_evidence: string;
          awaiting_approval: string;
          unverified_actions: string;
          failed_integrations: string;
          degraded_integrations: string;
          last_assessed_at: Date | null;
        }>(
          `SELECT o.id AS organisation_id, o.name, o.slug, o.status,
             count(a.*) FILTER (WHERE a.state = 'SATISFIED')::text AS satisfied,
             count(a.*) FILTER (WHERE a.state = 'NOT_SATISFIED')::text AS not_satisfied,
             count(a.*) FILTER (WHERE a.state = 'PARTIALLY_SATISFIED')::text AS partially,
             count(a.*) FILTER (WHERE a.state = 'UNKNOWN')::text AS unknown,
             count(a.*) FILTER (WHERE a.state = 'EXCEPTED')::text AS excepted,
             count(a.*) FILTER (WHERE a.state = 'NOT_APPLICABLE')::text AS not_applicable,
             (SELECT count(*)::text FROM findings f
               WHERE f.organisation_id = o.id AND f.severity = 'CRITICAL'
                 AND f.status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION')) AS critical_findings,
             (SELECT count(*)::text FROM findings f
               WHERE f.organisation_id = o.id AND f.severity = 'HIGH'
                 AND f.status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION')) AS high_findings,
             (SELECT count(*)::text FROM findings f
               WHERE f.organisation_id = o.id
                 AND f.status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION')) AS open_findings,
             (SELECT (EXTRACT(EPOCH FROM (now() - min(f.first_detected_at)))::bigint / 86400)::text
                FROM findings f
               WHERE f.organisation_id = o.id
                 AND f.status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION')) AS oldest_finding_days,
             (SELECT count(*)::text FROM evidence e
               WHERE e.organisation_id = o.id AND e.status = 'ACTIVE'
                 AND e.valid_until IS NOT NULL AND e.valid_until < now()) AS stale_evidence,
             (SELECT count(*)::text FROM actions ac
               WHERE ac.organisation_id = o.id AND ac.state = 'AWAITING_APPROVAL') AS awaiting_approval,
             (SELECT count(*)::text FROM actions ac
               WHERE ac.organisation_id = o.id AND ac.state = 'UNVERIFIED') AS unverified_actions,
             (SELECT count(*)::text FROM integrations i
               WHERE i.organisation_id = o.id AND i.status = 'FAILED') AS failed_integrations,
             (SELECT count(*)::text FROM integrations i
               WHERE i.organisation_id = o.id AND i.status = 'DEGRADED') AS degraded_integrations,
             max(a.last_assessed_at) AS last_assessed_at
           FROM organisations o
           LEFT JOIN assurance_states a
             ON a.organisation_id = o.id AND a.subject_kind = 'CONTROL'
           WHERE o.msp_id = $1 AND o.status <> 'CLOSED'
           GROUP BY o.id, o.name, o.slug, o.status
           ORDER BY o.name`,
          [mspId],
        ),
      );

      const organisations = rows.map((row) => {
        const states: AssuranceState[] = [
          ...Array<AssuranceState>(Number(row.satisfied)).fill('SATISFIED'),
          ...Array<AssuranceState>(Number(row.not_satisfied)).fill('NOT_SATISFIED'),
          ...Array<AssuranceState>(Number(row.partially)).fill('PARTIALLY_SATISFIED'),
          ...Array<AssuranceState>(Number(row.unknown)).fill('UNKNOWN'),
          ...Array<AssuranceState>(Number(row.excepted)).fill('EXCEPTED'),
          ...Array<AssuranceState>(Number(row.not_applicable)).fill('NOT_APPLICABLE'),
        ];
        const summary = summarise(states);
        return {
          organisationId: row.organisation_id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          state: summary.state,
          counts: summary.counts,
          coverage: summary.coverage,
          satisfactionOfKnown: summary.satisfactionOfKnown,
          criticalFindings: Number(row.critical_findings),
          highFindings: Number(row.high_findings),
          openFindings: Number(row.open_findings),
          oldestFindingDays:
            row.oldest_finding_days === null ? null : Number(row.oldest_finding_days),
          staleEvidence: Number(row.stale_evidence),
          awaitingApproval: Number(row.awaiting_approval),
          unverifiedActions: Number(row.unverified_actions),
          failedIntegrations: Number(row.failed_integrations),
          // Degraded means collecting, but with known gaps — a different
          // operational problem from an integration that is not collecting.
          degradedIntegrations: Number(row.degraded_integrations),
          lastAssessedAt: row.last_assessed_at?.toISOString() ?? null,
          // Attention is a triage ordering, not a score. It is explicitly not
          // presented as a measure of security.
          attentionRank: attentionRank({
            state: summary.state,
            criticalFindings: Number(row.critical_findings),
            unknownCount: summary.counts.UNKNOWN,
            staleEvidence: Number(row.stale_evidence),
            failedIntegrations: Number(row.failed_integrations),
            lastAssessedAt: row.last_assessed_at,
            nowMs: app.clock.nowEpochMs(),
          }),
        };
      });

      organisations.sort(
        (a, b) => b.attentionRank - a.attentionRank || a.name.localeCompare(b.name),
      );

      return reply.status(200).send({
        mspId,
        organisationCount: organisations.length,
        totals: {
          criticalFindings: organisations.reduce((n, o) => n + o.criticalFindings, 0),
          openFindings: organisations.reduce((n, o) => n + o.openFindings, 0),
          unknownControls: organisations.reduce((n, o) => n + o.counts.UNKNOWN, 0),
          failingControls: organisations.reduce((n, o) => n + o.counts.NOT_SATISFIED, 0),
          awaitingApproval: organisations.reduce((n, o) => n + o.awaitingApproval, 0),
          unverifiedActions: organisations.reduce((n, o) => n + o.unverifiedActions, 0),
          staleEvidence: organisations.reduce((n, o) => n + o.staleEvidence, 0),
          failedIntegrations: organisations.reduce((n, o) => n + o.failedIntegrations, 0),
          degradedIntegrations: organisations.reduce((n, o) => n + o.degradedIntegrations, 0),
        },
        organisations,
      });
    },
  );

  /**
   * Controls failing most often across the portfolio.
   *
   * This is where MSP leverage comes from: one systemic fix applied across
   * fifteen customers is worth far more than fifteen individual remediations,
   * and this endpoint is how that opportunity becomes visible.
   */
  server.get(
    '/v1/msps/:mspId/portfolio/recurring-failures',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:read');
      const query = parseQuery(
        request,
        z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      );

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          control_key: string;
          title: string;
          affected_organisations: string;
          total_organisations: string;
          failing: string;
          unknown: string;
          open_findings: string;
          remediable: boolean;
        }>(
          `WITH portfolio AS (
             SELECT id FROM organisations WHERE msp_id = $1 AND status <> 'CLOSED'
           )
           SELECT c.key AS control_key,
                  min(c.title) AS title,
                  count(DISTINCT a.organisation_id) FILTER
                    (WHERE a.state IN ('NOT_SATISFIED','UNKNOWN'))::text AS affected_organisations,
                  (SELECT count(*)::text FROM portfolio) AS total_organisations,
                  count(*) FILTER (WHERE a.state = 'NOT_SATISFIED')::text AS failing,
                  count(*) FILTER (WHERE a.state = 'UNKNOWN')::text AS unknown,
                  (SELECT count(*)::text FROM findings f
                    WHERE f.control_id IN (SELECT id FROM controls c2 WHERE c2.key = c.key)
                      AND f.organisation_id IN (SELECT id FROM portfolio)
                      AND f.status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION')) AS open_findings,
                  bool_or(true) AS remediable
           FROM controls c
           JOIN assurance_states a
             ON a.subject_id = c.id AND a.subject_kind = 'CONTROL'
            AND a.organisation_id = c.organisation_id
           WHERE c.organisation_id IN (SELECT id FROM portfolio)
           GROUP BY c.key
           HAVING count(DISTINCT a.organisation_id) FILTER
                    (WHERE a.state IN ('NOT_SATISFIED','UNKNOWN')) > 0
           ORDER BY count(DISTINCT a.organisation_id) FILTER
                      (WHERE a.state IN ('NOT_SATISFIED','UNKNOWN')) DESC
           LIMIT $2`,
          [mspId, query.limit],
        ),
      );

      const capabilities = new Set(app.connectors.capabilities().map((c) => c.actionType));

      return reply.status(200).send({
        controls: rows.map((row) => {
          const affected = Number(row.affected_organisations);
          const total = Number(row.total_organisations);
          const rule = app.rulesets
            .list()
            .flatMap((r) => r.rules)
            .find((r) => r.key === row.control_key);
          return {
            controlKey: row.control_key,
            title: row.title,
            affectedOrganisations: affected,
            totalOrganisations: total,
            failing: Number(row.failing),
            unknown: Number(row.unknown),
            openFindings: Number(row.open_findings),
            // Whether a single remediation could be applied across all of them.
            systemicRemediation:
              rule?.remediation && capabilities.has(rule.remediation.actionType)
                ? {
                    actionType: rule.remediation.actionType,
                    riskClass: rule.remediation.riskClass,
                    rationale: rule.remediation.rationale,
                  }
                : null,
          };
        }),
      });
    },
  );

  /** Organisations whose assurance has deteriorated over the window. */
  server.get(
    '/v1/msps/:mspId/portfolio/deteriorating',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:read');
      const query = parseQuery(
        request,
        z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
      );

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          organisation_id: string;
          name: string;
          deteriorations: string;
          improvements: string;
          newly_unknown: string;
          latest_change: Date;
        }>(
          `SELECT o.id AS organisation_id, o.name,
                  count(*) FILTER (WHERE a.state IN ('NOT_SATISFIED','UNKNOWN')
                                     AND a.previous_assessment_id IS NOT NULL
                                     AND prev.state = 'SATISFIED')::text AS deteriorations,
                  count(*) FILTER (WHERE a.state = 'SATISFIED'
                                     AND prev.state IN ('NOT_SATISFIED','UNKNOWN'))::text AS improvements,
                  count(*) FILTER (WHERE a.state = 'UNKNOWN' AND prev.state <> 'UNKNOWN')::text AS newly_unknown,
                  max(a.assessed_at) AS latest_change
           FROM organisations o
           JOIN assessments a ON a.organisation_id = o.id AND a.state_changed
           LEFT JOIN assessments prev ON prev.id = a.previous_assessment_id
           WHERE o.msp_id = $1
             AND a.assessed_at > now() - ($2 || ' days')::interval
           GROUP BY o.id, o.name
           HAVING count(*) FILTER (WHERE a.state IN ('NOT_SATISFIED','UNKNOWN')
                                     AND prev.state = 'SATISFIED') > 0
           ORDER BY count(*) FILTER (WHERE a.state IN ('NOT_SATISFIED','UNKNOWN')
                                       AND prev.state = 'SATISFIED') DESC`,
          [mspId, String(query.days)],
        ),
      );

      return reply.status(200).send({
        windowDays: query.days,
        organisations: rows.map((row) => ({
          organisationId: row.organisation_id,
          name: row.name,
          deteriorations: Number(row.deteriorations),
          improvements: Number(row.improvements),
          newlyUnknown: Number(row.newly_unknown),
          latestChangeAt: row.latest_change.toISOString(),
        })),
      });
    },
  );

  /**
   * Customers whose assurance is going unknown for operational reasons — a
   * failed integration, evidence nobody is refreshing, a control never assessed.
   * These are Adericel's problems to fix, not the customer's.
   */
  server.get(
    '/v1/msps/:mspId/portfolio/unknowns',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:read');

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          organisation_id: string;
          name: string;
          unknown_reason: string | null;
          control_count: string;
          control_keys: string[];
        }>(
          `SELECT o.id AS organisation_id, o.name, a.unknown_reason,
                  count(*)::text AS control_count,
                  array_agg(c.key ORDER BY c.key) AS control_keys
           FROM organisations o
           JOIN assurance_states a ON a.organisation_id = o.id AND a.subject_kind = 'CONTROL'
           JOIN controls c ON c.id = a.subject_id
           WHERE o.msp_id = $1 AND a.state = 'UNKNOWN'
           GROUP BY o.id, o.name, a.unknown_reason
           ORDER BY count(*) DESC`,
          [mspId],
        ),
      );

      return reply.status(200).send({
        unknowns: rows.map((row) => ({
          organisationId: row.organisation_id,
          organisationName: row.name,
          reason: row.unknown_reason ?? 'UNSPECIFIED',
          controlCount: Number(row.control_count),
          controlKeys: row.control_keys.slice(0, 20),
          // What the MSP should actually do about it.
          suggestedRemedy: remedyForUnknown(row.unknown_reason),
        })),
      });
    },
  );

  /** Everything across the portfolio waiting on a human decision. */
  server.get(
    '/v1/msps/:mspId/portfolio/approvals',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:organisation:read');

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          action_id: string;
          organisation_id: string;
          organisation_name: string;
          action_type: string;
          risk_class: string;
          rationale: string;
          required_approvals: number;
          recorded: string;
          proposed_at: Date;
          expires_at: Date | null;
        }>(
          `SELECT a.id AS action_id, o.id AS organisation_id, o.name AS organisation_name,
                  a.action_type, a.risk_class, a.proposal_rationale AS rationale,
                  ap.required_approvals,
                  (SELECT count(*)::text FROM approval_decisions d
                    WHERE d.approval_id = ap.id AND d.decision = 'APPROVED') AS recorded,
                  a.proposed_at, a.expires_at
           FROM actions a
           JOIN organisations o ON o.id = a.organisation_id
           JOIN approvals ap ON ap.id = a.approval_id
           WHERE o.msp_id = $1 AND a.state = 'AWAITING_APPROVAL'
           ORDER BY a.expires_at NULLS LAST, a.proposed_at`,
          [mspId],
        ),
      );

      return reply.status(200).send({
        approvals: rows.map((row) => ({
          actionId: row.action_id,
          organisationId: row.organisation_id,
          organisationName: row.organisation_name,
          actionType: row.action_type,
          riskClass: row.risk_class,
          rationale: row.rationale,
          requiredApprovals: row.required_approvals,
          approvalsRecorded: Number(row.recorded),
          proposedAt: row.proposed_at.toISOString(),
          expiresAt: row.expires_at?.toISOString() ?? null,
          hoursRemaining: row.expires_at
            ? Math.max(
                0,
                Math.round((row.expires_at.getTime() - app.clock.nowEpochMs()) / 3_600_000),
              )
            : null,
        })),
      });
    },
  );
}

/**
 * Triage ordering for the portfolio view.
 *
 * Deliberately not a security score and never shown as a number to the user —
 * it only decides which customer appears at the top of the list. Unknowns
 * contribute, because an MSP that cannot see a customer has a problem even when
 * nothing is visibly failing.
 */
function attentionRank(input: {
  state: AssuranceState;
  criticalFindings: number;
  unknownCount: number;
  staleEvidence: number;
  failedIntegrations: number;
  lastAssessedAt: Date | null;
  nowMs: number;
}): number {
  const staleness =
    input.lastAssessedAt === null
      ? 30
      : Math.min(30, (input.nowMs - input.lastAssessedAt.getTime()) / 86_400_000);
  return (
    (5 - assuranceSeverityRank(input.state)) * 10 +
    input.criticalFindings * 25 +
    input.unknownCount * 6 +
    input.staleEvidence * 2 +
    input.failedIntegrations * 15 +
    staleness * 2
  );
}

function remedyForUnknown(reason: string | null): string {
  switch (reason) {
    case 'NO_EVIDENCE':
      return 'No evidence has been collected for this control. Connect an integration or record an attestation.';
    case 'STALE_EVIDENCE':
      return 'Evidence exists but is beyond its freshness limit. Check that the integration is still collecting.';
    case 'COLLECTION_FAILED':
      return 'The integration failed to collect. Re-check its credentials and permissions.';
    case 'INSUFFICIENT_EVIDENCE':
      return 'Some required facts are missing. Review the control explanation to see which predicates are absent.';
    case 'CONTRADICTORY_EVIDENCE':
      return 'Sources disagree. Review the conflicting evidence and resolve which is authoritative.';
    case 'EVIDENCE_REVOKED':
      return 'The supporting evidence was revoked. Collect replacement evidence.';
    case 'NOT_YET_ASSESSED':
      return 'This control has never been assessed. Run an assessment.';
    default:
      return 'Review the control explanation to see which inputs are missing.';
  }
}

/**
 * Proof of value.
 *
 * Registered on the MSP surface because an MSP's own cost model is
 * MSP_PORTFOLIO information: a client organisation must never see what its MSP
 * believes the work costs, and Veylith has no standing access to it either.
 */
export function registerValueRoutes(server: FastifyInstance, app: AppContext): void {
  /** The task catalogue, and what this MSP has said each one costs. */
  server.get(
    '/v1/msps/:mspId/value/effort-model',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:read');

      const model = await loadEffortModel(app, mspId);
      return reply.status(200).send({
        tasks: ASSURANCE_TASKS.map((task) => {
          const effort = effortFor(model, task.key);
          return {
            ...task,
            minutes: effort.minutes,
            source: effort.source,
            basis: effort.basis,
            recordedAt: effort.recordedAt,
          };
        }),
        completeness: modelCompleteness(model),
        // Said plainly at the top of the response rather than in a footnote:
        // these numbers are the MSP's, and Adericel will not supply them.
        note:
          'Adericel measures what it did. Only you can say what that work is worth in your ' +
          'business. Tasks you have not priced contribute nothing to any saving, and are ' +
          'reported as unpriced rather than estimated.',
      });
    },
  );

  /** Record what one task actually costs this MSP. */
  server.put(
    '/v1/msps/:mspId/value/effort-model/:taskKey',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:manage');
      const { taskKey } = parseParams(request, z.object({ taskKey: z.string().max(64) }));
      const body = parseBody(
        request,
        z.object({
          minutes: z.number().min(0).max(600).nullable(),
          source: z.enum(['MSP_MEASURED', 'MSP_ESTIMATED', 'INDUSTRY_REFERENCE', 'UNKNOWN']),
          basis: z.string().min(3).max(500).nullable(),
        }),
      );
      const principal = requirePrincipal(request);

      const effort = await recordTaskEffort(
        app,
        mspId,
        { ...body, taskKey, recordedAt: null },
        principal.principalType === 'USER' ? principal.principalId : null,
      );

      await audit(app, request, {
        action: 'value:effort:record',
        resourceType: 'Msp',
        resourceId: mspId,
        metadata: { taskKey, source: body.source, minutes: body.minutes },
      });

      return reply.status(200).send(effort);
    },
  );

  /**
   * The report.
   *
   * `target` asks for the portfolio projection — the hundred-customer question
   * — which is refused rather than fudged when the sample cannot support it.
   */
  server.get(
    '/v1/msps/:mspId/value/report',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:billing:read');
      const query = parseQuery(
        request,
        z.object({
          windowDays: z.coerce.number().int().min(1).max(365).default(30),
          target: z.coerce.number().int().min(1).max(10_000).optional(),
          ftePerMonthHours: z.coerce.number().min(1).max(400).optional(),
        }),
      );

      const result = await buildValueReport(app, mspId, {
        windowDays: query.windowDays,
        targetOrganisations: query.target ?? null,
        ftePerMonthHours: query.ftePerMonthHours ?? null,
      });

      return reply.status(200).send(result);
    },
  );

  /** Keep a report, hashed, so a figure quoted in a proposal can be reproduced. */
  server.post(
    '/v1/msps/:mspId/value/reports',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:billing:read');
      const body = parseBody(
        request,
        z.object({ windowDays: z.coerce.number().int().min(1).max(365).default(30) }),
      );
      const principal = requirePrincipal(request);

      const { report } = await buildValueReport(app, mspId, {
        windowDays: body.windowDays,
        targetOrganisations: null,
        ftePerMonthHours: null,
      });
      const retained = await retainValueReport(
        app,
        report,
        principal.principalType === 'USER' ? principal.principalId : null,
      );

      await audit(app, request, {
        action: 'value:report:retain',
        resourceType: 'Msp',
        resourceId: mspId,
        metadata: { contentHash: retained.contentHash, caveats: report.caveats.length },
      });

      return reply.status(201).send({ ...retained, report });
    },
  );

  /** Reports kept, newest first, so a trend is visible rather than a snapshot. */
  server.get(
    '/v1/msps/:mspId/value/reports',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      await requireMsp(app, request, mspId, 'msp:billing:read');

      const rows = await app.db.withPlatform(async (ctx) =>
        ctx.many<{
          id: string;
          period_from: string;
          period_to: string;
          organisation_count: number;
          content_hash: string;
          hours_displaced: string;
          hours_still_spent: string;
          model_completeness: string;
          caveat_count: number;
          generated_at: string;
        }>(
          `SELECT id, period_from, period_to, organisation_count, content_hash,
                  hours_displaced, hours_still_spent, model_completeness, caveat_count,
                  generated_at
             FROM value_reports WHERE msp_id = $1 ORDER BY period_to DESC LIMIT 50`,
          [mspId],
        ),
      );

      return reply.status(200).send({
        reports: rows.map((row) => ({
          id: row.id,
          from: row.period_from,
          to: row.period_to,
          organisationCount: row.organisation_count,
          contentHash: row.content_hash,
          hoursDisplaced: Number(row.hours_displaced),
          hoursStillSpent: Number(row.hours_still_spent),
          modelCompleteness: Number(row.model_completeness),
          caveats: row.caveat_count,
          generatedAt: row.generated_at,
        })),
      });
    },
  );
}
