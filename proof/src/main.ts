/**
 * The hundred-customer proof.
 *
 *   pnpm proof
 *
 * Builds a heterogeneous portfolio, runs the real operating cycle across it,
 * and prints what an MSP operator would actually see. Requires the test
 * database; takes a few minutes.
 */
import { bearer } from '../../tests/helpers/harness.js';
import { buildPortfolio } from './portfolio.js';
import { runScenario } from './scenario.js';
import { print, snapshot } from './report.js';

const portfolio = await buildPortfolio();
try {
  const scenario = await runScenario(portfolio);
  print(await snapshot(portfolio, scenario));

  // The loop, run as one recorded pass over the whole portfolio, and then the
  // commercial question it exists to answer.
  process.stdout.write('\nRunning one full loop cycle across the portfolio…\n');
  const cycle = await portfolio.harness.server.inject({
    method: 'POST',
    url: `/v1/msps/${portfolio.mspId}/loop/cycles`,
    headers: bearer(portfolio.operatorToken),
    payload: { collect: false },
  });
  const recorded = cycle.json() as {
    organisationsInScope: number;
    determinationsMade: number;
    exceptionsNeedingHuman: number;
    stageTimings: { stage: string; milliseconds: number }[];
    organisationsSkipped: unknown[];
  };

  process.stdout.write('\nONE LOOP CYCLE\n');
  process.stdout.write('───────────────────────────────────────────────────────────────\n');
  process.stdout.write(`  organisations in scope        ${recorded.organisationsInScope}\n`);
  process.stdout.write(`  determinations made           ${recorded.determinationsMade}\n`);
  process.stdout.write(`  exceptions needing a person   ${recorded.exceptionsNeedingHuman}\n`);
  process.stdout.write(`  organisations skipped         ${recorded.organisationsSkipped.length}\n`);
  for (const timing of recorded.stageTimings) {
    const perOrg = timing.milliseconds / Math.max(1, recorded.organisationsInScope);
    process.stdout.write(
      `  ${timing.stage.padEnd(28)}  ${String(Math.round(timing.milliseconds / 1000)).padStart(4)}s  (${perOrg.toFixed(0)}ms per customer)\n`,
    );
  }

  // Capacity, before and after the MSP supplies its own numbers.
  const before = await portfolio.harness.server.inject({
    method: 'GET',
    url: `/v1/msps/${portfolio.mspId}/capacity?windowDays=30`,
    headers: bearer(portfolio.operatorToken),
  });
  const beforeReport = before.json() as { capacity: { basis: string; missing?: string[] } };

  process.stdout.write('\nCAPACITY — before the MSP has supplied anything\n');
  process.stdout.write('───────────────────────────────────────────────────────────────\n');
  process.stdout.write(`  ${beforeReport.capacity.basis}\n`);
  for (const missing of beforeReport.capacity.missing ?? []) {
    process.stdout.write(`  - ${missing}\n`);
  }

  for (const [responseType, minutes] of [
    ['DECIDE', 6],
    ['CONFIGURE', 20],
    ['INVESTIGATE', 45],
    ['ASK_CUSTOMER', 15],
  ] as const) {
    await portfolio.harness.server.inject({
      method: 'PUT',
      url: `/v1/msps/${portfolio.mspId}/capacity/response-effort/${responseType}`,
      headers: bearer(portfolio.operatorToken),
      payload: { minutes, source: 'MSP_MEASURED', basis: 'Typed into the demonstration script' },
    });
  }
  await portfolio.harness.server.inject({
    method: 'PUT',
    url: `/v1/msps/${portfolio.mspId}/capacity/engineer-hours`,
    headers: bearer(portfolio.operatorToken),
    payload: { hoursPerMonth: 130, basis: 'Typed into the demonstration script' },
  });

  const after = await portfolio.harness.server.inject({
    method: 'GET',
    url: `/v1/msps/${portfolio.mspId}/capacity?windowDays=30`,
    headers: bearer(portfolio.operatorToken),
  });
  const afterReport = after.json() as {
    capacity: {
      basis: string;
      customersPerEngineer: number;
      hoursPerCustomerPerMonth: number;
      hoursByResponseType: Record<string, number>;
      autonomousShare: number | null;
      caveats: string[];
    };
  };

  process.stdout.write('\nCAPACITY — with durations supplied\n');
  process.stdout.write('───────────────────────────────────────────────────────────────\n');
  if (afterReport.capacity.basis === 'MEASURED') {
    const c = afterReport.capacity;
    process.stdout.write(`  hours per customer per month   ${c.hoursPerCustomerPerMonth}\n`);
    for (const [type, hours] of Object.entries(c.hoursByResponseType)) {
      process.stdout.write(`    ${type.padEnd(14)} ${String(hours).padStart(6)}h\n`);
    }
    process.stdout.write(`\n  CUSTOMERS PER ENGINEER         ${c.customersPerEngineer}\n\n`);
    for (const caveat of c.caveats) process.stdout.write(`  - ${caveat}\n`);
  } else {
    process.stdout.write(`  ${afterReport.capacity.basis}\n`);
  }
  process.stdout.write(
    '\n  The durations above were typed into this script, not measured by an MSP.\n',
  );
} finally {
  await portfolio.harness.close();
}
process.exit(0);
