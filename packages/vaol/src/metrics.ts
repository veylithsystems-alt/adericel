import type { PlatformContext } from '@adericel/graph';
import type { Clock } from '@adericel/shared';

/**
 * Autonomy metrics.
 *
 * Derived from the event ledger and the exception queue, never estimated. A
 * company optimising for autonomy that cannot measure it will optimise for the
 * appearance of it, and the appearance is easy: stop recording the times a
 * person had to intervene.
 *
 * So every number here has a denominator, and the denominator is a count of
 * rows somebody can go and look at.
 */

export interface AutonomyMetrics {
  readonly windowHours: number;
  readonly from: string;
  readonly to: string;

  /** Operations attempted through the gate, permitted or not. */
  readonly operations: number;
  /** Operations that ran unattended. */
  readonly autonomous: number;
  /**
   * Autonomous operations as a proportion of those attempted.
   *
   * Null rather than zero when nothing was attempted. A ratio over no
   * operations is not 0% autonomy; it is no information, and reporting it as a
   * number would make a quiet week look like a regression.
   */
  readonly automationRatio: number | null;

  /** Operations where a person made or confirmed the decision. */
  readonly humanInterventions: number;
  readonly humanInterventionRate: number | null;

  readonly exceptionsRaised: number;
  /** Exceptions per operation attempted. */
  readonly exceptionRate: number | null;
  readonly exceptionsResolvedAutomatically: number;
  readonly autonomousResolutionRate: number | null;
  readonly exceptionsOpen: number;
  readonly exceptionsOverdue: number;

  /** Operations that claimed to need verification and got a confirmed one. */
  readonly verificationRate: number | null;
  /** Operations that ended UNKNOWN_OUTCOME — dispatched, outcome unestablished. */
  readonly unknownOutcomes: number;

  /** Refusals by outcome, so a policy that is too tight is visible. */
  readonly refusals: Readonly<Record<string, number>>;
}

export interface ProcessAutonomy {
  readonly processKey: string;
  readonly domain: string;
  readonly title: string;
  readonly currentMaturity: number;
  readonly targetMaturity: number;
  readonly humanBoundary: string;
  readonly risk: string;
  readonly automationCandidate: boolean;
  readonly operations: number;
  readonly autonomous: number;
  readonly exceptions: number;
  /**
   * The maturity the evidence supports, which may be below the recorded one.
   *
   * A process recorded at L3 whose every execution raises an exception is not
   * operating at L3, and reporting the recorded figure would let the company
   * believe its own plan instead of its own logs.
   */
  readonly observedMaturity: number | null;
}

/**
 * What the evidence says a process's maturity actually is.
 *
 * Deliberately conservative, and never above the recorded level: this function
 * can lower a claim, never raise one. Being generous here would defeat the
 * purpose of measuring.
 */
export function observedMaturity(
  recorded: number,
  operations: number,
  autonomous: number,
  exceptions: number,
): number | null {
  // Too little happened to say anything. Null, not zero.
  if (operations < 5) return null;

  const autonomousShare = autonomous / operations;
  const exceptionShare = exceptions / operations;

  // Nothing ran without a person: manual, whatever the plan says.
  if (autonomousShare === 0) return 0;
  // Mostly prepared rather than performed.
  if (autonomousShare < 0.5) return Math.min(recorded, 1);
  // Running unattended but frequently stopping.
  if (exceptionShare > 0.25) return Math.min(recorded, 2);
  // Running unattended and mostly completing.
  if (exceptionShare > 0.05) return Math.min(recorded, 3);
  // L4 and L5 require self-recovery and self-improvement, which this function
  // cannot see from counts alone. It will not award them.
  return Math.min(recorded, 4);
}

export interface MetricsService {
  autonomy(windowHours?: number): Promise<AutonomyMetrics>;
  byProcess(windowHours?: number): Promise<readonly ProcessAutonomy[]>;
}

