import {
  orderResolutionQueue,
  planResolution,
  type ResolutionPlan,
  type UnknownItemInput,
} from '@adericel/resolution';
import {
  BLOCKED_REASONS,
  DEGRADED_REASONS,
  UNKNOWN_REASONS,
  type BlockedReason,
  type DegradedReason,
  type Severity,
  type UnknownReason,
} from '@adericel/domain';
import { ruleRequiredPredicates } from '@adericel/truth-engine';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * The resolution queue, from live data.
 *
 * `@adericel/resolution` decides what to do about an unknown and is pure. This
 * layer supplies the four facts it cannot derive for itself:
 *
 *   1. Which controls are currently undecided, and why.
 *   2. Which predicates each one's rule needed and did not get.
 *   3. Which connector declares those predicates, and whether it is configured
 *      for this organisation.
 *   4. **How many other controls the same gap darkens.**
 *
 * The fourth is the one that changes how an MSP works. A per-control view shows
 * forty unknowns and no way to tell that nine of them are the same expired
 * credential. Computing the fan-out turns forty items into a handful of pieces
 * of work, and the largest is usually an hour.
 */

/** A predicate, and the controls whose rules are waiting on it. */
type FanOut = ReadonlyMap<string, readonly string[]>;

export interface ResolutionQueue {
  readonly organisationId: string;
  readonly work: readonly ResolutionPlan[];
  readonly notActionable: readonly ResolutionPlan[];
  readonly summary: string;
  /** Stated with the queue: what this view could not see. */
  readonly limitations: readonly string[];
}

interface UndecidedRow {
  control_id: string;
  control_key: string;
  control_title: string;
  rule_key: string;
  ruleset_key: string;
  state: string;
  unknown_reason: string | null;
  degraded_reason: string | null;
  blocked_reason: string | null;
  /** Null for a control that has never been assessed. */
  last_assessed_at: Date | null;
}

/**
 * Predicates a rule reads, from the compiled ruleset rather than from a stored
 * column.
 *
 * The ruleset is the authority on what a rule needs. A column would be a copy,
 * and a copy of a rule's requirements goes stale the moment the ruleset version
 * changes — which is exactly when an operator most needs the list to be right.
 */
function predicatesForRule(
  app: AppContext,
  rulesetKey: string,
  ruleKey: string,
): readonly string[] {
  try {
    const ruleset = app.rulesets.get(rulesetKey);
    const rule = ruleset.rules.find((candidate) => candidate.key === ruleKey);
    // `ruleRequiredPredicates` walks the expression AND the applicability
    // condition. Reading only the expression would miss the predicate a rule
    // needs to decide whether it applies at all — and a control that cannot
    // establish its own applicability is exactly the kind that reads UNKNOWN
    // for a reason nobody can find.
    return rule ? ruleRequiredPredicates(rule) : [];
  } catch {
    // An assessment recorded against a ruleset this deployment no longer
    // carries. Reported as a limitation rather than crashing the queue: the
    // control is genuinely undecided and the operator should still see it.
    return [];
  }
}

