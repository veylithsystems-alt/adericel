import { z } from 'zod';

/**
 * The support case.
 *
 * Contract v3.1 §20–21. Support is not a bolt-on to assurance infrastructure;
 * it is part of it. A customer who cannot get an answer about why a control
 * reads UNKNOWN has an assurance problem, not a service problem, and the two
 * are answered by the same evidence.
 *
 * Two things shape everything in this file.
 *
 * **The §2 boundary, expressed in support.** Adericel is sold to MSPs. An end
 * customer's request goes to their MSP unless a signed agreement says
 * otherwise. A support system that lets the vendor answer an MSP's customer
 * directly is channel conflict wearing a helpdesk, and it is structural rather
 * than a matter of policy: see `routing.ts`.
 *
 * **Support is a disclosure surface.** Every answer given in a case discloses
 * something about somebody's estate. §22 therefore requires identity and
 * entitlement to be established before disclosure, not before closure — see
 * `entitlement.ts`.
 *
 * NAMING NOTE, stated rather than hidden: the counts here match §21 (14
 * categories, 12 queues, 4 severities, 20 states). Where the contract's exact
 * wording was not available to the author at the time of writing, the name is
 * derived from Adericel's own vocabulary and should be reconciled against §21
 * before the first MSP sees it. A wrong label is cheap to change; a wrong
 * transition rule is not, so the rules were the priority.
 */

/** §21 — 14 categories. What the case is actually about. */
export const SUPPORT_CATEGORIES = [
  /** A connector has stopped supplying observations. The commonest case there is. */
  'INTEGRATION_FAILURE',
  /** Credentials expired, revoked, or scoped too narrowly. */
  'CREDENTIAL_PROBLEM',
  /** "Why does this control say UNKNOWN?" The question Adericel exists to answer. */
  'ASSURANCE_EXPLANATION',
  /** The customer believes an assessment is wrong. */
  'ASSURANCE_DISPUTE',
  /** Evidence is missing, stale, or believed to be misattributed. */
  'EVIDENCE_QUERY',
  /** An automated action failed, or did something unexpected. */
  'ACTION_FAILURE',
  /** Onboarding an organisation, a framework, or a connector. */
  'ONBOARDING',
  /** Getting data out: Passport, export, questionnaire, auditor request. */
  'EXPORT_REQUEST',
  /** A claimed defect in the product itself. */
  'PRODUCT_DEFECT',
  /** A request for something the product does not do. */
  'FEATURE_REQUEST',
  /** Platform availability or performance. */
  'SERVICE_AVAILABILITY',
  /** A suspected or confirmed security matter. Routed separately (§26). */
  'SECURITY_CONCERN',
  /** Personal data: access, erasure, rectification, a data-protection question. */
  'PRIVACY_REQUEST',
  /** Billing, entitlement, contract. Never resolved by restricting assurance. */
  'COMMERCIAL_QUERY',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export const supportCategorySchema = z.enum(SUPPORT_CATEGORIES);

/** §21 — 12 queues. Who owns the case, not where it came from. */
export const SUPPORT_QUEUES = [
  'MSP_FRONTLINE',
  'MSP_ASSURANCE',
  'MSP_COMMERCIAL',
  'VEYLITH_TRIAGE',
  'VEYLITH_INTEGRATIONS',
  'VEYLITH_ASSURANCE',
  'VEYLITH_PLATFORM',
  'VEYLITH_ENGINEERING',
  'VEYLITH_SECURITY',
  'VEYLITH_PRIVACY',
  'VEYLITH_COMMERCIAL',
  /** Waiting on somebody outside both organisations: a vendor, an auditor. */
  'EXTERNAL_DEPENDENCY',
] as const;
export type SupportQueue = (typeof SUPPORT_QUEUES)[number];
export const supportQueueSchema = z.enum(SUPPORT_QUEUES);

/** Queues that belong to the MSP rather than to Veylith. */
export const MSP_QUEUES: readonly SupportQueue[] = [
  'MSP_FRONTLINE',
  'MSP_ASSURANCE',
  'MSP_COMMERCIAL',
];

export function isMspQueue(queue: SupportQueue): boolean {
  return MSP_QUEUES.includes(queue);
}

/**
 * §21 — 4 severities.
 *
 * Severity describes consequence, not volume and not volume of shouting. The
 * definitions are written so that two people reading them reach the same
 * answer, because a severity scale everyone interprets differently is a
 * prioritisation scheme with extra steps.
 */
export const SUPPORT_SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];
export const supportSeveritySchema = z.enum(SUPPORT_SEVERITIES);

