import { z } from 'zod';
import type { Severity } from '@adericel/domain';

/**
 * How much this particular not-knowing matters.
 *
 * An MSP with two hundred unknowns needs an order to work them in, and the
 * order cannot come from severity alone: a CRITICAL control that nobody is
 * being asked about this quarter matters less, today, than a MEDIUM one
 * blocking a certification the customer is paying for next week.
 *
 * WHY THIS IS NOT A SCORE
 *
 * Adericel provides no single assurance score (ADR-0017) and this is not one
 * by the back door. Materiality does not mix coverage with satisfaction and
 * says nothing about how secure an organisation is. It answers one operational
 * question — which of these should a human look at first — and every band
 * carries the reasons that put it there, so an operator can disagree with the
 * reasoning rather than with a number.
 */
export const MATERIALITY = ['BLOCKING', 'HIGH', 'MODERATE', 'LOW', 'IMMATERIAL'] as const;
export type Materiality = (typeof MATERIALITY)[number];
export const materialitySchema = z.enum(MATERIALITY);

export interface MaterialityInput {
  /** Severity of the control this unknown sits on. */
  readonly severity: Severity;
  /**
   * How many controls this one unknown darkens.
   *
   * The multiplier that matters most in practice. One expired credential can
   * be the sole reason nine controls read UNKNOWN, and fixing it is nine
   * controls of progress for one piece of work — which no per-control view
   * ever shows.
   */
  readonly controlsAffected: number;
  /**
   * Whether an obligation with a date depends on it: a certification
   * assessment, an insurer's renewal, a customer questionnaire due.
   */
  readonly blocksCommitment: boolean;
  /** Days until that commitment, where there is one. */
  readonly daysUntilCommitment: number | null;
  /** Whether a person has already been asked and has not answered. */
  readonly awaitingPerson: boolean;
  /** Whether anything inside Adericel can close it (see `kind.ts`). */
  readonly actionable: boolean;
}

export interface MaterialityVerdict {
  readonly materiality: Materiality;
  /** Every reason that contributed, in the order they were applied. */
  readonly because: readonly string[];
  /**
   * What happens if nobody resolves it. Required, and never "nothing" — an
   * unknown with no stated consequence has no business being in a queue.
   */
  readonly ifUnresolved: string;
}

const SEVERITY_FLOOR: Readonly<Record<Severity, Materiality>> = {
  CRITICAL: 'HIGH',
  HIGH: 'MODERATE',
  MEDIUM: 'LOW',
  LOW: 'LOW',
  INFO: 'IMMATERIAL',
};

const ORDER: Readonly<Record<Materiality, number>> = {
  BLOCKING: 4,
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
  IMMATERIAL: 0,
};

function raise(current: Materiality, to: Materiality): Materiality {
  return ORDER[to] > ORDER[current] ? to : current;
}

/** Days inside which a commitment counts as imminent. */
export const IMMINENT_COMMITMENT_DAYS = 30;

export function assessMateriality(input: MaterialityInput): MaterialityVerdict {
  const because: string[] = [];
  let materiality = SEVERITY_FLOOR[input.severity];
  because.push(`The control is ${input.severity}, which places this at ${materiality} or above.`);

  /**
   * Fan-out, before anything else raises it.
   *
   * Checked early because it is the factor an operator cannot see for
   * themselves. Severity is on the screen; "this one credential is why nine
   * controls are dark" is not.
   */
  if (input.controlsAffected >= 5) {
    materiality = raise(materiality, 'HIGH');
    because.push(
      `It is the reason ${input.controlsAffected} controls cannot be decided, so resolving it ` +
        'once is worth that many controls of progress.',
    );
  } else if (input.controlsAffected > 1) {
    materiality = raise(materiality, 'MODERATE');
    because.push(`It affects ${input.controlsAffected} controls rather than one.`);
  }

  if (input.blocksCommitment) {
    const imminent =
      input.daysUntilCommitment !== null && input.daysUntilCommitment <= IMMINENT_COMMITMENT_DAYS;
    materiality = imminent ? 'BLOCKING' : raise(materiality, 'HIGH');
    because.push(
      imminent
        ? `A dated commitment depends on it in ${input.daysUntilCommitment} day(s). Until it is ` +
            'resolved that commitment cannot be met honestly.'
        : 'A dated commitment depends on it, but not imminently.',
    );
  }

  if (input.awaitingPerson) {
    // Not raised. Somebody has already been asked, and asking again is not
    // progress — it is the same request with more urgency attached, which is
    // how a queue becomes noise.
    because.push(
      'Somebody has already been asked and has not answered. Chasing again is not new work; ' +
        'escalating or accepting the risk is.',
    );
  }

  if (!input.actionable) {
    /**
     * Capped rather than zeroed.
     *
     * Adericel cannot close it, which is not the same as it not mattering: a
     * CRITICAL control nobody can observe is a real hole in the assurance
     * position and belongs in a report. It is capped so it stops competing
     * with work somebody can actually do today.
     */
    materiality = ORDER[materiality] > ORDER['LOW'] ? 'LOW' : materiality;
    because.push(
      'Nothing inside Adericel can close this, so it is capped at LOW to keep it out of the ' +
        'work queue. It still appears in the assurance position, because it is still true.',
    );
  }

  return {
    materiality,
    because,
    ifUnresolved: consequenceOf(materiality, input),
  };
}

/**
 * What happens if it stays unresolved, stated in consequences rather than
 * states.
 *
 * "The control will remain UNKNOWN" is a tautology and tells an operator
 * nothing. What they need is the sentence they would have to say to the
 * customer.
 */
function consequenceOf(materiality: Materiality, input: MaterialityInput): string {
  if (input.blocksCommitment) {
    return (
      'The commitment that depends on this cannot be met honestly. Adericel will not assert ' +
      'the control, so any submission either carries an UNKNOWN or carries a claim nobody can ' +
      'support.'
    );
  }

  switch (materiality) {
    case 'BLOCKING':
    case 'HIGH':
      return (
        `${input.controlsAffected > 1 ? `${input.controlsAffected} controls stay` : 'The control stays'} ` +
        'undecided. If a questionnaire or an assessor asks, the honest answer is that the ' +
        'organisation does not know — which reads to a third party exactly like a failure.'
      );
    case 'MODERATE':
      return (
        'The control stays undecided and the assurance position stays incomplete. Not urgent ' +
        'on its own; it becomes urgent the moment somebody asks about it.'
      );
    case 'LOW':
      return input.actionable
        ? 'The control stays undecided. Low consequence today, and it will not improve on its own.'
        : 'The control stays undecided, and will continue to, because nothing here can change ' +
            'that. It should be asserted by a person or recorded as out of scope.';
    case 'IMMATERIAL':
      return 'No material consequence. Recorded for completeness rather than for action.';
  }
}

/** Rank for a queue. Higher is worked first. */
export function materialityRank(materiality: Materiality): number {
  return ORDER[materiality];
}