export async function buildResolutionQueue(
  app: AppContext,
  organisationId: string,
): Promise<ResolutionQueue> {
  const limitations: string[] = [];

  /**
   * Driven from `controls`, not from `assurance_states`.
   *
   * A control that has never been assessed has no row in the projection at
   * all. Reading the projection alone therefore reports a freshly onboarded
   * organisation — every control undecided — as having nothing undecided,
   * which is the single most dangerous sentence this product could produce.
   * The Passport takes the same care for the same reason: a view listing only
   * the controls that happen to carry a state row flatters the organisation by
   * omission.
   */
  const undecided = await app.db.withTenant(organisationId, async (ctx) =>
    ctx.many<UndecidedRow>(
      `SELECT c.id                AS control_id,
              c.key               AS control_key,
              c.title             AS control_title,
              c.rule_key,
              c.ruleset_key,
              COALESCE(s.state, 'UNKNOWN')                  AS state,
              COALESCE(s.unknown_reason, 'NOT_YET_ASSESSED') AS unknown_reason,
              s.degraded_reason,
              s.blocked_reason,
              s.last_assessed_at
         FROM controls c
         LEFT JOIN assurance_states s
                ON s.subject_id = c.id
               AND s.organisation_id = c.organisation_id
               AND s.subject_kind = 'CONTROL'
        WHERE c.organisation_id = $1
          AND c.enabled
          AND (s.state IS NULL OR s.state IN ('UNKNOWN', 'DEGRADED', 'BLOCKED'))
        ORDER BY c.key`,
      [organisationId],
    ),
  );

  if (undecided.length === 0) {
    const enabled = await app.db.withTenant(organisationId, async (ctx) =>
      ctx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM controls
          WHERE organisation_id = $1 AND enabled`,
        [organisationId],
      ),
    );
    const total = Number(enabled?.count ?? 0);
    return {
      organisationId,
      work: [],
      notActionable: [],
      // Distinguished deliberately. "Nothing is undecided" and "there is
      // nothing to decide" read identically on a screen and mean opposite
      // things: the first is a good assurance position, the second is an
      // organisation with no controls at all.
      summary:
        total === 0
          ? 'This organisation has no enabled controls, so there is nothing to decide and ' +
            'nothing undecided. Adopt a framework or a baseline before reading this as a ' +
            'good position.'
          : `All ${total} enabled control(s) in this organisation have reached a determinate ` +
            'state or a recorded exception. Nothing is currently undecided.',
      limitations:
        total === 0 ? ['No controls are enabled, so this view has nothing to report on.'] : [],
    };
  }

  /**
   * The fan-out map: predicate -> the controls waiting on it.
   *
   * Built once for the whole organisation rather than per item, because the
   * question "how many controls does this gap darken" is a property of the set.
   */
  const fanOut = new Map<string, string[]>();
  const predicatesByControl = new Map<string, readonly string[]>();

  for (const row of undecided) {
    const predicates = predicatesForRule(app, row.ruleset_key, row.rule_key);
    predicatesByControl.set(row.control_id, predicates);
    if (predicates.length === 0) {
      limitations.push(
        `${row.control_key}: its rule (${row.ruleset_key}/${row.rule_key}) is not in a ruleset ` +
          'this deployment carries, so Adericel cannot say which predicates it needed.',
      );
    }
    for (const predicate of predicates) {
      const waiting = fanOut.get(predicate) ?? [];
      waiting.push(row.control_id);
      fanOut.set(predicate, waiting);
    }
  }

  const supply = await supplyingConnectors(app, organisationId, fanOut);
  const commitments = await datedCommitments(app, organisationId);

  const plans = undecided.map((row) =>
    planResolution(
      toItemInput(row, organisationId, predicatesByControl, fanOut, supply, commitments, app),
    ),
  );

  const ordered = orderResolutionQueue(plans);

  if (commitments.daysUntil === null) {
    limitations.push(
      'No dated commitment is recorded for this organisation, so nothing is ranked as ' +
        'BLOCKING. Record a certification date or a questionnaire deadline and the order ' +
        'changes accordingly.',
    );
  }

  return {
    organisationId,
    work: ordered.work,
    notActionable: ordered.notActionable,
    summary: ordered.summary,
    limitations,
  };
}

interface Supply {
  readonly connectorOf: ReadonlyMap<string, string>;
  readonly configured: ReadonlySet<string>;
  readonly degradedByConnector: ReadonlyMap<string, DegradedReason>;
  readonly attestationOnly: ReadonlySet<string>;
}

/**
 * Which connector could supply each predicate, and whether it is working.
 *
 * Read from the manifests rather than a table: a connector's declared
 * capability is part of the code, and a stored copy would let the queue tell an
 * operator to configure something that no longer supplies what they need.
 */
async function supplyingConnectors(
  app: AppContext,
  organisationId: string,
  fanOut: FanOut,
): Promise<Supply> {
  const connectorOf = new Map<string, string>();
  const attestationOnly = new Set<string>();

  for (const connector of app.connectors.list()) {
    for (const capability of connector.manifest.collect ?? []) {
      for (const predicate of capability.predicates) {
        // First declaring connector wins. Two connectors supplying the same
        // predicate is ordinary — Entra and Google Workspace both report MFA —
        // and for "who could close this gap" either answer is actionable.
        if (!connectorOf.has(predicate)) connectorOf.set(predicate, connector.manifest.id);
      }
    }
  }

  for (const predicate of fanOut.keys()) {
    if (!connectorOf.has(predicate)) attestationOnly.add(predicate);
  }

  const rows = await app.db.withTenant(organisationId, async (ctx) =>
    ctx.many<{ connector_key: string; health: string; consecutive_failures: number }>(
      `SELECT connector_key, health, consecutive_failures
         FROM integrations WHERE organisation_id = $1`,
      [organisationId],
    ),
  );

  const configured = new Set(rows.map((row) => row.connector_key));
  const degradedByConnector = new Map<string, DegradedReason>();
  for (const row of rows) {
    if (row.health === 'HEALTHY') continue;
    /**
     * Mapped conservatively. `health` says the connector is unwell, not why —
     * and naming a specific cause Adericel has not established would send an
     * engineer to reauthorise a credential that is fine. `COLLECTION_FAILING`
     * is the honest general answer, and the connector's own capability report
     * carries the specific one.
     */
    degradedByConnector.set(row.connector_key, 'COLLECTION_FAILING');
  }

  return { connectorOf, configured, degradedByConnector, attestationOnly };
}

/**
 * The nearest dated obligation, if one is recorded.
 *
 * Read rather than assumed. A queue that invented a deadline would rank
 * everything as blocking, and an operator would learn to ignore the ranking.
 */
async function datedCommitments(
  app: AppContext,
  organisationId: string,
): Promise<{ daysUntil: number | null; what: string | null }> {
  /**
   * "Now" comes from the injected clock, not from `now()`.
   *
   * The route refuses a past-dated commitment by comparing against
   * `app.clock`, so a query comparing against the database's clock is asking a
   * different question from the one that let the row in. Where the two
   * disagree — a replay, a backfill, a test, a database in another timezone
   * configuration — a commitment can be accepted and then never rank anything,
   * which reads as the feature silently not working.
   */
  const nowIso = app.clock.nowIso();
  const row = await app.db.withTenant(organisationId, async (ctx) =>
    ctx.one<{ due_at: Date; label: string }>(
      `SELECT due_at, label FROM organisation_commitments
        WHERE organisation_id = $1
          AND due_at > $2::timestamptz
          AND cancelled_at IS NULL
          AND met_at IS NULL
        ORDER BY due_at LIMIT 1`,
      [organisationId, nowIso],
    ),
  );
  if (!row) return { daysUntil: null, what: null };
  return {
    daysUntil: Math.max(0, Math.ceil((row.due_at.getTime() - app.clock.nowEpochMs()) / 86_400_000)),
    what: row.label,
  };
}

function toItemInput(
  row: UndecidedRow,
  organisationId: string,
  predicatesByControl: ReadonlyMap<string, readonly string[]>,
  fanOut: FanOut,
  supply: Supply,
  commitments: { daysUntil: number | null; what: string | null },
  app: AppContext,
): UnknownItemInput {
  const predicates = predicatesByControl.get(row.control_id) ?? [];

  /**
   * The predicate to route on: the one darkening the most controls.
   *
   * A rule may want three things and be missing all three. Routing on the
   * widest gap means the action Adericel proposes is the one that buys the
   * most, which is the whole reason the fan-out is computed.
   */
  const widest = [...predicates].sort(
    (a, b) => (fanOut.get(b)?.length ?? 0) - (fanOut.get(a)?.length ?? 0),
  )[0];

  const connector = widest ? (supply.connectorOf.get(widest) ?? null) : null;

  /**
   * The stored reason first; the connector's health only as a fallback.
   *
   * The projection carries the reason the engine recorded at assessment time,
   * and that is the authority. Deriving it from `integrations.health` instead
   * would flatten every degradation to COLLECTION_FAILING and lose the one
   * distinction an engineer acts on: CREDENTIAL_EXPIRED means reauthorise,
   * CONSENT_WITHDRAWN means do not touch it until the client says so.
   */
  const blockedReason = row.state === 'BLOCKED' ? normaliseBlockedReason(row.blocked_reason) : null;
  const degradedReason =
    row.state === 'DEGRADED'
      ? (normaliseDegradedReason(row.degraded_reason) ??
        (connector ? (supply.degradedByConnector.get(connector) ?? 'COLLECTION_FAILING') : null))
      : null;

  const affected = new Set<string>();
  for (const predicate of predicates) {
    for (const controlId of fanOut.get(predicate) ?? []) affected.add(controlId);
  }

  const decidedOutright = widest
    ? (fanOut.get(widest) ?? []).filter(
        (controlId) => (predicatesByControl.get(controlId) ?? []).length === 1,
      ).length
    : 0;

  const severity = severityOf(app, row);

  return {
    organisationId,
    controlId: row.control_id,
    controlKey: row.control_key,
    controlTitle: row.control_title,
    unknownReason:
      degradedReason === null && blockedReason === null
        ? normaliseUnknownReason(row.unknown_reason)
        : null,
    degradedReason,
    blockedReason,
    missingPredicates: widest ? [widest, ...predicates.filter((p) => p !== widest)] : [],
    supplyingConnector: connector,
    connectorConfigured: connector !== null && supply.configured.has(connector),
    attestationOnly: widest !== undefined && supply.attestationOnly.has(widest),
    materialityInput: {
      severity,
      controlsAffected: affected.size,
      blocksCommitment: commitments.daysUntil !== null,
      daysUntilCommitment: commitments.daysUntil,
      /**
       * Somebody has already been asked, for exactly two of the blocked
       * reasons. `assessMateriality` deliberately does not raise materiality
       * for these: asking again is not progress, and a queue that escalates on
       * every pass teaches an operator to ignore it.
       */
      awaitingPerson: blockedReason === 'APPROVAL_PENDING' || blockedReason === 'CONSENT_REQUIRED',
      // Decided by the planner from the kind, not asserted here. Passing `true`
      // would let this layer overrule `isActionable` and put an OUT_OF_SCOPE
      // item back into the work queue.
      actionable: true,
    },
    uncertaintyReduction: {
      controlsUnblocked: widest ? (fanOut.get(widest)?.length ?? 1) : 1,
      controlsDecidedOutright: decidedOutright,
    },
    outstandingRequestAgeDays: null,
  };
}

/**
 * The stored reasons, validated rather than trusted.
 *
 * All three are text columns on the projection. A value the domain does not
 * recognise — a reason from a newer release, or a hand-edited row — must not
 * flow into the planner and produce a plan built on a word nobody defined.
 *
 * Each falls back to the most conservative member of its own vocabulary rather
 * than to null. Null would read as "the engine gave no reason", which the
 * planner correctly reports as a defect in Adericel — and blaming ourselves for
 * a row somebody edited by hand is a false bug report in the customer's face.
 */
function normaliseUnknownReason(value: string | null): UnknownReason | null {
  if (value === null) return null;
  return (UNKNOWN_REASONS as readonly string[]).includes(value)
    ? (value as UnknownReason)
    : 'RULE_INPUTS_MISSING';
}

function normaliseDegradedReason(value: string | null): DegradedReason | null {
  if (value === null) return null;
  return (DEGRADED_REASONS as readonly string[]).includes(value)
    ? (value as DegradedReason)
    : 'COLLECTION_FAILING';
}

function normaliseBlockedReason(value: string | null): BlockedReason | null {
  if (value === null) return null;
  return (BLOCKED_REASONS as readonly string[]).includes(value)
    ? (value as BlockedReason)
    : 'DEPENDENCY_BLOCKED';
}

/** Severity from the rule, which is where it is defined. */
function severityOf(app: AppContext, row: UndecidedRow): Severity {
  try {
    const rule = app.rulesets
      .get(row.ruleset_key)
      .rules.find((candidate) => candidate.key === row.rule_key);
    return (rule?.severity as Severity | undefined) ?? 'MEDIUM';
  } catch {
    return 'MEDIUM';
  }
}

/** One control's plan, for the explanation page. */
export async function resolutionForControl(
  app: AppContext,
  organisationId: string,
  controlId: string,
): Promise<ResolutionPlan> {
  const queue = await buildResolutionQueue(app, organisationId);
  const found = [...queue.work, ...queue.notActionable].find(
    (plan) => plan.controlId === controlId,
  );
  if (!found) {
    throw new AdericelError(
      'NOT_FOUND',
      'That control is not currently undecided, so there is nothing to resolve.',
    );
  }
  return found;
}
