import { describe, expect, it } from 'vitest';
import {
  ASSURANCE_TASKS,
  buildEffortModel,
  modelCompleteness,
  unpriced,
  type TaskEffort,
} from './effort.js';
import type { HumanInterventions } from './intervention.js';
import type { OperationalLedger } from './ledger.js';
import type { AssuranceQuality } from './quality.js';
import { buildProofOfValue, taskVolumes } from './report.js';
import { MINIMUM_SAMPLE_ORGANISATIONS, project } from './projection.js';

/**
 * The proof-of-value arithmetic, and the rules that keep it honest.
 *
 * The interesting tests here are not the ones that check the sums. They are the
 * ones that check the sums REFUSE to be produced: no duration means no hours,
 * an industry citation never becomes this MSP's own number, and a projection
 * from two customers to a hundred is declined rather than disclaimed.
 *
 * A proof-of-value engine that will produce a big number when pressed is worth
 * nothing to the person being sold to, and this is where that is enforced.
 */

const FROM = '2026-08-11T00:00:00.000Z';
const TO = '2026-09-10T00:00:00.000Z';

function ledger(overrides: Partial<OperationalLedger> = {}): OperationalLedger {
  return {
    from: FROM,
    to: TO,
    organisationIds: ['a', 'b', 'c', 'd', 'e'],
    observationsCollected: 5000,
    evidenceCollectedAutomatically: 1200,
    evidenceSuppliedByHuman: 0,
    claimsAsserted: 3000,
    changesDetected: 180,
    conflictsRefused: 0,
    controlDeterminations: 900,
    assuranceTransitions: 120,
    determinationsUnknown: 40,
    findingsRaised: 60,
    remediationsProposed: 80,
    remediationsAutonomous: 55,
    remediationsApproved: 20,
    remediationsUnverified: 0,
    remediationsFailed: 5,
    verificationsPerformed: 75,
    verificationsConfirmed: 70,
    verificationsRefuted: 3,
    passportsIssued: 5,
    assuranceEnquiriesAnswered: 12,
    ...overrides,
  };
}

function interventions(overrides: Partial<HumanInterventions> = {}): HumanInterventions {
  return {
    from: FROM,
    to: TO,
    organisationIds: ['a', 'b', 'c', 'd', 'e'],
    byAction: [
      { auditAction: 'action:approved', taskKey: 'remediation.perform', count: 20 },
      { auditAction: 'finding:update', taskKey: 'finding.triage', count: 15 },
    ],
    total: 35,
    classified: 35,
    unclassified: 0,
    peopleInvolved: 2,
    excluded: 40,
    ...overrides,
  };
}

function quality(overrides: Partial<AssuranceQuality> = {}): AssuranceQuality {
  return {
    from: FROM,
    to: TO,
    organisationIds: ['a', 'b', 'c', 'd', 'e'],
    medianEvidenceAgeHours: 6,
    oldestEvidenceAgeHours: 200,
    staleEvidenceItems: 0,
    evidenceSupportingClaims: 1200,
    unknownControls: 40,
    oldestUnknownDays: 12,
    unresolvedGaps: 0,
    controlsDetermined: 180,
    controlsTotal: 180,
    determinationCoverage: 1,
    staleDeterminations: 0,
    disputedClaims: 0,
    ...overrides,
  };
}

function priced(taskKey: string, minutes: number): TaskEffort {
  return {
    taskKey,
    minutes,
    source: 'MSP_MEASURED',
    basis: 'Timed across ten samples in August',
    recordedAt: FROM,
  };
}

/** Every task priced at the same duration, for arithmetic that is easy to check. */
function fullyPricedModel(minutes = 6): ReturnType<typeof buildEffortModel> {
  return buildEffortModel(
    'msp-1',
    ASSURANCE_TASKS.map((task) => priced(task.key, minutes)),
  );
}

