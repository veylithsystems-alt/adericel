import type { SupportCategory, SupportQueue, SupportSeverity } from './case.js';

/**
 * Where a case goes, and who is allowed to answer it.
 *
 * Contract v3.1 §20 and §26. This file is the §2 distribution boundary
 * expressed in support: Adericel is sold to MSPs, so an end customer's request
 * goes to their MSP. Veylith answering an MSP's customer directly is channel
 * conflict wearing a helpdesk.
 *
 * It is structural rather than a matter of policy. `routeCase` has no argument
 * through which a requester can ask to be handled by Veylith, and the only way
 * a case reaches a Veylith queue from an end customer is a stored
 * direct-support entitlement that a person signed — see `entitlement.ts`.
 */

/** Who opened the case. Established, never asserted by the requester. */
export const REQUESTER_KINDS = [
  /** A person at the client organisation whose estate this is. */
  'END_CUSTOMER',
  /** A person at the MSP that runs that organisation. */
  'MSP',
  /** Veylith's own staff, raising something they found. */
  'VEYLITH',
  /** Adericel itself: connector health, a failed action, an integrity check. */
  'SYSTEM',
] as const;
export type RequesterKind = (typeof REQUESTER_KINDS)[number];

export interface RoutingRequest {
  readonly requesterKind: RequesterKind;
  readonly category: SupportCategory;
  readonly severity: SupportSeverity;
  /**
   * Whether a signed agreement grants Veylith direct support responsibility for
   * this organisation.
   *
   * Loaded from the entitlement record, never taken from the request. Today no
   * such entitlement is granted to anyone (ADR-0048, decision D2): the gate is
   * built because §22 requires it regardless, and shipping it closed means the
   * MSP sees a system that structurally cannot talk to their customer behind
   * their back.
   */
  readonly directSupportEntitled: boolean;
}

export interface RoutingDecision {
  readonly queue: SupportQueue;
  /** Said on the case, so nobody has to reconstruct why it went where it went. */
  readonly because: string;
  /**
   * Whether this case may disclose anything about the tenant to the requester
   * once identity is established. An end customer sees their own estate; the
   * MSP sees the estates it runs; nobody sees another tenant's.
   */
  readonly disclosureScope: 'OWN_ORGANISATION' | 'MSP_PORTFOLIO' | 'PLATFORM' | 'NONE';
}

/**
 * Categories that go to a specialist regardless of who raised them (§26).
 *
 * Security, privacy and commercial are not ordinary support. Each has a
 * different obligation attached — a breach clock, a statutory deadline, a
 * contract — and each is the kind of thing a frontline queue resolves by
 * accident and badly.
 */
const SPECIALIST_QUEUES: Partial<Record<SupportCategory, SupportQueue>> = {
  SECURITY_CONCERN: 'VEYLITH_SECURITY',
  PRIVACY_REQUEST: 'VEYLITH_PRIVACY',
  COMMERCIAL_QUERY: 'VEYLITH_COMMERCIAL',
};

/** Where a Veylith-side case of each category belongs. */
const VEYLITH_QUEUES: Record<SupportCategory, SupportQueue> = {
  INTEGRATION_FAILURE: 'VEYLITH_INTEGRATIONS',
  CREDENTIAL_PROBLEM: 'VEYLITH_INTEGRATIONS',
  ASSURANCE_EXPLANATION: 'VEYLITH_ASSURANCE',
  ASSURANCE_DISPUTE: 'VEYLITH_ASSURANCE',
  EVIDENCE_QUERY: 'VEYLITH_ASSURANCE',
  ACTION_FAILURE: 'VEYLITH_ENGINEERING',
  ONBOARDING: 'VEYLITH_TRIAGE',
  EXPORT_REQUEST: 'VEYLITH_ASSURANCE',
  PRODUCT_DEFECT: 'VEYLITH_ENGINEERING',
  FEATURE_REQUEST: 'VEYLITH_TRIAGE',
  SERVICE_AVAILABILITY: 'VEYLITH_PLATFORM',
  SECURITY_CONCERN: 'VEYLITH_SECURITY',
  PRIVACY_REQUEST: 'VEYLITH_PRIVACY',
  COMMERCIAL_QUERY: 'VEYLITH_COMMERCIAL',
};

