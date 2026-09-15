import { createAssessmentService, createCollectionService } from '@adericel/actions';
import { buildExceptionQueue, EXCEPTION_KINDS_BY_KEY } from '@adericel/triage';
import { newCorrelationId } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * The loop, run as one thing.
 *
 * Connect, discover, collect, establish truth, find exceptions, prioritise,
 * fix what is safe, verify, prove, repeat. Adericel already did all of it —
 * as separate scheduled jobs and separate routes, which meant the loop an MSP
 * is actually buying existed only as emergent behaviour.
 *
 * Emergent behaviour cannot be measured, and "how much work does this take off
 * my desk" is the question the product lives or dies on. So a cycle is a
 * recorded object with per-stage counts and timings.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not approve anything, and it cannot. Remediation that policy permits
 * unattended runs; remediation that needs a person waits for one, and appears
 * in the next exception queue. A loop that could approve its own actions would
 * be the "AI to API to green" pattern the whole architecture refuses.
 */

export interface StageTiming {
  readonly stage: string;
  readonly milliseconds: number;
}

export interface LoopCycleResult {
  readonly cycleId: string;
  readonly mspId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly organisationsInScope: number;
  /** Customers the cycle could not complete, and why. Never silently dropped. */
  readonly organisationsSkipped: readonly { organisationId: string; reason: string }[];

  readonly observationsCollected: number;
  readonly evidenceCreated: number;
  readonly claimsAsserted: number;
  readonly changesDetected: number;
  readonly determinationsMade: number;
  readonly determinationsUnknown: number;
  readonly exceptionsOpen: number;
  readonly exceptionsNeedingHuman: number;
  readonly remediationsProposed: number;
  readonly remediationsAutonomous: number;
  readonly remediationsApproved: number;
  readonly verificationsConfirmed: number;
  readonly verificationsRefuted: number;

  readonly stageTimings: readonly StageTiming[];
}

interface CycleCounters {
  observationsCollected: number;
  evidenceCreated: number;
  claimsAsserted: number;
  changesDetected: number;
  determinationsMade: number;
  determinationsUnknown: number;
  remediationsProposed: number;
  remediationsAutonomous: number;
  remediationsApproved: number;
  verificationsConfirmed: number;
  verificationsRefuted: number;
}

async function timed<T>(timings: StageTiming[], stage: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ stage, milliseconds: Date.now() - started });
  }
}

/** The organisations a cycle may act on. Proven from the database, never taken. */
async function organisationsFor(app: AppContext, mspId: string): Promise<readonly string[]> {
  return app.db.withPlatform(async (ctx) => {
    const rows = await ctx.many<{ id: string }>(
      // Only organisations Adericel is being paid to maintain. A lapsed or
      // offboarding customer is deliberately excluded: collecting from an
      // estate Adericel has stopped asserting about would be the billing
      // lifecycle's only lever quietly not working (ADR-0027).
      `SELECT id FROM organisations
        WHERE msp_id = $1 AND status = 'ACTIVE' AND assurance_maintained
        ORDER BY created_at`,
      [mspId],
    );
    return rows.map((row) => row.id);
  });
}

/**
 * Run one pass of the loop across an MSP's portfolio.
 *
 * Sequential by customer. Parallelism would make the timings unreadable and
 * would turn a scaling question into a connection-pool question — and the
 * timings are the point of recording a cycle at all.
 */
