import { describe, expect, it } from 'vitest';
import {
  computeCapacity,
  IMPLAUSIBLE_CAPACITY,
  MINIMUM_CAPACITY_ORGANISATIONS,
  MINIMUM_CAPACITY_WINDOW_DAYS,
  RESPONSE_TYPES,
  unpricedResponse,
  type ExceptionLoad,
  type ResponseEffort,
  type ResponseType,
} from './capacity.js';

/**
 * How many customers one engineer can run.
 *
 * The interesting tests are the refusals. A capacity figure is the number an
 * MSP owner makes hiring decisions with, so a tool that produces one when
 * pressed — from two weeks of nothing, from three customers, from durations
 * nobody supplied — is worse than a tool that has no opinion.
 */

function load(overrides: Partial<ExceptionLoad> = {}): ExceptionLoad {
  return {
    windowDays: 30,
    organisations: 40,
    byResponseType: { DECIDE: 80, CONFIGURE: 40, INVESTIGATE: 20, ASK_CUSTOMER: 10 },
    handledAutonomously: 600,
    ...overrides,
  };
}

function priced(responseType: ResponseType, minutes: number): ResponseEffort {
  return {
    responseType,
    minutes,
    source: 'MSP_MEASURED',
    basis: 'Timed across a fortnight of the queue',
  };
}

const FULLY_PRICED = [
  priced('DECIDE', 6),
  priced('CONFIGURE', 20),
  priced('INVESTIGATE', 45),
  priced('ASK_CUSTOMER', 15),
];

describe('refusing to answer', () => {
  it('refuses a window too short to mean anything', () => {
    const result = computeCapacity(load({ windowDays: 5 }), FULLY_PRICED, 130);
    expect(result.basis).toBe('REFUSED');
    if (result.basis !== 'REFUSED') return;
    // A quiet fortnight would otherwise double the answer, and this is exactly
    // the number that would be quoted on that noise.
    expect(result.reason).toContain('5 day(s)');
    expect(MINIMUM_CAPACITY_WINDOW_DAYS).toBe(14);
  });

  it('refuses a portfolio too small to average over', () => {
    const result = computeCapacity(load({ organisations: 2 }), FULLY_PRICED, 130);
    expect(result.basis).toBe('REFUSED');
    if (result.basis !== 'REFUSED') return;
    expect(result.reason).toContain('One unusual customer would become the whole model');
    expect(MINIMUM_CAPACITY_ORGANISATIONS).toBe(3);
  });

  it('refuses when nobody has said what an engineer month is', () => {
    const result = computeCapacity(load(), FULLY_PRICED, null);
    expect(result.basis).toBe('REFUSED');
    if (result.basis !== 'REFUSED') return;
    expect(result.missing.join(' ')).toContain('hours one of your engineers has');
  });

  it('refuses when a response type that occurred is unpriced', () => {
    const result = computeCapacity(
      load(),
      [priced('DECIDE', 6), unpricedResponse('CONFIGURE')],
      130,
    );
    expect(result.basis).toBe('REFUSED');
    if (result.basis !== 'REFUSED') return;
    expect(result.missing.join(' ')).toContain('CONFIGURE');
    expect(result.reason).toContain('will not guess');
  });

  it('does not demand a price for work that never happened', () => {
    // An MSP whose portfolio produced no ASK_CUSTOMER exceptions should not be
    // told to price one.
    const result = computeCapacity(
      load({ byResponseType: { DECIDE: 80, CONFIGURE: 0, INVESTIGATE: 0, ASK_CUSTOMER: 0 } }),
      [priced('DECIDE', 6)],
      130,
    );
    expect(result.basis).toBe('MEASURED');
  });

  it('refuses an industry figure as a stand-in for this MSP', () => {
    const result = computeCapacity(
      load({ byResponseType: { DECIDE: 80, CONFIGURE: 0, INVESTIGATE: 0, ASK_CUSTOMER: 0 } }),
      [{ responseType: 'DECIDE', minutes: 6, source: 'INDUSTRY_REFERENCE', basis: 'a survey' }],
      130,
    );
    // A published figure is a claim about somebody else's business.
    expect(result.basis).toBe('REFUSED');
  });
});

