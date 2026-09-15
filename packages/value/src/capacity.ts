import { z } from 'zod';
import { HEADLINE_SOURCES, effortSourceSchema, type EffortSource } from './effort.js';

/**
 * How many customers one engineer can actually run.
 *
 * This is the number an MSP owner makes decisions with. Not hours saved in the
 * abstract — whether the next fifteen customers need another salary.
 *
 * It is computable, and it is computable honestly, because both halves are
 * things somebody can check:
 *
 *   Adericel measures   how many exceptions each customer generated, by the
 *                       kind of response each needed. Counted from rows.
 *   The MSP supplies    how long their people take to answer one of each, and
 *                       how many hours an engineer has in a month.
 *
 *   capacity = engineer hours per month / hours of exception work per customer
 *
 * The arithmetic is trivial. The discipline is in refusing to produce it when
 * either half is missing, and in measuring the load over a long enough window
 * that one quiet fortnight does not double the answer.
 */

/** The four things an operator can be asked to do. Mirrors the triage package. */
export const RESPONSE_TYPES = ['DECIDE', 'CONFIGURE', 'INVESTIGATE', 'ASK_CUSTOMER'] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

/**
 * What answering one exception of each kind costs this MSP.
 *
 * Priced by response type rather than by exception kind, because that is how
 * the work divides in practice: a morning of fifteen decisions is a different
 * day from a morning of three investigations, and an MSP can time four
 * categories far more readily than fifteen.
 */
export interface ResponseEffort {
  readonly responseType: ResponseType;
  readonly minutes: number | null;
  readonly source: EffortSource;
  readonly basis: string | null;
}

export const responseEffortSchema = z
  .object({
    responseType: z.enum(RESPONSE_TYPES),
    minutes: z.number().min(0).max(600).nullable(),
    source: effortSourceSchema,
    basis: z.string().min(3).max(500).nullable(),
  })
  .refine((value) => value.source === 'UNKNOWN' || value.minutes !== null, {
    message: 'A duration with a source must have a number of minutes',
  })
  .refine((value) => value.source === 'UNKNOWN' || value.basis !== null, {
    message: 'A duration must say how it was arrived at.',
  });

export function unpricedResponse(responseType: ResponseType): ResponseEffort {
  return { responseType, minutes: null, source: 'UNKNOWN', basis: null };
}

/** The measured exception load over a window. Counted, never modelled. */
export interface ExceptionLoad {
  readonly windowDays: number;
  readonly organisations: number;
  /**
   * Exceptions that AROSE inside the window, by what the operator had to do.
   *
   * Arrivals, not the standing queue. A backlog divided by the window length
   * looks like a trickle, and computing capacity from it overstates how many
   * customers an engineer can carry — badly enough to produce figures no MSP
   * would believe.
   */
  readonly byResponseType: Readonly<Record<ResponseType, number>>;
  /** Exceptions nobody had to touch, because Adericel handled them. */
  readonly handledAutonomously: number;
  /**
   * What is open right now, whenever it arrived.
   *
   * Reported because "am I underwater today" is a real question, and a
   * different one from "can one engineer carry this portfolio".
   */
  readonly standingQueue?: Readonly<Record<ResponseType, number>>;
  readonly standingQueueTotal?: number;
}

export interface CapacityRefusal {
  readonly basis: 'REFUSED';
  readonly reason: string;
  /** What the MSP would have to supply for this to be answerable. */
  readonly missing: readonly string[];
}

export interface CapacityEstimate {
  readonly basis: 'MEASURED';
  readonly windowDays: number;
  readonly organisationsMeasured: number;

  /** Hours of human exception work per customer per 30 days. */
  readonly hoursPerCustomerPerMonth: number;
  /** Broken down, so a busy category is visible rather than averaged away. */
  readonly hoursByResponseType: Readonly<Record<ResponseType, number>>;

