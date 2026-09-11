import {
  ASSURANCE_TASKS,
  buildEffortModel,
  buildLedger,
  buildProofOfValue,
  measureInterventions,
  measureQuality,
  project,
  taskEffortSchema,
  type EffortModel,
  type ProjectionResult,
  type ProofOfValue,
  type TaskEffort,
} from '@adericel/value';
import { AdericelError, contentHash } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * The proof-of-value service.
 *
 * Assembles the report from four independently measured things — what Adericel
 * did, what people still did, how good the assurance is, and what the MSP says
 * the work is worth — and refuses to fill in any of them.
 *
 * Runs in platform scope because an MSP-level figure spans organisations. The
 * route proves the caller owns the MSP first; this only does arithmetic over
 * the organisations it is handed.
 */

/** The organisations an MSP-level report covers. Proven, never assumed. */
async function organisationsOf(app: AppContext, mspId: string): Promise<readonly string[]> {
  return app.db.withPlatform(async (ctx) => {
    const rows = await ctx.many<{ id: string }>(
      // Closed organisations are included deliberately: work done for a
      // customer who has since left was still work done, and excluding them
      // would make a report get better every time a customer leaves.
      `SELECT id FROM organisations WHERE msp_id = $1 ORDER BY created_at`,
      [mspId],
    );
    return rows.map((row) => row.id);
  });
}

export async function loadEffortModel(app: AppContext, mspId: string): Promise<EffortModel> {
  const rows = await app.db.withPlatform(async (ctx) =>
    ctx.many<{
      task_key: string;
      minutes: string | null;
      source: string;
      basis: string | null;
      recorded_at: string;
    }>(
      `SELECT task_key, minutes, source, basis, recorded_at
         FROM msp_task_efforts WHERE msp_id = $1`,
      [mspId],
    ),
  );

  const supplied: TaskEffort[] = rows.map((row) => ({
    taskKey: row.task_key,
    minutes: row.minutes === null ? null : Number(row.minutes),
    source: row.source as TaskEffort['source'],
    basis: row.basis,
    recordedAt: row.recorded_at,
  }));

  return buildEffortModel(mspId, supplied);
}

export async function recordTaskEffort(
  app: AppContext,
  mspId: string,
  input: unknown,
  recordedByUserId: string | null,
): Promise<TaskEffort> {
  const effort = taskEffortSchema.parse(input);

  if (!ASSURANCE_TASKS.some((task) => task.key === effort.taskKey)) {
    throw new AdericelError('VALIDATION_FAILED', `Unknown assurance task: ${effort.taskKey}`, {
      safeDetails: { known: ASSURANCE_TASKS.map((task) => task.key) },
    });
  }

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `INSERT INTO msp_task_efforts
         (msp_id, task_key, minutes, source, basis, recorded_by, recorded_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (msp_id, task_key) DO UPDATE
         SET minutes = EXCLUDED.minutes,
             source = EXCLUDED.source,
             basis = EXCLUDED.basis,
             recorded_by = EXCLUDED.recorded_by,
             updated_at = EXCLUDED.updated_at`,
      [
        mspId,
        effort.taskKey,
        effort.minutes,
        effort.source,
        effort.basis,
        recordedByUserId,
        app.clock.nowIso(),
      ],
    );
  });

  return { ...effort, recordedAt: app.clock.nowIso() };
}

export interface ValueReportOptions {
  readonly windowDays: number;
  readonly targetOrganisations: number | null;
  readonly ftePerMonthHours: number | null;
}

export interface ValueReportResult {
  readonly report: ProofOfValue;
  readonly projection: ProjectionResult | null;
}

export async function buildValueReport(
  app: AppContext,
  mspId: string,
  options: ValueReportOptions,
): Promise<ValueReportResult> {
  const to = app.clock.nowIso();
  const from = new Date(Date.parse(to) - options.windowDays * 86_400_000).toISOString();
  const window = { from, to };

  const organisationIds = await organisationsOf(app, mspId);
  const model = await loadEffortModel(app, mspId);

  const { ledger, interventions, quality } = await app.db.withPlatform(async (ctx) => ({
    ledger: await buildLedger(ctx, organisationIds, window),
    interventions: await measureInterventions(ctx, organisationIds, window),
    quality: await measureQuality(ctx, organisationIds, window),
  }));

  const report = buildProofOfValue({ mspId, model, ledger, interventions, quality });

  const projection =
    options.targetOrganisations === null
      ? null
      : project(report, {
          targetOrganisations: options.targetOrganisations,
          ftePerMonthHours: options.ftePerMonthHours,
        });

  return { report, projection };
}

/**
 * Keep a report, so a figure quoted in a proposal can still be produced later.
 *
 * Hashed the same way as an Assurance Passport, and for the same reason: a
 * number somebody has been sent should be checkable against the one Adericel
 * actually produced.
 */
export async function retainValueReport(
  app: AppContext,
  report: ProofOfValue,
  generatedByUserId: string | null,
): Promise<{ id: string; contentHash: string }> {
  // The hash covers the figures rather than the whole object, so that a
  // rebuild on a later engine version produces the same hash for the same
  // numbers — which is what a recipient is actually checking.
  const hashable = {
    mspId: report.mspId,
    from: report.from,
    to: report.to,
    organisationCount: report.organisationCount,
    hoursDisplaced: report.hoursDisplaced,
    hoursStillSpent: report.hoursStillSpent,
    hoursIfEntirelyManual: report.hoursIfEntirelyManual,
    modelCompleteness: report.modelCompleteness,
    lines: report.lines.map((line) => ({
      task: line.task.key,
      performedByAdericel: line.performedByAdericel,
      performedByPeople: line.performedByPeople,
      minutesEach: line.minutesEach,
      minutesSource: line.minutesSource,
    })),
  };
  const hash = contentHash(hashable);

  const row = await app.db.withPlatform(async (ctx) =>
    ctx.oneOrFail<{ id: string }>(
      `INSERT INTO value_reports
         (msp_id, period_from, period_to, organisation_count, content, content_hash,
          hours_displaced, hours_still_spent, model_completeness, caveat_count,
          generated_at, generated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        report.mspId,
        report.from,
        report.to,
        report.organisationCount,
        JSON.stringify(report),
        hash,
        report.hoursDisplaced,
        report.hoursStillSpent,
        report.modelCompleteness,
        report.caveats.length,
        app.clock.nowIso(),
        generatedByUserId,
      ],
      'Value report',
    ),
  );

  return { id: row.id, contentHash: hash };
}
