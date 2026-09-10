import type { PlatformContext } from '@adericel/graph';
import { contentHash, type Clock } from '@adericel/shared';
import { z } from 'zod';

/**
 * The exception queue.
 *
 * The company's intended steady state is that people deal with exceptions
 * rather than workflows. That is only possible if an automation which cannot
 * proceed has somewhere safe to stop — so this exists before any automation
 * that could raise one.
 *
 * An automation with no escalation path has three options when it gets stuck:
 * throw and lose the context, retry forever, or do nothing. All three are
 * silent, and the last two are the dangerous ones.
 *
 * Not to be confused with `adericel.exceptions`, which is a control
 * deliberately waived on a customer estate. Same word, unrelated concept.
 */

export const EXCEPTION_CATEGORIES = [
  /** A person must authorise this. The system prepared it and stopped. */
  'AUTHORITY_REQUIRED',
  /** Policy explicitly refused. Recorded so a wrong policy is visible. */
  'POLICY_DENIED',
  /** Two readings of the situation, or none. The system will not guess. */
  'AMBIGUOUS',
  /** The automation ran and failed. */
  'AUTOMATION_FAILED',
  /** Something outside the company did not respond, or responded wrongly. */
  'EXTERNAL_DEPENDENCY',
  /** A fact the process needs was never established. */
  'DATA_MISSING',
  /** Sources disagree. */
  'CONFLICT',
  'SECURITY',
  'FINANCIAL',
  'LEGAL',
  /** A customer is affected right now. */
  'CUSTOMER_IMPACT',
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

export const EXCEPTION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/**
 * How long a person has before an exception is overdue.
 *
 * Deliberately short at the top. A CRITICAL exception that sits for a day is
 * indistinguishable from one nobody raised, and the whole point of the queue is
 * that it is the thing a person opens first.
 */
export const RESPONSE_HOURS: Record<ExceptionSeverity, number> = {
  CRITICAL: 1,
  HIGH: 4,
  MEDIUM: 24,
  LOW: 72,
};

export const EXCEPTION_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED_AUTOMATICALLY',
  'RESOLVED_BY_HUMAN',
  'ESCALATED',
  'WONT_FIX',
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

const OPEN_STATUSES: readonly ExceptionStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'ESCALATED',
];

