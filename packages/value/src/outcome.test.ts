import { describe, expect, it } from 'vitest';
import {
  METRIC_CLASS,
  METRIC_PROVENANCE,
  OUTCOME_METRICS,
  USAGE_CAVEAT,
  buildOutcomeScorecard,
  scorecardByClass,
} from './outcome.js';

/**
 * The customer outcome scorecard.
 *
 * Two disciplines are under test, and both are about what the scorecard
 * refuses to do:
 *
 *   1. No metric here measures usage. Usage is the number always available and
 *      never evidence of value — four hundred assessments a week because a
 *      connector keeps breaking is heavy engagement and bad service.
 *   2. A figure nobody produced never appears. Absence reads as unavailable
 *      with a reason, never as zero, because on a chart those look identical.
 */

const PERIOD = { fromIso: '2026-07-01T00:00:00.000Z', toIso: '2026-09-30T00:00:00.000Z' };

describe('the fifteen measures', () => {
  it('has fifteen of them, each classified and directed', () => {
    expect(OUTCOME_METRICS).toHaveLength(15);
    for (const metric of OUTCOME_METRICS) {
      expect(METRIC_CLASS).toContain(metric.metricClass);
      expect(METRIC_PROVENANCE).toContain(metric.provenance);
      expect(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']).toContain(metric.direction);
    }
  });

  it('gives every key uniquely, so a figure cannot land on two metrics', () => {
    const keys = OUTCOME_METRICS.map((metric) => metric.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('states for every metric why it is not a usage measure', () => {
    /**
     * The field exists to force the question "would this go up if the product
     * were merely busier". If the answer is yes, the metric does not belong
     * here — and writing the sentence is what surfaces that.
     */
    for (const metric of OUTCOME_METRICS) {
      expect(metric.notUsageBecause.length, metric.key).toBeGreaterThan(30);
    }
  });

  it('defines each one including what it does not mean', () => {
    for (const metric of OUTCOME_METRICS) {
      expect(metric.definition.length, metric.key).toBeGreaterThan(80);
    }
  });

  it('is honest that most of them are not Adericel’s to know', () => {
    /**
     * Manual chasing hours, audit preparation, satisfaction, retention — those
     * happen in an inbox, a meeting and a contract Adericel never sees. A
     * scorecard claiming to measure all fifteen from product data would be
     * claiming to measure things it cannot reach.
     */
    const notMeasured = OUTCOME_METRICS.filter((metric) => metric.provenance !== 'MEASURED');
    expect(notMeasured.length).toBeGreaterThanOrEqual(4);
    for (const metric of notMeasured) {
      // Matched on the substance rather than one phrasing: a metric Adericel
      // does not measure must say, in its own definition, who does hold it or
      // that nobody does. A definition silent on provenance is the failure
      // this asserts against.
      expect(metric.definition.toLowerCase(), metric.key).toMatch(
        /reported by|only the msp|msp attributes|does not collect|never see|adericel cannot|adericel does not/,
      );
    }
  });

  it('never claims to infer a renewal from behaviour inside the product', () => {
    const retention = OUTCOME_METRICS.find(
      (metric) => metric.key === 'commercial.retention_impact',
    )!;
    expect(retention.provenance).toBe('NOT_YET_INSTRUMENTED');
    expect(retention.definition).toMatch(/never inferred from behaviour inside the product/i);
  });
});

describe('a figure nobody produced does not appear', () => {
  it('reports every absent metric as unavailable, with a reason', () => {
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map(),
    });

    expect(scorecard.measured).toBe(0);
    for (const metric of scorecard.metrics) {
      expect(metric.value, metric.key).toBeNull();
      expect(metric.unavailableBecause, metric.key).not.toBeNull();
      expect(metric.unavailableBecause!.length).toBeGreaterThan(30);
    }
  });

  it('never defaults an absent metric to zero', () => {
    /**
     * The failure this file exists to prevent. Zero is a claim — "you chased
     * evidence for no hours" — and absence is a fact. On a chart they are the
     * same pixel, which is how an outcome dashboard comes to be trusted for
     * numbers nobody produced.
     */
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map(),
    });
    expect(scorecard.metrics.some((metric) => metric.value === 0)).toBe(false);
  });

  it('distinguishes "nobody told us" from "we do not collect it"', () => {
    // Different remedies. The first is a conversation with the MSP; the second
    // is a release. Collapsing them would send somebody to ask for a number
    // that has nowhere to go.
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map(),
    });
    expect(scorecard.reportedMissing).toBeGreaterThan(0);
    expect(scorecard.notInstrumented).toBeGreaterThan(0);
    expect(scorecard.completeness).toMatch(/has not reported/i);
    expect(scorecard.completeness).toMatch(/not instrumented yet/i);
  });

  it('does not carry a figure forward from a previous period', () => {
    // A stale number labelled with a current date is worse than a gap: it is
    // a gap that looks like data.
    const first = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map([['quality.unknown_share', { value: 12 }]]),
    });
    const second = buildOutcomeScorecard({
      organisationId: 'org-1',
      fromIso: '2026-10-01T00:00:00.000Z',
      toIso: '2026-12-31T00:00:00.000Z',
      values: new Map(),
    });
    expect(first.metrics.find((m) => m.key === 'quality.unknown_share')!.value).toBe(12);
    expect(second.metrics.find((m) => m.key === 'quality.unknown_share')!.value).toBeNull();
  });

  it('carries the sample size where one was given', () => {
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map([['cycle.time_to_complete', { value: 11, sampleSize: 3 }]]),
    });
    const metric = scorecard.metrics.find((m) => m.key === 'cycle.time_to_complete')!;
    expect(metric.value).toBe(11);
    expect(metric.sampleSize).toBe(3);
  });
});

describe('the caveat that must never be dropped', () => {
  it('travels with every scorecard', () => {
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map([['quality.unknown_share', { value: 4 }]]),
    });
    expect(scorecard.usageCaveat).toBe(USAGE_CAVEAT);
    expect(scorecard.usageCaveat).toMatch(/high usage is not proof of value/i);
    expect(scorecard.usageCaveat).toMatch(/never as zero/i);
  });

  it('states completeness rather than presenting a partial card as whole', () => {
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map([['quality.unknown_share', { value: 4 }]]),
    });
    expect(scorecard.completeness).toMatch(/1 of 15 measures/);
  });
});

describe('reading it as four questions rather than fifteen numbers', () => {
  it('groups every metric into exactly one class', () => {
    const scorecard = buildOutcomeScorecard({
      organisationId: 'org-1',
      ...PERIOD,
      values: new Map(),
    });
    const grouped = scorecardByClass(scorecard);
    const total = METRIC_CLASS.reduce((sum, key) => sum + grouped[key].length, 0);
    expect(total).toBe(OUTCOME_METRICS.length);
    for (const metricClass of METRIC_CLASS) {
      expect(grouped[metricClass].length, metricClass).toBeGreaterThan(0);
    }
  });
});
