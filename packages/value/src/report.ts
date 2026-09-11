import {
  ASSURANCE_TASKS,
  HEADLINE_SOURCES,
  TASK_BY_KEY,
  effortFor,
  modelCompleteness,
  unpricedTaskKeys,
  type AssuranceTask,
  type EffortModel,
  type EffortSource,
} from './effort.js';
import { interventionsByTask, type HumanInterventions } from './intervention.js';
import type { OperationalLedger } from './ledger.js';
import type { AssuranceQuality } from './quality.js';

/**
 * The proof-of-value report.
 *
 * One arithmetic, shown in full:
 *
 *   for each task:  operations Adericel performed  x  minutes the MSP supplied
 *                 = hours the MSP did not spend
 *
 *   for each task:  human interventions measured   x  the same minutes
 *                 = hours the MSP still spent
 *
 *   what it would have taken = the two added together
 *   what it took             = the second
 *
 * Note the direction of the last two lines. The baseline is DERIVED FROM
 * ADERICEL'S OWN WORKLOAD, not asserted about the MSP's past. Adericel is not
 * claiming to know what last year cost; it is saying "this is the work that got
 * done this month, here is which part of it you did, and here is your own
 * number for what the rest would have taken you". Every input is either a row
 * count or something the MSP typed.
 *
 * Every line carries the provenance of its minutes. A task whose duration
 * nobody supplied contributes nothing to the hours and appears in
 * `unpricedWork`, so the report is visibly incomplete rather than quietly
 * smaller.
 */

/** How many times Adericel performed the work behind each task. */
export type TaskVolumes = ReadonlyMap<string, number>;

/**
 * Map the ledger onto the task catalogue.
 *
 * Kept as one explicit function rather than spread across the tasks, so the
 * whole mapping from "what was counted" to "what it stands for" can be read at
 * once and argued with.
 */
export function taskVolumes(ledger: OperationalLedger): TaskVolumes {
  const volumes = new Map<string, number>();

  volumes.set('evidence.collect', ledger.evidenceCollectedAutomatically);
  volumes.set('evidence.file', ledger.evidenceCollectedAutomatically);
  /**
   * Only determinations that reached a conclusion.
   *
   * A determination of UNKNOWN is honest work and it is not displaced work. An
   * engineer who looked at the same evidence and concluded they could not tell
   * would still have the job in front of them: they would go and find out.
   * Counting UNKNOWN here would credit Adericel for the labour of producing no
   * assurance, which is the precise shape of "less work, worse outcome" that
   * this report exists to make visible rather than to hide.
   *
   * This makes the saving smaller. It is the correct number.
   */
  const informative = Math.max(0, ledger.controlDeterminations - ledger.determinationsUnknown);
  volumes.set('control.determine', informative);
  volumes.set('control.explain', informative);
  volumes.set('change.detect', ledger.changesDetected);
  // Impact analysis is only work when something actually moved as a result.
  // Counting every detected change would credit Adericel for the ones that
  // changed nothing.
  volumes.set('change.impact', ledger.assuranceTransitions);
  volumes.set('finding.triage', ledger.findingsRaised);
  // Only remediations that ran unattended. One that needed an approval is not
  // work Adericel took off the MSP; it is work it prepared, and the approval
  // itself is counted on the other side as an intervention.
  volumes.set('remediation.perform', ledger.remediationsAutonomous);
  // Only verifications that reached a conclusion. An inconclusive one did not
  // save anybody the trip.
  volumes.set('remediation.verify', ledger.verificationsConfirmed + ledger.verificationsRefuted);
  volumes.set('report.produce', ledger.passportsIssued);
  volumes.set('enquiry.answer', ledger.assuranceEnquiriesAnswered);

  return volumes;
}

export interface TaskLine {
  readonly task: AssuranceTask;
  /** Times Adericel did it. */
  readonly performedByAdericel: number;
  /** Times a person still had to. Measured from the audit trail. */
  readonly performedByPeople: number;
  readonly minutesEach: number | null;
  readonly minutesSource: EffortSource;
  readonly minutesBasis: string | null;
  /** Hours the MSP did not spend, or null when the task is unpriced. */
  readonly hoursDisplaced: number | null;
  /** Hours the MSP did spend on this task. */
  readonly hoursStillSpent: number | null;
  /** Whether this line may appear in a headline figure. */
  readonly headline: boolean;
}

