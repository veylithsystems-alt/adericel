import type { PlatformContext } from '@adericel/graph';
import {
  agedSeverity,
  rankOf,
  EXCEPTION_KINDS_BY_KEY,
  type ExceptionKind,
  type PortfolioException,
} from './exception.js';

/**
 * Building the queue.
 *
 * One pass over a portfolio, producing every reason a person is needed. Runs in
 * platform scope because it spans organisations by definition; the caller
 * proves the MSP owns them first and passes the ids in. No query here takes an
 * organisation id from a request.
 *
 * Each source below is a separate query rather than one enormous union, because
 * each has genuinely different joins and a single query would be unreadable and
 * unprofilable. They are assembled, ranked and returned together.
 */

export interface QueueOptions {
  /** How long a control may be UNKNOWN before nobody is closing it. */
  readonly unknownGraceDays?: number;
  /** How old supporting evidence may be before the determination is stale. */
  readonly evidenceStaleDays?: number;
  /** How many times a control may fail and be fixed before that is the problem. */
  readonly recurrenceThreshold?: number;
  /** Cap, so one broken customer cannot fill the whole queue. */
  readonly perOrganisationLimit?: number;
  readonly limit?: number;
}

const DEFAULTS = {
  unknownGraceDays: 14,
  evidenceStaleDays: 30,
  recurrenceThreshold: 3,
  perOrganisationLimit: 25,
  limit: 500,
} as const;

function hoursBetween(fromIso: string, toIso: string): number {
  return Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000);
}

/** Assemble one exception, applying ageing and ranking consistently. */
function build(input: {
  kind: ExceptionKind;
  keyParts: readonly string[];
  organisationId: string;
  organisationName: string;
  cause: string;
  recommendedAction: string;
  since: string;
  now: string;
  controlId?: string | null;
  controlKey?: string | null;
  controlTitle?: string | null;
  truthState?: string | null;
  unknownReason?: string | null;
  automatable?: boolean;
  approvalRequired?: boolean;
  actionId?: string | null;
  actionState?: string | null;
  verificationOutcome?: string | null;
  evidenceAgeHours?: number | null;
  provenance?: Record<string, string | null>;
}): PortfolioException {
  const definition = EXCEPTION_KINDS_BY_KEY[input.kind];
  const ageHours = hoursBetween(input.since, input.now);
  const severity = agedSeverity(definition.baseSeverity, ageHours);

  return {
    key: [input.kind, ...input.keyParts].join(':'),
    kind: input.kind,
    severity,
    organisationId: input.organisationId,
    organisationName: input.organisationName,
    controlId: input.controlId ?? null,
    controlKey: input.controlKey ?? null,
    controlTitle: input.controlTitle ?? null,
    truthState: input.truthState ?? null,
    unknownReason: input.unknownReason ?? null,
    cause: input.cause,
    recommendedAction: input.recommendedAction,
    response: definition.response,
    assuranceMaintained: definition.assuranceMaintained,
    automatable: input.automatable ?? false,
    approvalRequired: input.approvalRequired ?? false,
    actionId: input.actionId ?? null,
    actionState: input.actionState ?? null,
    verificationOutcome: input.verificationOutcome ?? null,
    since: input.since,
    ageHours: Math.round(ageHours * 10) / 10,
    evidenceAgeHours: input.evidenceAgeHours ?? null,
    provenance: input.provenance ?? {},
    rank: rankOf({
      severity,
      assuranceMaintained: definition.assuranceMaintained,
      ageHours,
    }),
  };
}

/** Connector outcomes that mean a person has to change something upstream. */
const CONNECTOR_KIND_BY_OUTCOME: Readonly<Record<string, ExceptionKind>> = {
  AUTHENTICATION_FAILED: 'CONNECTOR_AUTHENTICATION',
  PERMISSION_DENIED: 'CONNECTOR_PERMISSION',
  UPSTREAM_UNAVAILABLE: 'CONNECTOR_UNREACHABLE',
  SCHEMA_DRIFT: 'CONNECTOR_SCHEMA_DRIFT',
};

/**
 * A control Adericel cannot evidence for anybody.
 *
 * Reported separately from the queue, because it is a statement about the
 * product rather than a task for an operator.
 */
