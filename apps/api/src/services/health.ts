import { outboxStats } from '@adericel/graph';
import type { AppContext } from '../context.js';

/**
 * System health.
 *
 * Adericel must be able to tell an operator which of two very different things
 * is true: the customer has an assurance problem, or Adericel has an
 * operational problem. A failed integration produces UNKNOWN assurance states
 * that look identical to a customer with no controls in place — so integration
 * health is reported as an Adericel component, not as customer posture.
 */

export type ComponentStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface ComponentHealth {
  readonly component: string;
  readonly status: ComponentStatus;
  readonly detail: string;
  readonly latencyMs: number | null;
}

export interface SystemHealth {
  readonly status: ComponentStatus;
  readonly checkedAt: string;
  readonly release: string;
  readonly components: readonly ComponentHealth[];
  readonly platformProblems: readonly string[];
}

export async function collectHealth(
  app: AppContext,
  options: { deep: boolean },
): Promise<SystemHealth> {
  const components: ComponentHealth[] = [];
  const platformProblems: string[] = [];

  components.push(
    await check('database', async () => {
      const latency = await app.db.ping();
      return {
        status: latency < 500 ? 'HEALTHY' : 'DEGRADED',
        detail: `Round trip ${latency}ms`,
        latencyMs: latency,
      };
    }),
  );

  components.push(
    await check('object-storage', async () => {
      const latency = await app.storage.ping();
      return {
        status: 'HEALTHY',
        detail: `${app.storage.driver} store reachable in ${latency}ms`,
        latencyMs: latency,
      };
    }),
  );

  components.push({
    component: 'truth-engine',
    // The engine is a pure library with no I/O, so it is healthy whenever the
    // process is running and its rulesets compiled at startup.
    status: app.rulesets.list().length > 0 ? 'HEALTHY' : 'UNHEALTHY',
    detail: `${app.rulesets.list().length} ruleset(s) loaded`,
    latencyMs: null,
  });

  if (!options.deep) {
    return finalise(components, platformProblems, app);
  }

  components.push(
    await check('event-outbox', async () => {
      const stats = await app.db.withPlatform(async (ctx) => outboxStats(ctx));
      if (stats.deadLetter > 0) {
        platformProblems.push(
          `${stats.deadLetter} event(s) in the dead-letter queue. Assurance state elsewhere may be stale.`,
        );
        return {
          status: 'DEGRADED',
          detail: `${stats.pending} pending, ${stats.inFlight} in flight, ${stats.deadLetter} dead-lettered`,
          latencyMs: null,
        };
      }
      const lagging = (stats.oldestPendingAgeSeconds ?? 0) > 300;
      if (lagging) platformProblems.push('Event delivery is lagging by more than five minutes.');
      return {
        status: lagging ? 'DEGRADED' : 'HEALTHY',
        detail: `${stats.pending} pending, oldest ${Math.round(stats.oldestPendingAgeSeconds ?? 0)}s`,
        latencyMs: null,
      };
    }),
  );

  components.push(
    await check('integrations', async () => {
      const row = await app.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ failed: string; degraded: string; total: string }>(
          `SELECT count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
                count(*) FILTER (WHERE status = 'DEGRADED')::text AS degraded,
                count(*)::text AS total
         FROM integrations WHERE status <> 'DISABLED'`,
          [],
          'Integration health',
        ),
      );
      const failed = Number(row.failed);
      const degraded = Number(row.degraded);
      if (failed > 0) {
        platformProblems.push(
          `${failed} integration(s) are failing. Controls that depend on them will report UNKNOWN — ` +
            'this is an Adericel collection problem, not a customer posture change.',
        );
      }
      return {
        status: failed > 0 ? 'DEGRADED' : degraded > 0 ? 'DEGRADED' : 'HEALTHY',
        detail: `${row.total} active, ${failed} failed, ${degraded} degraded`,
        latencyMs: null,
      };
    }),
  );

  components.push(
    await check('scheduled-jobs', async () => {
      const row = await app.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ overdue: string; failed: string }>(
          `SELECT count(*) FILTER (WHERE enabled AND next_run_at < now() - interval '15 minutes')::text AS overdue,
                count(*) FILTER (WHERE last_status = 'FAILED')::text AS failed
         FROM scheduled_jobs`,
          [],
          'Job health',
        ),
      );
      const overdue = Number(row.overdue);
      if (overdue > 0) {
        platformProblems.push(
          `${overdue} scheduled job(s) are overdue. The worker may not be running.`,
        );
      }
      return {
        status: overdue > 0 ? 'DEGRADED' : 'HEALTHY',
        detail: `${overdue} overdue, ${row.failed} failed on last run`,
        latencyMs: null,
      };
    }),
  );

  components.push(
    await check('action-execution', async () => {
      const row = await app.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ unknown_outcome: string; unverified: string }>(
          `SELECT (SELECT count(*)::text FROM action_executions WHERE status = 'UNKNOWN_OUTCOME') AS unknown_outcome,
                (SELECT count(*)::text FROM actions WHERE state = 'UNVERIFIED') AS unverified`,
          [],
          'Action health',
        ),
      );
      const unknown = Number(row.unknown_outcome);
      if (unknown > 0) {
        platformProblems.push(
          `${unknown} execution(s) have an unknown outcome and need reconciliation before they can be retried.`,
        );
      }
      return {
        status: unknown > 0 ? 'DEGRADED' : 'HEALTHY',
        detail: `${unknown} unknown outcome(s), ${row.unverified} unverified action(s)`,
        latencyMs: null,
      };
    }),
  );

  return finalise(components, platformProblems, app);
}

async function check(
  component: string,
  probe: () => Promise<{ status: ComponentStatus; detail: string; latencyMs: number | null }>,
): Promise<ComponentHealth> {
  try {
    const result = await probe();
    return { component, ...result };
  } catch (error) {
    return {
      component,
      status: 'UNHEALTHY',
      detail: (error as Error).message.slice(0, 500),
      latencyMs: null,
    };
  }
}

function finalise(
  components: ComponentHealth[],
  platformProblems: string[],
  app: AppContext,
): SystemHealth {
  const worst: ComponentStatus = components.some((c) => c.status === 'UNHEALTHY')
    ? 'UNHEALTHY'
    : components.some((c) => c.status === 'DEGRADED')
      ? 'DEGRADED'
      : 'HEALTHY';

  return {
    status: worst,
    checkedAt: app.clock.nowIso(),
    release: app.config.releaseVersion,
    components,
    // Stated in operator language, because these are the things that make
    // Adericel's own answers less trustworthy.
    platformProblems,
  };
}
