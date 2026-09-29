import type { SupportCaseState } from './case.js';
import { mayDiscloseAt } from './case.js';
import type { RequesterKind } from './routing.js';

/**
 * Who is asking, and what they are entitled to be told.
 *
 * Contract v3.1 §22. Support is a disclosure surface — every answer given in a
 * case says something about somebody's estate — so identity and entitlement are
 * established before disclosure, not before closure.
 *
 * The failure this prevents is specific and common: somebody calls, sounds
 * plausible, says they are from the customer, and is told which controls the
 * organisation is failing. That is a tenancy breach conducted entirely through
 * a helpdesk, and no amount of row-level security prevents it, because the
 * person disclosing is authorised.
 *
 * So the check is not "is this session authorised" — it is "has this requester
 * been identified, is the identification still good, and does their entitlement
 * cover the thing about to be said".
 */

/** How the requester was identified. */
export const IDENTIFICATION_METHODS = [
  /** They are signed in. The strongest, and the default for anyone with an account. */
  'AUTHENTICATED_SESSION',
  /** A link sent to an address already on the organisation's record. */
  'VERIFIED_EMAIL_CHALLENGE',
  /** The MSP vouched for them in writing, on this case. */
  'MSP_VOUCHED',
  /** Nothing has been established yet. */
  'NONE',
] as const;
export type IdentificationMethod = (typeof IDENTIFICATION_METHODS)[number];

/**
 * How long an identification stays good.
 *
 * Not forever. A case that runs for three weeks and discloses an estate in week
 * three on the strength of an email link clicked in week one is relying on
 * something that was true once.
 */
export const IDENTIFICATION_VALID_MINUTES: Readonly<Record<IdentificationMethod, number>> = {
  AUTHENTICATED_SESSION: 60,
  VERIFIED_EMAIL_CHALLENGE: 1440,
  MSP_VOUCHED: 10_080,
  NONE: 0,
};

/** What is about to be said. Ordered by how much it gives away. */
export const DISCLOSURE_KINDS = [
  /** That a case exists and where it is. Says nothing about any estate. */
  'CASE_STATUS',
  /** Which controls are in which state, and why. */
  'ASSURANCE_STATE',
  /** Nodes, integrations, configuration: what the estate is made of. */
  'ESTATE_DETAIL',
  /** Evidence and its provenance. */
  'EVIDENCE',
  /** A diagnostic bundle. Broad by construction — see `diagnostics.ts`. */
  'DIAGNOSTIC_BUNDLE',
  /** Anything identifying a person. */
  'PERSONAL_DATA',
  /** What the MSP is charged, what their book looks like. Never to a client. */
  'COMMERCIAL_POSITION',
] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number];

/**
 * What each requester kind may ever be told, before any case-specific check.
 *
 * `COMMERCIAL_POSITION` is absent from `END_CUSTOMER` on purpose and for the
 * same reason the MSP surface excludes it: a client must never learn what their
 * MSP pays or who else is in their book.
 */
export const DISCLOSURE_CEILING: Readonly<Record<RequesterKind, readonly DisclosureKind[]>> = {
  END_CUSTOMER: ['CASE_STATUS', 'ASSURANCE_STATE', 'ESTATE_DETAIL', 'EVIDENCE', 'PERSONAL_DATA'],
  MSP: [
    'CASE_STATUS',
    'ASSURANCE_STATE',
    'ESTATE_DETAIL',
    'EVIDENCE',
    'DIAGNOSTIC_BUNDLE',
    'PERSONAL_DATA',
    'COMMERCIAL_POSITION',
  ],
  VEYLITH: ['CASE_STATUS', 'DIAGNOSTIC_BUNDLE', 'COMMERCIAL_POSITION'],
  // Adericel raising a case about what it observed is not a party that gets
  // told things. It has no inbox.
  SYSTEM: [],
};

export interface DisclosureRequest {
  readonly kind: DisclosureKind;
  readonly caseState: SupportCaseState;
  readonly requesterKind: RequesterKind;
  readonly identifiedBy: IdentificationMethod;
  /** When the identification was established. */
  readonly identifiedAtIso: string | null;
  readonly atIso: string;
  /**
   * Whether the requester's organisation is the one the case concerns.
   *
   * Resolved from grants by the caller, never asserted by the requester. A
   * caller-supplied tenant id is never sufficient.
   */
  readonly concernsRequestersOwnOrganisation: boolean;
  /** Whether the MSP in question is proved to run the organisation. */
  readonly requesterMspRunsOrganisation: boolean;
  /** A live, recorded direct-support agreement. Loaded, never asserted. */
  readonly directSupportEntitled: boolean;
}

