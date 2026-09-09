import { publish, type Database, type PlatformContext } from '@adericel/graph';
import { errorFields, newCorrelationId, type Clock, type Logger } from '@adericel/shared';

/**
 * Scheduled work.
 *
 * The schedule lives in the database, not in n8n or in a cron file. A workflow
 * outage should delay a reassessment, not lose it — and when the worker comes
 * back it must be able to see exactly what it missed.
 *
 * Jobs are claimed with a lock so several worker replicas never run the same
 * job twice. A stale lock is reclaimed after a timeout, so a crashed worker
 * does not block a job permanently.
 */

export const JOB_TYPES = [
  'reassess-organisation',
  'expire-evidence',
  'expire-approvals',
  'expire-exceptions',
  'collect-integrations',
  'reconcile-executions',
  'purge-observations',
  'purge-idempotency-keys',
  'self-assurance',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface DueJob {
  readonly id: string;
  readonly organisationId: string | null;
  readonly jobType: JobType;
  readonly payload: Record<string, unknown>;
  readonly cron: string | null;
}

export interface JobResult {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  readonly detail: string;
  /** Explicit next run; otherwise derived from the cron expression. */
  readonly nextRunAt?: string;
}

export type JobHandler = (job: DueJob) => Promise<JobResult>;

const LOCK_TIMEOUT_MS = 10 * 60_000;

export async function claimDueJobs(
  db: Database,
  workerId: string,
  limit: number,
  nowIso: string,
): Promise<readonly DueJob[]> {
  return db.withPlatform(async (ctx) => {
    const rows = await ctx.many<{
      id: string;
      organisation_id: string | null;
      job_type: string;
      payload: Record<string, unknown>;
      cron: string | null;
    }>(
      `WITH due AS (
         SELECT id FROM scheduled_jobs
         WHERE enabled
           AND next_run_at <= $2::timestamptz
           AND (locked_at IS NULL OR locked_at < $2::timestamptz - ($4 || ' milliseconds')::interval)
         ORDER BY next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE scheduled_jobs j
       SET locked_at = $2::timestamptz, locked_by = $1
       FROM due
       WHERE j.id = due.id
       RETURNING j.id, j.organisation_id, j.job_type, j.payload, j.cron`,
      [workerId, nowIso, limit, String(LOCK_TIMEOUT_MS)],
    );
    return rows.map((row) => ({
      id: row.id,
      organisationId: row.organisation_id,
      jobType: row.job_type as JobType,
      payload: row.payload,
      cron: row.cron,
    }));
  });
}

export async function completeJob(
  db: Database,
  job: DueJob,
  result: JobResult,
  clock: Clock,
): Promise<void> {
  const nextRunAt = result.nextRunAt ?? nextRunFromCron(job.cron, clock.nowIso());
  await db.withPlatform(async (ctx) => {
    await ctx.query(
      `UPDATE scheduled_jobs
       SET last_run_at = $2::timestamptz,
           last_status = $3,
           last_error = $4,
           next_run_at = $5::timestamptz,
           locked_at = NULL,
           locked_by = NULL
       WHERE id = $1`,
      [
        job.id,
        clock.nowIso(),
        result.status,
        result.status === 'FAILED' ? result.detail.slice(0, 2000) : null,
        nextRunAt,
      ],
    );
  });
}

/**
 * Next run time from a cron expression.
 *
 * Supports the standard five-field form with `*`, fixed values, ranges,
 * comma-separated lists and step values — the subset an operator actually
 * writes for a collection or reassessment schedule. Anything else falls back to
 * hourly, and the fallback is logged rather than silently accepted.
 */
export function nextRunFromCron(cron: string | null, fromIso: string): string {
  const from = new Date(fromIso);
  if (!cron) return new Date(from.getTime() + 3_600_000).toISOString();

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return new Date(from.getTime() + 3_600_000).toISOString();

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];

  const matches = (field: string, value: number, min: number, max: number): boolean => {
    if (field === '*') return true;
    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [range, stepRaw] = part.split('/');
        const step = Number(stepRaw);
        if (!Number.isInteger(step) || step <= 0) continue;
        const [lo, hi] =
          range === '*' || range === undefined
            ? [min, max]
            : range.includes('-')
              ? (range.split('-').map(Number) as [number, number])
              : [Number(range), max];
        if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
        continue;
      }
      if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number) as [number, number];
        if (value >= lo && value <= hi) return true;
        continue;
      }
      if (Number(part) === value) return true;
    }
    return false;
  };

  // Step minute by minute for at most a year. Simple, exact, and fast enough
  // for a scheduler that runs once a second.
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < 527_040; i += 1) {
    if (
      matches(minute, candidate.getUTCMinutes(), 0, 59) &&
      matches(hour, candidate.getUTCHours(), 0, 23) &&
      matches(dayOfMonth, candidate.getUTCDate(), 1, 31) &&
      matches(month, candidate.getUTCMonth() + 1, 1, 12) &&
      matches(dayOfWeek, candidate.getUTCDay(), 0, 6)
    ) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return new Date(from.getTime() + 3_600_000).toISOString();
}