export interface ProofOfValue {
  readonly mspId: string;
  readonly from: string;
  readonly to: string;
  readonly organisationCount: number;

  readonly lines: readonly TaskLine[];

  /** Hours of assurance work Adericel performed, where priced. */
  readonly hoursDisplaced: number;
  /** Hours the MSP's people still spent, where priced. */
  readonly hoursStillSpent: number;
  /**
   * The two added together: what this month's assurance work would have cost
   * entirely by hand, at the MSP's own rates.
   *
   * Derived, never asserted. It is the total volume of work that demonstrably
   * happened, priced by the MSP.
   */
  readonly hoursIfEntirelyManual: number;
  /**
   * Displaced hours as a share of the total.
   *
   * Null when nothing is priced. A ratio over an unpriced estate is not zero
   * per cent; it is no information.
   */
  readonly displacementRatio: number | null;

  /**
   * How much of the picture the arithmetic covers.
   *
   * Reported at the same prominence as the saving, because a saving computed
   * from three of eleven tasks is a different claim from one computed from all
   * eleven, and the reader is entitled to know which they are reading.
   */
  readonly modelCompleteness: number;
  readonly unpricedWork: readonly {
    taskKey: string;
    title: string;
    performedByAdericel: number;
    reason: string;
  }[];
  /**
   * Human actions that count as assurance work but map to no task. Priced at
   * nothing, so the residual is understated by however many these are — stated
   * rather than hidden, because understating the residual inflates the saving.
   */
  readonly unclassifiedInterventions: number;

  /**
   * Determinations that reached a conclusion, out of all that were made.
   *
   * Reported at the top of the document rather than buried, because a portfolio
   * where most controls answer UNKNOWN has an observation problem, and a saving
   * measured on it is a saving on the labour of not knowing.
   */
  readonly determinationsInformative: number;
  readonly determinationsAttempted: number;
  /** Informative as a share of attempted. Null when none were attempted. */
  readonly informativeRate: number | null;

  readonly ledger: OperationalLedger;
  readonly interventions: HumanInterventions;
  readonly quality: AssuranceQuality;

