import { bearer } from '../../tests/helpers/harness.js';
import type { ProofPortfolio } from './portfolio.js';
import type { ScenarioResult } from './scenario.js';

/**
 * What the portfolio actually shows.
 *
 * Read back through the same API an MSP operator uses. Nothing here recomputes
 * anything from the harness's own knowledge of what it built — if the queue
 * says a customer is fine and the archetype says they should not be, that is a
 * finding about the product and this must surface it rather than paper over it.
 */

export interface PortfolioSnapshot {
  readonly customers: number;
  readonly limitations: { controlTitle: string; organisationsAffected: number }[];
  readonly exceptions: {
    readonly total: number;
    readonly byKind: Record<string, number>;
    readonly bySeverity: Record<string, number>;
    readonly byResponse: Record<string, number>;
    readonly organisationsAffected: number;
    readonly organisationsNotMaintained: number;
    readonly top: {
      organisationName: string;
      kind: string;
      severity: string;
      cause: string;
      recommendedAction: string;
      rank: number;
    }[];
  };
  readonly coverage: {
    readonly byStage: Record<string, number>;
    readonly fullyCovered: number;
    readonly total: number;
    readonly organisations: {
      organisationName: string;
      stage: string;
      coverageRatio: number | null;
      controlsUnknown: number;
      controlsTotal: number;
      blockedBy: string | null;
    }[];
  };
  readonly value: {
    readonly ledger: Record<string, number>;
    readonly hoursDisplaced: number;
    readonly modelCompleteness: number;
    readonly caveats: string[];
    readonly determinationsInformative: number;
    readonly determinationsAttempted: number;
  };
  readonly scenario: ScenarioResult;
}

export async function snapshot(
  portfolio: ProofPortfolio,
  scenario: ScenarioResult,
): Promise<PortfolioSnapshot> {
  const { harness, mspId, operatorToken } = portfolio;

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await harness.server.inject({
      method: 'GET',
      url: path,
      headers: bearer(operatorToken),
    });
    if (response.statusCode !== 200) {
      throw new Error(`${path} returned ${response.statusCode}: ${response.body.slice(0, 300)}`);
    }
    return response.json() as Record<string, unknown>;
  };

  const queue = (await get(`/v1/msps/${mspId}/exceptions?limit=500`)) as unknown as {
    summary: PortfolioSnapshot['exceptions'];
    exceptions: {
      organisationName: string;
      kind: string;
      severity: string;
      cause: string;
      recommendedAction: string;
      rank: number;
    }[];
    limitations: { controlTitle: string; organisationsAffected: number }[];
  };

  const coverage = (await get(
    `/v1/msps/${mspId}/coverage`,
  )) as unknown as PortfolioSnapshot['coverage'];

  const value = (await get(`/v1/msps/${mspId}/value/report?windowDays=30`)) as unknown as {
    report: {
      ledger: Record<string, number>;
      hoursDisplaced: number;
      modelCompleteness: number;
      caveats: string[];
      determinationsInformative: number;
      determinationsAttempted: number;
    };
  };

  return {
    customers: portfolio.customers.length,
    limitations: queue.limitations,
    exceptions: {
      ...queue.summary,
      top: queue.exceptions.slice(0, 10).map((exception) => ({
        organisationName: exception.organisationName,
        kind: exception.kind,
        severity: exception.severity,
        cause: exception.cause,
        recommendedAction: exception.recommendedAction,
        rank: exception.rank,
      })),
    },
    coverage,
    value: {
      ledger: value.report.ledger,
      hoursDisplaced: value.report.hoursDisplaced,
      modelCompleteness: value.report.modelCompleteness,
      caveats: value.report.caveats,
      determinationsInformative: value.report.determinationsInformative,
      determinationsAttempted: value.report.determinationsAttempted,
    },
    scenario,
  };
}