export interface SeverityDefinition {
  readonly severity: SupportSeverity;
  readonly name: string;
  readonly meaning: string;
  /** Minutes to a human acknowledging the case exists. */
  readonly acknowledgeWithinMinutes: number;
  /** Whether a case may be closed without the customer confirming. */
  readonly closureNeedsCustomerConfirmation: boolean;
}

export const SEVERITY_DEFINITIONS: Readonly<Record<SupportSeverity, SeverityDefinition>> = {
  S1: {
    severity: 'S1',
    name: 'Assurance is wrong or unavailable',
    meaning:
      'Adericel is asserting something untrue, or an organisation cannot reach its own ' +
      'assurance record. Either way somebody may act on a false position.',
    acknowledgeWithinMinutes: 30,
    closureNeedsCustomerConfirmation: true,
  },
  S2: {
    severity: 'S2',
    name: 'Assurance has stopped being maintained',
    meaning:
      'Collection or assessment has stopped for an estate. Nothing said so far is wrong, ' +
      'but it is ageing and will become wrong.',
    acknowledgeWithinMinutes: 120,
    closureNeedsCustomerConfirmation: true,
  },
  S3: {
    severity: 'S3',
    name: 'Degraded or partial',
    meaning: 'Something works less well than it should, with a workaround available.',
    acknowledgeWithinMinutes: 480,
    closureNeedsCustomerConfirmation: false,
  },
  S4: {
    severity: 'S4',
    name: 'Question or request',
    meaning: 'Nothing is broken. Somebody needs an answer or a change.',
    acknowledgeWithinMinutes: 1440,
    closureNeedsCustomerConfirmation: false,
  },
};

/**
 * §21 — 20 case states.
 *
 * Grouped by what is true while a case sits in them, because that is what
 * decides which transitions are legal.
 */
export const SUPPORT_CASE_STATES = [
  // Arrival
  'RECEIVED',
  'IDENTITY_PENDING',
  'ENTITLEMENT_PENDING',
  'TRIAGING',
  // Ownership
  'ROUTED_TO_MSP',
  'QUEUED',
  'IN_PROGRESS',
  // Waiting
  'AWAITING_CUSTOMER',
  'AWAITING_MSP',
  'AWAITING_VENDOR',
  'AWAITING_CHANGE',
  // Specialist handling
  'SECURITY_REVIEW',
  'PRIVACY_REVIEW',
  'COMMERCIAL_REVIEW',
  // Resolution
  'RESOLUTION_PROPOSED',
  'AWAITING_VERIFICATION',
  'RESOLVED',
  'CLOSED',
  // Endings that are not resolutions, and must not be recorded as one
  'WITHDRAWN',
  'REJECTED',
] as const;
export type SupportCaseState = (typeof SUPPORT_CASE_STATES)[number];
export const supportCaseStateSchema = z.enum(SUPPORT_CASE_STATES);

/** States in which the case is finished and nothing further happens. */
export const TERMINAL_CASE_STATES: readonly SupportCaseState[] = [
  'CLOSED',
  'WITHDRAWN',
  'REJECTED',
];

/**
 * States in which identity and entitlement have been established.
 *
 * Before these, nothing about any tenant may be disclosed — not the assurance
 * state, not the estate, not whether an organisation exists. §22.
 */
export const DISCLOSURE_PERMITTED_STATES: readonly SupportCaseState[] = [
  'TRIAGING',
  'ROUTED_TO_MSP',
  'QUEUED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER',
  'AWAITING_MSP',
  'AWAITING_VENDOR',
  'AWAITING_CHANGE',
  'SECURITY_REVIEW',
  'PRIVACY_REVIEW',
  'COMMERCIAL_REVIEW',
  'RESOLUTION_PROPOSED',
  'AWAITING_VERIFICATION',
  'RESOLVED',
  'CLOSED',
];