export function createMetricsService(ctx: PlatformContext, clock: Clock): MetricsService {
  return {
    async autonomy(windowHours = 24 * 30): Promise<AutonomyMetrics> {
      const to = clock.nowIso();
      const from = new Date(Date.parse(to) - windowHours * 3_600_000).toISOString();
      const ratio = (numerator: number, denominator: number): number | null =>
        denominator === 0 ? null : numerator / denominator;

      const decisions = await ctx.oneOrFail<{
        operations: string;
        permitted: string;
        require_approval: string;
        escalate: string;
        deny: string;
        unknown: string;
      }>(
        `SELECT count(*)::text AS operations,
                count(*) FILTER (WHERE outcome = 'PERMIT')::text AS permitted,
                count(*) FILTER (WHERE outcome = 'REQUIRE_APPROVAL')::text AS require_approval,
                count(*) FILTER (WHERE outcome = 'ESCALATE')::text AS escalate,
                count(*) FILTER (WHERE outcome = 'DENY')::text AS deny,
                count(*) FILTER (WHERE outcome = 'UNKNOWN')::text AS unknown
         FROM veylith.policy_decisions WHERE decided_at > $1 AND decided_at <= $2`,
        [from, to],
        'Policy decision counts',
      );

      const eventCounts = await ctx.oneOrFail<{
        human: string;
        unknown_outcomes: string;
        verifiable: string;
        confirmed: string;
      }>(
        `SELECT count(*) FILTER (WHERE human_in_loop)::text AS human,
                count(*) FILTER (WHERE result = 'UNKNOWN_OUTCOME')::text AS unknown_outcomes,
                count(*) FILTER (WHERE verification <> 'NOT_REQUIRED')::text AS verifiable,
                count(*) FILTER (WHERE verification = 'CONFIRMED')::text AS confirmed
         FROM veylith.business_events WHERE occurred_at > $1 AND occurred_at <= $2`,
        [from, to],
        'Business event counts',
      );

      const exceptionCounts = await ctx.oneOrFail<{
        raised: string;
        auto_resolved: string;
        resolved: string;
        open: string;
        overdue: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE created_at > $1 AND created_at <= $2)::text AS raised,
           count(*) FILTER (WHERE status = 'RESOLVED_AUTOMATICALLY'
                              AND resolved_at > $1 AND resolved_at <= $2)::text AS auto_resolved,
           count(*) FILTER (WHERE resolved_at > $1 AND resolved_at <= $2)::text AS resolved,
           count(*) FILTER (WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ESCALATED'))::text AS open,
           count(*) FILTER (WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS')
                              AND due_at < $2::timestamptz)::text AS overdue
         FROM veylith.operational_exceptions`,
        [from, to],
        'Exception counts',
      );

      const operations = Number(decisions.operations);
      const autonomous = Number(decisions.permitted);
      const humanInterventions = Number(eventCounts.human);
      const exceptionsRaised = Number(exceptionCounts.raised);
      const resolved = Number(exceptionCounts.resolved);
      const autoResolved = Number(exceptionCounts.auto_resolved);
      const verifiable = Number(eventCounts.verifiable);

      return {
        windowHours,
        from,
        to,
        operations,
        autonomous,
        automationRatio: ratio(autonomous, operations),
        humanInterventions,
        humanInterventionRate: ratio(humanInterventions, operations),
        exceptionsRaised,
        exceptionRate: ratio(exceptionsRaised, operations),
        exceptionsResolvedAutomatically: autoResolved,
        autonomousResolutionRate: ratio(autoResolved, resolved),
        exceptionsOpen: Number(exceptionCounts.open),
        exceptionsOverdue: Number(exceptionCounts.overdue),
        verificationRate: ratio(Number(eventCounts.confirmed), verifiable),
        unknownOutcomes: Number(eventCounts.unknown_outcomes),
        refusals: {
          REQUIRE_APPROVAL: Number(decisions.require_approval),
          ESCALATE: Number(decisions.escalate),
          DENY: Number(decisions.deny),
          UNKNOWN: Number(decisions.unknown),
        },
      };
    },

    async byProcess(windowHours = 24 * 30): Promise<readonly ProcessAutonomy[]> {
      const to = clock.nowIso();
      const from = new Date(Date.parse(to) - windowHours * 3_600_000).toISOString();

      const rows = await ctx.many<{
        key: string;
        domain: string;
        title: string;
        current_maturity: number;
        target_maturity: number;
        human_boundary: string;
        risk: string;
        automation_candidate: boolean;
        operations: string;
        autonomous: string;
        exceptions: string;
      }>(
        `SELECT p.key, p.domain, p.title, p.current_maturity, p.target_maturity,
                p.human_boundary, p.risk, p.automation_candidate,
                COALESCE(d.operations, 0)::text AS operations,
                COALESCE(d.autonomous, 0)::text AS autonomous,
                COALESCE(e.exceptions, 0)::text AS exceptions
         FROM veylith.company_processes p
         LEFT JOIN (
           SELECT process_key,
                  count(*) AS operations,
                  count(*) FILTER (WHERE outcome = 'PERMIT') AS autonomous
           FROM veylith.policy_decisions WHERE decided_at > $1 AND decided_at <= $2
           GROUP BY process_key
         ) d ON d.process_key = p.key
         LEFT JOIN (
           SELECT process_key, count(*) AS exceptions
           FROM veylith.operational_exceptions WHERE created_at > $1 AND created_at <= $2
           GROUP BY process_key
         ) e ON e.process_key = p.key
         ORDER BY p.domain, p.key`,
        [from, to],
      );

      return rows.map((row) => {
        const operations = Number(row.operations);
        const autonomous = Number(row.autonomous);
        const exceptions = Number(row.exceptions);
        return {
          processKey: row.key,
          domain: row.domain,
          title: row.title,
          currentMaturity: row.current_maturity,
          targetMaturity: row.target_maturity,
          humanBoundary: row.human_boundary,
          risk: row.risk,
          automationCandidate: row.automation_candidate,
          operations,
          autonomous,
          exceptions,
          observedMaturity: observedMaturity(
            row.current_maturity,
            operations,
            autonomous,
            exceptions,
          ),
        };
      });
    },
  };
}
