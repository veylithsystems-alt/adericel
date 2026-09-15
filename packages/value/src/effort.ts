import { z } from 'zod';

/**
 * What maintaining defensible assurance costs, before Adericel.
 *
 * This file exists to answer one question — how much MSP labour does Adericel
 * remove — without committing the offence the whole product is built to
 * refuse.
 *
 * THE RULE THIS FILE IS BUILT AROUND
 *
 * Adericel never invents the baseline. "A hundred customers used to take 180
 * staff-hours a month" is not a fact Adericel can observe, and asserting it
 * would be manufactured certainty aimed at the person paying — the worst
 * possible place to put it.
 *
 * So the split is absolute:
 *
 *   Adericel measures WHAT IT DID.        Counted from rows. Auditable.
 *   The MSP supplies HOW LONG THAT TAKES. Their number, their business.
 *   The arithmetic is shown, not asserted.
 *
 * A task with no supplied duration does not get a plausible default. It counts
 * as work performed and contributes UNKNOWN to the hours, and the report says
 * how much of the estate is unpriced. An MSP who prices nothing gets a report
 * that says "Adericel performed 4,120 operations for you and you have told us
 * nothing about what they are worth" — which is useless as marketing and
 * honest, in that order.
 *
 * The commercial argument is stronger this way, not weaker. An MSP will believe
 * a number they supplied the inputs to. They will not believe one a vendor
 * asserted about their own business.
 */

/**
 * Where a duration came from. Carried on every figure, all the way to the
 * report, so nobody has to ask.
 */
export const EFFORT_SOURCES = [
  /** The MSP timed it. The only kind of number worth building a case on. */
  'MSP_MEASURED',
  /** The MSP's own estimate. Theirs, and they know it is an estimate. */
  'MSP_ESTIMATED',
  /**
   * A published figure, cited. Usable as a starting point for a conversation
   * and never presented as this MSP's own cost.
   */
  'INDUSTRY_REFERENCE',
  /** Nobody has said. Contributes no hours and is reported as unpriced. */
  'UNKNOWN',
] as const;
export type EffortSource = (typeof EFFORT_SOURCES)[number];
export const effortSourceSchema = z.enum(EFFORT_SOURCES);

/**
 * Sources that may contribute to a headline saving.
 *
 * `INDUSTRY_REFERENCE` is deliberately absent. A citation is fine for
 * illustrating what the arithmetic would look like; it is not fine as the basis
 * of "Adericel saves you 145 hours a month", because it is a claim about
 * somebody else's business presented as one about theirs.
 */
export const HEADLINE_SOURCES: ReadonlySet<EffortSource> = new Set<EffortSource>([
  'MSP_MEASURED',
  'MSP_ESTIMATED',
]);

/** What the duration is measured per. Decides which counter multiplies it. */
export const EFFORT_UNITS = [
  'PER_EVIDENCE_ITEM',
  'PER_CONTROL_DETERMINATION',
  'PER_DETECTED_CHANGE',
  'PER_FINDING',
  'PER_REMEDIATION',
  'PER_VERIFICATION',
  'PER_ORGANISATION_REPORT',
  'PER_ASSURANCE_ENQUIRY',
] as const;
export type EffortUnit = (typeof EFFORT_UNITS)[number];

export interface AssuranceTask {
  readonly key: string;
  readonly title: string;
  /** The manual job, described as the person doing it would describe it. */
  readonly manualDescription: string;
  /** How Adericel discharges it, or the honest statement that it does not. */
  readonly adericelDoes: string;
  readonly unit: EffortUnit;
  /**
   * Whether Adericel removes this work entirely or only reduces it.
   *
   * `REDUCED` tasks still cost the MSP time, and that residue is measured
   * rather than assumed away — it is the "35 hours" side of the comparison.
   */
  readonly displacement: 'ELIMINATED' | 'REDUCED';
}

/**
 * The manual work of keeping a customer's assurance defensible.
 *
 * Written from the job rather than from the software: each entry is something
 * an engineer actually does, in the words they would use, and only then mapped
 * to what Adericel does instead. A catalogue derived from the product's own
 * feature list would flatter the product and describe nobody's Tuesday.
 */