  /**
   * Every reason this report should be read with caution, assembled by the
   * code that knows about them rather than left for a reader to notice.
   */
  readonly caveats: readonly string[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildProofOfValue(input: {
  readonly mspId: string;
  readonly model: EffortModel;
  readonly ledger: OperationalLedger;
  readonly interventions: HumanInterventions;
  readonly quality: AssuranceQuality;
}): ProofOfValue {
  const { mspId, model, ledger, interventions, quality } = input;
  const volumes = taskVolumes(ledger);
  const byTask = interventionsByTask(interventions);
  const informativeDeterminations = Math.max(
    0,
    ledger.controlDeterminations - ledger.determinationsUnknown,
  );

  const lines: TaskLine[] = ASSURANCE_TASKS.map((task) => {
    const effort = effortFor(model, task.key);
    const performedByAdericel = volumes.get(task.key) ?? 0;
    const performedByPeople = byTask.get(task.key) ?? 0;
    const headline = effort.minutes !== null && HEADLINE_SOURCES.has(effort.source);
    const minutes = effort.minutes;

    return {
      task,
      performedByAdericel,
      performedByPeople,
      minutesEach: minutes,
      minutesSource: effort.source,
      minutesBasis: effort.basis,
      hoursDisplaced:
        headline && minutes !== null ? round((performedByAdericel * minutes) / 60) : null,
      hoursStillSpent:
        headline && minutes !== null ? round((performedByPeople * minutes) / 60) : null,
      headline,
    };
  });

  const hoursDisplaced = round(
    lines.reduce((total, line) => total + (line.hoursDisplaced ?? 0), 0),
  );
  const hoursStillSpent = round(
    lines.reduce((total, line) => total + (line.hoursStillSpent ?? 0), 0),
  );
  const hoursIfEntirelyManual = round(hoursDisplaced + hoursStillSpent);

  const unpriced = unpricedTaskKeys(model).map((taskKey) => {
    const effort = effortFor(model, taskKey);
    const task = TASK_BY_KEY.get(taskKey);
    return {
      taskKey,
      title: task?.title ?? taskKey,
      performedByAdericel: volumes.get(taskKey) ?? 0,
      reason:
        effort.source === 'INDUSTRY_REFERENCE'
          ? 'Priced from a published figure rather than by this MSP. Usable for illustration, ' +
            'not for a claim about this business.'
          : 'No duration supplied.',
    };
  });

  return {
    mspId,
    from: ledger.from,
    to: ledger.to,
    organisationCount: ledger.organisationIds.length,
    lines,
    hoursDisplaced,
    hoursStillSpent,
    hoursIfEntirelyManual,
    displacementRatio: hoursIfEntirelyManual === 0 ? null : hoursDisplaced / hoursIfEntirelyManual,
    modelCompleteness: modelCompleteness(model),
    unpricedWork: unpriced,
    unclassifiedInterventions: interventions.unclassified,
    determinationsInformative: informativeDeterminations,
    determinationsAttempted: ledger.controlDeterminations,
    informativeRate:
      ledger.controlDeterminations === 0
        ? null
        : informativeDeterminations / ledger.controlDeterminations,
    ledger,
    interventions,
    quality,
    caveats: caveatsFor({ model, ledger, interventions, quality, hoursIfEntirelyManual }),
  };
}

/**
 * Everything wrong with this report, said by the report.
 *
 * A proof-of-value document that lists its own weaknesses is more persuasive
 * than one that does not, and it is the only version consistent with a product
 * whose entire claim is that it does not overstate what it knows.
 */
function caveatsFor(input: {
  model: EffortModel;
  ledger: OperationalLedger;
  interventions: HumanInterventions;
  quality: AssuranceQuality;
  hoursIfEntirelyManual: number;
}): readonly string[] {
  const { model, ledger, interventions, quality, hoursIfEntirelyManual } = input;
  const caveats: string[] = [];

  const completeness = modelCompleteness(model);
  if (completeness === 0) {
    caveats.push(
      'No durations have been supplied, so no hours can be calculated. The operation counts ' +
        'below are real; what they are worth is a question only this MSP can answer.',
    );
  } else if (completeness < 1) {
    caveats.push(
      `Durations have been supplied for ${Math.round(completeness * 100)}% of the task ` +
        'catalogue. The hours below therefore understate both the work displaced and the work ' +
        'still being done.',
    );
  }

  if (interventions.unclassified > 0) {
    caveats.push(
      `${interventions.unclassified} human action(s) were recorded that map to no task in the ` +
        'catalogue. They are counted as interventions but priced at nothing, so the hours still ' +
        'being spent are understated.',
    );
  }

  if (ledger.remediationsUnverified > 0) {
    caveats.push(
      `${ledger.remediationsUnverified} remediation(s) were dispatched without their outcome ` +
        'being established. They are not counted as work done, because an attempted change is ' +
        'not a completed one.',
    );
  }

  if (ledger.evidenceSuppliedByHuman > 0) {
    caveats.push(
      `${ledger.evidenceSuppliedByHuman} piece(s) of evidence had to be supplied by a person. ` +
        'That is work Adericel did not remove.',
    );
  }

  const attempted = ledger.controlDeterminations;
  const informative = Math.max(0, attempted - ledger.determinationsUnknown);
  if (attempted > 0 && informative / attempted < 0.5) {
    caveats.push(
      `Only ${informative} of ${attempted} determination(s) reached a conclusion; the rest ` +
        'answered UNKNOWN. Adericel is not seeing enough of these estates to determine most ' +
        'controls, and a saving measured on a portfolio in that state is a saving on the labour ' +
        'of not knowing. Connect more evidence sources before quoting these figures.',
    );
  }

  if (quality.unresolvedGaps > 0) {
    caveats.push(
      `${quality.unresolvedGaps} control(s) have been UNKNOWN for more than 30 days. Reduced ` +
        'labour on an estate with unresolved gaps is not the same as better assurance.',
    );
  }

  if (quality.staleEvidenceItems > 0) {
    caveats.push(
      `${quality.staleEvidenceItems} piece(s) of supporting evidence are more than 30 days old.`,
    );
  }

  if (hoursIfEntirelyManual > 0 && ledger.organisationIds.length < 3) {
    caveats.push(
      'This covers fewer than three organisations. A figure from a small sample extrapolates ' +
        'badly, and should not be multiplied up to a portfolio.',
    );
  }

  return caveats;
}
