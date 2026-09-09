/**
 * Assurance state presentation.
 *
 * The domain and the interface use different words on purpose: the domain needs
 * precision for rules and audit, the interface needs language an MSP engineer
 * can scan at speed. This module is the only place the mapping exists.
 *
 * Unknown deliberately has no colour. It is rendered as a diagonal hatch,
 * because any hue would place it somewhere on the good-to-bad axis and Unknown
 * is not on that axis — it means Adericel does not hold sufficient trustworthy
 * evidence to say, which is a distinct kind of fact and frequently the most
 * urgent one on the page.
 */

export type AssuranceState =
  | 'SATISFIED'
  | 'PARTIALLY_SATISFIED'
  | 'NOT_SATISFIED'
  | 'EXCEPTED'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN';

export interface StatePresentation {
  readonly label: string;
  readonly tone: 'proven' | 'failing' | 'exception' | 'unknown' | 'muted';
  /** One line explaining what the state actually asserts. */
  readonly meaning: string;
}

export const STATE_PRESENTATION: Record<AssuranceState, StatePresentation> = {
  SATISFIED: {
    label: 'Proven',
    tone: 'proven',
    meaning: 'Evidence Adericel holds supports this control being met.',
  },
  PARTIALLY_SATISFIED: {
    label: 'Partial',
    tone: 'exception',
    meaning: 'Some subjects satisfy this control and some do not.',
  },
  NOT_SATISFIED: {
    label: 'Failing',
    tone: 'failing',
    meaning: 'Evidence Adericel holds shows this control is not met.',
  },
  EXCEPTED: {
    label: 'Exception',
    tone: 'exception',
    meaning: 'An authorised, time-bounded deviation is in force.',
  },
  NOT_APPLICABLE: {
    label: 'Not applicable',
    tone: 'muted',
    meaning: 'Nothing this control governs exists in this organisation.',
  },
  UNKNOWN: {
    label: 'Unknown',
    tone: 'unknown',
    meaning:
      'Adericel does not hold sufficient trustworthy evidence to say. This is not the same as ' +
      'secure, insecure, compliant or non-compliant.',
  },
};

/** Worst first. Failures rank above unknowns; unknowns above anything positive. */
export const STATE_ORDER: Record<AssuranceState, number> = {
  NOT_SATISFIED: 0,
  UNKNOWN: 1,
  PARTIALLY_SATISFIED: 2,
  EXCEPTED: 3,
  SATISFIED: 4,
  NOT_APPLICABLE: 5,
};

export const UNKNOWN_REASON_TEXT: Record<string, string> = {
  NO_EVIDENCE: 'No evidence has been collected',
  INSUFFICIENT_EVIDENCE: 'Some required facts are missing',
  STALE_EVIDENCE: 'The evidence is beyond its freshness limit',
  CONTRADICTORY_EVIDENCE: 'Sources disagree',
  EVIDENCE_INTEGRITY_UNVERIFIED: 'Evidence integrity could not be verified',
  EVIDENCE_REVOKED: 'The supporting evidence was revoked',
  NO_APPLICABLE_RULE: 'No rule covers this control',
  RULE_INPUTS_MISSING: 'The rule inputs were not available',
  COLLECTION_FAILED: 'Collection from the source failed',
  NOT_YET_ASSESSED: 'This has never been assessed',
};

export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

export const SEVERITY_TONE: Record<Severity, StatePresentation['tone']> = {
  CRITICAL: 'failing',
  HIGH: 'failing',
  MEDIUM: 'exception',
  LOW: 'muted',
  INFO: 'muted',
};

/**
 * Format a proportion for display.
 *
 * Always paired with its denominator. A bare percentage invites the reader to
 * treat it as a score, which is precisely what the product must not offer.
 */
export function proportion(part: number, whole: number): string {
  if (whole === 0) return 'none in scope';
  return `${part} of ${whole}`;
}

/** Relative time, for ageing findings and evidence. */
export function since(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return 'never';
  const days = Math.floor((nowMs - Date.parse(iso)) / 86_400_000);
  if (days < 0) return 'in the future';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