export const ASSURANCE_TASKS: readonly AssuranceTask[] = [
  {
    key: 'evidence.collect',
    title: 'Collect a piece of evidence',
    manualDescription:
      'Sign in to the customer tenant, find the setting, screenshot or export it, and note the ' +
      'date you looked.',
    adericelDoes: 'Collects it from the connector on a schedule, with the observation timestamp.',
    unit: 'PER_EVIDENCE_ITEM',
    displacement: 'ELIMINATED',
  },
  {
    key: 'evidence.file',
    title: 'File the evidence so it can be found again',
    manualDescription:
      'Save it somewhere with a name and a date that a future auditor, or a future you, can ' +
      'make sense of.',
    adericelDoes: 'Stores it against the control it supports, content-hashed, with its provenance.',
    unit: 'PER_EVIDENCE_ITEM',
    displacement: 'ELIMINATED',
  },
  {
    key: 'control.determine',
    title: 'Decide whether a control is actually met',
    manualDescription:
      'Read the evidence, apply the framework wording, and form a view. The judgement call that ' +
      'the whole file rests on.',
    adericelDoes:
      'Determines it from a published ruleset against observed facts, and answers UNKNOWN rather ' +
      'than guessing where it cannot see.',
    unit: 'PER_CONTROL_DETERMINATION',
    displacement: 'ELIMINATED',
  },
  {
    key: 'control.explain',
    title: 'Write down why the control is met',
    manualDescription:
      'Record the reasoning, so that in nine months somebody can tell whether it was ever true.',
    adericelDoes:
      'Produces the explanation from the rule and the evidence that satisfied it, replayable ' +
      'against the ruleset version used at the time.',
    unit: 'PER_CONTROL_DETERMINATION',
    displacement: 'ELIMINATED',
  },
  {
    key: 'change.detect',
    title: 'Notice that something changed',
    manualDescription:
      'Compare what you see now against what you recorded last time. Usually skipped, which is ' +
      'why assurance goes stale without anybody deciding to let it.',
    adericelDoes: 'Compares every observation against the current claim and records the delta.',
    unit: 'PER_DETECTED_CHANGE',
    displacement: 'ELIMINATED',
  },
  {
    key: 'change.impact',
    title: 'Work out what a change broke',
    manualDescription:
      'Trace the change through to the controls that depended on it, and re-determine each one.',
    adericelDoes: 'Reassesses every control whose inputs moved, and records the state transition.',
    unit: 'PER_DETECTED_CHANGE',
    displacement: 'ELIMINATED',
  },
  {
    key: 'finding.triage',
    title: 'Decide whether a gap matters',
    manualDescription:
      'Look at the failure, judge the severity, decide whether to act now, later, or accept it.',
    adericelDoes:
      'Raises the finding with a severity and a proposed remediation. The decision to accept risk ' +
      'stays with a person — this reduces the work, it does not remove it.',
    unit: 'PER_FINDING',
    displacement: 'REDUCED',
  },
  {
    key: 'remediation.perform',
    title: 'Actually fix it',
    manualDescription:
      'Make the change in the customer tenant, having first worked out what change to make.',
    adericelDoes:
      'Executes the remediation where policy permits it unattended. Where policy requires a human, ' +
      'the human still approves — and that time is measured, not waved away.',
    unit: 'PER_REMEDIATION',
    displacement: 'REDUCED',
  },
  {
    key: 'remediation.verify',
    title: 'Go back and confirm the fix stuck',
    manualDescription:
      'Return to the system, re-check the setting, and confirm it is still as you left it. The ' +
      'step most often skipped, and the reason "remediated" so often means "attempted".',
    adericelDoes:
      'Re-observes the estate independently of the action that changed it, and refuses to record ' +
      'the fix as confirmed unless the observation agrees.',
    unit: 'PER_VERIFICATION',
    displacement: 'ELIMINATED',
  },
  {
    key: 'report.produce',
    title: 'Produce the customer-facing assurance report',
    manualDescription:
      'Assemble the current picture into something a customer can read, usually the night before ' +
      'the meeting.',
    adericelDoes:
      'Maintains it continuously as an Assurance Passport that is true at the moment it is opened.',
    unit: 'PER_ORGANISATION_REPORT',
    displacement: 'ELIMINATED',
  },
  {
    key: 'enquiry.answer',
    title: 'Answer "are they compliant?" for a third party',
    manualDescription:
      'An insurer, a prospect or an auditor asks. Somebody stops what they are doing and ' +
      'assembles an answer from whatever the file currently holds.',
    adericelDoes:
      'Answers from a shared, revocable, tamper-evident passport the third party opens themselves.',
    unit: 'PER_ASSURANCE_ENQUIRY',
    displacement: 'ELIMINATED',
  },
];