  readonly engineerHoursPerMonth: number;
  /**
   * Customers one engineer can run at this exception load.
   *
   * Floored, not rounded. An engineer who can handle 47.8 customers can handle
   * 47; rounding up puts a real person over their capacity on the strength of
   * a decimal.
   */
  readonly customersPerEngineer: number;
  /**
   * Whether assurance work is what limits an engineer at this load.
   *
   * When false, the number above is real arithmetic over real counts and is not
   * a staffing plan: something Adericel cannot see binds first.
   */
  readonly assuranceIsTheConstraint: boolean;

  /**
   * Exceptions Adericel resolved without anybody, as a share of all the work.
   *
   * Null rather than zero when nothing happened at all: a quiet window is not
   * 0% automation, it is no information.
   */
  readonly autonomousShare: number | null;

  readonly caveats: readonly string[];
}

export type CapacityResult = CapacityEstimate | CapacityRefusal;

/**
 * The shortest window a capacity figure may be built from.
 *
 * Two weeks. Shorter than that and a quiet fortnight doubles the answer, which
 * is exactly the kind of flattering noise this figure will be quoted on.
 */
export const MINIMUM_CAPACITY_WINDOW_DAYS = 14;

/** The smallest portfolio that can support a per-customer average. */
export const MINIMUM_CAPACITY_ORGANISATIONS = 3;

/**
 * Above this, assurance work is no longer what limits an engineer.
 *
 * The arithmetic can legitimately produce very large numbers: a well-covered
 * portfolio generating few exceptions really does cost very little assurance
 * time per customer. But an MSP engineer does not run four hundred customers,
 * because onboarding calls, account management, and the customer who telephones
 * bind long before the exception queue does.
 *
 * Printing the bare number would be arithmetically true and commercially
 * absurd, and an absurd number destroys trust in every honest number beside it.
 * So above this threshold the figure is reported with what it actually means:
 * assurance has stopped being the bottleneck, and the real limit is elsewhere
 * and is not something Adericel can see.
 */
