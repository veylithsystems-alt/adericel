import type { TenantContext } from '@adericel/graph';

/**
 * The onboarding ledger.
 *
 * Onboarding fails commercially in one specific way: the customer signs in,
 * sees a page of UNKNOWN, does not know which of the twelve things they could
 * do would change that, and leaves. The engine's honesty about not knowing is
 * correct and is also, unaided, the most discouraging first impression a
 * product can give.
 *
 * So the path to the first evidence-backed answer is recorded as state the
 * customer can see, ordered, with each step saying what it unlocks. Tasks are
 * completed by the system observing that the thing happened — a source
 * connected, evidence collected, a second approver present — never by the
 * customer ticking a box. A checklist that can be ticked without the underlying
 * fact being true is a worse lie than no checklist.
 */

export interface OnboardingTask {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly state: 'PENDING' | 'BLOCKED' | 'COMPLETED' | 'SKIPPED';
  readonly required: boolean;
  readonly position: number;
  readonly completedAt: string | null;
  readonly detail: string | null;
}

interface TaskSeed {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  /** Only seeded for this account shape; undefined means both. */
  readonly onlyFor?: 'MSP' | 'DIRECT';
}

/**
 * The steps, in the order they unblock each other.
 *
 * Each description says what the step buys, not what it is. "Connect a source"
 * means nothing; "until a source is connected Adericel has nothing to reason
 * about, so every control will read UNKNOWN" means something.
 */
const TASKS: readonly TaskSeed[] = [
  {
    key: 'account.mfa',
    title: 'Set up your second factor',
    description:
      'Approving a change is where a person takes responsibility for altering a production ' +
      'estate. Adericel will not accept an approval from a session that presented only a ' +
      'password, so until a factor is enrolled no remediation can be authorised.',
    required: true,
  },
  {
    key: 'source.connected',
    title: 'Connect your first source',
    description:
      'A directory, an endpoint manager, or a cloud account. Until one is connected Adericel ' +
      'has nothing to reason about, and every control will correctly read UNKNOWN.',
    required: true,
  },
  {
    key: 'evidence.collected',
    title: 'Collect evidence for the first time',
    description:
      'Adericel reads the connected source and records what it finds, with a content hash and ' +
      'a timestamp, so every later statement can be traced back to something observed.',
    required: true,
  },
  {
    key: 'assessment.first',
    title: 'Get your first determination',
    description:
      'Controls move from UNKNOWN to satisfied or not satisfied, each one carrying the claims ' +
      'and evidence it rested on. This is the first moment Adericel is telling you something ' +
      'about your estate rather than about itself.',
    required: true,
  },
  {
    key: 'approver.second',
    title: 'Invite a second approver',
    description:
      'A change can never be approved by the person who proposed it. With one person in the ' +
      'account, no remediation can ever be authorised — Adericel will assess and propose, and ' +
      'stop there. A second person with a second factor is what makes the rest of the product ' +
      'work.',
    required: true,
  },
  {
    key: 'framework.adopted',
    title: 'Adopt a framework',
    description:
      'Cyber Essentials, ISO 27001, or your own baseline. Adericel assesses controls either ' +
      'way; adopting a framework is what maps those controls onto requirements you can show ' +
      'an auditor or a client.',
    required: false,
  },
  {
    key: 'remediation.verified',
    title: 'See a change through to verification',
    description:
      'Propose a fix, approve it, let Adericel apply it, and watch it re-observe the estate to ' +
      'confirm the fix actually took. An executed action is not a remediated finding, and this ' +
      'is where that difference becomes visible.',
    required: false,
  },
  {
    key: 'customer.first',
    title: 'Onboard your first customer organisation',
    description:
      'Your own account is the operator boundary. Each organisation you look after gets its ' +
      'own tenant, its own evidence and its own assurance state, and nothing crosses between ' +
      'them.',
    required: true,
    onlyFor: 'MSP',
  },
];

export async function seedOnboardingTasks(
  ctx: TenantContext,
  options: {
    readonly organisationId: string;
    readonly accountKind: 'MSP' | 'DIRECT';
    readonly nowIso: string;
  },
): Promise<number> {
  const applicable = TASKS.filter(
    (task) => task.onlyFor === undefined || task.onlyFor === options.accountKind,
  );
  let position = 0;
  for (const task of applicable) {
    position += 1;
    await ctx.query(
      `INSERT INTO onboarding_tasks
         (organisation_id, key, title, description, state, required, position)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
       ON CONFLICT (organisation_id, key) DO NOTHING`,
      [options.organisationId, task.key, task.title, task.description, task.required, position],
    );
  }
  return applicable.length;
}

