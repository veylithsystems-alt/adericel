import { z } from 'zod';

/**
 * The commercial position, as a thing in its own right.
 *
 * Contract v3.1 §16. Ten states, and one sentence that matters more than all of
 * them: **a commercial state is not a security state.**
 *
 * The two are constantly confused because they produce similar-looking
 * outcomes — something stops working — and the confusion is expensive in both
 * directions:
 *
 *   - Treating an unpaid invoice as a security event contains an estate that
 *     is not compromised. The customer loses observation, their assurance goes
 *     UNKNOWN, and Adericel has manufactured a security incident out of an
 *     accounts-receivable problem.
 *
 *   - Treating a compromised credential as a commercial event bills a customer
 *     through an incident and, far worse, leaves collection running against an
 *     integration nobody trusts.
 *
 * So they are separate types with no function between them. There is
 * deliberately no `containmentForCommercialState` and no
 * `commercialStateForContainment`, and `tests/security/commercial-separation`
 * asserts that no such mapping exists. See ADR-0047.
 *
 * The second sentence that matters: **no commercial state withholds an
 * organisation's own assurance record.** Exactly the invariant containment
 * carries (ADR-0045). A customer who stops paying stops receiving new
 * assurance; they never stop being able to read and export what they already
 * proved. Holding a customer's compliance record hostage over an invoice is
 * not a commercial lever, it is a reason to be sued and deserves to be.
 */
export const COMMERCIAL_STATES = [
  /** Agreed on paper, nothing provisioned. No service, no charge. */
  'DRAFT',
  /** Evaluating, at no charge, for a bounded period. */
  'TRIAL',
  /** Paying and current. */
  'ACTIVE',
  /** A payment is late. Nothing has been restricted — this is a fact, not a lever. */
  'PAST_DUE',
  /** Arrears being paid down under an agreement. Full service continues. */
  'PAYMENT_PLAN',
  /** New chargeable commitments are refused. Everything already running continues. */
  'COMMERCIAL_RESTRICTION',
  /** Service suspended: no new observation, no new assessment. The record stays readable. */
  'COMMERCIAL_SUSPENSION',
  /** The relationship has ended. The retention window is running. */
  'TERMINATED',
  /** Retention elapsed. The record is closed and nothing further happens to it. */
  'ARCHIVED',
  /**
   * The commercial position cannot currently be established.
   *
   * The billing provider is unreachable, or says two things at once. This is
   * not a synonym for unpaid and must never be resolved to one by default: an
   * outage at a payment processor is not evidence that a customer has stopped
   * paying. It restricts new chargeable commitments and changes nothing else.
   */
  'UNKNOWN',
] as const;
export type CommercialState = (typeof COMMERCIAL_STATES)[number];
export const commercialStateSchema = z.enum(COMMERCIAL_STATES);

/**
 * What a commercial state permits.
 *
 * `readOwnRecord` and `exportOwnRecord` are `true` in every row. That is the
 * invariant, written out ten times rather than assumed, so that removing it
 * from one row is a visible edit rather than a missing case.
 */
export interface CommercialCapability {
  /** Read the organisation's own assurance record. True at every state. */
  readonly readOwnRecord: true;
  /** Export it, in full, including the Passport. True at every state. */
  readonly exportOwnRecord: true;
  /** Keep collecting observations from integrations. */
  readonly collectObservations: boolean;
  /** Keep re-deciding assurance from what is collected. */
  readonly runAssessments: boolean;
  /** Take on a new organisation, or anything else that adds cost. */
  readonly newCommitments: boolean;
  /** Whether this state produces an invoice. */
  readonly chargeable: boolean;
  /** Said to the operator, in the words the customer would be told. */
  readonly summary: string;
}

