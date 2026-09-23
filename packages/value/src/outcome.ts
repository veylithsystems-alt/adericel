import { z } from 'zod';

/**
 * The customer outcome scorecard.
 *
 * Fifteen measures of whether Adericel is doing the customer any good, kept
 * deliberately apart from every measure of whether Adericel is being used.
 *
 * WHY THE SEPARATION IS THE WHOLE POINT
 *
 * Usage is the metric every product reaches for because it is the one always
 * available: logins, assessments run, reports generated, controls touched. None
 * of it is evidence of value. An MSP running four hundred assessments a week
 * because the connector keeps breaking is heavily engaged and badly served, and
 * a dashboard that led with that number would be lying by selection.
 *
 * So the usage measures already in this package — the operational ledger, the
 * intervention meter — answer "what did Adericel do". This file answers "did it
 * help", and the two are never combined into one figure.
 *
 * THE HARDER DISCIPLINE: MOST OF THESE ARE NOT OURS TO KNOW
 *
 * Adericel can measure time-to-cycle and evidence freshness because it holds
 * the timestamps. It cannot measure manual evidence-chasing hours, customer
 * satisfaction or renewal impact, because those happen in an MSP's inbox, in a
 * conversation, and in a contract Adericel never sees.
 *
 * Every metric therefore declares its provenance, and the scorecard **refuses
 * to compute** where it has no basis. A metric with no data reads as
 * `UNAVAILABLE` with the reason, never as zero. Zero is a claim; absence is a
 * fact, and the two look identical on a chart — which is how outcome dashboards
 * come to be trusted for numbers nobody produced.
 */

export const METRIC_PROVENANCE = [
  /** Adericel holds the data and computes it. Nobody has to be asked. */
  'MEASURED',
  /**
   * Derived from what Adericel measures plus a figure the MSP supplied.
   *
   * The supplied part is never invented and never defaulted: a rate nobody
   * gave is a metric that does not appear.
   */
  'DERIVED_FROM_SUPPLIED',
  /** Only the MSP or the client knows it. Adericel records what they report. */
  'REPORTED',
  /** Nobody has it yet. Stated, so its absence is visible rather than a gap. */
  'NOT_YET_INSTRUMENTED',
] as const;
export type MetricProvenance = (typeof METRIC_PROVENANCE)[number];

/** Which question a metric answers. Usage never mixes with outcome. */
export const METRIC_CLASS = [
  /** Did the customer get a better result? */
  'OUTCOME',
  /** How much human effort did it take? */
  'EFFORT',
  /** How good is the assurance position itself? */
  'QUALITY',
  /** What did the relationship do commercially? */
  'COMMERCIAL',
] as const;
export type MetricClass = (typeof METRIC_CLASS)[number];

export const METRIC_DIRECTION = ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'] as const;
export type MetricDirection = (typeof METRIC_DIRECTION)[number];

export interface OutcomeMetricDefinition {
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly metricClass: MetricClass;
  readonly direction: MetricDirection;
  readonly provenance: MetricProvenance;
  /** What it means, and what it deliberately does not mean. */
  readonly definition: string;
  /**
   * Why this is not a usage metric.
   *
   * Required on every entry. Writing it forces the question "would this go up
   * if the product were merely busier", and if the answer is yes the metric
   * does not belong here.
   */
  readonly notUsageBecause: string;
}

