import { z } from 'zod';

/**
 * The MSP exception queue.
 *
 * An MSP with a hundred customers cannot inspect a hundred customers. The only
 * workload that scales is one where the operator deals with exceptions and
 * everything else is left alone — so this is the operational centre of gravity
 * of the product, not a report about it.
 *
 * Before this existed the portfolio offered five disconnected lists: unknowns,
 * approvals, deteriorating, recurring failures, coverage. Each answered part of
 * one question, and an operator holding an exception in their head had to visit
 * several screens to find out what it actually was. This makes one queue where
 * every item carries the whole story.
 *
 * WHAT AN EXCEPTION IS NOT
 *
 * It is not a finding. A finding says a control is not satisfied; an exception
 * says a HUMAN IS NEEDED. A failing control that Adericel is permitted to fix
 * and has already fixed and verified is not an exception, and putting it in the
 * queue would train the operator to ignore the queue.
 *
 * The queue is deliberately hard to get into. Everything Adericel can handle
 * itself stays out of it.
 */

/**
 * Why a person is needed.
 *
 * Ordered by how much of somebody's day each one deserves, which is also the
 * order they are worked. A kind that cannot be acted on does not belong here.
 */
export const EXCEPTION_KINDS = [
  // --- Something is waiting on a person's decision --------------------------
  /** An action is built, policy-evaluated and stopped, pending a human. */
  'APPROVAL_REQUIRED',

  // --- Adericel tried and could not finish ----------------------------------
  /** Execution was dispatched and failed. The estate is unchanged. */
  'AUTOMATION_FAILED',
  /**
   * Execution happened and the re-observation did not agree, or could not be
   * made. The estate is in an unknown condition, which is worse than failure
   * because it looks like success from the action record alone.
   */
  'VERIFICATION_FAILED',

  // --- Adericel cannot see ---------------------------------------------------
  /** Credentials rejected. Nothing further is being learned from this source. */
  'CONNECTOR_AUTHENTICATION',
  /** Credentials valid, permission missing. Named to the exact grant needed. */
  'CONNECTOR_PERMISSION',
  /** The upstream could not be reached. May be transient; is not assurance. */
  'CONNECTOR_UNREACHABLE',
  /** The response parsed and did not contain what the connector expects. */
  'CONNECTOR_SCHEMA_DRIFT',
  /** A control needs a predicate no configured connector can produce at all. */
  'COVERAGE_GAP',

  // --- Adericel can see and cannot conclude ----------------------------------
  /** Two sources disagree. Both claims are DISPUTED and no rule reads them. */
  'EVIDENCE_CONFLICT',
  /** The evidence behind a determination is older than the control allows. */
  'EVIDENCE_STALE',
  /** A control has been UNKNOWN long enough that nobody is closing it. */
  'UNKNOWN_PERSISTENT',

  // --- Adericel concluded, and the answer needs a person ---------------------
  /** Failing, and no remediation exists or is permitted. A person must act. */
  'REMEDIATION_UNAVAILABLE',
  /** Was satisfied, is not now. Something changed and somebody should know. */
  'DETERIORATION',
  /** The same control keeps failing after remediation. Fixing it is not working. */
  'RECURRING_FAILURE',

  // --- Lifecycle --------------------------------------------------------------
  /** Offboarding has stalled on a step that needs a person. */
  'OFFBOARDING_BLOCKED',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export const exceptionKindSchema = z.enum(EXCEPTION_KINDS);

/**
 * What the operator is being asked to do. Four kinds, and no others.
 *
 * Every exception resolves to exactly one of these, because an operator
 * planning their morning needs to know whether the queue is ten decisions or
 * ten investigations — those are very different days.
 */
export const RESPONSE_TYPES = [
  /** Say yes or no. Adericel has done everything else. */
  'DECIDE',
  /** Change something outside Adericel — a permission, a credential, a setting. */
  'CONFIGURE',
  /** Find out what is true. Adericel cannot, and says why. */
  'INVESTIGATE',
  /** Contact the customer. The thing needed is not in the MSP's gift. */
  'ASK_CUSTOMER',
] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

export const EXCEPTION_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

export interface ExceptionKindDefinition {
  readonly kind: ExceptionKind;
  /** What has happened, in the words an operator would use. */
  readonly summary: string;
  /** Why a person is needed rather than Adericel handling it. */
  readonly whyHuman: string;
  readonly response: ResponseType;
  /** Severity before any per-item adjustment. */
  readonly baseSeverity: ExceptionSeverity;
  /**
   * Whether the underlying assurance is currently being maintained.
   *
   * False means Adericel has stopped being able to say anything true about the
   * affected controls. Those exceptions outrank everything else regardless of
   * severity, because an unattended one silently turns into a customer whose
   * assurance quietly stopped.
   */
  readonly assuranceMaintained: boolean;
}

/**
 * Every kind, defined once.
 *
 * `Record<ExceptionKind, …>` so adding a kind without deciding what it means,
 * who it needs and how urgent it is does not compile.
 */
export const EXCEPTION_KINDS_BY_KEY: Readonly<Record<ExceptionKind, ExceptionKindDefinition>> = {
  APPROVAL_REQUIRED: {
    kind: 'APPROVAL_REQUIRED',
    summary: 'A remediation is prepared and waiting for a human decision.',
    whyHuman:
      'Policy requires a person to authorise this class of change. No configuration of Adericel ' +
      'approves its own actions.',
    response: 'DECIDE',
    baseSeverity: 'HIGH',
    assuranceMaintained: true,
  },
  AUTOMATION_FAILED: {
    kind: 'AUTOMATION_FAILED',
    summary: 'Adericel attempted the fix and the execution failed.',
    whyHuman:
      'The estate is unchanged and the cause is upstream of Adericel. Retrying without ' +
      'understanding why would be guessing.',
    response: 'INVESTIGATE',
    baseSeverity: 'HIGH',
    assuranceMaintained: true,
  },
  VERIFICATION_FAILED: {
    kind: 'VERIFICATION_FAILED',
    summary: 'The fix was dispatched and re-observation did not confirm it.',
    whyHuman:
      'The estate is in an unknown condition. This is worse than a clean failure, because the ' +
      'action record alone would read as success.',
    response: 'INVESTIGATE',
    baseSeverity: 'CRITICAL',
    assuranceMaintained: false,
  },
  CONNECTOR_AUTHENTICATION: {
    kind: 'CONNECTOR_AUTHENTICATION',
    summary: 'The connector credentials were rejected.',
    whyHuman: 'Only a person with access to the customer tenant can issue new credentials.',
    response: 'CONFIGURE',
    baseSeverity: 'CRITICAL',
    assuranceMaintained: false,
  },
  CONNECTOR_PERMISSION: {
    kind: 'CONNECTOR_PERMISSION',
    summary: 'The credentials are valid and lack a permission this needs.',
    whyHuman:
      'The exact grant is named. Adericel will not escalate its own access, and should not be ' +
      'able to.',
    response: 'CONFIGURE',
    baseSeverity: 'HIGH',
    assuranceMaintained: false,
  },
  CONNECTOR_UNREACHABLE: {
    kind: 'CONNECTOR_UNREACHABLE',
    summary: 'The upstream system could not be reached.',
    whyHuman:
      'May be transient. It is raised once it has persisted, because a retry loop that never ' +
      'tells anybody is how a customer stops being observed for a fortnight.',
    response: 'INVESTIGATE',
    baseSeverity: 'MEDIUM',
    assuranceMaintained: false,
  },
  CONNECTOR_SCHEMA_DRIFT: {
    kind: 'CONNECTOR_SCHEMA_DRIFT',
    summary: 'The upstream responded with a shape the connector does not recognise.',
    whyHuman:
      'The vendor changed something. Adericel refuses to guess at the new shape rather than ' +
      'risk reading a field wrongly and asserting it.',
    response: 'INVESTIGATE',
    baseSeverity: 'HIGH',
    assuranceMaintained: false,
  },
  COVERAGE_GAP: {
    kind: 'COVERAGE_GAP',
    summary: 'A control needs a fact no connected system can supply.',
    whyHuman:
      'Either a connector is missing or the fact has to be attested by a person. Adericel will ' +
      'hold the control UNKNOWN until one of those happens.',
    response: 'ASK_CUSTOMER',
    baseSeverity: 'MEDIUM',
    assuranceMaintained: false,
  },
  EVIDENCE_CONFLICT: {
    kind: 'EVIDENCE_CONFLICT',
    summary: 'Two sources disagree about the same fact.',
    whyHuman:
      'Adericel refuses to choose between them, so the affected controls read UNKNOWN until ' +
      'somebody settles it. Picking the more recent one would be treating recency as authority.',
    response: 'INVESTIGATE',
    baseSeverity: 'HIGH',
    assuranceMaintained: false,
  },
  EVIDENCE_STALE: {
    kind: 'EVIDENCE_STALE',
    summary: 'The evidence behind a determination is older than the control allows.',
    whyHuman:
      'Collection has stopped or is failing silently. The determination still stands as a ' +
      'statement about when it was made, and it is no longer a statement about now.',
    response: 'INVESTIGATE',
    baseSeverity: 'MEDIUM',
    assuranceMaintained: false,
  },
  UNKNOWN_PERSISTENT: {
    kind: 'UNKNOWN_PERSISTENT',
    summary: 'A control has been UNKNOWN long enough that nobody is closing it.',
    whyHuman:
      'UNKNOWN is an honest answer and a permanent one is an unowned gap. Somebody has to ' +
      'decide to close it or to accept it.',
    response: 'ASK_CUSTOMER',
    baseSeverity: 'MEDIUM',
    assuranceMaintained: false,
  },
  REMEDIATION_UNAVAILABLE: {
    kind: 'REMEDIATION_UNAVAILABLE',
    summary: 'A control is failing and Adericel has no permitted way to fix it.',
    whyHuman:
      'Either no connector exposes the change, or policy forbids Adericel making it. The work ' +
      'is a person’s.',
    response: 'CONFIGURE',
    baseSeverity: 'HIGH',
    assuranceMaintained: true,
  },
  DETERIORATION: {
    kind: 'DETERIORATION',
    summary: 'A control that was satisfied no longer is.',
    whyHuman:
      'Something changed in the estate. Whether it was intentional is not a question Adericel ' +
      'can answer.',
    response: 'INVESTIGATE',
    baseSeverity: 'HIGH',
    assuranceMaintained: true,
  },
  RECURRING_FAILURE: {
    kind: 'RECURRING_FAILURE',
    summary: 'The same control keeps failing after being remediated.',
    whyHuman:
      'Fixing it is not working. Something is putting it back, and continuing to remediate ' +
      'would be automating a loop instead of solving a problem.',
    response: 'INVESTIGATE',
    baseSeverity: 'HIGH',
    assuranceMaintained: true,
  },
  OFFBOARDING_BLOCKED: {
    kind: 'OFFBOARDING_BLOCKED',
    summary: 'A customer is mid-offboarding and a required step has not been done.',
    whyHuman:
      'Offboarding steps are deliberate acts. A customer left half-offboarded keeps its ' +
      'credentials and its place in the bill.',
    response: 'CONFIGURE',
    baseSeverity: 'HIGH',
    assuranceMaintained: false,
  },
};

/** One thing needing a person, with everything needed to deal with it. */
export interface PortfolioException {
  /**
   * Stable across rebuilds of the queue, so an operator can be sent a link and
   * a workflow can tell "still open" from "new".
   */
  readonly key: string;
  readonly kind: ExceptionKind;
  readonly severity: ExceptionSeverity;

  // Who
  readonly organisationId: string;
  readonly organisationName: string;

  // What
  /** The control affected, where the exception is about one. */
  readonly controlId: string | null;
  readonly controlKey: string | null;
  readonly controlTitle: string | null;
  /** The assurance state of that control right now. */
  readonly truthState: string | null;
  /** Adericel's own words for why it cannot conclude, where it cannot. */
  readonly unknownReason: string | null;

  // Why
  /** What actually happened, specific to this item, not the kind. */
  readonly cause: string;
  /** What the operator should do about it. */
  readonly recommendedAction: string;
  readonly response: ResponseType;

  // Posture
  /** Whether assurance on the affected controls is still being maintained. */
  readonly assuranceMaintained: boolean;
  /** Whether Adericel could fix this itself if policy permitted. */
  readonly automatable: boolean;
  /** Whether a human approval is what is being waited on. */
  readonly approvalRequired: boolean;

  // Progress
  readonly actionId: string | null;
  readonly actionState: string | null;
  readonly verificationOutcome: string | null;

  // Freshness
  /** When the condition first arose. Drives ageing, and is never guessed. */
  readonly since: string;
  readonly ageHours: number;
  /** Age of the newest evidence bearing on this, where there is any. */
  readonly evidenceAgeHours: number | null;

  /** Where to look. Ids, not prose, so a UI can link straight through. */
  readonly provenance: Readonly<Record<string, string | null>>;

  /** The computed queue position. Higher is sooner. */
  readonly rank: number;
}

const SEVERITY_WEIGHT: Readonly<Record<ExceptionSeverity, number>> = {
  CRITICAL: 1000,
  HIGH: 600,
  MEDIUM: 300,
  LOW: 100,
};

/**
 * Where an exception sits in the queue.
 *
 * Deterministic and explainable, because an operator who cannot predict the
 * order stops trusting it and reads the whole list anyway — at which point the
 * queue has failed at its only job.
 *
 * Three inputs, in order of weight:
 *
 *   1. Is assurance still being maintained? An exception that has stopped
 *      Adericel knowing anything true about a customer outranks one where the
 *      picture is intact and something merely needs deciding. This is the
 *      product's central value: a customer silently stopping being observed is
 *      the worst thing that can happen and the least visible.
 *   2. Severity of the kind.
 *   3. Age, capped. Age should float a forgotten item up the list; it should
 *      never let a fortnight-old cosmetic item outrank a broken connector, so
 *      the contribution is bounded well below one severity step.
 */
export function rankOf(input: {
  readonly severity: ExceptionSeverity;
  readonly assuranceMaintained: boolean;
  readonly ageHours: number;
}): number {
  const base = SEVERITY_WEIGHT[input.severity];
  const blind = input.assuranceMaintained ? 0 : 2000;
  // Capped at 14 days and worth at most 200 — less than one severity step, so
  // ageing reorders within a band and never across one.
  const age = Math.min(input.ageHours, 24 * 14) * (200 / (24 * 14));
  return Math.round(blind + base + age);
}

/** Severity, adjusted for how long it has been true. */
export function agedSeverity(
  base: ExceptionSeverity,
  ageHours: number,
  escalateAfterHours = 24 * 7,
): ExceptionSeverity {
  if (ageHours < escalateAfterHours) return base;
  // One step, once. An item that escalated itself to CRITICAL by sitting there
  // would let neglect manufacture urgency.
  if (base === 'LOW') return 'MEDIUM';
  if (base === 'MEDIUM') return 'HIGH';
  return base;
}

export interface QueueSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byResponse: Readonly<Record<string, number>>;
  /** Organisations where assurance has stopped being maintained. */
  readonly organisationsNotMaintained: number;
  /** Organisations appearing in the queue at all. */
  readonly organisationsAffected: number;
}

export function summariseQueue(exceptions: readonly PortfolioException[]): QueueSummary {
  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byResponse: Record<string, number> = {};
  const affected = new Set<string>();
  const blind = new Set<string>();

  for (const exception of exceptions) {
    byKind[exception.kind] = (byKind[exception.kind] ?? 0) + 1;
    bySeverity[exception.severity] = (bySeverity[exception.severity] ?? 0) + 1;
    byResponse[exception.response] = (byResponse[exception.response] ?? 0) + 1;
    affected.add(exception.organisationId);
    if (!exception.assuranceMaintained) blind.add(exception.organisationId);
  }

  return {
    total: exceptions.length,
    byKind,
    bySeverity,
    byResponse,
    organisationsNotMaintained: blind.size,
    organisationsAffected: affected.size,
  };
}