export type DisclosureDecision =
  | { readonly permitted: true; readonly kind: DisclosureKind }
  | { readonly permitted: false; readonly reason: string; readonly remedy: string };

/**
 * Whether this thing may be said to this person, now.
 *
 * Refuses in order of what a support agent can do about it, so the answer is
 * actionable: "verify them first" is a different problem from "they are never
 * entitled to this".
 */
export function mayDisclose(request: DisclosureRequest): DisclosureDecision {
  // 1. Has the case reached a state where anything may be said at all?
  if (!mayDiscloseAt(request.caseState)) {
    return {
      permitted: false,
      reason:
        `Nothing about any organisation is disclosed while a case is ${request.caseState}. ` +
        'That includes whether the organisation exists.',
      remedy: 'Establish identity and entitlement, then triage the case.',
    };
  }

  // 2. Is the requester identified at all?
  if (request.identifiedBy === 'NONE' || request.identifiedAtIso === null) {
    return {
      permitted: false,
      reason: 'This requester has not been identified.',
      remedy:
        'Send a verification challenge to an address already on the record, or ask the MSP ' +
        'to vouch for them on this case. Do not accept an address supplied in the request.',
    };
  }

  // 3. Is the identification still good?
  const validForMinutes = IDENTIFICATION_VALID_MINUTES[request.identifiedBy];
  const ageMinutes = (Date.parse(request.atIso) - Date.parse(request.identifiedAtIso)) / 60_000;
  if (ageMinutes > validForMinutes) {
    return {
      permitted: false,
      reason:
        `This requester was identified by ${request.identifiedBy} ${Math.floor(ageMinutes)} ` +
        `minutes ago, which is past the ${validForMinutes}-minute window for that method.`,
      remedy: 'Re-identify them before saying anything further.',
    };
  }

  // 4. Is this kind of thing ever said to this kind of requester?
  if (!DISCLOSURE_CEILING[request.requesterKind].includes(request.kind)) {
    return {
      permitted: false,
      reason: `${request.kind} is never disclosed to a ${request.requesterKind}.`,
      remedy:
        request.requesterKind === 'END_CUSTOMER' && request.kind === 'COMMERCIAL_POSITION'
          ? 'A client never learns their MSP’s commercial position. Refer them to their MSP.'
          : 'There is no path to this. Do not look for one.',
    };
  }

  // 5. Is it their estate?
  if (request.requesterKind === 'END_CUSTOMER' && !request.concernsRequestersOwnOrganisation) {
    return {
      permitted: false,
      reason: 'This case concerns an organisation other than the requester’s own.',
      remedy: 'Answer nothing. Treat a cross-tenant request as a security matter.',
    };
  }

  if (request.requesterKind === 'MSP' && !request.requesterMspRunsOrganisation) {
    return {
      permitted: false,
      reason: 'This MSP does not run the organisation this case concerns.',
      remedy: 'Answer nothing. Treat a cross-tenant request as a security matter.',
    };
  }

  /**
   * 6. Veylith reaching a customer's estate.
   *
   * A Veylith agent's ceiling already excludes assurance, estate, evidence and
   * personal data, so this is the belt to that braces: even a diagnostic bundle
   * requires a live direct-support agreement. Veylith holds no standing access
   * to a customer's estate (§29); what it can obtain is break-glass, which is
   * announced, time-limited and reviewed (ADR-0046).
   */
  if (
    request.requesterKind === 'VEYLITH' &&
    request.kind === 'DIAGNOSTIC_BUNDLE' &&
    !request.directSupportEntitled
  ) {
    return {
      permitted: false,
      reason:
        'Veylith holds no standing access to a customer’s estate, and no direct-support ' +
        'agreement covers this organisation.',
      remedy:
        'Ask the MSP to pull the bundle and share it, or open break-glass — which tells the ' +
        'MSP at the time, expires on its own, and is reviewed afterwards.',
    };
  }

  return { permitted: true, kind: request.kind };
}