export const OUTCOME_METRICS: readonly OutcomeMetricDefinition[] = [
  {
    key: 'cycle.time_to_complete',
    name: 'Time to complete an assurance cycle',
    unit: 'days',
    metricClass: 'OUTCOME',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Elapsed days from the start of an assurance cycle to every in-scope control reaching a ' +
      'determinate state or a recorded exception. A cycle that ends with controls still UNKNOWN ' +
      'has not completed and is not counted as one.',
    notUsageBecause:
      'It gets worse, not better, when Adericel runs more assessments to reach the same answer.',
  },
  {
    key: 'effort.evidence_chasing_hours',
    name: 'Manual evidence-chasing hours',
    unit: 'hours',
    metricClass: 'EFFORT',
    direction: 'LOWER_IS_BETTER',
    provenance: 'REPORTED',
    definition:
      'Hours the MSP spent asking people for evidence rather than collecting it. Reported by ' +
      'the MSP; Adericel cannot see an inbox or a phone call.',
    notUsageBecause: 'It is time spent outside the product, which usage cannot reach.',
  },
  {
    key: 'quality.answered_from_existing_evidence',
    name: 'Questions answered from evidence already held',
    unit: 'percent',
    metricClass: 'QUALITY',
    direction: 'HIGHER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Of questions answered in a cycle, the share resolved from evidence Adericel already ' +
      'held, with no new collection and no new human input. The closest single measure of ' +
      'whether continuous assurance is earning its keep.',
    notUsageBecause:
      'A busier product answers no more questions from evidence it already had; this only ' +
      'improves when the evidence base genuinely covers more.',
  },
  {
    key: 'quality.unknown_share',
    name: 'Answers classified UNKNOWN',
    unit: 'percent',
    metricClass: 'QUALITY',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Share of in-scope controls that cannot be decided. Lower is better only when it falls ' +
      'because evidence arrived — never because a rule was loosened or a control was scoped ' +
      'out, which is why the ruleset version travels with this figure.',
    notUsageBecause: 'Running an assessment again over the same evidence does not move it.',
  },
  {
    key: 'quality.rework_rate',
    name: 'Rework rate',
    unit: 'percent',
    metricClass: 'QUALITY',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Share of answers or determinations that were revised after being reviewed or submitted. ' +
      'High rework means Adericel is producing work a person then has to redo.',
    notUsageBecause: 'It rises with volume only if the extra volume is wrong.',
  },
  {
    key: 'quality.evidence_freshness',
    name: 'Evidence freshness',
    unit: 'days (median age)',
    metricClass: 'QUALITY',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Median age of the evidence currently supporting determinate controls. A position built ' +
      'on six-month-old observations is a historical record, not an assurance position.',
    notUsageBecause: 'Activity that collects nothing new leaves it unchanged.',
  },
  {
    key: 'quality.unsupported_assertions_prevented',
    name: 'Unsupported assertions prevented',
    unit: 'count',
    metricClass: 'QUALITY',
    direction: 'HIGHER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Times Adericel refused to assert something: a bare positive blocked, an AI suggestion ' +
      'not confirmed, an answer held at UNKNOWN rather than rendered as a yes. Each one is a ' +
      'statement the customer did not have to stand behind.',
    notUsageBecause:
      'This is the one metric where the count and the value genuinely coincide — each refusal ' +
      'is a specific claim that was not made. It is still not usage: it counts refusals, and ' +
      'a product doing more work correctly produces fewer of them over time, not more.',
  },
  {
    key: 'effort.customer_review_turnaround',
    name: 'Customer review turnaround',
    unit: 'days',
    metricClass: 'EFFORT',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Elapsed days from Adericel asking a client to confirm something to their confirming it. ' +
      'Measures the relationship as much as the product, and a slow figure here is usually ' +
      'the real bottleneck rather than collection.',
    notUsageBecause: 'It measures a person’s response time, not the product’s activity.',
  },
  {
    key: 'outcome.audit_preparation_time',
    name: 'Renewal or audit preparation time',
    unit: 'hours',
    metricClass: 'OUTCOME',
    direction: 'LOWER_IS_BETTER',
    provenance: 'REPORTED',
    definition:
      'Hours spent preparing for a certification assessment, insurer renewal or audit. ' +
      'Reported by the MSP, because most of it happens in meetings and documents Adericel ' +
      'never sees.',
    notUsageBecause: 'Almost all of this effort is outside the product by definition.',
  },
  {
    key: 'effort.exception_backlog',
    name: 'Exception backlog',
    unit: 'count',
    metricClass: 'EFFORT',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Open exceptions past their review date. A growing backlog means risk is being accepted ' +
      'by drift rather than by decision.',
    notUsageBecause: 'More product activity does not clear a queue; people do.',
  },
  {
    key: 'effort.human_interventions_per_customer',
    name: 'Human interventions per customer',
    unit: 'count per cycle',
    metricClass: 'EFFORT',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Times a person had to act for a cycle to progress. Already measured by the intervention ' +
      'meter; restated here because it is an outcome for the MSP, not only an operating ' +
      'statistic.',
    notUsageBecause:
      'This is the inverse of usage: the product succeeding means this number falls.',
  },
  {
    key: 'quality.evidence_reuse_rate',
    name: 'Evidence reuse rate',
    unit: 'answers per evidence artefact',
    metricClass: 'QUALITY',
    direction: 'HIGHER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'How many answers or determinations each piece of evidence supported. The economic ' +
      'argument for a graph rather than a folder: collect once, answer many times.',
    notUsageBecause: 'Collecting the same thing repeatedly lowers it.',
  },
  {
    key: 'outcome.report_generation_time',
    name: 'Report generation time',
    unit: 'minutes',
    metricClass: 'OUTCOME',
    direction: 'LOWER_IS_BETTER',
    provenance: 'MEASURED',
    definition:
      'Wall-clock time from requesting a Passport, questionnaire or assurance report to it ' +
      'being ready to send. Includes any human confirmation the report required.',
    notUsageBecause: 'Generating more reports does not make each one faster.',
  },
  {
    key: 'commercial.customer_satisfaction',
    name: 'Customer satisfaction',
    unit: 'score, as collected',
    metricClass: 'COMMERCIAL',
    direction: 'HIGHER_IS_BETTER',
    provenance: 'REPORTED',
    definition:
      'Whatever measure the MSP already uses with their clients, recorded as they report it. ' +
      'Adericel does not define a scale, does not survey anybody, and does not convert one ' +
      'scale into another.',
    notUsageBecause: 'It is an opinion held by a person Adericel has never contacted.',
  },
  {
    key: 'commercial.retention_impact',
    name: 'Customer retention impact',
    unit: 'attribution, as reported',
    metricClass: 'COMMERCIAL',
    direction: 'HIGHER_IS_BETTER',
    provenance: 'NOT_YET_INSTRUMENTED',
    definition:
      'Whether Adericel contributed to a client renewing or leaving. Recorded only where the ' +
      'MSP attributes it, and never inferred from behaviour inside the product.',
    notUsageBecause:
      'Attributing a renewal to a tool is a judgement, and one Adericel is the last party who ' +
      'should be making about itself.',
  },
];