export function isOpen(status: ExceptionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export const raiseExceptionSchema = z.object({
  processKey: z.string().min(1).max(200),
  category: z.enum(EXCEPTION_CATEGORIES),
  severity: z.enum(EXCEPTION_SEVERITIES).default('MEDIUM'),
  title: z.string().min(1).max(300),
  /** What the automation tried. Required: an exception that omits this forces a
   *  person to re-derive what already happened. */
  attempted: z.string().min(1).max(4000),
  failureReason: z.string().min(1).max(4000),
  /** A recommendation, never an instruction. The person decides. */
  recommendedAction: z.string().max(4000).default(''),
  requiredAuthority: z.string().max(200).default(''),
  evidence: z.record(z.string(), z.unknown()).default({}),
  organisationId: z.string().uuid().nullable().default(null),
  subjectKind: z.string().max(120).nullable().default(null),
  subjectId: z.string().max(200).nullable().default(null),
  correlationId: z.string().uuid().nullable().default(null),
  escalationPath: z.string().max(500).default(''),
  /**
   * Overrides the derived identity of the condition.
   *
   * Rarely needed. The default is derived from process, category, subject and
   * title, which is right when the same fault recurs and wrong only when a
   * caller wants finer or coarser grouping.
   */
  dedupeKey: z.string().max(200).optional(),
});
export type RaiseExceptionInput = z.input<typeof raiseExceptionSchema>;

export interface OperationalException {
  readonly id: string;
  readonly processKey: string;
  readonly category: ExceptionCategory;
  readonly severity: ExceptionSeverity;
  readonly title: string;
  readonly attempted: string;
  readonly failureReason: string;
  readonly recommendedAction: string;
  readonly requiredAuthority: string;
  readonly evidence: Record<string, unknown>;
  readonly organisationId: string | null;
  readonly subjectKind: string | null;
  readonly subjectId: string | null;
  readonly correlationId: string | null;
  readonly status: ExceptionStatus;
  readonly owner: string | null;
  readonly dueAt: string;
  readonly escalationPath: string;
  readonly escalatedAt: string | null;
  readonly resolution: string | null;
  readonly verification: 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'REFUTED' | 'INCONCLUSIVE';
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly occurrences: number;
  readonly dedupeKey: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly createdAt: string;
}

interface ExceptionRow {
  id: string;
  process_key: string;
  category: string;
  severity: string;
  title: string;
  attempted: string;
  failure_reason: string;
  recommended_action: string;
  required_authority: string;
  evidence: Record<string, unknown>;
  organisation_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  correlation_id: string | null;
  status: string;
  owner: string | null;
  due_at: Date;
  escalation_path: string;
  escalated_at: Date | null;
  resolution: string | null;
  verification: string;
  resolved_at: Date | null;
  resolved_by: string | null;
  occurrences: number;
  dedupe_key: string;
  first_seen_at: Date;
  last_seen_at: Date;
  created_at: Date;
}

const SELECT = `
  id, process_key, category, severity, title, attempted, failure_reason, recommended_action,
  required_authority, evidence, organisation_id, subject_kind, subject_id, correlation_id,
  status, owner, due_at, escalation_path, escalated_at, resolution, verification,
  resolved_at, resolved_by, occurrences, dedupe_key, first_seen_at, last_seen_at, created_at`;

function toRecord(row: ExceptionRow): OperationalException {
  return {
    id: row.id,
    processKey: row.process_key,
    category: row.category as ExceptionCategory,
    severity: row.severity as ExceptionSeverity,
    title: row.title,
    attempted: row.attempted,
    failureReason: row.failure_reason,
    recommendedAction: row.recommended_action,
    requiredAuthority: row.required_authority,
    evidence: row.evidence,
    organisationId: row.organisation_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    correlationId: row.correlation_id,
    status: row.status as ExceptionStatus,
    owner: row.owner,
    dueAt: row.due_at.toISOString(),
    escalationPath: row.escalation_path,
    escalatedAt: row.escalated_at?.toISOString() ?? null,
    resolution: row.resolution,
    verification: row.verification as OperationalException['verification'],
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedBy: row.resolved_by,
    occurrences: row.occurrences,
    dedupeKey: row.dedupe_key,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The stable identity of a condition.
 *
 * The same fault arising ten times is one exception seen ten times, not ten
 * exceptions. Getting this wrong in either direction is bad: too coarse and
 * distinct problems merge; too fine and a flapping integration buries the queue
 * it is supposed to be surfaced in.
 *
 * Deliberately excludes the failure detail, which often carries a timestamp or
 * a request id and would make every occurrence unique.
 */
export function deriveDedupeKey(input: {
  processKey: string;
  category: string;
  title: string;
  organisationId?: string | null;
  subjectKind?: string | null;
  subjectId?: string | null;
}): string {
  return contentHash({
    processKey: input.processKey,
    category: input.category,
    title: input.title,
    organisationId: input.organisationId ?? null,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
  });
}

export interface ExceptionQueue {
  /** Raise, or record another occurrence of an identical open condition. */
  raise(input: RaiseExceptionInput, actor: string): Promise<OperationalException>;
  get(id: string): Promise<OperationalException | null>;
  open(options?: { limit?: number }): Promise<readonly OperationalException[]>;
  overdue(): Promise<readonly OperationalException[]>;
  acknowledge(id: string, owner: string): Promise<OperationalException>;
  /** Resolve. `automatic` records that no person was involved. */
  resolve(
    id: string,
    resolution: string,
    actor: string,
    options?: { automatic?: boolean; verification?: OperationalException['verification'] },
  ): Promise<OperationalException>;
  escalate(id: string, reason: string, actor: string): Promise<OperationalException>;
  transitions(id: string): Promise<readonly { toStatus: string; actor: string; note: string; occurredAt: string }[]>;
}

export function createExceptionQueue(ctx: PlatformContext, clock: Clock): ExceptionQueue {
  async function recordTransition(
    exceptionId: string,
    from: string | null,
    to: string,
    actorKind: 'SYSTEM' | 'HUMAN' | 'AI' | 'EXTERNAL',
    actor: string,
    note: string,
  ): Promise<void> {
    await ctx.query(
      `INSERT INTO veylith.exception_transitions
         (exception_id, from_status, to_status, actor_kind, actor, note, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [exceptionId, from, to, actorKind, actor, note.slice(0, 2000), clock.nowIso()],
    );
  }

  async function require(id: string): Promise<ExceptionRow> {
    return ctx.oneOrFail<ExceptionRow>(
      `SELECT ${SELECT} FROM veylith.operational_exceptions WHERE id = $1`,
      [id],
      'Operational exception',
    );
  }

  const queue: ExceptionQueue = {
    async raise(rawInput, actor): Promise<OperationalException> {
      const input = raiseExceptionSchema.parse(rawInput);
      const now = clock.nowIso();
      const dedupeKey = input.dedupeKey ?? deriveDedupeKey(input);
      const dueAt = new Date(
        Date.parse(now) + RESPONSE_HOURS[input.severity] * 3_600_000,
      ).toISOString();

      // A recurrence bumps the count and refreshes the detail rather than
      // creating a second row. The count is itself the signal: a condition
      // arising forty times is a process that needs automating, not forty
      // things for a person to read.
      //
      // Severity only ever rises on recurrence. A condition that was CRITICAL
      // once must not be quietly downgraded by a later, milder report of the
      // same fault.
      const row = await ctx.oneOrFail<ExceptionRow>(
        `INSERT INTO veylith.operational_exceptions
           (process_key, category, severity, title, attempted, failure_reason,
            recommended_action, required_authority, evidence, organisation_id,
            subject_kind, subject_id, correlation_id, escalation_path, due_at,
            dedupe_key, first_seen_at, last_seen_at, created_at)
         -- created_at is passed rather than defaulted. Left to the database it
         -- would come from the server's wall clock while every other timestamp
         -- in the ledger comes from the injected one, and a record whose
         -- timestamps come from two sources cannot be ordered or windowed
         -- reliably. It also made exceptions invisible to the metrics.
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$17,$17)
         ON CONFLICT (dedupe_key)
           WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ESCALATED')
         DO UPDATE SET
           occurrences    = veylith.operational_exceptions.occurrences + 1,
           last_seen_at   = EXCLUDED.last_seen_at,
           failure_reason = EXCLUDED.failure_reason,
           evidence       = EXCLUDED.evidence,
           severity       = CASE
             WHEN array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'], EXCLUDED.severity)
                > array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'],
                                 veylith.operational_exceptions.severity)
             THEN EXCLUDED.severity
             ELSE veylith.operational_exceptions.severity
           END,
           due_at = LEAST(veylith.operational_exceptions.due_at, EXCLUDED.due_at)
         RETURNING ${SELECT}`,
        [
          input.processKey,
          input.category,
          input.severity,
          input.title,
          input.attempted,
          input.failureReason,
          input.recommendedAction,
          input.requiredAuthority,
          JSON.stringify(input.evidence),
          input.organisationId,
          input.subjectKind,
          input.subjectId,
          input.correlationId,
          input.escalationPath,
          dueAt,
          dedupeKey,
          now,
        ],
        'Operational exception',
      );

      if (row.occurrences === 1) {
        await recordTransition(row.id, null, 'OPEN', 'SYSTEM', actor, input.failureReason);
      }
      return toRecord(row);
    },

    async get(id): Promise<OperationalException | null> {
      const row = await ctx.one<ExceptionRow>(
        `SELECT ${SELECT} FROM veylith.operational_exceptions WHERE id = $1`,
        [id],
      );
      return row ? toRecord(row) : null;
    },

    async open(options = {}): Promise<readonly OperationalException[]> {
      // Ordered as a person would work it: most severe first, then most overdue.
      const rows = await ctx.many<ExceptionRow>(
        `SELECT ${SELECT} FROM veylith.operational_exceptions
         WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','ESCALATED')
         ORDER BY array_position(ARRAY['CRITICAL','HIGH','MEDIUM','LOW'], severity), due_at
         LIMIT $1`,
        [options.limit ?? 200],
      );
      return rows.map(toRecord);
    },

    async overdue(): Promise<readonly OperationalException[]> {
      const rows = await ctx.many<ExceptionRow>(
        `SELECT ${SELECT} FROM veylith.operational_exceptions
         WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS')
           AND due_at < $1::timestamptz
         ORDER BY due_at`,
        [clock.nowIso()],
      );
      return rows.map(toRecord);
    },

    async acknowledge(id, owner): Promise<OperationalException> {
      const before = await require(id);
      if (!isOpen(before.status as ExceptionStatus)) {
        return toRecord(before);
      }
      const row = await ctx.oneOrFail<ExceptionRow>(
        `UPDATE veylith.operational_exceptions
         SET status = 'ACKNOWLEDGED', owner = $2
         WHERE id = $1 RETURNING ${SELECT}`,
        [id, owner],
        'Operational exception',
      );
      await recordTransition(id, before.status, 'ACKNOWLEDGED', 'HUMAN', owner, '');
      return toRecord(row);
    },

    async resolve(id, resolution, actor, options = {}): Promise<OperationalException> {
      const before = await require(id);
      const automatic = options.automatic === true;
      const status = automatic ? 'RESOLVED_AUTOMATICALLY' : 'RESOLVED_BY_HUMAN';
      // NOT_REQUIRED is not the default here. Something that had to be fixed
      // usually has a way to check the fix worked, and a resolution nobody
      // confirmed is a claim rather than a fact.
      const verification = options.verification ?? 'PENDING';
      const row = await ctx.oneOrFail<ExceptionRow>(
        `UPDATE veylith.operational_exceptions
         SET status = $2, resolution = $3, resolved_at = $4::timestamptz, resolved_by = $5,
             verification = $6
         WHERE id = $1 RETURNING ${SELECT}`,
        [id, status, resolution, clock.nowIso(), actor, verification],
        'Operational exception',
      );
      await recordTransition(
        id,
        before.status,
        status,
        automatic ? 'SYSTEM' : 'HUMAN',
        actor,
        resolution,
      );
      return toRecord(row);
    },

    async escalate(id, reason, actor): Promise<OperationalException> {
      const before = await require(id);
      const row = await ctx.oneOrFail<ExceptionRow>(
        `UPDATE veylith.operational_exceptions
         SET status = 'ESCALATED', escalated_at = $2::timestamptz
         WHERE id = $1 RETURNING ${SELECT}`,
        [id, clock.nowIso()],
        'Operational exception',
      );
      await recordTransition(id, before.status, 'ESCALATED', 'SYSTEM', actor, reason);
      return toRecord(row);
    },

    async transitions(id) {
      const rows = await ctx.many<{
        to_status: string;
        actor: string;
        note: string;
        occurred_at: Date;
      }>(
        `SELECT to_status, actor, note, occurred_at FROM veylith.exception_transitions
         WHERE exception_id = $1 ORDER BY sequence`,
        [id],
      );
      return rows.map((row) => ({
        toStatus: row.to_status,
        actor: row.actor,
        note: row.note,
        occurredAt: row.occurred_at.toISOString(),
      }));
    },
  };

  return queue;
}
