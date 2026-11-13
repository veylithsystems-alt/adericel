import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nullLogger } from '@adericel/shared';
import { dispatchOnce } from '../../apps/worker/src/dispatcher.js';
import { databaseAvailable } from '../helpers/harness.js';
import { PORTFOLIO_SIZE } from '../../proof/src/archetypes.js';
import { buildPortfolio, type ProofPortfolio } from '../../proof/src/portfolio.js';

/**
 * What Adericel does at the scale somebody would actually sell.
 *
 * WHY THIS SUITE EXISTS, STATED PRECISELY
 *
 * The chaos suite established something uncomfortable: a product-killing
 * defect — a healthy estate going undetermined on day seven — sat behind 1,677
 * passing tests, and the only thing that found it was opening a dimension
 * nothing had tested. Moving the clock.
 *
 * Two dimensions remain. **Scale** is this suite. **Sustained operation** is
 * `tests/soak`. The inference is not "the code is probably fine"; it is
 * "whatever is wrong at a hundred customers is invisible until something runs
 * a hundred customers", and that is a reason to run one rather than a reason
 * to reason about one.
 *
 * WHAT THIS SUITE ASSERTS, AND WHAT IT REFUSES TO ASSERT
 *
 * It asserts **properties that must hold at any scale** — no organisation
 * silently dropped, every organisation reaching either a determination or a
 * recorded reason it did not, no cross-tenant leakage under concurrency, the
 * outbox draining.
 *
 * It does **not** assert a performance budget in milliseconds. A threshold
 * invented here would be a target dressed as a measurement, which is the exact
 * dishonesty this product refuses to commit against its customers and would be
 * incoherent to commit against ourselves. It would also fail on a slower CI
 * runner for no reason anybody could act on.
 *
 * What it does instead is **measure, and assert the shape of the curve.** A
 * sweep whose cost per organisation rises as the portfolio grows has an N+1
 * query or a missing index in it, and that is a defect at any absolute speed.
 * A sweep that is uniformly slow is a capacity question for an operator with
 * a real machine, and this suite prints the number rather than judging it.
 */

const available = await databaseAvailable();

/**
 * Provisioning a hundred tenants and sweeping them twice is minutes of work,
 * not seconds. Deliberately generous: a timeout tuned so tightly that a slow
 * runner trips it teaches people to re-run a red suite, which is worse than
 * having no suite.
 */
const LOAD_TIMEOUT_MS = 30 * 60 * 1000;

interface Measurement {
  readonly label: string;
  readonly organisations: number;
  readonly milliseconds: number;
  readonly perOrganisationMs: number;
}

const measurements: Measurement[] = [];

async function measure<T>(label: string, organisations: number, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const value = await fn();
  const milliseconds = Date.now() - started;
  measurements.push({
    label,
    organisations,
    milliseconds,
    perOrganisationMs: organisations === 0 ? 0 : milliseconds / organisations,
  });
  return value;
}