export interface MetricValue {
  readonly key: string;
  /** Null where there is no basis. Never defaulted to zero. */
  readonly value: number | null;
  readonly provenance: MetricProvenance;
  /** Set whenever `value` is null. Says why, so absence is legible. */
  readonly unavailableBecause: string | null;
  /** How many observations the figure rests on, where that is meaningful. */
  readonly sampleSize: number | null;
  /** The period the figure covers. */
  readonly fromIso: string;
  readonly toIso: string;
}

export interface OutcomeScorecard {
  readonly organisationId: string;
  readonly fromIso: string;
  readonly toIso: string;
  readonly metrics: readonly MetricValue[];
  readonly measured: number;
  readonly reportedMissing: number;
  readonly notInstrumented: number;
  /**
   * Said with every scorecard, because a scorecard that does not say what it
   * cannot see reads as complete.
   */
  readonly completeness: string;
  /** Never omitted. This is the sentence the whole file exists to protect. */
  readonly usageCaveat: string;
}

export const USAGE_CAVEAT =
  'Nothing on this scorecard measures how much Adericel was used. High usage is not proof of ' +
  'value — an MSP running four hundred assessments a week because a connector keeps breaking ' +
  'is heavily engaged and badly served. Where a figure is missing it is shown as unavailable ' +
  'with the reason, and never as zero.';