export const COMMERCIAL_CAPABILITY: Readonly<Record<CommercialState, CommercialCapability>> = {
  DRAFT: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: false,
    runAssessments: false,
    newCommitments: false,
    chargeable: false,
    summary: 'Agreed but not started. Nothing is provisioned and nothing is charged.',
  },
  TRIAL: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: true,
    runAssessments: true,
    newCommitments: true,
    chargeable: false,
    summary: 'Evaluating at no charge. Full service for a bounded period.',
  },
  ACTIVE: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: true,
    runAssessments: true,
    newCommitments: true,
    chargeable: true,
    summary: 'Current. Everything runs.',
  },
  PAST_DUE: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: true,
    runAssessments: true,
    newCommitments: true,
    chargeable: true,
    // Deliberately identical to ACTIVE. A late invoice is a fact about an
    // account, and turning it into a service change on day one is how a
    // finance problem becomes an assurance problem.
    summary: 'A payment is late. Nothing has been restricted.',
  },
  PAYMENT_PLAN: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: true,
    runAssessments: true,
    newCommitments: false,
    chargeable: true,
    summary:
      'Arrears are being paid down under an agreement. Service continues in full; new ' +
      'chargeable commitments wait until the plan completes.',
  },
  COMMERCIAL_RESTRICTION: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: true,
    runAssessments: true,
    newCommitments: false,
    chargeable: true,
    summary:
      'No new chargeable commitments. Every organisation already running continues to be ' +
      'observed and assessed — restriction limits growth, not assurance.',
  },
  COMMERCIAL_SUSPENSION: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: false,
    runAssessments: false,
    newCommitments: false,
    chargeable: false,
    summary:
      'Service is suspended: no new observation and no new assessment. The assurance record ' +
      'already held stays readable and exportable in full, and says plainly that it is no ' +
      'longer being maintained.',
  },
  TERMINATED: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: false,
    runAssessments: false,
    newCommitments: false,
    chargeable: false,
    summary:
      'The relationship has ended and the retention window is running. The record can still ' +
      'be read and exported throughout it.',
  },
  ARCHIVED: {
    readOwnRecord: true,
    exportOwnRecord: true,
    collectObservations: false,
    runAssessments: false,
    newCommitments: false,
    chargeable: false,
    summary: 'Retention has elapsed. The record is closed and nothing further happens to it.',
  },
  UNKNOWN: {
    readOwnRecord: true,
    exportOwnRecord: true,
    // Everything already running keeps running. An outage at a payment
    // processor is not evidence that a customer has stopped paying, and
    // stopping collection on that basis would turn a billing incident into an
    // assurance incident for every customer at once.
    collectObservations: true,
    runAssessments: true,
    newCommitments: false,
    chargeable: false,
    summary:
      'The commercial position cannot currently be established. Existing service continues ' +
      'unchanged; new chargeable commitments wait until it can. This is not a synonym for ' +
      'unpaid and is never resolved to one by default.',
  },
};

/**
 * Which moves are legal.
 *
 * Absence is refusal. The interesting entries are the ones that are missing:
 * nothing reaches `DRAFT` again, nothing leaves `ARCHIVED`, and no state jumps
 * straight from `PAST_DUE` to `COMMERCIAL_SUSPENSION` — a customer whose
 * invoice is late is restricted before they are suspended, because suspension
 * is the step that stops their assurance being maintained and it is not taken
 * by accident.
 */
export const COMMERCIAL_TRANSITIONS: Readonly<Record<CommercialState, readonly CommercialState[]>> =
  {
    DRAFT: ['TRIAL', 'ACTIVE', 'TERMINATED'],
    TRIAL: ['ACTIVE', 'COMMERCIAL_SUSPENSION', 'TERMINATED', 'UNKNOWN'],
    ACTIVE: ['PAST_DUE', 'COMMERCIAL_RESTRICTION', 'TERMINATED', 'UNKNOWN'],
    PAST_DUE: ['ACTIVE', 'PAYMENT_PLAN', 'COMMERCIAL_RESTRICTION', 'TERMINATED', 'UNKNOWN'],
    PAYMENT_PLAN: ['ACTIVE', 'COMMERCIAL_RESTRICTION', 'TERMINATED', 'UNKNOWN'],
    COMMERCIAL_RESTRICTION: [
      'ACTIVE',
      'PAYMENT_PLAN',
      'COMMERCIAL_SUSPENSION',
      'TERMINATED',
      'UNKNOWN',
    ],
    COMMERCIAL_SUSPENSION: ['ACTIVE', 'PAYMENT_PLAN', 'TERMINATED', 'UNKNOWN'],
    TERMINATED: ['ARCHIVED'],
    ARCHIVED: [],
    // UNKNOWN resolves to whatever the provider eventually says, including
    // back to where it came from. It is never a terminus.
    UNKNOWN: [
      'TRIAL',
      'ACTIVE',
      'PAST_DUE',
      'PAYMENT_PLAN',
      'COMMERCIAL_RESTRICTION',
      'COMMERCIAL_SUSPENSION',
      'TERMINATED',
    ],
  };