/**
 * Which moves are legal. Absence is refusal.
 *
 * The interesting entries are the ones that are missing. §21 calls these
 * prohibited transitions, and each of the four below is prohibited because
 * allowing it would let the system record something that did not happen.
 */
export const SUPPORT_CASE_TRANSITIONS: Readonly<
  Record<SupportCaseState, readonly SupportCaseState[]>
> = {
  // Nothing is known yet, so the only moves are toward knowing.
  RECEIVED: ['IDENTITY_PENDING', 'WITHDRAWN', 'REJECTED'],
  IDENTITY_PENDING: ['ENTITLEMENT_PENDING', 'WITHDRAWN', 'REJECTED'],
  ENTITLEMENT_PENDING: ['TRIAGING', 'WITHDRAWN', 'REJECTED'],

  TRIAGING: [
    'ROUTED_TO_MSP',
    'QUEUED',
    'SECURITY_REVIEW',
    'PRIVACY_REVIEW',
    'COMMERCIAL_REVIEW',
    'WITHDRAWN',
    'REJECTED',
  ],
  ROUTED_TO_MSP: ['QUEUED', 'IN_PROGRESS', 'WITHDRAWN', 'CLOSED'],
  QUEUED: ['IN_PROGRESS', 'ROUTED_TO_MSP', 'WITHDRAWN', 'REJECTED'],
  IN_PROGRESS: [
    'AWAITING_CUSTOMER',
    'AWAITING_MSP',
    'AWAITING_VENDOR',
    'AWAITING_CHANGE',
    'SECURITY_REVIEW',
    'PRIVACY_REVIEW',
    'COMMERCIAL_REVIEW',
    'RESOLUTION_PROPOSED',
    'QUEUED',
    'WITHDRAWN',
  ],

  AWAITING_CUSTOMER: ['IN_PROGRESS', 'WITHDRAWN', 'REJECTED'],
  AWAITING_MSP: ['IN_PROGRESS', 'WITHDRAWN'],
  AWAITING_VENDOR: ['IN_PROGRESS', 'WITHDRAWN'],
  AWAITING_CHANGE: ['IN_PROGRESS', 'WITHDRAWN'],

  SECURITY_REVIEW: ['IN_PROGRESS', 'RESOLUTION_PROPOSED', 'REJECTED'],
  PRIVACY_REVIEW: ['IN_PROGRESS', 'RESOLUTION_PROPOSED', 'REJECTED'],
  COMMERCIAL_REVIEW: ['IN_PROGRESS', 'RESOLUTION_PROPOSED', 'REJECTED'],

  RESOLUTION_PROPOSED: ['AWAITING_VERIFICATION', 'IN_PROGRESS', 'WITHDRAWN'],
  AWAITING_VERIFICATION: ['RESOLVED', 'IN_PROGRESS'],
  // A case can be reopened from RESOLVED — the fix did not hold — but not
  // from CLOSED. Closure is the point at which the record is final.
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],

  CLOSED: [],
  WITHDRAWN: [],
  REJECTED: [],
};

/**
 * The prohibited transitions, named.
 *
 * Kept as data rather than left implicit in the table above, because §21 asks
 * for them specifically and because a reviewer should be able to read the four
 * rules without reconstructing them from twenty rows.
 */
