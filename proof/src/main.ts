/**
 * The hundred-customer proof.
 *
 *   pnpm proof
 *
 * Builds a heterogeneous portfolio, runs the real operating cycle across it,
 * and prints what an MSP operator would actually see. Requires the test
 * database; takes a few minutes.
 */
import { buildPortfolio } from './portfolio.js';
import { runScenario } from './scenario.js';
import { print, snapshot } from './report.js';

const portfolio = await buildPortfolio();
try {
  const scenario = await runScenario(portfolio);
  print(await snapshot(portfolio, scenario));
} finally {
  await portfolio.harness.close();
}
process.exit(0);