export interface CoverageLimitation {
  readonly controlTitle: string;
  readonly organisationsAffected: number;
}

export interface ExceptionQueueResult {
  readonly exceptions: readonly PortfolioException[];
  readonly limitations: readonly CoverageLimitation[];
}

export async function buildExceptionQueue(
  ctx: PlatformContext,
  organisationIds: readonly string[],
  nowIso: string,
  options: QueueOptions = {},
): Promise<ExceptionQueueResult> {
  const ids = [...organisationIds];
  if (ids.length === 0) return { exceptions: [], limitations: [] };

  const config = { ...DEFAULTS, ...options };
  const found: PortfolioException[] = [];

  // --- Waiting on a person's decision ---------------------------------------
  const approvals = await ctx.many<{
    action_id: string;
    organisation_id: string;
    organisation_name: string;
    action_type: string;
    risk_class: string;
    proposed_at: string;
    control_id: string | null;
    control_key: string | null;
    control_title: string | null;
  }>(
    `SELECT a.id AS action_id, o.id AS organisation_id, o.name AS organisation_name,
            a.action_type, a.risk_class, a.proposed_at,
            c.id AS control_id, c.key AS control_key, c.title AS control_title
       FROM actions a
       JOIN organisations o ON o.id = a.organisation_id
       LEFT JOIN findings f ON f.id = a.finding_id
       LEFT JOIN controls c ON c.id = f.control_id
      WHERE a.organisation_id = ANY($1::uuid[]) AND a.state = 'AWAITING_APPROVAL'`,
    [ids],
  );
  for (const row of approvals) {
    found.push(
      build({
        kind: 'APPROVAL_REQUIRED',
        keyParts: [row.action_id],
        organisationId: row.organisation_id,
        organisationName: row.organisation_name,
        controlId: row.control_id,
        controlKey: row.control_key,
        controlTitle: row.control_title,
        cause: `A ${row.risk_class} remediation (${row.action_type}) is prepared and policy requires a human decision.`,
        recommendedAction: 'Approve or reject it. Nothing has been changed in the estate yet.',
        approvalRequired: true,
        automatable: true,
        actionId: row.action_id,
        actionState: 'AWAITING_APPROVAL',
        since: row.proposed_at,
        now: nowIso,
        provenance: { actionId: row.action_id, controlId: row.control_id },
      }),
    );
  }

  // --- Adericel tried and could not finish -----------------------------------
  const failed = await ctx.many<{
    action_id: string;
    organisation_id: string;
    organisation_name: string;
    action_type: string;
    state: string;
    last_error: string | null;
    attempt_count: number;
    executed_at: string | null;
    proposed_at: string;
    verification_outcome: string | null;
  }>(
    `SELECT a.id AS action_id, o.id AS organisation_id, o.name AS organisation_name,
            a.action_type, a.state, a.last_error, a.attempt_count,
            a.executed_at, a.proposed_at,
            v.outcome AS verification_outcome
       FROM actions a
       JOIN organisations o ON o.id = a.organisation_id
       LEFT JOIN verifications v ON v.id = a.verification_id
      WHERE a.organisation_id = ANY($1::uuid[])
        AND a.state IN ('FAILED', 'TIMED_OUT', 'UNVERIFIED', 'ROLLBACK_REQUIRED')`,
    [ids],
  );
  for (const row of failed) {
    // UNVERIFIED is the dangerous one: the change was dispatched and nobody
    // established what it did. It is reported as a different kind from a clean
    // failure, because the two need different responses.
    const kind: ExceptionKind =
      row.state === 'FAILED' || row.state === 'TIMED_OUT'
        ? 'AUTOMATION_FAILED'
        : 'VERIFICATION_FAILED';
    found.push(
      build({
        kind,
        keyParts: [row.action_id],
        organisationId: row.organisation_id,
        organisationName: row.organisation_name,
        cause:
          kind === 'AUTOMATION_FAILED'
            ? `${row.action_type} failed after ${row.attempt_count} attempt(s): ${row.last_error ?? 'no error recorded'}`
            : `${row.action_type} was dispatched and re-observation ${
                row.verification_outcome === 'REFUTED'
                  ? 'contradicted it'
                  : 'could not establish the outcome'
              }. The estate is in an unknown condition.`,
        recommendedAction:
          kind === 'AUTOMATION_FAILED'
            ? 'Establish why the change was rejected upstream before retrying.'
            : 'Check the estate directly. Do not treat this as remediated on the action record alone.',
        automatable: false,
        actionId: row.action_id,
        actionState: row.state,
        verificationOutcome: row.verification_outcome,
        since: row.executed_at ?? row.proposed_at,
        now: nowIso,
        provenance: { actionId: row.action_id },
      }),
    );
  }

  // --- Adericel cannot see ----------------------------------------------------
  // Latest report per integration and capability, so a problem fixed this
  // morning does not sit in the queue behind its own history.
  const capabilities = await ctx.many<{
    organisation_id: string;
    organisation_name: string;
    integration_id: string;
    integration_name: string;
    capability: string;
    outcome: string;
    detail: string;
    required_permission: string;
    unavailable_predicates: string[];
    observed_at: string;
  }>(
    `SELECT DISTINCT ON (r.integration_id, r.capability)
            o.id AS organisation_id, o.name AS organisation_name,
            r.integration_id, i.name AS integration_name,
            r.capability, r.outcome, r.detail, r.required_permission,
            r.unavailable_predicates, r.created_at AS observed_at
       FROM integration_capability_reports r
       JOIN organisations o ON o.id = r.organisation_id
       JOIN integrations i ON i.id = r.integration_id
      WHERE r.organisation_id = ANY($1::uuid[])
      ORDER BY r.integration_id, r.capability, r.created_at DESC`,
    [ids],
  );
  for (const row of capabilities) {
    const kind = CONNECTOR_KIND_BY_OUTCOME[row.outcome];
    if (!kind) continue;
    const predicates = row.unavailable_predicates ?? [];
    found.push(
      build({
        kind,
        keyParts: [row.integration_id, row.capability],
        organisationId: row.organisation_id,
        organisationName: row.organisation_name,
        cause:
          `${row.integration_name} could not collect ${row.capability}: ${row.outcome}` +
          (row.detail ? ` — ${row.detail}` : ''),
        recommendedAction:
          kind === 'CONNECTOR_PERMISSION' && row.required_permission
            ? `Grant ${row.required_permission} in the customer tenant.`
            : kind === 'CONNECTOR_AUTHENTICATION'
              ? 'Reconnect the integration with valid credentials.'
              : 'Establish whether the upstream is available, then re-run collection.',
        // Naming the controls this actually costs, so the exception is about
        // assurance rather than about an integration.
        unknownReason:
          predicates.length > 0
            ? `${predicates.length} predicate(s) unavailable: ${predicates.slice(0, 5).join(', ')}`
            : null,
        since: row.observed_at,
        now: nowIso,
        provenance: { integrationId: row.integration_id, capability: row.capability },
      }),
    );
  }

  // --- Sources disagreeing ----------------------------------------------------
  const conflicts = await ctx.many<{
    organisation_id: string;
    organisation_name: string;
    predicate: string;
    subject_external_id: string | null;
    distinct_values: number;
    detected_at: string;
  }>(
    `SELECT o.id AS organisation_id, o.name AS organisation_name,
            k.predicate, k.subject_external_id, k.distinct_values,
            k.created_at AS detected_at
       FROM claim_conflicts k
       JOIN organisations o ON o.id = k.organisation_id
      WHERE k.organisation_id = ANY($1::uuid[]) AND k.resolution = 'UNRESOLVED'`,
    [ids],
  );
  for (const row of conflicts) {
    found.push(
      build({
        kind: 'EVIDENCE_CONFLICT',
        keyParts: [row.organisation_id, row.predicate, row.subject_external_id ?? '-'],
        organisationId: row.organisation_id,
        organisationName: row.organisation_name,
        cause: `${row.distinct_values} sources disagree about ${row.predicate}${
          row.subject_external_id ? ` for ${row.subject_external_id}` : ''
        }.`,
        recommendedAction:
          'Establish which source is right, then set source authority for this predicate. ' +
          'Until then the affected controls read UNKNOWN.',
        truthState: 'UNKNOWN',
        since: row.detected_at,
        now: nowIso,
        provenance: { predicate: row.predicate, subject: row.subject_external_id },
      }),
    );
  }

  // --- Determinations that have stopped meaning anything -----------------------
  const states = await ctx.many<{
    organisation_id: string;
    organisation_name: string;
    control_id: string;
    control_key: string;
    control_title: string;
    state: string;
    previous_state: string | null;
    unknown_reason: string | null;
    since: string;
    last_assessed_at: string;
    open_action: string | null;
    detections: number;
  }>(
    `SELECT o.id AS organisation_id, o.name AS organisation_name,
            c.id AS control_id, c.key AS control_key, c.title AS control_title,
            s.state, s.previous_state, s.unknown_reason, s.since, s.last_assessed_at,
            (SELECT a.id::text FROM actions a
               JOIN findings f2 ON f2.id = a.finding_id
              WHERE f2.control_id = c.id
                AND a.state NOT IN ('REJECTED','CANCELLED','FAILED','TIMED_OUT')
              LIMIT 1) AS open_action,
            COALESCE((SELECT count(*)::int FROM findings f3
                       WHERE f3.control_id = c.id AND f3.status = 'RESOLVED'), 0) AS detections
       FROM assurance_states s
       JOIN organisations o ON o.id = s.organisation_id
       JOIN controls c ON c.id = s.subject_id
      WHERE s.organisation_id = ANY($1::uuid[])
        AND s.subject_kind = 'CONTROL'
        AND (s.state IN ('UNKNOWN', 'NOT_SATISFIED')
             OR (s.previous_state = 'SATISFIED' AND s.state <> 'SATISFIED'))`,
    [ids],
  );

  const unknownGraceHours = config.unknownGraceDays * 24;
  const staleHours = config.evidenceStaleDays * 24;

  /**
   * Coverage gaps and ageing unknowns are aggregated per customer.
   *
   * One exception per control made the queue unusable: a customer with thin
   * connector coverage produced twenty near-identical items, which pushed
   * every other customer's single urgent problem off the first screen. The
   * operator's job on all twenty is the same one job — connect a system — so
   * it is one exception naming the count, with examples.
   *
   * This is the difference between a queue and a list.
   */
  const coverageGaps = new Map<
    string,
    { organisationName: string; controls: string[]; since: string; reasons: Set<string> }
  >();
  const ageingUnknowns = new Map<
    string,
    { organisationName: string; controls: string[]; since: string }
  >();

  for (const row of states) {
    const ageHours = hoursBetween(row.since, nowIso);
    const assessedAgeHours = hoursBetween(row.last_assessed_at, nowIso);

    // Deterioration is reported per control and once, on the transition: a
    // customer getting worse is specific, and aggregating it would lose which
    // control moved.
    if (row.previous_state === 'SATISFIED' && row.state !== 'SATISFIED') {
      found.push(
        build({
          kind: 'DETERIORATION',
          keyParts: [row.control_id, row.since],
          organisationId: row.organisation_id,
          organisationName: row.organisation_name,
          controlId: row.control_id,
          controlKey: row.control_key,
          controlTitle: row.control_title,
          truthState: row.state,
          unknownReason: row.unknown_reason,
          cause: `${row.control_title} was satisfied and is now ${row.state}.`,
          recommendedAction: 'Establish what changed in the estate, and whether it was intended.',
          automatable: row.open_action !== null,
          actionId: row.open_action,
          since: row.since,
          now: nowIso,
          provenance: { controlId: row.control_id },
        }),
      );
      continue;
    }

    if (row.state === 'UNKNOWN') {
      // The Truth Engine's own reason codes. Matched on the code rather than on
      // prose: an earlier version compared against "no evidence" with a space
      // and never matched NO_EVIDENCE, so every coverage gap in the portfolio
      // was misreported as an ageing unknown.
      const reason = (row.unknown_reason ?? '').toUpperCase();
      const neverDeterminable =
        reason.includes('NO_EVIDENCE') ||
        reason.includes('INSUFFICIENT_EVIDENCE') ||
        reason.includes('NO_CLAIM') ||
        reason.includes('NEVER_OBSERVED');

      if (neverDeterminable) {
        const entry = coverageGaps.get(row.organisation_id) ?? {
          organisationName: row.organisation_name,
          controls: [],
          since: row.since,
          reasons: new Set<string>(),
        };
        entry.controls.push(row.control_title);
        entry.reasons.add(reason);
        // The oldest gap dates the exception: how long has this customer had a
        // hole in its coverage.
        if (Date.parse(row.since) < Date.parse(entry.since)) entry.since = row.since;
        coverageGaps.set(row.organisation_id, entry);
      } else if (ageHours > unknownGraceHours) {
        const entry = ageingUnknowns.get(row.organisation_id) ?? {
          organisationName: row.organisation_name,
          controls: [],
          since: row.since,
        };
        entry.controls.push(row.control_title);
        if (Date.parse(row.since) < Date.parse(entry.since)) entry.since = row.since;
        ageingUnknowns.set(row.organisation_id, entry);
      }
      continue;
    }

    // NOT_SATISFIED from here down. These stay per control: each is a specific
    // failing thing with its own fix.
    if (row.detections >= config.recurrenceThreshold) {
      found.push(
        build({
          kind: 'RECURRING_FAILURE',
          keyParts: [row.control_id],
          organisationId: row.organisation_id,
          organisationName: row.organisation_name,
          controlId: row.control_id,
          controlKey: row.control_key,
          controlTitle: row.control_title,
          truthState: row.state,
          cause: `${row.control_title} has been remediated and failed again ${row.detections} times.`,
          recommendedAction:
            'Something is putting this back. Continuing to remediate automates a loop ' +
            'rather than solving the problem.',
          automatable: true,
          since: row.since,
          now: nowIso,
          provenance: { controlId: row.control_id },
        }),
      );
      continue;
    }

    if (row.open_action === null) {
      found.push(
        build({
          kind: 'REMEDIATION_UNAVAILABLE',
          keyParts: [row.control_id],
          organisationId: row.organisation_id,
          organisationName: row.organisation_name,
          controlId: row.control_id,
          controlKey: row.control_key,
          controlTitle: row.control_title,
          truthState: row.state,
          cause: `${row.control_title} is failing and no remediation is proposed or permitted.`,
          recommendedAction:
            'Either no connector exposes this change, or policy forbids Adericel making it. ' +
            'The work is a person’s.',
          automatable: false,
          since: row.since,
          now: nowIso,
          provenance: { controlId: row.control_id },
        }),
      );
    }

    if (assessedAgeHours > staleHours && row.open_action !== null) {
      found.push(
        build({
          kind: 'EVIDENCE_STALE',
          keyParts: [row.control_id],
          organisationId: row.organisation_id,
          organisationName: row.organisation_name,
          controlId: row.control_id,
          controlKey: row.control_key,
          controlTitle: row.control_title,
          truthState: row.state,
          cause: `${row.control_title} has not been reassessed for ${Math.round(assessedAgeHours / 24)} days.`,
          recommendedAction:
            'Collection has stopped or is failing quietly. The determination still stands as ' +
            'a statement about when it was made, and is not a statement about now.',
          evidenceAgeHours: Math.round(assessedAgeHours),
          since: row.last_assessed_at,
          now: nowIso,
          provenance: { controlId: row.control_id },
        }),
      );
    }
  }

  /**
   * A gap every customer has is not a hundred jobs; it is one product limit.
   *
   * A control that no customer in the portfolio can determine is not something
   * an operator can fix by connecting a system — no system supplies it. Raising
   * it per customer produced a hundred identical exceptions telling a hundred
   * different people to do the impossible, and buried every genuine coverage
   * gap underneath them.
   *
   * So gaps universal to the portfolio are withheld from the queue and returned
   * separately as what they are: a limit of what Adericel can currently
   * evidence. Gaps that only some customers have stay in the queue, because for
   * those, connecting something really would help.
   */
  const organisationsSeen = new Set(states.map((row) => row.organisation_id));
  const gapCountByControl = new Map<string, number>();
  for (const [, entry] of coverageGaps) {
    for (const control of entry.controls) {
      gapCountByControl.set(control, (gapCountByControl.get(control) ?? 0) + 1);
    }
  }
  const universalGaps = new Set(
    [...gapCountByControl.entries()]
      .filter(([, count]) => count >= organisationsSeen.size && organisationsSeen.size > 1)
      .map(([control]) => control),
  );

  const examples = (controls: readonly string[]): string =>
    controls.slice(0, 3).join('; ') +
    (controls.length > 3 ? `; and ${controls.length - 3} more` : '');

  for (const [organisationId, entry] of coverageGaps) {
    const actionable = entry.controls.filter((control) => !universalGaps.has(control));
    // Every gap this customer has is one the whole portfolio has. Nothing an
    // operator does for this customer would close it.
    if (actionable.length === 0) continue;
    found.push(
      build({
        kind: 'COVERAGE_GAP',
        keyParts: [organisationId],
        organisationId,
        organisationName: entry.organisationName,
        truthState: 'UNKNOWN',
        unknownReason: [...entry.reasons].sort().join(', '),
        cause:
          `${actionable.length} control(s) have never been determined because nothing ` +
          `observed supplies the facts they need: ${examples(actionable)}.`,
        recommendedAction:
          'Connect a system that can supply these facts, or record attestations. Adericel ' +
          'will hold them UNKNOWN until one of those happens.',
        since: entry.since,
        now: nowIso,
        provenance: { organisationId, controls: String(actionable.length) },
      }),
    );
  }

  for (const [organisationId, entry] of ageingUnknowns) {
    found.push(
      build({
        kind: 'UNKNOWN_PERSISTENT',
        keyParts: [organisationId],
        organisationId,
        organisationName: entry.organisationName,
        truthState: 'UNKNOWN',
        cause:
          `${entry.controls.length} control(s) have been UNKNOWN for more than ` +
          `${config.unknownGraceDays} days: ${examples(entry.controls)}.`,
        recommendedAction: 'Close the gaps, or record a decision to accept them.',
        since: entry.since,
        now: nowIso,
        provenance: { organisationId, controls: String(entry.controls.length) },
      }),
    );
  }

  // --- Lifecycle ---------------------------------------------------------------
  const offboarding = await ctx.many<{
    organisation_id: string;
    organisation_name: string;
    started_at: string;
    pending: number;
  }>(
    `SELECT o.id AS organisation_id, o.name AS organisation_name,
            o.offboarding_started_at AS started_at,
            (SELECT count(*)::int FROM offboarding_tasks t
              WHERE t.organisation_id = o.id AND t.required AND t.state <> 'COMPLETED') AS pending
       FROM organisations o
      WHERE o.id = ANY($1::uuid[]) AND o.status = 'OFFBOARDING'`,
    [ids],
  );
  for (const row of offboarding) {
    if (row.pending === 0) continue;
    found.push(
      build({
        kind: 'OFFBOARDING_BLOCKED',
        keyParts: [row.organisation_id],
        organisationId: row.organisation_id,
        organisationName: row.organisation_name,
        cause: `Offboarding began and ${row.pending} required step(s) are outstanding.`,
        recommendedAction:
          'Complete the outstanding steps. A half-offboarded customer keeps its credentials ' +
          'and its place in the bill.',
        since: row.started_at,
        now: nowIso,
        provenance: { organisationId: row.organisation_id },
      }),
    );
  }

  // --- Rank, cap, return --------------------------------------------------------
  found.sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key));

  // One badly broken customer must not fill the queue and hide every other
  // customer's single urgent item. The cap is per organisation and the
  // remainder is still reachable through that customer's own view.
  const perOrganisation = new Map<string, number>();
  const capped: PortfolioException[] = [];
  for (const exception of found) {
    const seen = perOrganisation.get(exception.organisationId) ?? 0;
    if (seen >= config.perOrganisationLimit) continue;
    perOrganisation.set(exception.organisationId, seen + 1);
    capped.push(exception);
    if (capped.length >= config.limit) break;
  }

  return {
    exceptions: capped,
    limitations: [...universalGaps]
      .map((controlTitle) => ({
        controlTitle,
        organisationsAffected: gapCountByControl.get(controlTitle) ?? 0,
      }))
      .sort((a, b) => a.controlTitle.localeCompare(b.controlTitle)),
  };
}