export const MINIMUM_COMMERCIAL_REASON = 20;

export interface CommercialTransitionRequest {
  readonly from: CommercialState;
  readonly to: CommercialState;
  /** Why. Recorded, and read back by whoever asks what happened to the account. */
  readonly reason: string;
  /**
   * Whether the customer has been told. Required before anything that stops
   * their assurance being maintained: they plan around this, and finding out
   * from a dashboard is not being told.
   */
  readonly customerNotified: boolean;
}

export type CommercialTransitionDecision =
  | { readonly permitted: true; readonly to: CommercialState; readonly customerImpact: string }
  | { readonly permitted: false; readonly reason: string };

/** States after which assurance is no longer being maintained. */
export const SERVICE_STOPPING_STATES: readonly CommercialState[] = [
  'COMMERCIAL_SUSPENSION',
  'TERMINATED',
  'ARCHIVED',
];

export function stopsService(state: CommercialState): boolean {
  return !COMMERCIAL_CAPABILITY[state].collectObservations;
}

export function transitionCommercial(
  request: CommercialTransitionRequest,
): CommercialTransitionDecision {
  if (request.from === request.to) {
    return { permitted: false, reason: `Already ${request.from}` };
  }

  const legal = COMMERCIAL_TRANSITIONS[request.from];
  if (!legal.includes(request.to)) {
    return {
      permitted: false,
      reason:
        `${request.from} cannot become ${request.to}. ` +
        (legal.length === 0
          ? `${request.from} is final.`
          : `From ${request.from}, only: ${legal.join(', ')}.`),
    };
  }

  if (request.reason.trim().length < MINIMUM_COMMERCIAL_REASON) {
    return {
      permitted: false,
      reason:
        `A commercial state change needs a reason of at least ${MINIMUM_COMMERCIAL_REASON} ` +
        'characters. Somebody will read this while a customer is on the phone.',
    };
  }

  if (SERVICE_STOPPING_STATES.includes(request.to) && !request.customerNotified) {
    return {
      permitted: false,
      reason:
        `Moving to ${request.to} stops assurance being maintained. The customer must be told ` +
        'before it happens, not after — they plan around this.',
    };
  }

  return {
    permitted: true,
    to: request.to,
    customerImpact: COMMERCIAL_CAPABILITY[request.to].summary,
  };
}

/**
 * What a commercial state does to assurance. Nothing, is the answer.
 *
 * Contract v3.1 §16: billing is never assurance truth. A suspended customer's
 * last assessment said what it said, and it goes on saying it. What changes is
 * that nothing new is decided — which the record states as a fact about
 * freshness, not as a change of outcome.
 *
 * This function exists to be the only answer to "what does the commercial state
 * do to the assurance state", so that the answer is in one place and is
 * testable. It returns no assurance state because it must not have one.
 */
export function assuranceImpactOf(state: CommercialState): {
  readonly changesAnyOutcome: false;
  readonly stopsBeingMaintained: boolean;
  readonly note: string;
} {
  const stops = stopsService(state);
  return {
    changesAnyOutcome: false,
    stopsBeingMaintained: stops,
    note: stops
      ? 'Assurance already decided is unchanged and remains readable. Nothing new is being ' +
        'decided, so the record states when it was last maintained.'
      : 'Assurance is unaffected and continues to be maintained.',
  };
}