export const IMPLAUSIBLE_CAPACITY = 150;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeCapacity(
  load: ExceptionLoad,
  efforts: readonly ResponseEffort[],
  engineerHoursPerMonth: number | null,
): CapacityResult {
  const missing: string[] = [];

  if (engineerHoursPerMonth === null || engineerHoursPerMonth <= 0) {
    missing.push(
      'How many hours one of your engineers has for assurance work in a month. There is no ' +
        'default: a guess here would silently decide the headline figure.',
    );
  }

  const priced = new Map<ResponseType, ResponseEffort>();
  for (const effort of efforts) {
    if (effort.minutes !== null && HEADLINE_SOURCES.has(effort.source)) {
      priced.set(effort.responseType, effort);
    }
  }

  // Only response types that actually occurred need pricing. An MSP whose
  // portfolio never produced an ASK_CUSTOMER exception should not be told to
  // price one.
  const occurring = RESPONSE_TYPES.filter((type) => (load.byResponseType[type] ?? 0) > 0);
  const unpriced = occurring.filter((type) => !priced.has(type));
  for (const type of unpriced) {
    missing.push(`How long your team takes to handle one ${type} exception.`);
  }

  if (load.windowDays < MINIMUM_CAPACITY_WINDOW_DAYS) {
    return {
      basis: 'REFUSED',
      reason:
        `A capacity figure cannot be built from ${load.windowDays} day(s) of observation. ` +
        `Below ${MINIMUM_CAPACITY_WINDOW_DAYS} days a quiet fortnight doubles the answer, and ` +
        'this is exactly the number that would be quoted on that flattering noise.',
      missing,
    };
  }

  if (load.organisations < MINIMUM_CAPACITY_ORGANISATIONS) {
    return {
      basis: 'REFUSED',
      reason:
        `A per-customer average cannot be built from ${load.organisations} organisation(s). ` +
        'One unusual customer would become the whole model.',
      missing,
    };
  }

  if (missing.length > 0) {
    return {
      basis: 'REFUSED',
      reason:
        'Adericel has measured the exception load. It cannot turn that into a capacity figure ' +
        'without knowing what your people cost in time — and it will not guess, because a ' +
        'number a vendor invented about your business is worth nothing to you.',
      missing,
    };
  }

  const months = load.windowDays / 30;
  const hoursByResponseType = {} as Record<ResponseType, number>;
  let totalHours = 0;

  for (const type of RESPONSE_TYPES) {
    const count = load.byResponseType[type] ?? 0;
    const effort = priced.get(type);
    const hours = effort?.minutes ? (count * effort.minutes) / 60 : 0;
    const perCustomerPerMonth = load.organisations === 0 ? 0 : hours / load.organisations / months;
    hoursByResponseType[type] = round(perCustomerPerMonth);
    totalHours += perCustomerPerMonth;
  }

  const hoursPerCustomer = round(totalHours);
  const engineerHours = engineerHoursPerMonth as number;

  const totalWork =
    Object.values(load.byResponseType).reduce((sum, count) => sum + count, 0) +
    load.handledAutonomously;

  const arrivals = Object.values(load.byResponseType).reduce((sum, n) => sum + n, 0);
  const caveats = [
    `Measured from ${arrivals} exception(s) that arose during ${load.windowDays} day(s) ` +
      `across ${load.organisations} organisation(s).`,
    'Counts the work Adericel routed to a person. It does not count the meetings, the ' +
      'onboarding calls or the customer who telephones — an engineer runs fewer customers than ' +
      'this in practice, and this figure is an upper bound on the assurance work alone.',
    'Assumes exception load scales with customers. A portfolio with one chaotic customer and ' +
      'forty quiet ones does not behave like forty-one average ones.',
  ];

  if (hoursPerCustomer === 0) {
    caveats.push(
      'No priced exception work arose during the window. The capacity figure below is therefore ' +
        'a statement about an unusually quiet period rather than about steady state.',
    );
  }

  const computed =
    hoursPerCustomer === 0 ? load.organisations : Math.floor(engineerHours / hoursPerCustomer);

  if (computed > IMPLAUSIBLE_CAPACITY) {
    caveats.push(
      `The arithmetic gives ${computed} customers per engineer. Read that as "assurance work is ` +
        'no longer what limits this team" rather than as a staffing plan: onboarding, account ' +
        'management and the telephone bind long before the exception queue does, and none of ' +
        'them is something Adericel can see or measure.',
    );
  }

  const standing = load.standingQueueTotal ?? 0;
  if (standing > arrivals * 2 && arrivals > 0) {
    // A queue much larger than the arrival rate means work is accumulating.
    // Capacity computed from arrivals alone would say the portfolio is
    // comfortable while the backlog grows underneath it.
    caveats.push(
      `${standing} exception(s) are open against ${arrivals} that arose in this window. Work is ` +
        'accumulating faster than it is being cleared, and a capacity figure from arrivals ' +
        'alone does not show that.',
    );
  }

  return {
    basis: 'MEASURED',
    windowDays: load.windowDays,
    organisationsMeasured: load.organisations,
    hoursPerCustomerPerMonth: hoursPerCustomer,
    hoursByResponseType,
    engineerHoursPerMonth: engineerHours,
    // Division by zero is a real case: a portfolio that generated no human work
    // at all. Reported as the portfolio size rather than as infinity, because
    // "unbounded" is not a thing an MSP can plan with.
    customersPerEngineer: computed,
    /**
     * Whether assurance work is what limits an engineer at this load.
     *
     * When false, the figure above is real arithmetic over real counts and is
     * not a staffing plan: something Adericel cannot see binds first.
     */
    assuranceIsTheConstraint: computed <= IMPLAUSIBLE_CAPACITY,
    autonomousShare: totalWork === 0 ? null : load.handledAutonomously / totalWork,
    caveats,
  };
}
