import {
  computeCapacity,
  responseEffortSchema,
  RESPONSE_TYPES,
  unpricedResponse,
  type CapacityResult,
  type ExceptionLoad,
  type ResponseEffort,
  type ResponseType,
} from '@adericel/value';
import { buildExceptionQueue, EXCEPTION_KINDS_BY_KEY } from '@adericel/triage';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Measuring what the portfolio actually costs a person.
 *
 * The exception load is counted from the live queue and from the cycle history,
 * never modelled. The durations come from the MSP. The arithmetic is in
 * `packages/value/capacity.ts`, which refuses to produce a figure when either
 * half is missing.
 */

export async function loadResponseEfforts(
  app: AppContext,
  mspId: string,
): Promise<readonly ResponseEffort[]> {
  const rows = await app.db.withPlatform(async (ctx) =>
    ctx.many<{
      response_type: string;
      minutes: string | null;
      source: string;
      basis: string | null;
    }>(`SELECT response_type, minutes, source, basis FROM msp_response_efforts WHERE msp_id = $1`, [
      mspId,
    ]),
  );

  const supplied = new Map<ResponseType, ResponseEffort>(
    rows.map((row) => [
      row.response_type as ResponseType,
      {
        responseType: row.response_type as ResponseType,
        minutes: row.minutes === null ? null : Number(row.minutes),
        source: row.source as ResponseEffort['source'],
        basis: row.basis,
      },
    ]),
  );

  return RESPONSE_TYPES.map((type) => supplied.get(type) ?? unpricedResponse(type));
}

export async function recordResponseEffort(
  app: AppContext,
  mspId: string,
  input: unknown,
  recordedByUserId: string | null,
): Promise<ResponseEffort> {
  const effort = responseEffortSchema.parse(input);

  await app.db.withPlatform(async (ctx) => {
    await ctx.query(
      `INSERT INTO msp_response_efforts
         (msp_id, response_type, minutes, source, basis, recorded_by, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (msp_id, response_type) DO UPDATE
         SET minutes = EXCLUDED.minutes, source = EXCLUDED.source,
             basis = EXCLUDED.basis, recorded_by = EXCLUDED.recorded_by,
             recorded_at = EXCLUDED.recorded_at`,
      [
        mspId,
        effort.responseType,
        effort.minutes,
        effort.source,
        effort.basis,
        recordedByUserId,
        app.clock.nowIso(),
      ],
    );
  });

  return effort;
}

/**
 * Count the exception load over a window.
 *
 * ARRIVALS, NOT THE STANDING QUEUE.
 *
 * This distinction is the whole correctness of the capacity figure, and an
 * earlier version of this function got it wrong in a way that produced 433
 * customers per engineer on a hundred-customer portfolio — a number no MSP
 * would believe, which is how the error was caught.
 *
 * The standing queue is what is open right now. Ninety open items does not mean
 * ninety items arrived this month; it may mean ninety arrived last year and
 * nobody has closed them. Dividing a standing queue by the window length treats
 * a backlog as a trickle and makes the product look effortless.
 *
 * So the load counts exceptions whose condition AROSE inside the window, taken
 * from each exception's own `since` timestamp — which is recorded from the
 * underlying event, never guessed. That is a true arrival rate, and it is what
 * capacity has to be computed from.
 *
 * The standing queue is still reported, separately, because "am I underwater
 * today" is a real and different question from "can one engineer carry this".
 */
async function measureLoad(
  app: AppContext,
  mspId: string,
  windowDays: number,
): Promise<ExceptionLoad> {
  const organisationIds = await app.db.withPlatform(async (ctx) => {
    const rows = await ctx.many<{ id: string }>(
      `SELECT id FROM organisations WHERE msp_id = $1 AND status <> 'CLOSED'`,
      [mspId],
    );
    return rows.map((row) => row.id);
  });

  const queue = await app.db.withPlatform(async (ctx) =>
    buildExceptionQueue(ctx, organisationIds, app.clock.nowIso(), { limit: 5000 }),
  );

  const byResponseType = {
    DECIDE: 0,
    CONFIGURE: 0,
    INVESTIGATE: 0,
    ASK_CUSTOMER: 0,
  } as Record<ResponseType, number>;
  const standingByResponseType = { ...byResponseType };

  const since = new Date(Date.parse(app.clock.nowIso()) - windowDays * 86_400_000).toISOString();
  const windowStart = Date.parse(since);

  for (const exception of queue.exceptions) {
    const response = EXCEPTION_KINDS_BY_KEY[exception.kind].response;
    standingByResponseType[response] += 1;
    // Arrived inside the window. An exception older than the window is a
    // backlog item, and counting it as an arrival would understate the flow
    // and overstate capacity.
    if (Date.parse(exception.since) >= windowStart) byResponseType[response] += 1;
  }

  const autonomous = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ count: string }>(
      // Remediations that ran and were confirmed with no approval: work that
      // would otherwise have been somebody's, and was not.
      `SELECT count(*)::text AS count FROM actions
        WHERE organisation_id = ANY($1::uuid[])
          AND proposed_at > $2 AND state = 'CONFIRMED' AND approval_id IS NULL`,
      [organisationIds, since],
    ),
  );

  return {
    windowDays,
    organisations: organisationIds.length,
    byResponseType,
    handledAutonomously: Number(autonomous?.count ?? '0'),
    standingQueue: standingByResponseType,
    standingQueueTotal: queue.exceptions.length,
  };
}

export interface CapacityReport {
  readonly load: ExceptionLoad;
  readonly efforts: readonly ResponseEffort[];
  readonly engineerHoursPerMonth: number | null;
  readonly engineerHoursBasis: string | null;
  readonly capacity: CapacityResult;
}

export async function measureCapacity(
  app: AppContext,
  mspId: string,
  windowDays: number,
): Promise<CapacityReport> {
  const msp = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ engineer_hours_per_month: string | null; engineer_hours_basis: string | null }>(
      `SELECT engineer_hours_per_month, engineer_hours_basis FROM msps WHERE id = $1`,
      [mspId],
    ),
  );
  if (!msp) throw new AdericelError('NOT_FOUND', 'No such MSP');

  const [load, efforts] = await Promise.all([
    measureLoad(app, mspId, windowDays),
    loadResponseEfforts(app, mspId),
  ]);

  const engineerHours =
    msp.engineer_hours_per_month === null ? null : Number(msp.engineer_hours_per_month);

  return {
    load,
    efforts,
    engineerHoursPerMonth: engineerHours,
    engineerHoursBasis: msp.engineer_hours_basis,
    capacity: computeCapacity(load, efforts, engineerHours),
  };
}