/** Where an MSP-side case of each category belongs. */
const MSP_QUEUE_FOR: Record<SupportCategory, SupportQueue> = {
  INTEGRATION_FAILURE: 'MSP_FRONTLINE',
  CREDENTIAL_PROBLEM: 'MSP_FRONTLINE',
  ASSURANCE_EXPLANATION: 'MSP_ASSURANCE',
  ASSURANCE_DISPUTE: 'MSP_ASSURANCE',
  EVIDENCE_QUERY: 'MSP_ASSURANCE',
  ACTION_FAILURE: 'MSP_ASSURANCE',
  ONBOARDING: 'MSP_FRONTLINE',
  EXPORT_REQUEST: 'MSP_ASSURANCE',
  PRODUCT_DEFECT: 'MSP_FRONTLINE',
  FEATURE_REQUEST: 'MSP_FRONTLINE',
  SERVICE_AVAILABILITY: 'MSP_FRONTLINE',
  SECURITY_CONCERN: 'MSP_FRONTLINE',
  PRIVACY_REQUEST: 'MSP_FRONTLINE',
  COMMERCIAL_QUERY: 'MSP_COMMERCIAL',
};

export function routeCase(request: RoutingRequest): RoutingDecision {
  /**
   * A security concern goes to security whoever raised it, and it is the one
   * exception to MSP-first routing.
   *
   * If Adericel itself is compromised, the MSP is not the right first
   * responder and may not be a disinterested one. This does not disclose the
   * tenant's data to Veylith — the case is a security report, and reaching the
   * estate still requires break-glass with its own record (ADR-0046).
   */
  if (request.category === 'SECURITY_CONCERN') {
    return {
      queue: SPECIALIST_QUEUES.SECURITY_CONCERN!,
      because:
        'A security concern reaches Veylith security directly, whoever raised it. If the ' +
        'platform is the thing that is compromised, routing through the MSP costs time and ' +
        'may route through an affected party. Reaching the estate still requires break-glass.',
      disclosureScope: request.requesterKind === 'END_CUSTOMER' ? 'OWN_ORGANISATION' : 'NONE',
    };
  }

  if (request.requesterKind === 'END_CUSTOMER') {
    if (!request.directSupportEntitled) {
      return {
        queue: MSP_QUEUE_FOR[request.category],
        because:
          'Adericel is delivered through your MSP, who holds the relationship and the context. ' +
          'Your request goes to them. Veylith does not answer an MSP customer directly without ' +
          'a signed agreement saying so.',
        disclosureScope: 'OWN_ORGANISATION',
      };
    }
    return {
      queue: VEYLITH_QUEUES[request.category],
      because:
        'A signed agreement grants Veylith direct support responsibility for this ' +
        'organisation. The MSP remains visible on the case.',
      disclosureScope: 'OWN_ORGANISATION',
    };
  }

  if (request.requesterKind === 'MSP') {
    // An MSP raising a case is escalating to its supplier, which is exactly
    // what the relationship is for.
    return {
      queue: VEYLITH_QUEUES[request.category],
      because: 'Raised by the MSP to Veylith, which is the supported escalation path.',
      disclosureScope: 'MSP_PORTFOLIO',
    };
  }

  if (request.requesterKind === 'SYSTEM') {
    /**
     * Proactive support (§24). Connector health, failed actions and integrity
     * failures raise their own cases.
     *
     * It goes to the MSP, not to Veylith. The MSP owns the customer
     * relationship and usually owns the credential that broke, so they are
     * both the right responder and the one who will be awake. Telling Veylith
     * first and the MSP later is how a supplier finds out about their own
     * customer's problem from their supplier.
     */
    return {
      queue: MSP_QUEUE_FOR[request.category],
      because:
        'Raised by Adericel from what it observed, and sent to the MSP who owns this ' +
        'customer — they hold the credential and the relationship.',
      disclosureScope: 'MSP_PORTFOLIO',
    };
  }

  return {
    queue: VEYLITH_QUEUES[request.category],
    because: 'Raised inside Veylith.',
    disclosureScope: 'PLATFORM',
  };
}

/**
 * Whether a queue may be assigned a case with this disclosure scope.
 *
 * Routing decides where a case starts; this decides where it may be moved to
 * afterwards, which is the path a boundary is usually crossed by. A case whose
 * requester is an end customer with no direct-support entitlement must not be
 * reassigned into a Veylith queue by someone tidying a backlog.
 */
export function mayAssign(
  queue: SupportQueue,
  request: Pick<RoutingRequest, 'requesterKind' | 'directSupportEntitled' | 'category'>,
): { readonly permitted: boolean; readonly reason: string } {
  const veylithQueue = !queue.startsWith('MSP_') && queue !== 'EXTERNAL_DEPENDENCY';
  if (
    veylithQueue &&
    request.requesterKind === 'END_CUSTOMER' &&
    !request.directSupportEntitled &&
    request.category !== 'SECURITY_CONCERN'
  ) {
    return {
      permitted: false,
      reason:
        `This case was raised by an end customer with no direct-support entitlement, so it ` +
        `cannot be assigned to ${queue}. Escalate it through the MSP, who can raise their own ` +
        'case to Veylith — that keeps the MSP in the conversation about their own customer.',
    };
  }
  return { permitted: true, reason: 'Assignment is within the distribution boundary.' };
}
