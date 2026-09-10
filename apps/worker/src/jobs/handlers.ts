import {
  createActionService,
  createAssessmentService,
  createCollectionService,
  type CredentialUnsealer,
} from '@adericel/actions';
import { createEvidenceRepository, createObservationRepository } from '@adericel/evidence';
import { publish, type Database } from '@adericel/graph';
import type { ConnectorRegistry } from '@adericel/integrations';
import { compilePolicy, type CompiledPolicy } from '@adericel/policy';
import type { RulesetRegistry } from '@adericel/truth-engine';
import {
  errorFields,
  newCorrelationId,
  type AdericelConfig,
  type Clock,
  type Logger,
} from '@adericel/shared';
import { organisationSettingsSchema, type AutonomyLevel } from '@adericel/domain';
import { sweepRetention } from '@adericel/api';
import type { DueJob, JobHandler, JobResult, JobType } from './scheduler.js';

/**
 * Job handlers.
 *
 * Every handler is idempotent and bounded: it processes at most a fixed batch
 * and reports honestly what it did. A job that could run unbounded would turn a
 * backlog into an outage.
 */

export interface HandlerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly config: AdericelConfig;
  readonly rulesets: RulesetRegistry;
  readonly connectors: ConnectorRegistry;
  readonly defaultPolicy: CompiledPolicy;
  readonly unsealCredentials: CredentialUnsealer;
}

const BATCH = 200;