export interface ScorecardInput {
  readonly organisationId: string;
  readonly fromIso: string;
  readonly toIso: string;
  /**
   * Values the caller could substantiate, keyed by metric.
   *
   * A metric absent from this map is reported as unavailable. There is no
   * default, no zero-fill and no carry-forward from a previous period: a
   * number nobody produced must not appear on a page somebody acts on.
   */
  readonly values: ReadonlyMap<string, { value: number; sampleSize?: number }>;
}

export function buildOutcomeScorecard(input: ScorecardInput): OutcomeScorecard {
  const metrics: MetricValue[] = OUTCOME_METRICS.map((definition) => {
    const supplied = input.values.get(definition.key);
    if (supplied === undefined) {
      return {
        key: definition.key,
        value: null,
        provenance: definition.provenance,
        unavailableBecause: unavailableReason(definition),
        sampleSize: null,
        fromIso: input.fromIso,
        toIso: input.toIso,
      };
    }
    return {
      key: definition.key,
      value: supplied.value,
      provenance: definition.provenance,
      unavailableBecause: null,
      sampleSize: supplied.sampleSize ?? null,
      fromIso: input.fromIso,
      toIso: input.toIso,
    };
  });

  const present = metrics.filter((metric) => metric.value !== null);
  const reportedMissing = metrics.filter(
    (metric) =>
      metric.value === null &&
      (metric.provenance === 'REPORTED' || metric.provenance === 'DERIVED_FROM_SUPPLIED'),
  ).length;
  const notInstrumented = metrics.filter(
    (metric) => metric.value === null && metric.provenance === 'NOT_YET_INSTRUMENTED',
  ).length;

  return {
    organisationId: input.organisationId,
    fromIso: input.fromIso,
    toIso: input.toIso,
    metrics,
    measured: present.length,
    reportedMissing,
    notInstrumented,
    completeness:
      `${present.length} of ${OUTCOME_METRICS.length} measures have a figure for this period. ` +
      `${reportedMissing} depend on something the MSP or the client has not reported, and ` +
      `${notInstrumented} are not instrumented yet. Those are shown as unavailable rather ` +
      'than estimated.',
    usageCaveat: USAGE_CAVEAT,
  };
}

function unavailableReason(definition: OutcomeMetricDefinition): string {
  switch (definition.provenance) {
    case 'MEASURED':
      return (
        'Adericel can measure this and has no data for the period — usually because the ' +
        'organisation completed no assurance cycle in it. Not zero: unmeasured.'
      );
    case 'DERIVED_FROM_SUPPLIED':
      return (
        'This needs a figure the MSP supplies, and none was given. Adericel will not default ' +
        'or estimate it.'
      );
    case 'REPORTED':
      return `Only the MSP or the client knows this. ${definition.name} has not been reported for this period.`;
    case 'NOT_YET_INSTRUMENTED':
      return 'Adericel does not collect this yet. Stated so its absence is visible.';
  }
}

/**
 * Metrics grouped by what they answer, for a scorecard a person can read.
 *
 * Four questions rather than fifteen numbers: did the customer get a better
 * result, how much effort did it take, how good is the position, and what did
 * the relationship do commercially.
 */
export function scorecardByClass(
  scorecard: OutcomeScorecard,
): Readonly<Record<MetricClass, readonly MetricValue[]>> {
  const definitionOf = new Map(OUTCOME_METRICS.map((metric) => [metric.key, metric]));
  const inClass = (metricClass: MetricClass): readonly MetricValue[] =>
    scorecard.metrics.filter((metric) => definitionOf.get(metric.key)?.metricClass === metricClass);

  // Written out rather than built from the list, so a new class cannot be added
  // without deciding where it appears.
  return {
    OUTCOME: inClass('OUTCOME'),
    EFFORT: inClass('EFFORT'),
    QUALITY: inClass('QUALITY'),
    COMMERCIAL: inClass('COMMERCIAL'),
  };
}

export const outcomeMetricKeySchema = z.enum(
  OUTCOME_METRICS.map((metric) => metric.key) as [string, ...string[]],
);