export async function runLoopCycle(
  app: AppContext,
  mspId: string,
  options: {
    readonly trigger: 'SCHEDULED' | 'MANUAL' | 'EVENT' | 'PROOF';
    /** Run the collection stage. Off when a cycle only re-determines. */
    readonly collect?: boolean;
  },
): Promise<LoopCycleResult> {
  const startedAt = app.clock.nowIso();
  // One correlation id for the whole cycle, so every observation, determination
  // and action it produced can be traced back to the pass that caused them.
  const correlationId = newCorrelationId();
  const timings: StageTiming[] = [];
  const skipped: { organisationId: string; reason: string }[] = [];
  const counters: CycleCounters = {
    observationsCollected: 0,
    evidenceCreated: 0,
    claimsAsserted: 0,
    changesDetected: 0,
    determinationsMade: 0,
    determinationsUnknown: 0,
    remediationsProposed: 0,
    remediationsAutonomous: 0,
    remediationsApproved: 0,
    verificationsConfirmed: 0,
    verificationsRefuted: 0,
  };

  const organisationIds = await organisationsFor(app, mspId);

  // ---------------------------------------------------------------- observe
  if (options.collect !== false) {
    await timed(timings, 'collect', async () => {
      for (const organisationId of organisationIds) {
        const integrations = await app.db.withPlatform(async (ctx) =>
          ctx.many<{ id: string }>(
            `SELECT id FROM integrations
              WHERE organisation_id = $1 AND status = 'CONNECTED'`,
            [organisationId],
          ),
        );
        if (integrations.length === 0) {
          // A customer with nothing connected is not a failure of the cycle;
          // it is the coverage ladder's bottom rung, and it is recorded rather
          // than passed over in silence.
          skipped.push({ organisationId, reason: 'No connected integration' });
          continue;
        }
        for (const integration of integrations) {
          try {
            const run = await app.db.withTenant(organisationId, async (ctx) =>
              createCollectionService({
                ctx,
                clock: app.clock,
                logger: app.logger,
                connectors: app.connectors,
                correlationId,
                actor: 'operating-loop',
                unsealCredentials: app.unsealCredentials,
              }).runIntegration(integration.id, 'SCHEDULED'),
            );
            counters.observationsCollected += run.observationsRecorded;
            counters.evidenceCreated += run.evidenceCreated;
            counters.claimsAsserted += run.claimsChanged;
          } catch (error) {
            skipped.push({
              organisationId,
              reason: `Collection failed: ${(error as Error).message}`,
            });
          }
        }
      }
    });
  }

  // --------------------------------------------------------------- determine
  await timed(timings, 'determine', async () => {
    for (const organisationId of organisationIds) {
      try {
        const outputs = await app.db.withTenant(organisationId, async (ctx) => {
          const service = createAssessmentService({
            ctx,
            clock: app.clock,
            logger: app.logger,
            rulesets: app.rulesets,
            actor: 'operating-loop',
            correlationId,
          });
          const controls = await service.assessAllControls('SCHEDULED');
          // Roll up in dependency order so each level aggregates fresh
          // children, exactly as the manual route does.
          const requirements = await ctx.many<{ requirement_id: string }>(
            `SELECT DISTINCT requirement_id FROM control_requirements
              WHERE organisation_id = $1`,
            [organisationId],
          );
          for (const row of requirements) await service.rollUpRequirement(row.requirement_id);
          const frameworks = await ctx.many<{ framework_id: string }>(
            `SELECT framework_id FROM organisation_frameworks WHERE organisation_id = $1`,
            [organisationId],
          );
          for (const row of frameworks) await service.rollUpFramework(row.framework_id);
          await service.rollUpOrganisation();
          return controls;
        });
        counters.determinationsMade += outputs.length;
        counters.determinationsUnknown += outputs.filter(
          (output: { assessment: { state: string } }) => output.assessment.state === 'UNKNOWN',
        ).length;
      } catch (error) {
        skipped.push({
          organisationId,
          reason: `Assessment failed: ${(error as Error).message}`,
        });
      }
    }
  });

  // ------------------------------------------------------------------ measure
  const windowFrom = new Date(Date.parse(startedAt) - 3_600_000).toISOString();
  await timed(timings, 'measure', async () => {
    const row = await app.db.withPlatform(async (ctx) =>
      ctx.one<{
        changes: string;
        proposed: string;
        autonomous: string;
        approved: string;
        confirmed: string;
        refuted: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM claims
             WHERE organisation_id = ANY($1::uuid[]) AND supersedes_claim_id IS NOT NULL
               AND asserted_at > $2) AS changes,
           (SELECT count(*)::text FROM actions
             WHERE organisation_id = ANY($1::uuid[]) AND proposed_at > $2) AS proposed,
           (SELECT count(*)::text FROM actions
             WHERE organisation_id = ANY($1::uuid[]) AND proposed_at > $2
               AND state = 'CONFIRMED' AND approval_id IS NULL) AS autonomous,
           (SELECT count(*)::text FROM actions
             WHERE organisation_id = ANY($1::uuid[]) AND proposed_at > $2
               AND approval_id IS NOT NULL) AS approved,
           (SELECT count(*)::text FROM verifications
             WHERE organisation_id = ANY($1::uuid[]) AND verified_at > $2
               AND outcome = 'CONFIRMED') AS confirmed,
           (SELECT count(*)::text FROM verifications
             WHERE organisation_id = ANY($1::uuid[]) AND verified_at > $2
               AND outcome = 'REFUTED') AS refuted`,
        [[...organisationIds], windowFrom],
      ),
    );
    counters.changesDetected = Number(row?.changes ?? '0');
    counters.remediationsProposed = Number(row?.proposed ?? '0');
    counters.remediationsAutonomous = Number(row?.autonomous ?? '0');
    counters.remediationsApproved = Number(row?.approved ?? '0');
    counters.verificationsConfirmed = Number(row?.confirmed ?? '0');
    counters.verificationsRefuted = Number(row?.refuted ?? '0');
  });

  // ------------------------------------------------------------------- triage
  const queue = await timed(timings, 'triage', async () =>
    app.db.withPlatform(async (ctx) =>
      buildExceptionQueue(ctx, organisationIds, app.clock.nowIso()),
    ),
  );

  // Every exception in the queue is by definition something a person must do:
  // the queue is deliberately hard to get into, and anything Adericel can
  // handle itself never reaches it.
  const needingHuman = queue.exceptions.filter(
    (exception) => EXCEPTION_KINDS_BY_KEY[exception.kind].response !== undefined,
  ).length;

  const finishedAt = app.clock.nowIso();

  const cycle = await app.db.withPlatform(async (ctx) =>
    ctx.oneOrFail<{ id: string }>(
      `INSERT INTO loop_cycles
         (msp_id, started_at, finished_at, trigger, organisations_in_scope,
          observations_collected, evidence_created, claims_asserted, changes_detected,
          determinations_made, determinations_unknown, exceptions_open,
          exceptions_needing_human, remediations_proposed, remediations_autonomous,
          remediations_approved, verifications_confirmed, verifications_refuted,
          stage_timings, organisations_skipped)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)
       RETURNING id`,
      [
        mspId,
        startedAt,
        finishedAt,
        options.trigger,
        organisationIds.length,
        counters.observationsCollected,
        counters.evidenceCreated,
        counters.claimsAsserted,
        counters.changesDetected,
        counters.determinationsMade,
        counters.determinationsUnknown,
        queue.exceptions.length,
        needingHuman,
        counters.remediationsProposed,
        counters.remediationsAutonomous,
        counters.remediationsApproved,
        counters.verificationsConfirmed,
        counters.verificationsRefuted,
        JSON.stringify(timings),
        JSON.stringify(skipped),
      ],
      'Loop cycle',
    ),
  );

  return {
    cycleId: cycle.id,
    mspId,
    startedAt,
    finishedAt,
    organisationsInScope: organisationIds.length,
    organisationsSkipped: skipped,
    ...counters,
    exceptionsOpen: queue.exceptions.length,
    exceptionsNeedingHuman: needingHuman,
    stageTimings: timings,
  };
}