/**
 * Recompute the ledger from what is actually true.
 *
 * Every task is decided by a query against real state rather than by a flag set
 * when an endpoint was called. That makes the ledger self-correcting: an
 * integration that is later disconnected reopens its task, and a task can never
 * be complete because a request succeeded once.
 */
export async function refreshOnboardingTasks(
  ctx: TenantContext,
  organisationId: string,
  nowIso: string,
): Promise<readonly OnboardingTask[]> {
  const facts = await ctx.oneOrFail<{
    connected_sources: string;
    evidence_items: string;
    determinations: string;
    frameworks: string;
    verified_actions: string;
  }>(
    `SELECT
       (SELECT count(*) FROM integrations
         WHERE organisation_id = $1 AND status = 'CONNECTED')::text AS connected_sources,
       (SELECT count(*) FROM evidence WHERE organisation_id = $1)::text AS evidence_items,
       (SELECT count(*) FROM assessments
         WHERE organisation_id = $1 AND subject_kind = 'CONTROL'
           AND state <> 'UNKNOWN')::text AS determinations,
       (SELECT count(*) FROM organisation_frameworks
         WHERE organisation_id = $1)::text AS frameworks,
       (SELECT count(*) FROM actions
         WHERE organisation_id = $1 AND state = 'CONFIRMED')::text AS verified_actions`,
    [organisationId],
    'Onboarding facts',
  );

  // Identity facts live outside the tenant boundary — users and grants are read
  // to establish who a caller is, before any tenant context exists — so they
  // are counted under platform scope by the caller and passed in. Here we only
  // read what the tenant itself owns.
  const completions: Record<string, boolean> = {
    'source.connected': Number(facts.connected_sources) > 0,
    'evidence.collected': Number(facts.evidence_items) > 0,
    'assessment.first': Number(facts.determinations) > 0,
    'framework.adopted': Number(facts.frameworks) > 0,
    'remediation.verified': Number(facts.verified_actions) > 0,
  };

  for (const [key, done] of Object.entries(completions)) {
    await ctx.query(
      `UPDATE onboarding_tasks
       SET state = CASE WHEN $3 THEN 'COMPLETED' ELSE 'PENDING' END,
           completed_at = CASE WHEN $3 THEN COALESCE(completed_at, $4::timestamptz) ELSE NULL END
       WHERE organisation_id = $1 AND key = $2 AND state <> 'SKIPPED'`,
      [organisationId, key, done, nowIso],
    );
  }

  // A step whose prerequisite is not met is BLOCKED rather than PENDING, so the
  // customer is never asked to do something they cannot yet do.
  await ctx.query(
    `UPDATE onboarding_tasks SET state = 'BLOCKED'
     WHERE organisation_id = $1 AND state = 'PENDING'
       AND key IN ('evidence.collected', 'assessment.first')
       AND NOT $2`,
    [organisationId, completions['source.connected']],
  );
  await ctx.query(
    `UPDATE onboarding_tasks SET state = 'BLOCKED'
     WHERE organisation_id = $1 AND state = 'PENDING'
       AND key = 'remediation.verified' AND NOT $2`,
    [organisationId, completions['assessment.first']],
  );

  return listOnboardingTasks(ctx, organisationId);
}

export async function listOnboardingTasks(
  ctx: TenantContext,
  organisationId: string,
): Promise<readonly OnboardingTask[]> {
  const rows = await ctx.many<{
    key: string;
    title: string;
    description: string;
    state: OnboardingTask['state'];
    required: boolean;
    position: number;
    completed_at: Date | null;
    detail: string | null;
  }>(
    `SELECT key, title, description, state, required, position, completed_at, detail
     FROM onboarding_tasks WHERE organisation_id = $1 ORDER BY position`,
    [organisationId],
  );
  return rows.map((row) => ({
    key: row.key,
    title: row.title,
    description: row.description,
    state: row.state,
    required: row.required,
    position: row.position,
    completedAt: row.completed_at?.toISOString() ?? null,
    detail: row.detail,
  }));
}

/** Mark a task complete from a fact the tenant context cannot see itself. */
export async function completeOnboardingTask(
  ctx: TenantContext,
  organisationId: string,
  key: string,
  nowIso: string,
  detail?: string,
): Promise<void> {
  await ctx.query(
    `UPDATE onboarding_tasks
     SET state = 'COMPLETED', completed_at = COALESCE(completed_at, $3::timestamptz),
         detail = COALESCE($4, detail)
     WHERE organisation_id = $1 AND key = $2`,
    [organisationId, key, nowIso, detail ?? null],
  );
}