describe('nothing is invented', () => {
  it('produces no hours at all when nobody has supplied a duration', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: buildEffortModel('msp-1', []),
      ledger: ledger(),
      interventions: interventions(),
      quality: quality(),
    });

    // Adericel performed thousands of operations. It still refuses to say what
    // they were worth, because nobody has told it.
    expect(report.hoursDisplaced).toBe(0);
    expect(report.hoursStillSpent).toBe(0);
    expect(report.displacementRatio).toBeNull();
    expect(report.modelCompleteness).toBe(0);
    expect(report.unpricedWork).toHaveLength(ASSURANCE_TASKS.length);
    expect(report.caveats[0]).toContain('No durations have been supplied');
  });

  it('still reports the work it actually did', () => {
    // The operation counts are Adericel's to assert. Only the pricing is not.
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: buildEffortModel('msp-1', []),
      ledger: ledger(),
      interventions: interventions(),
      quality: quality(),
    });
    const collect = report.lines.find((line) => line.task.key === 'evidence.collect');
    expect(collect?.performedByAdericel).toBe(1200);
    expect(collect?.hoursDisplaced).toBeNull();
  });

  it("refuses to let a published figure become this MSP's own number", () => {
    const model = buildEffortModel('msp-1', [
      {
        taskKey: 'control.determine',
        minutes: 9,
        source: 'INDUSTRY_REFERENCE',
        basis: 'A vendor survey',
        recordedAt: FROM,
      },
    ]);
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model,
      ledger: ledger(),
      interventions: interventions(),
      quality: quality(),
    });

    // 900 determinations x 9 minutes would be 135 hours. It contributes nothing,
    // because it is a claim about somebody else's business.
    expect(report.hoursDisplaced).toBe(0);
    const line = report.lines.find((l) => l.task.key === 'control.determine');
    expect(line?.headline).toBe(false);
    expect(line?.minutesSource).toBe('INDUSTRY_REFERENCE');
    expect(report.unpricedWork.find((w) => w.taskKey === 'control.determine')?.reason).toContain(
      'not for a claim about this business',
    );
  });

  it('has no default duration anywhere', () => {
    // The guarantee, checked directly: an unpriced task is UNKNOWN with null
    // minutes, and there is no code path that fills one in.
    for (const task of ASSURANCE_TASKS) {
      const effort = unpriced(task.key);
      expect(effort.minutes).toBeNull();
      expect(effort.source).toBe('UNKNOWN');
    }
    expect(modelCompleteness(buildEffortModel('msp-1', []))).toBe(0);
  });
});

describe('the arithmetic', () => {
  const report = buildProofOfValue({
    mspId: 'msp-1',
    model: fullyPricedModel(6),
    ledger: ledger(),
    interventions: interventions(),
    quality: quality(),
  });

  it('multiplies operations by the supplied minutes and nothing else', () => {
    const collect = report.lines.find((line) => line.task.key === 'evidence.collect');
    // 1200 items x 6 minutes = 7200 minutes = 120 hours.
    expect(collect?.hoursDisplaced).toBe(120);
  });

  it('counts an approved remediation as work the MSP still did', () => {
    // The distinction the commercial case rests on. 55 ran unattended; 20
    // needed a person, and that person's time is on the other side of the sum.
    const perform = report.lines.find((line) => line.task.key === 'remediation.perform');
    expect(perform?.performedByAdericel).toBe(55);
    expect(perform?.performedByPeople).toBe(20);
    expect(perform?.hoursDisplaced).toBe(5.5);
    expect(perform?.hoursStillSpent).toBe(2);
  });

  it('derives the manual baseline from work that demonstrably happened', () => {
    // Never asserted about the MSP's past. It is displaced plus residual: the
    // total volume of work that actually occurred, priced by the MSP.
    expect(report.hoursIfEntirelyManual).toBe(
      Math.round((report.hoursDisplaced + report.hoursStillSpent) * 100) / 100,
    );
    expect(report.displacementRatio).toBeGreaterThan(0.9);
  });

  it('excludes remediations that were never verified', () => {
    const volumes = taskVolumes(ledger({ remediationsAutonomous: 55, remediationsUnverified: 30 }));
    // An attempted change is not a completed one, and does not earn credit.
    expect(volumes.get('remediation.perform')).toBe(55);
  });

  it('counts only verifications that reached a conclusion', () => {
    const volumes = taskVolumes(
      ledger({ verificationsPerformed: 100, verificationsConfirmed: 70, verificationsRefuted: 3 }),
    );
    // 27 were inconclusive. Nobody was saved a trip by those.
    expect(volumes.get('remediation.verify')).toBe(73);
  });

  it('credits impact analysis only where the assurance actually moved', () => {
    const volumes = taskVolumes(ledger({ changesDetected: 180, assuranceTransitions: 120 }));
    expect(volumes.get('change.detect')).toBe(180);
    expect(volumes.get('change.impact')).toBe(120);
  });
});

describe('the report argues against itself where it should', () => {
  it('says so when human actions are counted but not priced', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger(),
      interventions: interventions({ unclassified: 14, total: 49 }),
      quality: quality(),
    });
    expect(report.unclassifiedInterventions).toBe(14);
    expect(report.caveats.join(' ')).toContain('understated');
  });

  it('says so when remediations were dispatched with no established outcome', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger({ remediationsUnverified: 9 }),
      interventions: interventions(),
      quality: quality(),
    });
    expect(report.caveats.join(' ')).toContain('outcome being established');
  });

  it('refuses to let reduced labour read as better assurance when gaps are open', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger(),
      interventions: interventions(),
      quality: quality({ unresolvedGaps: 7 }),
    });
    expect(report.caveats.join(' ')).toContain('not the same as better assurance');
  });

  it('warns when the sample is too small to generalise from', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger({ organisationIds: ['only-one'] }),
      interventions: interventions(),
      quality: quality(),
    });
    expect(report.caveats.join(' ')).toContain('fewer than three organisations');
  });
});