export function buildHandlers(deps: HandlerDeps): Partial<Record<JobType, JobHandler>> {
  const { db, clock, logger } = deps;

  /**
   * The organisations a scheduled job may act on.
   *
   * `assurance_maintained` is the billing lifecycle's only lever, and this is
   * where it bites: an organisation whose subscription has lapsed stops being
   * collected from and stops being assessed. Nothing is deleted and no
   * determination changes — the record stands as a set of statements about the
   * instants they were made — but Adericel stops claiming to know the present.
   *
   * Filtering here rather than in each handler is deliberate. Every scheduled
   * job routes through this one function, so a new job inherits the rule
   * instead of having to remember it.
   *
   * A job that names an organisation explicitly is checked too. An operator
   * re-running a collection by hand for a lapsed customer would otherwise
   * quietly resume the assurance Adericel is no longer being paid to maintain.
   */
  async function organisationsToProcess(job: DueJob): Promise<readonly string[]> {
    if (job.organisationId) {
      const maintained = await db.withPlatform(async (ctx) =>
        ctx.one<{ id: string }>(
          `SELECT id FROM organisations
           WHERE id = $1 AND status = 'ACTIVE' AND assurance_maintained`,
          [job.organisationId],
        ),
      );
      if (!maintained) {
        logger.info(
          { organisationId: job.organisationId, jobType: job.jobType },
          'skipping scheduled work: assurance is not being maintained for this organisation',
        );
        return [];
      }
      return [job.organisationId];
    }
    return db.withPlatform(async (ctx) => {
      const rows = await ctx.many<{ id: string }>(
        `SELECT id FROM organisations
         WHERE status = 'ACTIVE' AND assurance_maintained
         ORDER BY id LIMIT $1`,
        [BATCH],
      );
      return rows.map((row) => row.id);
    });
  }

  async function autonomyFor(organisationId: string): Promise<AutonomyLevel> {
    return db.withPlatform(async (ctx) => {
      const row = await ctx.one<{ settings: Record<string, unknown> }>(
        `SELECT settings FROM organisations WHERE id = $1`,
        [organisationId],
      );
      return organisationSettingsSchema.parse(row?.settings ?? {})
        .defaultAutonomyLevel as AutonomyLevel;
    });
  }

  return {
    /**
     * Scheduled reassessment.
     *
     * Runs every control, then rolls up requirements, frameworks and the
     * organisation so each level aggregates freshly assessed children.
     */
    'reassess-organisation': async (job): Promise<JobResult> => {
      const organisationIds = await organisationsToProcess(job);
      let assessed = 0;
      let changed = 0;

      for (const organisationId of organisationIds) {
        const correlationId = newCorrelationId();
        await db.withTenant(organisationId, async (ctx) => {
          const service = createAssessmentService({
            ctx,
            clock,
            logger: logger.child({ organisationId, correlationId }),
            rulesets: deps.rulesets,
            actor: 'scheduler',
            correlationId,
          });
          const outputs = await service.assessAllControls('SCHEDULED');
          assessed += outputs.length;
          changed += outputs.filter((o) => o.stateChanged).length;

          const requirements = await ctx.many<{ requirement_id: string }>(
            `SELECT DISTINCT requirement_id FROM control_requirements WHERE organisation_id = $1`,
            [organisationId],
          );
          for (const row of requirements) await service.rollUpRequirement(row.requirement_id);

          const frameworks = await ctx.many<{ framework_id: string }>(
            `SELECT framework_id FROM organisation_frameworks WHERE organisation_id = $1`,
            [organisationId],
          );
          for (const row of frameworks) await service.rollUpFramework(row.framework_id);

          await service.rollUpOrganisation();
        });
      }

      return {
        status: 'SUCCEEDED',
        detail: `Assessed ${assessed} control(s) across ${organisationIds.length} organisation(s); ${changed} state change(s)`,
      };
    },

    /**
     * Evidence expiry.
     *
     * Marking evidence expired is what turns a control from SATISFIED to
     * UNKNOWN when nobody has refreshed the proof — the single most important
     * behaviour separating Adericel from a point-in-time compliance snapshot.
     */
    'expire-evidence': async (job): Promise<JobResult> => {
      const organisationIds = await organisationsToProcess(job);
      let expired = 0;

      for (const organisationId of organisationIds) {
        const correlationId = newCorrelationId();
        const ids = await db.withTenant(organisationId, async (ctx) => {
          const expiredIds = await createEvidenceRepository(ctx, clock).expireOverdue(BATCH);
          for (const evidenceId of expiredIds) {
            await publish(
              ctx,
              {
                type: 'EvidenceExpired',
                organisationId,
                subjectType: 'Evidence',
                subjectId: evidenceId,
                payload: {},
                correlationId,
                actor: 'scheduler',
              },
              clock.nowIso(),
            );
          }
          return expiredIds;
        });
        expired += ids.length;
      }

      return { status: 'SUCCEEDED', detail: `Expired ${expired} evidence record(s)` };
    },

    /** Time out approvals nobody acted on, so an action cannot sit forever. */
    /**
     * Stop maintaining assurance for subscriptions whose grace period ended.
     *
     * The grace period exists because a failed payment is usually an expired
     * card, and suspending an estate over one is disproportionate. When it runs
     * out, Adericel stops observing — and stops nothing else. No evidence is
     * deleted, no determination is altered, and the record remains available in
     * full. What ends is the claim to currency.
     */
    'lapse-overdue-subscriptions': async (): Promise<JobResult> => {
      const now = clock.nowIso();
      const lapsed = await db.withPlatform(async (ctx) => {
        const due = await ctx.many<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions
           WHERE lapsed_at IS NULL
             AND ((grace_ends_at IS NOT NULL AND grace_ends_at <= $1::timestamptz)
                  OR (status = 'TRIAL' AND trial_ends_at IS NOT NULL
                      AND trial_ends_at <= $1::timestamptz))`,
          [now],
        );
        const results: { subscriptionId: string; organisations: number }[] = [];
        for (const row of due) {
          const reason =
            row.status === 'TRIAL' ? 'Trial ended without a subscription' : 'Payment overdue';
          const affected = await ctx.many<{ id: string }>(
            `UPDATE organisations o
             SET assurance_maintained = false,
                 maintenance_stopped_at = COALESCE(o.maintenance_stopped_at, $2::timestamptz),
                 maintenance_stopped_reason = $3
             FROM subscriptions s
             WHERE s.id = $1 AND o.status <> 'CLOSED' AND o.assurance_maintained
               AND ((s.organisation_id IS NOT NULL AND o.id = s.organisation_id)
                    OR (s.msp_id IS NOT NULL AND o.msp_id = s.msp_id))
             RETURNING o.id`,
            [row.id, now, reason],
          );
          await ctx.query(
            `UPDATE subscriptions
             SET lapsed_at = COALESCE(lapsed_at, $2::timestamptz), lapse_reason = $3
             WHERE id = $1`,
            [row.id, now, reason],
          );
          logger.warn(
            { subscriptionId: row.id, organisations: affected.length, reason },
            'stopped maintaining assurance for a lapsed subscription',
          );
          results.push({ subscriptionId: row.id, organisations: affected.length });
        }
        return results;
      });

      const organisations = lapsed.reduce((total, row) => total + row.organisations, 0);
      return {
        status: 'SUCCEEDED',
        detail:
          lapsed.length === 0
            ? 'No subscriptions were overdue'
            : `Stopped maintaining ${organisations} organisation(s) across ` +
              `${lapsed.length} lapsed subscription(s)`,
      };
    },

    'expire-approvals': async (job): Promise<JobResult> => {
      const organisationIds = await organisationsToProcess(job);
      let expired = 0;

      for (const organisationId of organisationIds) {
        const correlationId = newCorrelationId();
        const autonomyLevel = await autonomyFor(organisationId);
        const ids = await db.withTenant(organisationId, async (ctx) =>
          createActionService({
            ctx,
            clock,
            logger,
            connectors: deps.connectors,
            policy: deps.defaultPolicy,
            policyId: null,
            organisationAutonomyLevel: autonomyLevel,
            correlationId,
            actor: 'scheduler',
            actorUserId: null,
            unsealCredentials: deps.unsealCredentials,
          }).expireOverdueApprovals(),
        );
        expired += ids.length;
      }

      return { status: 'SUCCEEDED', detail: `Timed out ${expired} approval(s)` };
    },

    /**
     * Expire exceptions.
     *
     * An expired exception stops suppressing its control, which is the entire
     * point of requiring an end date: the deviation comes back into view.
     */
    'expire-exceptions': async (job): Promise<JobResult> => {
      const organisationIds = await organisationsToProcess(job);
      let expired = 0;

      for (const organisationId of organisationIds) {
        const correlationId = newCorrelationId();
        const ids = await db.withTenant(organisationId, async (ctx) => {
          const rows = await ctx.many<{ id: string; control_id: string | null }>(
            `UPDATE exceptions SET status = 'EXPIRED'
             WHERE organisation_id = $1 AND status = 'APPROVED' AND expires_at <= $2::timestamptz
             RETURNING id, control_id`,
            [organisationId, clock.nowIso()],
          );
          for (const row of rows) {
            await publish(
              ctx,
              {
                type: 'ExceptionExpired',
                organisationId,
                subjectType: 'Exception',
                subjectId: row.id,
                payload: { controlId: row.control_id },
                correlationId,
                actor: 'scheduler',
              },
              clock.nowIso(),
            );
          }
          return rows;
        });
        expired += ids.length;
      }

      return { status: 'SUCCEEDED', detail: `Expired ${expired} exception(s)` };
    },

    /** Run every integration whose schedule is due. */
    'collect-integrations': async (job): Promise<JobResult> => {
      const organisationIds = await organisationsToProcess(job);
      let succeeded = 0;
      let failed = 0;

      for (const organisationId of organisationIds) {
        const integrations = await db.withTenant(organisationId, async (ctx) =>
          ctx.many<{ id: string; connector_key: string }>(
            `SELECT id, connector_key FROM integrations
             WHERE organisation_id = $1 AND status IN ('CONFIGURED', 'CONNECTED', 'DEGRADED')`,
            [organisationId],
          ),
        );

        for (const integration of integrations) {
          const correlationId = newCorrelationId();
          try {
            const outcome = await db.withTenant(organisationId, async (ctx) =>
              createCollectionService({
                ctx,
                clock,
                logger: logger.child({
                  organisationId,
                  integrationId: integration.id,
                  correlationId,
                }),
                connectors: deps.connectors,
                correlationId,
                actor: 'scheduler',
                unsealCredentials: deps.unsealCredentials,
              }).runIntegration(integration.id, 'SCHEDULED'),
            );
            if (outcome.status === 'FAILED') failed += 1;
            else succeeded += 1;
          } catch (error) {
            failed += 1;
            // One integration failing must not abandon the rest of the batch.
            logger.error(
              { integrationId: integration.id, organisationId, ...errorFields(error) },
              'scheduled collection failed',
            );
          }
        }
      }

      return {
        status: failed > 0 ? 'SUCCEEDED' : 'SUCCEEDED',
        detail: `${succeeded} collection(s) succeeded, ${failed} failed`,
      };
    },

    /**
     * Reconcile executions with an unknown outcome.
     *
     * These are the dangerous ones: Adericel dispatched something and never
     * learned whether it took effect. They are surfaced rather than retried,
     * because a blind retry could duplicate a side effect in a customer's
     * environment.
     */
    'reconcile-executions': async (): Promise<JobResult> => {
      const stranded = await db.withPlatform(async (ctx) =>
        ctx.many<{
          id: string;
          action_id: string;
          organisation_id: string;
          started_at: Date;
          action_type: string;
        }>(
          `SELECT ae.id, ae.action_id, ae.organisation_id, ae.started_at, a.action_type
           FROM action_executions ae
           JOIN actions a ON a.id = ae.action_id
           WHERE ae.status = 'UNKNOWN_OUTCOME'
             AND ae.started_at < now() - interval '5 minutes'
           ORDER BY ae.started_at
           LIMIT $1`,
          [50],
        ),
      );

      for (const execution of stranded) {
        const correlationId = newCorrelationId();
        await db.withTenant(execution.organisation_id, async (ctx) => {
          await publish(
            ctx,
            {
              type: 'ActionFailed',
              organisationId: execution.organisation_id,
              subjectType: 'Action',
              subjectId: execution.action_id,
              payload: {
                status: 'UNKNOWN_OUTCOME',
                detail:
                  'Execution outcome is unknown and needs reconciliation against the external system ' +
                  'before it can be retried.',
                executionId: execution.id,
                actionType: execution.action_type,
              },
              correlationId,
              actor: 'reconciler',
            },
            clock.nowIso(),
          );
        });
      }

      return {
        status: 'SUCCEEDED',
        detail:
          stranded.length === 0
            ? 'No executions need reconciliation'
            : `${stranded.length} execution(s) have an unknown outcome and were reported for reconciliation`,
      };
    },

    /**
     * Purge raw observations past their retention period.
     *
     * Only observations that were never promoted to evidence are removed;
     * deleting the others would break the provenance chain behind historical
     * assessments.
     */
    'purge-observations': async (job): Promise<JobResult> => {
      const organisationIds = await organisationsToProcess(job);
      let purged = 0;

      for (const organisationId of organisationIds) {
        const settings = await db.withPlatform(async (ctx) => {
          const row = await ctx.one<{ settings: Record<string, unknown> }>(
            `SELECT settings FROM organisations WHERE id = $1`,
            [organisationId],
          );
          return organisationSettingsSchema.parse(row?.settings ?? {});
        });
        const cutoff = new Date(
          clock.nowEpochMs() - settings.observationRetentionDays * 86_400_000,
        ).toISOString();

        purged += await db.withTenant(organisationId, async (ctx) =>
          createObservationRepository(ctx, clock).purgeOlderThan(cutoff, 5000),
        );
      }

      return { status: 'SUCCEEDED', detail: `Purged ${purged} observation(s) past retention` };
    },

    /**
     * Enforce every retention period in the register of personal data.
     *
     * The register is the single statement of what Adericel holds and for how
     * long; this runs it. A period that changes there changes what this does,
     * and there is nowhere for a published schedule and the running code to
     * disagree.
     */
    'sweep-retention': async (): Promise<JobResult> => {
      const report = await sweepRetention({ db, clock });
      const acted = report.outcomes.filter((outcome) => outcome.rowsAffected > 0);
      if (acted.length === 0) {
        return { status: 'SUCCEEDED', detail: 'Nothing past its retention period' };
      }
      const detail = acted
        .map((outcome) => `${outcome.entry}: ${outcome.treatment} ${outcome.rowsAffected}`)
        .join('; ');
      return { status: 'SUCCEEDED', detail };
    },

    'purge-idempotency-keys': async (): Promise<JobResult> => {
      const removed = await db.withPlatform(async (ctx) => {
        const { rowCount } = await ctx.query(
          `DELETE FROM idempotency_keys WHERE expires_at < now()`,
        );
        return rowCount;
      });
      return { status: 'SUCCEEDED', detail: `Removed ${removed} expired idempotency key(s)` };
    },

    /**
     * Adericel assesses itself.
     *
     * If an Adericel organisation exists, its self-assurance integration is
     * collected and reassessed on the same schedule a customer gets.
     */
    'self-assurance': async (): Promise<JobResult> => {
      const selfOrg = await db.withPlatform(async (ctx) =>
        ctx.one<{ id: string }>(`SELECT id FROM organisations WHERE slug = 'adericel'`),
      );
      if (!selfOrg) {
        return {
          status: 'SKIPPED',
          detail: 'No Adericel self-assurance organisation is configured',
        };
      }

      const correlationId = newCorrelationId();
      const integrations = await db.withTenant(selfOrg.id, async (ctx) =>
        ctx.many<{ id: string }>(
          `SELECT id FROM integrations
           WHERE organisation_id = $1 AND connector_key = 'adericel-self' AND status <> 'DISABLED'`,
          [selfOrg.id],
        ),
      );

      for (const integration of integrations) {
        await db.withTenant(selfOrg.id, async (ctx) =>
          createCollectionService({
            ctx,
            clock,
            logger,
            connectors: deps.connectors,
            correlationId,
            actor: 'self-assurance',
            unsealCredentials: deps.unsealCredentials,
          }).runIntegration(integration.id, 'SCHEDULED'),
        );
      }

      await db.withTenant(selfOrg.id, async (ctx) => {
        await createAssessmentService({
          ctx,
          clock,
          logger,
          rulesets: deps.rulesets,
          actor: 'self-assurance',
          correlationId,
        }).assessAllControls('SCHEDULED');
      });

      return {
        status: 'SUCCEEDED',
        detail: `Collected ${integrations.length} self-assurance source(s) and reassessed Adericel`,
      };
    },
  };
}

export { compilePolicy };