function bar(count: number, of: number, width = 28): string {
  if (of === 0) return '';
  const filled = Math.round((count / of) * width);
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

export function print(snapshot: PortfolioSnapshot): void {
  const out = (line = ''): void => process.stdout.write(`${line}\n`);

  out();
  out('═══════════════════════════════════════════════════════════════');
  out(`  ADERICEL — ${snapshot.customers} CUSTOMER PORTFOLIO`);
  out('═══════════════════════════════════════════════════════════════');

  out();
  out('WHAT NEEDS A PERSON');
  out('───────────────────────────────────────────────────────────────');
  out(
    `  ${snapshot.exceptions.total} exception(s) across ${snapshot.exceptions.organisationsAffected} of ${snapshot.customers} customers`,
  );
  out(
    `  ${snapshot.customers - snapshot.exceptions.organisationsAffected} customer(s) need nothing at all`,
  );
  out(
    `  ${snapshot.exceptions.organisationsNotMaintained} customer(s) where assurance has STOPPED being maintained`,
  );
  out();
  out('  By what the operator has to do:');
  for (const [response, count] of Object.entries(snapshot.exceptions.byResponse).sort(
    (a, b) => b[1] - a[1],
  )) {
    out(
      `    ${response.padEnd(14)} ${String(count).padStart(4)}  ${bar(count, snapshot.exceptions.total)}`,
    );
  }
  out();
  out('  By kind:');
  for (const [kind, count] of Object.entries(snapshot.exceptions.byKind).sort(
    (a, b) => b[1] - a[1],
  )) {
    out(`    ${kind.padEnd(26)} ${String(count).padStart(4)}`);
  }

  out();
  out('  Top of the queue:');
  for (const item of snapshot.exceptions.top) {
    out(`    [${item.severity}] ${item.organisationName} — ${item.kind}`);
    out(`        ${item.cause}`);
    out(`        → ${item.recommendedAction}`);
  }

  if (snapshot.limitations.length > 0) {
    out();
    out('  NOT IN THE QUEUE — controls Adericel cannot evidence for anybody:');
    for (const limitation of snapshot.limitations) {
      out(`    ${limitation.controlTitle} (all ${limitation.organisationsAffected} customers)`);
    }
    out('    These are a limit of what Adericel can currently observe, not operator tasks.');
    out('    Raising them per customer would be a hundred people told to do the impossible.');
  }

  out();
  out('COVERAGE LADDER — how far each customer actually got');
  out('───────────────────────────────────────────────────────────────');
  const stages = [
    'NOT_CONNECTED',
    'CONNECTED',
    'AUTHENTICATED',
    'AUTHORISED',
    'DATA_AVAILABLE',
    'PREDICATES_OBSERVED',
    'ASSURANCE_COVERED',
  ];
  for (const stage of stages) {
    const count = snapshot.coverage.byStage[stage] ?? 0;
    out(
      `  ${stage.padEnd(22)} ${String(count).padStart(4)}  ${bar(count, snapshot.coverage.total)}`,
    );
  }
  out();
  out(
    `  ${snapshot.coverage.fullyCovered} of ${snapshot.coverage.total} customers are fully covered.`,
  );
  out();
  out('  How much of each customer can actually be determined:');
  const bands: [string, (r: number) => boolean][] = [
    ['90-100%', (r) => r >= 0.9],
    ['70-89%', (r) => r >= 0.7 && r < 0.9],
    ['50-69%', (r) => r >= 0.5 && r < 0.7],
    ['25-49%', (r) => r >= 0.25 && r < 0.5],
    ['under 25%', (r) => r < 0.25],
  ];
  const ratios = snapshot.coverage.organisations
    .map((o) => o.coverageRatio)
    .filter((r): r is number => r !== null);
  for (const [label, test] of bands) {
    const count = ratios.filter(test).length;
    out(
      `    ${label.padEnd(12)} ${String(count).padStart(4)}  ${bar(count, snapshot.coverage.total)}`,
    );
  }
  out();
  out('  Every control Adericel cannot determine stays UNKNOWN. None becomes a pass.');
  out();
  out('  NOTE: no customer reaches full coverage in this demonstration because the');
  out('  fixture connector supplies identity and device facts only, and the enabled');
  out('  frameworks require more than that. That is a limit of the demonstration');
  out('  connector, not of the engine — and reporting these customers as covered');
  out('  would be the exact failure this ladder exists to prevent.');

  out();
  out('WHAT ADERICEL DID');
  out('───────────────────────────────────────────────────────────────');
  for (const [key, count] of Object.entries(snapshot.value.ledger)) {
    if (typeof count === 'number' && count > 0) {
      out(`  ${key.padEnd(34)} ${String(count).padStart(7)}`);
    }
  }
  out();
  out(
    `  Determinations reaching a conclusion: ${snapshot.value.determinationsInformative} of ${snapshot.value.determinationsAttempted}`,
  );
  out(`  Remediations proposed: ${snapshot.scenario.remediationsProposed}`);
  out(`  Remediations approved by a person: ${snapshot.scenario.remediationsApproved}`);
  out(`  Remediations executed: ${snapshot.scenario.remediationsExecuted}`);
  out(`  Verifications run: ${snapshot.scenario.verificationsRun}`);

  out();
  out('TIMING');
  out('───────────────────────────────────────────────────────────────');
  for (const timing of snapshot.scenario.timings) {
    const perOrg = timing.milliseconds / Math.max(1, timing.organisations);
    out(
      `  ${timing.label.padEnd(38)} ${String(Math.round(timing.milliseconds / 1000)).padStart(4)}s  (${perOrg.toFixed(0)}ms per customer)`,
    );
  }

  out();
  out('WHAT THIS REPORT SAYS AGAINST ITSELF');
  out('───────────────────────────────────────────────────────────────');
  if (snapshot.value.caveats.length === 0) {
    out('  Nothing. That is itself worth checking.');
  }
  for (const caveat of snapshot.value.caveats) out(`  - ${caveat}`);

  out();
  out('───────────────────────────────────────────────────────────────');
  out('  No labour value is shown, because no MSP has supplied durations.');
  out('  Adericel counts what it did. Only an MSP can price it.');
  out('═══════════════════════════════════════════════════════════════');
  out();
}