/** Register the standard job set for an organisation at onboarding. */
export async function ensureOrganisationJobs(
  ctx: PlatformContext,
  organisationId: string,
  nowIso: string,
): Promise<void> {
  const jobs: { type: JobType; cron: string }[] = [
    { type: 'reassess-organisation', cron: '0 */6 * * *' },
    { type: 'collect-integrations', cron: '0 */4 * * *' },
    { type: 'expire-evidence', cron: '15 * * * *' },
    { type: 'expire-approvals', cron: '30 * * * *' },
    { type: 'expire-exceptions', cron: '45 2 * * *' },
    { type: 'purge-observations', cron: '0 3 * * *' },
  ];

  for (const job of jobs) {
    await ctx.query(
      `INSERT INTO scheduled_jobs (organisation_id, job_type, cron, next_run_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (COALESCE(organisation_id, '00000000-0000-0000-0000-000000000000'), job_type)
       DO NOTHING`,
      [organisationId, job.type, job.cron, nextRunFromCron(job.cron, nowIso)],
    );
  }
}

/** Register platform-wide jobs that are not organisation-scoped. */
export async function ensurePlatformJobs(ctx: PlatformContext, nowIso: string): Promise<void> {
  const jobs: { type: JobType; cron: string }[] = [
    { type: 'reconcile-executions', cron: '*/10 * * * *' },
    { type: 'purge-idempotency-keys', cron: '0 4 * * *' },
    { type: 'self-assurance', cron: '0 * * * *' },
  ];
  for (const job of jobs) {
    await ctx.query(
      `INSERT INTO scheduled_jobs (organisation_id, job_type, cron, next_run_at)
       VALUES (NULL, $1, $2, $3::timestamptz)
       ON CONFLICT (COALESCE(organisation_id, '00000000-0000-0000-0000-000000000000'), job_type)
       DO NOTHING`,
      [job.type, job.cron, nextRunFromCron(job.cron, nowIso)],
    );
  }
}

export interface RunJobsOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly workerId: string;
  readonly limit: number;
  readonly handlers: Partial<Record<JobType, JobHandler>>;
}

export async function runDueJobs(options: RunJobsOptions): Promise<{ ran: number; failed: number }> {
  const jobs = await claimDueJobs(options.db, options.workerId, options.limit, options.clock.nowIso());
  let ran = 0;
  let failed = 0;

  for (const job of jobs) {
    const logger = options.logger.child({
      jobId: job.id,
      jobType: job.jobType,
      organisationId: job.organisationId,
      correlationId: newCorrelationId(),
    });
    const handler = options.handlers[job.jobType];

    if (!handler) {
      logger.warn({}, 'no handler registered for job type');
      await completeJob(options.db, job, { status: 'SKIPPED', detail: 'No handler registered' }, options.clock);
      continue;
    }

    try {
      const result = await handler(job);
      await completeJob(options.db, job, result, options.clock);
      ran += 1;
      logger.info({ status: result.status, detail: result.detail }, 'job completed');
    } catch (error) {
      failed += 1;
      // A failed job must still release its lock and be rescheduled, or one bad
      // organisation would stop that job type for everyone.
      await completeJob(
        options.db,
        job,
        { status: 'FAILED', detail: (error as Error).message },
        options.clock,
      );
      logger.error(errorFields(error), 'job failed');
    }
  }

  return { ran, failed };
}

export { publish };