describe.skipIf(!available)('Adericel at portfolio scale', () => {
  let portfolio: ProofPortfolio;

  beforeAll(async () => {
    portfolio = await measure('provision the portfolio', PORTFOLIO_SIZE, () =>
      buildPortfolio({ quiet: true }),
    );
  }, LOAD_TIMEOUT_MS);

  afterAll(async () => {
    /**
     * The measurements, printed rather than asserted.
     *
     * An operator sizing a machine needs the numbers; a test suite has no
     * business deciding whether they are acceptable on somebody else's
     * hardware. Printed on completion so a CI log carries them.
     */
    if (measurements.length > 0) {
      const lines = measurements.map(
        (m) =>
          `  ${m.label.padEnd(44)} ${String(m.organisations).padStart(4)} orgs  ` +
          `${String(m.milliseconds).padStart(8)} ms  ` +
          `${m.perOrganisationMs.toFixed(1).padStart(8)} ms/org`,
      );
      process.stdout.write(`\nMeasured at portfolio scale:\n${lines.join('\n')}\n`);
    }
    await portfolio?.harness.close();
  });

  it(`provisions ${PORTFOLIO_SIZE} organisations under one MSP`, () => {
    /**
     * The premise, asserted before anything is measured.
     *
     * A load suite that silently ran against four organisations would report
     * excellent numbers and prove nothing — which is precisely how the chaos
     * suite began, green and vacuous. If the fixture shrinks, this fails
     * first and the rest of the file is not believed.
     */
    expect(portfolio.customers.length).toBe(PORTFOLIO_SIZE);
    expect(PORTFOLIO_SIZE).toBeGreaterThanOrEqual(100);

    // One MSP, not a hundred businesses of one. A portfolio where each
    // customer had its own MSP would exercise none of the cross-organisation
    // work an MSP actually does.
    const msps = new Set(portfolio.customers.map((c) => c.tenant.mspId));
    expect(msps.size, 'the portfolio is not under a single MSP').toBe(1);
  });

  it(
    'collects from every organisation without dropping any',
    async () => {
      const organisationIds = portfolio.customers.map((c) => c.tenant.organisationId);

      const result = await measure('collect across the portfolio', organisationIds.length, () =>
        portfolio.harness.runJob('collect-integrations'),
      );

      /**
       * The batch limit, which is the thing most likely to be wrong here.
       *
       * `collect-integrations` with no organisation processes a batch. If that
       * batch is smaller than the portfolio, most customers are silently not
       * collected from — and every one of them would look healthy, because their
       * last reading is still inside its freshness window. That is the day-seven
       * defect again, arriving by a different route.
       */
      /**
       * Every organisation with any run at all, not runs within a window.
       *
       * `integration_runs.started_at` comes from the injected clock, not the
       * database's `now()`, so a `now() - interval '1 hour'` filter excluded
       * every row and reported that 100 of 100 organisations were never
       * collected from. The portfolio is built on a truncated database, so any
       * run present is a run from this test and no window is needed.
       *
       * Worth recording because it is the second time in this work that a
       * manual clock made a time-filtered query silently empty. A test that
       * matches nothing fails loudly here and would pass silently in a query
       * that counted rather than compared.
       */
      const collected = await portfolio.harness.db.withPlatform(async (ctx) =>
        ctx.many<{ organisation_id: string }>(
          `SELECT DISTINCT organisation_id FROM integration_runs`,
        ),
      );
      const missed = organisationIds.filter(
        (id) => !collected.some((row) => row.organisation_id === id),
      );
      expect(
        missed.length,
        `${missed.length} of ${organisationIds.length} organisations were never collected from. ` +
          'A batch limit below the portfolio size silently stops collecting from most customers, ' +
          'and every one of them keeps looking healthy until its evidence ages out.',
      ).toBe(0);

      expect(result.status).toBe('SUCCEEDED');
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    'assesses every organisation, or records why it did not',
    async () => {
      await measure('reassess across the portfolio', portfolio.customers.length, () =>
        portfolio.harness.runJob('reassess-organisation'),
      );

      /**
       * The property that matters more than any timing.
       *
       * An organisation that was skipped must be skipped *for a reason that is
       * on record*. A sweep that quietly drops the last forty customers of a
       * hundred produces a portfolio view that is confidently wrong about forty
       * businesses, and nothing on the screen would say so.
       */
      const assessed = await portfolio.harness.db.withPlatform(async (ctx) =>
        ctx.many<{ organisation_id: string; controls: string }>(
          `SELECT organisation_id, count(*)::text AS controls
           FROM assurance_states WHERE subject_kind = 'CONTROL'
          GROUP BY organisation_id`,
        ),
      );

      const maintained = await portfolio.harness.db.withPlatform(async (ctx) =>
        ctx.many<{ id: string }>(
          `SELECT id FROM organisations WHERE status = 'ACTIVE' AND assurance_maintained`,
        ),
      );

      const unassessed = maintained.filter(
        (org) => !assessed.some((row) => row.organisation_id === org.id),
      );
      expect(
        unassessed.length,
        `${unassessed.length} organisations are being maintained and have no assessed control. ` +
          'Either the sweep dropped them or it has a batch limit below the portfolio size.',
      ).toBe(0);
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    'does not get more expensive per organisation as the portfolio grows',
    async () => {
      /**
       * The shape of the curve, which is the only timing assertion worth making.
       *
       * A sweep of ten organisations and a sweep of a hundred are compared by
       * cost *per organisation*. Linear work gives roughly the same figure;
       * superlinear work — an N+1 query, a missing index, a per-organisation
       * scan of a shared table — gives a figure that climbs, and that is a
       * defect at any absolute speed.
       *
       * The tolerance is wide on purpose. This is a shared machine running a
       * database, and distinguishing 1.1× from 1.3× here would measure the
       * runner's mood. A factor of four is not noise: it is a complexity class.
       */
      const subset = portfolio.customers.slice(0, 10).map((c) => c.tenant.organisationId);

      let smallMs = 0;
      for (const organisationId of subset) {
        const started = Date.now();
        await portfolio.harness.runJob('reassess-organisation', organisationId);
        smallMs += Date.now() - started;
      }
      const smallPerOrg = smallMs / subset.length;

      const fullStarted = Date.now();
      await portfolio.harness.runJob('reassess-organisation');
      const fullPerOrg = (Date.now() - fullStarted) / portfolio.customers.length;

      measurements.push({
        label: 'reassess, 10 organisations one at a time',
        organisations: subset.length,
        milliseconds: smallMs,
        perOrganisationMs: smallPerOrg,
      });

      /**
       * Compared in the direction that can only indicate a defect.
       *
       * A batch sweep being *faster* per organisation than one-at-a-time is
       * expected and good — fixed costs amortise. The failure being tested for
       * is the batch being dramatically *slower* per organisation, which means
       * the cost of each organisation grows with how many others exist.
       */
      expect(
        fullPerOrg,
        `A full sweep costs ${fullPerOrg.toFixed(1)} ms/org against ` +
          `${smallPerOrg.toFixed(1)} ms/org one at a time. Cost per organisation that climbs with ` +
          'portfolio size is superlinear work — an N+1 query or a missing index — and it will not ' +
          'be fixed by a bigger machine.',
      ).toBeLessThan(Math.max(smallPerOrg * 4, 250));
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    'drains the outbox rather than accumulating it',
    async () => {
      /**
       * A sweep of a hundred customers publishes thousands of domain events. If
       * dispatch cannot keep up with production, the backlog grows every cycle
       * and the system is already failing on the day it is installed — visible
       * only as notifications arriving later and later.
       *
       * Dispatch is not a scheduled job; it is its own loop in the worker
       * process, so this drives `dispatchOnce` directly rather than through
       * `runJob`. A test that invented a job name would have passed by doing
       * nothing, which is why the names here were checked against
       * `buildHandlers` rather than assumed.
       */
      const pending = async (): Promise<number> =>
        portfolio.harness.db.withPlatform(async (ctx) => {
          const row = await ctx.oneOrFail<{ pending: string }>(
            `SELECT count(*)::text AS pending FROM outbox_events WHERE state = 'PENDING'`,
            [],
            'Outbox count',
          );
          return Number(row.pending);
        });

      const before = await pending();
      // The premise. A drain test over an empty outbox proves nothing, and a
      // hundred-customer sweep that published no events would itself be a
      // finding.
      expect(before, 'a full portfolio sweep published no domain events at all').toBeGreaterThan(0);

      /**
       * Bounded by the work, not by a number somebody typed.
       *
       * A fixed 200-pass bound was the first attempt and it was wrong: the
       * portfolio published 23,526 events, dispatch claims `batchSize` per pass,
       * and the loop stopped a long way short of the end. It reported "dispatch
       * cannot keep up" when what had actually happened was that the test gave
       * up. A bound derived from the backlog cannot make that mistake, and the
       * headroom covers events published *by* dispatch itself.
       */
      const batchSize = portfolio.harness.config.worker.batchSize;
      const maxPasses = Math.ceil(before / batchSize) * 3 + 10;

      let passes = 0;
      const dispatched = await measure('drain the outbox', portfolio.customers.length, async () => {
        let total = 0;
        for (passes = 0; passes < maxPasses; passes += 1) {
          const result = await dispatchOnce({
            db: portfolio.harness.db,
            logger: nullLogger,
            clock: portfolio.harness.clock,
            config: portfolio.harness.config,
            workerId: `load-test-${passes}`,
            subscribers: [],
          });
          total += result.delivered + result.deadLettered;
          if (result.claimed === 0) break;
        }
        return total;
      });

      const after = await pending();

      /**
       * The capacity number this test exists to produce.
       *
       * At the configured batch size and poll interval, one portfolio cycle's
       * events take this long to clear. It is reported rather than judged: an
       * operator with a real machine decides whether sixteen minutes to drain a
       * nightly sweep is acceptable, and a test has no business deciding for
       * them. What matters here is that it is a finite, stated number instead of
       * an unexamined assumption.
       */
      const drainSeconds =
        (before / batchSize) * (portfolio.harness.config.worker.pollIntervalMs / 1000);
      measurements.push({
        label: `events per cycle (drain ≈${Math.round(drainSeconds)}s at ${batchSize}/${portfolio.harness.config.worker.pollIntervalMs}ms)`,
        organisations: portfolio.customers.length,
        milliseconds: Math.round(drainSeconds * 1000),
        perOrganisationMs: before / portfolio.customers.length,
      });

      expect(
        after,
        `The outbox held ${before} pending events and holds ${after} after ${passes} dispatch ` +
          `passes (${dispatched} handled). A backlog that does not clear when driven to ` +
          'convergence means dispatch cannot keep up with production at this scale, and the ' +
          'deficit compounds on every cycle.',
      ).toBe(0);
    },
    LOAD_TIMEOUT_MS,
  );

  it(
    'keeps every organisation isolated while a hundred are in flight',
    async () => {
      /**
       * Tenant isolation is tested thoroughly elsewhere, one organisation at a
       * time. This asks the different question: whether it still holds when a
       * hundred organisations are being swept through the same connection pool.
       *
       * A pooled connection that leaked its tenant context between checkouts
       * would be invisible at one organisation and catastrophic at a hundred —
       * and it is exactly the class of defect that only appears under
       * concurrency.
       */
      const leaks = await portfolio.harness.db.withPlatform(async (ctx) =>
        ctx.many<{ table_name: string; rows: string }>(
          `SELECT 'assurance_states' AS table_name, count(*)::text AS rows
           FROM assurance_states s
           JOIN controls c ON c.id = s.subject_id
          WHERE s.subject_kind = 'CONTROL' AND c.organisation_id <> s.organisation_id
         UNION ALL
         SELECT 'claims', count(*)::text
           FROM claims cl
           JOIN graph_nodes n ON n.id = cl.subject_node_id
          WHERE n.organisation_id <> cl.organisation_id
         UNION ALL
         SELECT 'observations', count(*)::text
           FROM observations o
           JOIN graph_nodes n ON n.id = o.subject_node_id
          WHERE n.organisation_id <> o.organisation_id
         UNION ALL
         SELECT 'evidence_subjects', count(*)::text
           FROM evidence_subjects es
           JOIN graph_nodes n ON n.id = es.node_id
          WHERE n.organisation_id <> es.organisation_id`,
        ),
      );

      for (const row of leaks) {
        expect(
          Number(row.rows),
          `${row.rows} rows in ${row.table_name} reference a node belonging to a different ` +
            'organisation. A cross-tenant reference is a critical security failure, and one that ' +
            'appears only under concurrency points at the connection pool.',
        ).toBe(0);
      }
    },
    LOAD_TIMEOUT_MS,
  );
});
