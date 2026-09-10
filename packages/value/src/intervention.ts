import type { PlatformContext } from '@adericel/graph';
import type { LedgerWindow } from './ledger.js';

/**
 * Every time a person had to do something.
 *
 * This is the number that keeps the whole proof-of-value case honest. Anyone
 * can count what a system did; the interesting figure is what it still made
 * somebody else do, and it is the one a vendor is least motivated to measure
 * accurately.
 *
 * So it is measured the same way as everything else — from the audit trail,
 * which records every human action including the ones nobody thought to
 * feature — and it is deliberately biased against Adericel in two ways:
 *
 *   1. An audited human action that maps to no assurance task is still counted,
 *      as `unclassified`. Dropping it would shrink the residual and inflate the
 *      saving, which is precisely the error to guard against here.
 *
 *   2. Signing in, enrolling a second factor and reading a page are excluded —
 *      not because they are free, but because they are the cost of using any
 *      software and counting them would overstate the residual instead. The
 *      exclusions are listed, so the choice is visible and arguable.
 */

/**
 * Audited actions that are the cost of using software rather than the cost of
 * maintaining assurance. Excluded from the residual, and named so the exclusion
 * can be disagreed with.
 */
const NOT_ASSURANCE_WORK: ReadonlySet<string> = new Set([
  'auth:login',
  'auth:logout',
  'auth:mfa:verify',
  'auth:mfa:enrol:begin',
  'auth:mfa:enrol:confirm',
  'auth:mfa:remove',
  'evidence:download',
  'organisation:export',
]);

/**
 * Which assurance task a human action belongs to.
 *
 * The mapping matters because the residual has to be comparable with the
 * saving: both are expressed in the same tasks, priced with the same durations,
 * so "180 became 35" is one arithmetic rather than two.
 */
const TASK_BY_AUDIT_ACTION: Readonly<Record<string, string>> = {
  'evidence:create': 'evidence.collect',
  'evidence:upload': 'evidence.collect',
  'evidence:revoke': 'evidence.file',
  'evidence:integrity-failure': 'evidence.file',
  'claim:assert': 'control.determine',
  'claim:confirm': 'control.determine',
  'claim:reject': 'control.determine',
  'observation:ingest': 'evidence.collect',
  'assessment:run': 'control.determine',
  'assessment:run-all': 'control.determine',
  'assessment:replay': 'control.explain',
  'control:update': 'control.explain',
  'finding:update': 'finding.triage',
  'risk:create': 'finding.triage',
  'exception:request': 'finding.triage',
  'exception:approve': 'finding.triage',
  'action:propose': 'remediation.perform',
  'action:approved': 'remediation.perform',
  'action:rejected': 'remediation.perform',
  'action:execute': 'remediation.perform',
  'action:cancel': 'remediation.perform',
  'action:verify': 'remediation.verify',
  'passport:issue': 'report.produce',
  'passport:share': 'enquiry.answer',
  'passport:withdraw': 'report.produce',
  'passport:share:revoke': 'enquiry.answer',
  'integration:check': 'evidence.collect',
  'integration:collect': 'evidence.collect',
  'integration:rotate-credentials': 'evidence.collect',
  'integration:source-authority': 'change.impact',
};

export interface InterventionCount {
  readonly auditAction: string;
  /** The assurance task this belongs to, or null if nobody has classified it. */
  readonly taskKey: string | null;
  readonly count: number;
}

export interface HumanInterventions extends LedgerWindow {
  readonly organisationIds: readonly string[];
  /** Every human action that counts as assurance work, itemised. */
  readonly byAction: readonly InterventionCount[];
  readonly total: number;
  /** Actions mapping to a known task. */
  readonly classified: number;
  /**
   * Human actions nobody has mapped to a task. Counted in the total, priced at
   * nothing, and reported — because an unpriced intervention understates the
   * residual, and understating the residual is how a saving gets inflated.
   */
  readonly unclassified: number;
  /** Distinct people who did any of it. */
  readonly peopleInvolved: number;
  /** Excluded as the cost of using software rather than of assurance. */
  readonly excluded: number;
}

export async function measureInterventions(
  ctx: PlatformContext,
  organisationIds: readonly string[],
  window: LedgerWindow,
): Promise<HumanInterventions> {
  const ids = [...organisationIds];
  if (ids.length === 0) {
    return {
      ...window,
      organisationIds: ids,
      byAction: [],
      total: 0,
      classified: 0,
      unclassified: 0,
      peopleInvolved: 0,
      excluded: 0,
    };
  }

  const rows = await ctx.many<{ action: string; count: string }>(
    `SELECT action, count(*)::text AS count
       FROM audit_log
      WHERE organisation_id = ANY($1::uuid[])
        AND actor_type = 'USER'
        AND outcome = 'SUCCESS'
        AND occurred_at > $2 AND occurred_at <= $3
      GROUP BY action
      ORDER BY count(*) DESC`,
    [ids, window.from, window.to],
  );

  const people = await ctx.one<{ people: string }>(
    `SELECT count(DISTINCT actor_id)::text AS people
       FROM audit_log
      WHERE organisation_id = ANY($1::uuid[])
        AND actor_type = 'USER'
        AND occurred_at > $2 AND occurred_at <= $3`,
    [ids, window.from, window.to],
  );

  const byAction: InterventionCount[] = [];
  let total = 0;
  let classified = 0;
  let unclassified = 0;
  let excluded = 0;

  for (const row of rows) {
    const n = Number(row.count);
    if (NOT_ASSURANCE_WORK.has(row.action)) {
      excluded += n;
      continue;
    }
    const taskKey = TASK_BY_AUDIT_ACTION[row.action] ?? null;
    byAction.push({ auditAction: row.action, taskKey, count: n });
    total += n;
    if (taskKey === null) unclassified += n;
    else classified += n;
  }

  return {
    ...window,
    organisationIds: ids,
    byAction,
    total,
    classified,
    unclassified,
    peopleInvolved: Number(people?.people ?? '0'),
    excluded,
  };
}

/** Human interventions grouped by the assurance task they belong to. */
export function interventionsByTask(
  interventions: HumanInterventions,
): ReadonlyMap<string, number> {
  const byTask = new Map<string, number>();
  for (const entry of interventions.byAction) {
    if (entry.taskKey === null) continue;
    byTask.set(entry.taskKey, (byTask.get(entry.taskKey) ?? 0) + entry.count);
  }
  return byTask;
}

/** The audit actions this module knows how to classify. Used by its tests. */
export function classifiableAuditActions(): readonly string[] {
  return Object.keys(TASK_BY_AUDIT_ACTION).sort();
}

/** The audit actions deliberately excluded, so the choice can be inspected. */
export function excludedAuditActions(): readonly string[] {
  return [...NOT_ASSURANCE_WORK].sort();
}