describe('projecting to a hundred customers', () => {
  const report = buildProofOfValue({
    mspId: 'msp-1',
    model: fullyPricedModel(6),
    ledger: ledger(),
    interventions: interventions(),
    quality: quality(),
  });

  it('refuses a projection from too small a portfolio', () => {
    const thin = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger({ organisationIds: ['a', 'b'] }),
      interventions: interventions(),
      quality: quality(),
    });
    const result = project(thin, { targetOrganisations: 100, ftePerMonthHours: 130 });
    expect(result.basis).toBe('REFUSED');
    if (result.basis === 'REFUSED') {
      expect(result.reason).toContain('cannot be built from 2');
      // The comparison that gives the refusal its weight.
      expect(result.reason).toContain('unverified control');
    }
    expect(MINIMUM_SAMPLE_ORGANISATIONS).toBe(3);
  });

  it('refuses a projection when nothing is priced', () => {
    const unpricedReport = buildProofOfValue({
      mspId: 'msp-1',
      model: buildEffortModel('msp-1', []),
      ledger: ledger(),
      interventions: interventions(),
      quality: quality(),
    });
    const result = project(unpricedReport, { targetOrganisations: 100, ftePerMonthHours: 130 });
    expect(result.basis).toBe('REFUSED');
  });

  it('projects, and labels the result as projected', () => {
    const result = project(report, { targetOrganisations: 100, ftePerMonthHours: 130 });
    expect(result.basis).toBe('PROJECTED');
    if (result.basis !== 'PROJECTED') return;

    expect(result.sampleOrganisations).toBe(5);
    expect(result.targetOrganisations).toBe(100);
    // Twenty times the sample, so twenty times the hours.
    expect(result.hoursWithoutAdericel).toBeGreaterThan(result.hoursWithAdericel);
    expect(result.hoursReleased).toBe(
      Math.round((result.hoursWithoutAdericel - result.hoursWithAdericel) * 100) / 100,
    );
    expect(result.fteWithoutAdericel).toBeGreaterThan(result.fteWithAdericel);
  });

  it('reports no FTE figure when nobody has said what a full-time month is', () => {
    const result = project(report, { targetOrganisations: 100, ftePerMonthHours: null });
    expect(result.basis).toBe('PROJECTED');
    if (result.basis !== 'PROJECTED') return;
    // Zero rather than a plausible 140, because a default here would silently
    // decide the headline.
    expect(result.fteWithoutAdericel).toBe(0);
    expect(result.ftePerMonthHours).toBe(0);
  });

  it('carries every caveat from the report it was built on', () => {
    const flawed = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger({ remediationsUnverified: 4 }),
      interventions: interventions(),
      quality: quality({ unresolvedGaps: 2 }),
    });
    const result = project(flawed, { targetOrganisations: 100, ftePerMonthHours: 130 });
    if (result.basis !== 'PROJECTED') throw new Error('expected a projection');
    expect(result.caveats.join(' ')).toContain('outcome being established');
    expect(result.caveats.join(' ')).toContain('not the same as better assurance');
    expect(result.caveats.join(' ')).toContain('neither is modelled here');
  });
});

describe('the labour of not knowing is not a saving', () => {
  it('does not credit determinations that answered UNKNOWN', () => {
    // Found by running the machine against a real portfolio: 75 of 85
    // determinations came back UNKNOWN, because the estates were barely
    // observed — and every one of them was being counted as displaced work.
    // An engineer who concluded "I cannot tell" would still have the job in
    // front of them.
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(6),
      ledger: ledger({ controlDeterminations: 85, determinationsUnknown: 75 }),
      interventions: interventions(),
      quality: quality(),
    });

    const determine = report.lines.find((line) => line.task.key === 'control.determine');
    expect(determine?.performedByAdericel).toBe(10);
    expect(determine?.hoursDisplaced).toBe(1);
    expect(report.determinationsInformative).toBe(10);
    expect(report.determinationsAttempted).toBe(85);
  });

  it('says plainly when most of the portfolio is UNKNOWN', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger({ controlDeterminations: 85, determinationsUnknown: 75 }),
      interventions: interventions(),
      quality: quality(),
    });
    expect(report.caveats.join(' ')).toContain('the labour of not knowing');
    expect(report.caveats.join(' ')).toContain('Connect more evidence sources');
  });

  it('leaves a well-observed portfolio uncaveated on that point', () => {
    const report = buildProofOfValue({
      mspId: 'msp-1',
      model: fullyPricedModel(),
      ledger: ledger({ controlDeterminations: 100, determinationsUnknown: 5 }),
      interventions: interventions(),
      quality: quality(),
    });
    expect(report.informativeRate).toBeCloseTo(0.95, 2);
    expect(report.caveats.join(' ')).not.toContain('the labour of not knowing');
  });
});