export const TASK_BY_KEY: ReadonlyMap<string, AssuranceTask> = new Map(
  ASSURANCE_TASKS.map((task) => [task.key, task]),
);

/**
 * A duration an MSP has supplied for one task, with where it came from.
 *
 * There is no constructor that produces a duration without a source, and no
 * default duration anywhere in this package. That is the guarantee.
 */
export interface TaskEffort {
  readonly taskKey: string;
  /** Minutes of human time, per unit. Null means nobody has said. */
  readonly minutes: number | null;
  readonly source: EffortSource;
  /** How the MSP arrived at it. Required for anything but UNKNOWN. */
  readonly basis: string | null;
  readonly recordedAt: string | null;
}

export const taskEffortSchema = z
  .object({
    taskKey: z.string(),
    minutes: z.number().min(0).max(600).nullable(),
    source: effortSourceSchema,
    basis: z.string().min(3).max(500).nullable(),
    recordedAt: z.string().nullable(),
  })
  .refine((value) => value.source === 'UNKNOWN' || value.minutes !== null, {
    message: 'A duration with a source must have a number of minutes',
  })
  .refine((value) => value.source === 'UNKNOWN' || value.basis !== null, {
    message:
      'A duration must say how it was arrived at. An unexplained number cannot be checked, ' +
      'and a number nobody can check is not evidence of a saving.',
  });

/**
 * The effort model for one MSP: every task, priced or explicitly not.
 *
 * Built so the unpriced tasks are as visible as the priced ones. A model that
 * silently omitted what it did not know would produce a smaller, more
 * believable, and wrong saving.
 */
export interface EffortModel {
  readonly mspId: string;
  readonly efforts: ReadonlyMap<string, TaskEffort>;
}

/** An unpriced task. Never a default; always this. */
export function unpriced(taskKey: string): TaskEffort {
  return { taskKey, minutes: null, source: 'UNKNOWN', basis: null, recordedAt: null };
}

export function buildEffortModel(mspId: string, supplied: readonly TaskEffort[]): EffortModel {
  const efforts = new Map<string, TaskEffort>();
  for (const task of ASSURANCE_TASKS) efforts.set(task.key, unpriced(task.key));
  for (const effort of supplied) {
    // Silently ignore a duration for a task that does not exist rather than
    // letting it contribute to a total nobody can trace back to a task.
    if (TASK_BY_KEY.has(effort.taskKey)) efforts.set(effort.taskKey, effort);
  }
  return { mspId, efforts };
}

export function effortFor(model: EffortModel, taskKey: string): TaskEffort {
  return model.efforts.get(taskKey) ?? unpriced(taskKey);
}

/** Tasks with a duration that may appear in a headline figure. */
export function pricedTaskKeys(model: EffortModel): readonly string[] {
  return ASSURANCE_TASKS.filter((task) => {
    const effort = effortFor(model, task.key);
    return effort.minutes !== null && HEADLINE_SOURCES.has(effort.source);
  }).map((task) => task.key);
}

/** Tasks nobody has priced. Reported, never hidden. */
export function unpricedTaskKeys(model: EffortModel): readonly string[] {
  return ASSURANCE_TASKS.filter((task) => !pricedTaskKeys(model).includes(task.key)).map(
    (task) => task.key,
  );
}

/**
 * How complete the model is, as a fraction of the task catalogue.
 *
 * Reported alongside every saving, because a saving computed from two of eleven
 * tasks is a different claim from one computed from all eleven, and the reader
 * is entitled to know which they are looking at.
 */
export function modelCompleteness(model: EffortModel): number {
  return pricedTaskKeys(model).length / ASSURANCE_TASKS.length;
}