describe('the arithmetic', () => {
  const result = computeCapacity(load(), FULLY_PRICED, 130);

  it('computes hours per customer from counted exceptions and supplied minutes', () => {
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    // DECIDE: 80 x 6m = 8h; CONFIGURE: 40 x 20m = 13.33h;
    // INVESTIGATE: 20 x 45m = 15h; ASK_CUSTOMER: 10 x 15m = 2.5h
    // total 38.83h over 40 customers over 1 month.
    expect(result.hoursPerCustomerPerMonth).toBeCloseTo(0.97, 1);
    expect(result.hoursByResponseType.INVESTIGATE).toBeGreaterThan(
      result.hoursByResponseType.ASK_CUSTOMER,
    );
  });

  it('floors the capacity rather than rounding it', () => {
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    // Rounding up puts a real person over their capacity on a decimal.
    expect(Number.isInteger(result.customersPerEngineer)).toBe(true);
    expect(result.customersPerEngineer).toBe(Math.floor(130 / result.hoursPerCustomerPerMonth));
  });

  it('reports the autonomous share against all the work, not just the visible part', () => {
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    // 600 handled alone, 150 routed to a person.
    expect(result.autonomousShare).toBeCloseTo(600 / 750, 2);
  });

  it('reports no autonomous share at all when nothing happened', () => {
    const quiet = computeCapacity(
      load({
        byResponseType: { DECIDE: 0, CONFIGURE: 0, INVESTIGATE: 0, ASK_CUSTOMER: 0 },
        handledAutonomously: 0,
      }),
      FULLY_PRICED,
      130,
    );
    if (quiet.basis !== 'MEASURED') throw new Error('expected a measurement');
    // A quiet window is not 0% automation; it is no information.
    expect(quiet.autonomousShare).toBeNull();
  });

  it('says so when the window was too quiet to represent steady state', () => {
    const quiet = computeCapacity(
      load({
        byResponseType: { DECIDE: 0, CONFIGURE: 0, INVESTIGATE: 0, ASK_CUSTOMER: 0 },
        handledAutonomously: 0,
      }),
      FULLY_PRICED,
      130,
    );
    if (quiet.basis !== 'MEASURED') throw new Error('expected a measurement');
    expect(quiet.caveats.join(' ')).toContain('unusually quiet period');
    // And it does not claim unbounded capacity.
    expect(quiet.customersPerEngineer).toBe(quiet.organisationsMeasured);
  });

  it('always states that this is assurance work alone', () => {
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    // An engineer runs fewer customers than this in practice. Saying so is the
    // difference between a usable planning number and a sales figure.
    expect(result.caveats.join(' ')).toContain('upper bound on the assurance work alone');
  });
});

describe('the response vocabulary', () => {
  it('prices by what the operator does, not by exception kind', () => {
    // A morning of fifteen decisions is a different day from a morning of
    // three investigations, and an MSP can time four categories far more
    // readily than fifteen.
    expect([...RESPONSE_TYPES].sort()).toEqual([
      'ASK_CUSTOMER',
      'CONFIGURE',
      'DECIDE',
      'INVESTIGATE',
    ]);
  });

  it('has no default duration for any of them', () => {
    for (const type of RESPONSE_TYPES) {
      expect(unpricedResponse(type).minutes).toBeNull();
      expect(unpricedResponse(type).source).toBe('UNKNOWN');
    }
  });
});

describe('arrivals, not the standing queue', () => {
  it('warns when work is accumulating faster than it is cleared', () => {
    // The error this guards against produced 433 customers per engineer on a
    // hundred-customer portfolio: a standing backlog was divided by the window
    // length and read as a trickle. No MSP would have believed the number,
    // which is how it was caught.
    const result = computeCapacity(
      load({
        byResponseType: { DECIDE: 10, CONFIGURE: 5, INVESTIGATE: 2, ASK_CUSTOMER: 1 },
        standingQueueTotal: 400,
      }),
      FULLY_PRICED,
      130,
    );
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    expect(result.caveats.join(' ')).toContain('accumulating faster than it is being cleared');
    expect(result.caveats.join(' ')).toContain('400 exception(s) are open');
  });

  it('says nothing about accumulation when the queue matches the flow', () => {
    const result = computeCapacity(load({ standingQueueTotal: 150 }), FULLY_PRICED, 130);
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    expect(result.caveats.join(' ')).not.toContain('accumulating faster');
  });

  it('describes the figure as built from arrivals, not from the queue', () => {
    const result = computeCapacity(load(), FULLY_PRICED, 130);
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    // 80 + 40 + 20 + 10 arrivals.
    expect(result.caveats[0]).toContain('150 exception(s) that arose during 30 day(s)');
  });
});

describe('when assurance stops being the bottleneck', () => {
  it('says what a very large capacity figure actually means', () => {
    // A well-covered portfolio generating few exceptions really does cost
    // little assurance time per customer. Printing "433 customers per
    // engineer" as a staffing number would be arithmetically true and
    // commercially absurd, and one absurd number destroys trust in every
    // honest number beside it.
    const result = computeCapacity(
      load({ byResponseType: { DECIDE: 20, CONFIGURE: 10, INVESTIGATE: 2, ASK_CUSTOMER: 2 } }),
      FULLY_PRICED,
      130,
    );
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    expect(result.customersPerEngineer).toBeGreaterThan(IMPLAUSIBLE_CAPACITY);
    expect(result.assuranceIsTheConstraint).toBe(false);
    expect(result.caveats.join(' ')).toContain('no longer what limits this team');
    expect(result.caveats.join(' ')).toContain('none of them is something Adericel can see');
  });

  it('reports a plausible figure as a genuine constraint', () => {
    const result = computeCapacity(
      load({ byResponseType: { DECIDE: 400, CONFIGURE: 300, INVESTIGATE: 120, ASK_CUSTOMER: 60 } }),
      FULLY_PRICED,
      130,
    );
    if (result.basis !== 'MEASURED') throw new Error('expected a measurement');
    expect(result.customersPerEngineer).toBeLessThanOrEqual(IMPLAUSIBLE_CAPACITY);
    expect(result.assuranceIsTheConstraint).toBe(true);
    expect(result.caveats.join(' ')).not.toContain('no longer what limits');
  });
});