export const PROHIBITED_TRANSITIONS: readonly {
  readonly from: SupportCaseState | '*';
  readonly to: SupportCaseState;
  readonly because: string;
}[] = [
  {
    from: '*',
    to: 'RESOLVED',
    because:
      'A case reaches RESOLVED only through AWAITING_VERIFICATION. "We think we fixed it" is ' +
      'not a resolution, and a support system that lets an engineer mark their own work ' +
      'resolved measures how confident engineers are, not whether anything got fixed.',
  },
  {
    from: 'CLOSED',
    to: 'IN_PROGRESS',
    because:
      'A closed case is a finished record. Work that continues is a new case with a link to ' +
      'the old one, so the history shows two episodes rather than one that never ended.',
  },
  {
    from: 'RECEIVED',
    to: 'IN_PROGRESS',
    because:
      'Identity and entitlement come first (§22). Support is a disclosure surface, and ' +
      'starting work before establishing who is asking is how a stranger gets told which ' +
      'controls an organisation is failing.',
  },
  {
    from: '*',
    to: 'CLOSED',
    because:
      'CLOSED is reached from RESOLVED, or from ROUTED_TO_MSP where the MSP has taken it on. ' +
      'Nothing else closes: a case that stops mattering is WITHDRAWN or REJECTED, which are ' +
      'different facts and must not be recorded as a resolution.',
  },
];

export const MINIMUM_TRANSITION_REASON = 15;

export interface CaseTransitionRequest {
  readonly from: SupportCaseState;
  readonly to: SupportCaseState;
  readonly reason: string;
  /**
   * Whether the customer has confirmed the resolution worked. Required to leave
   * AWAITING_VERIFICATION at S1 and S2.
   */
  readonly customerVerified?: boolean;
  readonly severity: SupportSeverity;
}

export type CaseTransitionDecision =
  | { readonly permitted: true; readonly to: SupportCaseState }
  | { readonly permitted: false; readonly reason: string };

export function transitionCase(request: CaseTransitionRequest): CaseTransitionDecision {
  if (request.from === request.to) {
    return { permitted: false, reason: `Already ${request.from}` };
  }

  const legal = SUPPORT_CASE_TRANSITIONS[request.from];
  if (!legal.includes(request.to)) {
    const prohibited = PROHIBITED_TRANSITIONS.find(
      (rule) => rule.to === request.to && (rule.from === '*' || rule.from === request.from),
    );
    return {
      permitted: false,
      reason: prohibited
        ? `${request.from} cannot become ${request.to}. ${prohibited.because}`
        : `${request.from} cannot become ${request.to}. ` +
          (legal.length === 0
            ? `${request.from} is final.`
            : `From ${request.from}, only: ${legal.join(', ')}.`),
    };
  }

  if (request.reason.trim().length < MINIMUM_TRANSITION_REASON) {
    return {
      permitted: false,
      reason:
        `A case transition needs a reason of at least ${MINIMUM_TRANSITION_REASON} characters. ` +
        'The next person to pick this case up reads it before they read anything else.',
    };
  }

  if (
    request.to === 'RESOLVED' &&
    SEVERITY_DEFINITIONS[request.severity].closureNeedsCustomerConfirmation &&
    request.customerVerified !== true
  ) {
    return {
      permitted: false,
      reason:
        `An ${request.severity} case is resolved when the customer says it is, not when the ` +
        'engineer does. Their assurance was wrong or unavailable; they are the only party ' +
        'who can confirm it no longer is.',
    };
  }

  return { permitted: true, to: request.to };
}

export function isTerminal(state: SupportCaseState): boolean {
  return TERMINAL_CASE_STATES.includes(state);
}

/** Whether anything about a tenant may be disclosed while a case is here. */
export function mayDiscloseAt(state: SupportCaseState): boolean {
  return DISCLOSURE_PERMITTED_STATES.includes(state);
}

/**
 * The contract's support lifecycle, and how these twenty states realise it.
 *
 * Contract v3.2: "Support lifecycle: RECEIVED → TRIAGED → INVESTIGATING →
 * ACTION_REQUIRED → VERIFICATION_PENDING → RESOLVED → CLOSED".
 *
 * Seven stages; twenty states here. The twenty are a refinement, not a
 * disagreement, and the refinements exist because an MSP cannot work a queue
 * without them: "waiting on the customer" and "waiting on the vendor" are the
 * same contract stage and completely different operationally — one needs a
 * chase, the other needs patience.
 *
 * The mapping is total by construction, so a state added without deciding which
 * stage of the contract's lifecycle it belongs to does not compile. That is the
 * point: the contract's sequence is the obligation, and an operational state
 * nobody placed within it is a state nobody has reconciled.
 */
