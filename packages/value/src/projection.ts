import type { ProofOfValue } from './report.js';

/**
 * The hundred-customer question.
 *
 * "What does defensible assurance for 100 customers cost, with and without
 * Adericel?" is the question an MSP actually has, and answering it requires
 * multiplying up from a smaller portfolio — which is exactly where an honest
 * measurement turns into a dishonest projection if nobody is careful.
 *
 * Three rules, enforced here rather than remembered:
 *
 *   1. A projection is never produced from a sample too small to support it.
 *      Below the floor, the result is refused with a reason instead of being
 *      produced with a disclaimer nobody reads.
 *
 *   2. A projection is never presented as a measurement. Everything this file
 *      returns is labelled PROJECTED and carries the sample it came from.
 *
 *   3. Scaling is not assumed to be linear in the MSP's favour. Per-customer
 *      work scales with customers; the human oversight does not fall away as
 *      the portfolio grows, and pretending otherwise would produce a saving
 *      that gets more impressive the more it is extrapolated.
 */

/**
 * The smallest portfolio a projection may be built from.
 *
 * Three is not a statistically respectable sample. It is the point below which
 * the arithmetic is obviously meaningless rather than subtly so, and refusing
 * below it is the least this can do. The number is deliberately visible so an
 * MSP can see how thin the basis is.
 */
export const MINIMUM_SAMPLE_ORGANISATIONS = 3;

export interface Projection {
  readonly basis: 'PROJECTED';
  readonly targetOrganisations: number;
  /** The portfolio the figures were measured on. */
  readonly sampleOrganisations: number;
  readonly sampleDays: number;

  /** Measured hours per organisation per 30 days, displaced by Adericel. */
  readonly displacedHoursPerOrganisationPerMonth: number;
  /** Measured hours per organisation per 30 days, still spent by people. */
  readonly residualHoursPerOrganisationPerMonth: number;

  /** Projected monthly hours at the target, without Adericel. */
  readonly hoursWithoutAdericel: number;
  /** Projected monthly hours at the target, with Adericel. */
  readonly hoursWithAdericel: number;
  readonly hoursReleased: number;

  /** Full-time equivalents, at the stated hours per month. */
  readonly fteWithoutAdericel: number;
  readonly fteWithAdericel: number;
  readonly ftePerMonthHours: number;

  readonly caveats: readonly string[];
}

export interface ProjectionRefusal {
  readonly basis: 'REFUSED';
  readonly reason: string;
}

export type ProjectionResult = Projection | ProjectionRefusal;

export interface ProjectionOptions {
  readonly targetOrganisations: number;
  /**
   * Hours one full-time person is available for assurance work in a month.
   * Supplied by the MSP; there is no default, because a default here would
   * quietly decide the headline FTE figure.
   */
  readonly ftePerMonthHours: number | null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function project(report: ProofOfValue, options: ProjectionOptions): ProjectionResult {
  const sample = report.organisationCount;

  if (sample < MINIMUM_SAMPLE_ORGANISATIONS) {
    return {
      basis: 'REFUSED',
      reason:
        `A projection to ${options.targetOrganisations} organisations cannot be built from ` +
        `${sample}. Multiplying a figure from this few by that many produces a number with no ` +
        'relationship to what would actually happen, and presenting one would be the same ' +
        'failure as reporting an unverified control as satisfied.',
    };
  }

  if (report.modelCompleteness === 0) {
    return {
      basis: 'REFUSED',
      reason:
        'No task durations have been supplied, so there are no hours to project. Adericel can ' +
        'say how many operations it performed; only this MSP can say what they are worth.',
    };
  }

  const days = Math.max(1, (Date.parse(report.to) - Date.parse(report.from)) / 86_400_000);
  const months = days / 30;

  const displacedPerOrgPerMonth = report.hoursDisplaced / sample / months;
  const residualPerOrgPerMonth = report.hoursStillSpent / sample / months;

  const withAdericel = residualPerOrgPerMonth * options.targetOrganisations;
  const withoutAdericel =
    (displacedPerOrgPerMonth + residualPerOrgPerMonth) * options.targetOrganisations;

  const caveats = [
    `Projected from ${sample} organisation(s) over ${Math.round(days)} day(s). The wider the ` +
      'gap between that and the target, the less this figure means.',
    'Assumes work scales with the number of customers. Real portfolios have shared effort at ' +
      'the top and awkward customers at the bottom, and neither is modelled here.',
    'Assumes the same connector coverage and the same policy settings across the portfolio. A ' +
      'customer whose systems Adericel cannot see produces UNKNOWN, not a saving.',
    ...report.caveats,
  ];

  if (report.modelCompleteness < 1) {
    caveats.push(
      'Both figures understate the true totals, because part of the task catalogue is unpriced. ' +
        'They understate the "without" figure more than the "with" figure, so the saving shown ' +
        'is conservative.',
    );
  }

  const fteHours = options.ftePerMonthHours;

  return {
    basis: 'PROJECTED',
    targetOrganisations: options.targetOrganisations,
    sampleOrganisations: sample,
    sampleDays: Math.round(days),
    displacedHoursPerOrganisationPerMonth: round(displacedPerOrgPerMonth),
    residualHoursPerOrganisationPerMonth: round(residualPerOrgPerMonth),
    hoursWithoutAdericel: round(withoutAdericel),
    hoursWithAdericel: round(withAdericel),
    hoursReleased: round(withoutAdericel - withAdericel),
    // Zero rather than a guess when the MSP has not said what a full-time month
    // is for them. A default here would silently decide the headline number.
    ftePerMonthHours: fteHours ?? 0,
    fteWithoutAdericel: fteHours ? round(withoutAdericel / fteHours) : 0,
    fteWithAdericel: fteHours ? round(withAdericel / fteHours) : 0,
    caveats,
  };
}