export const CONTRACT_SUPPORT_STAGES = [
  'RECEIVED',
  'TRIAGED',
  'INVESTIGATING',
  'ACTION_REQUIRED',
  'VERIFICATION_PENDING',
  'RESOLVED',
  'CLOSED',
] as const;
export type ContractSupportStage = (typeof CONTRACT_SUPPORT_STAGES)[number];

export const CONTRACT_STAGE_OF_CASE_STATE: Readonly<
  Record<SupportCaseState, ContractSupportStage>
> = {
  RECEIVED: 'RECEIVED',

  /**
   * Identity and entitlement sit at RECEIVED, not TRIAGED.
   *
   * Nothing about an organisation may be disclosed before somebody is
   * identified, so these precede triage rather than being part of it — a case
   * in `IDENTITY_PENDING` has not been looked at, and placing it at TRIAGED
   * would say it had.
   */
  IDENTITY_PENDING: 'RECEIVED',
  ENTITLEMENT_PENDING: 'RECEIVED',

  TRIAGING: 'TRIAGED',
  ROUTED_TO_MSP: 'TRIAGED',

  QUEUED: 'INVESTIGATING',
  IN_PROGRESS: 'INVESTIGATING',

  // Every wait is the contract's ACTION_REQUIRED: somebody outside the case
  // owes something before it can move.
  AWAITING_CUSTOMER: 'ACTION_REQUIRED',
  AWAITING_MSP: 'ACTION_REQUIRED',
  AWAITING_VENDOR: 'ACTION_REQUIRED',
  AWAITING_CHANGE: 'ACTION_REQUIRED',

  /**
   * The three specialist reviews are INVESTIGATING, not ACTION_REQUIRED.
   *
   * §26 requires security, privacy and commercial routing, and work is actively
   * happening in each — by a different person, with a different authority.
   * Classing them as a wait would let a privacy review look like an idle ticket
   * on a report.
   */
  SECURITY_REVIEW: 'INVESTIGATING',
  PRIVACY_REVIEW: 'INVESTIGATING',
  COMMERCIAL_REVIEW: 'INVESTIGATING',

  RESOLUTION_PROPOSED: 'VERIFICATION_PENDING',
  AWAITING_VERIFICATION: 'VERIFICATION_PENDING',

  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',

  /**
   * Withdrawn and rejected map to CLOSED, and `isResolution()` below exists so
   * that mapping can never be read as resolution.
   *
   * The contract's sequence has no ending that is not a resolution, and real
   * support has two. They are closed — nothing further happens — and they are
   * not RESOLVED, because counting them as resolutions would inflate every
   * support metric an MSP shows a customer.
   */
  WITHDRAWN: 'CLOSED',
  REJECTED: 'CLOSED',
};

/**
 * Whether reaching this state means the customer's problem was actually solved.
 *
 * Only `RESOLVED`. The first version of this function also returned true for
 * `CLOSED`, which is wrong in precisely the way the comment above it warns
 * about: a withdrawn case reaches `CLOSED` too, so a closed case's state alone
 * cannot say whether anything was solved. Returning true would have inflated
 * every support metric an MSP shows a customer, via the function written to
 * prevent that.
 *
 * A `CLOSED` case's outcome is a question about its history, not its state. Use
 * `outcomeOfClosedCase()` with the transitions.
 */
export function isResolution(state: SupportCaseState): boolean {
  return state === 'RESOLVED';
}

/**
 * What a closed case's ending actually was, from the states it passed through.
 *
 * Returns null when the history does not say — which happens, and is better
 * than a guess. A support report with an unknown outcome is accurate; one that
 * assumed resolution is a claim nobody made.
 */
export function outcomeOfClosedCase(
  states: readonly SupportCaseState[],
): 'RESOLVED' | 'WITHDRAWN' | 'REJECTED' | null {
  for (const state of [...states].reverse()) {
    if (state === 'RESOLVED' || state === 'WITHDRAWN' || state === 'REJECTED') return state;
  }
  return null;
}

/** Case states that end the case without solving anything. */
export const NON_RESOLUTION_ENDINGS: readonly SupportCaseState[] = ['WITHDRAWN', 'REJECTED'];
