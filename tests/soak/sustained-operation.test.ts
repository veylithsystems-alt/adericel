import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * What Adericel does after running for a long time.
 *
 * WHY THIS IS A SEPARATE SUITE
 *
 * The chaos suite asks what the product says when something breaks. This one
 * asks what happens when nothing breaks, for months. They are different
 * questions and the second has a worse failure mode, because its symptom is
 * not an error — it is a disk filling up, a query getting slower every week,
 * and an MSP whose product degrades for reasons nobody can see from a test run
 * that lasted four seconds.
 *
 * The defect that prompted all of this was of exactly this shape: a healthy
 * estate went undetermined on day seven. Nothing failed. Nothing logged. 1,677
 * tests passed. **A product sold as continuously maintained has to be tested
 * continuing.**
 *
 * WHAT IS ASSERTED
 *
 * Two properties, and the second is the one that bites:
 *
 *   1. **Correctness is stable.** A satisfied control stays satisfied across
 *      ninety simulated days of successful collection. (The chaos suite proves
 *      this over twenty days; here it runs long enough to catch anything that
 *      degrades gradually rather than at a threshold.)
 *   2. **Storage is bounded by the estate, not by the number of times we
 *      looked at it.** An unchanged fact collected three hundred times must
 *      not be three hundred rows. This is the difference between an MSP paying
 *      for a 20 GB database after a year and paying for 2 TB.
 *
 * WHAT IS NOT ASSERTED
 *
 * No wall-clock budget. Soak time on a shared CI runner measures the runner.
 * Row counts, by contrast, are a property of the design and identical
 * everywhere, which is why the growth assertions here are exact and the timing
 * ones do not exist.
 */

const available = await databaseAvailable();

const SOAK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Ninety days of daily collection.
 *
 * Chosen because it is several times the longest freshness window in the
 * shipped rulesets, so anything that decays at a threshold has had three
 * chances to do it, and because a quarter is the shortest period an MSP would
 * describe as "we have been running this a while".
 */
const DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A device that passes, and never changes — the normal case, at length. */
const device = (externalId: string) => ({
  kind: 'DEVICE_STATE',
  subjectExternalId: externalId,
  payload: { managed: true, diskEncrypted: true, firewallEnabled: true },
});

interface Counts {
  readonly observations: number;
  readonly evidence: number;
  readonly claims: number;
  readonly assessments: number;
  readonly outboxPending: number;
  readonly assuranceStates: number;
}

describe.skipIf(!available)('Adericel under sustained operation', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let afterFirstCycle: Counts;
  let afterSoak: Counts;

  const counts = async (): Promise<Counts> =>
    harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{
        observations: string;
        evidence: string;
        claims: string;
        assessments: string;
        outbox_pending: string;
        assurance_states: string;
      }>(
        `SELECT (SELECT count(*) FROM observations WHERE organisation_id = $1)::text AS observations,
                (SELECT count(*) FROM evidence WHERE organisation_id = $1)::text AS evidence,
                (SELECT count(*) FROM claims WHERE organisation_id = $1)::text AS claims,
                (SELECT count(*) FROM assessments WHERE organisation_id = $1)::text AS assessments,
                (SELECT count(*) FROM outbox_events
                  WHERE organisation_id = $1 AND state = 'PENDING')::text AS outbox_pending,
                (SELECT count(*) FROM assurance_states WHERE organisation_id = $1)::text
                  AS assurance_states`,
        [tenant.organisationId],
      );
      return {
        observations: Number(row.observations),
        evidence: Number(row.evidence),
        claims: Number(row.claims),
        assessments: Number(row.assessments),
        outboxPending: Number(row.outbox_pending),
        assuranceStates: Number(row.assurance_states),
      };
    });

  const stateOf = async (): Promise<string | undefined> =>
    harness.db.withPlatform(async (ctx) => {
      const row = await ctx.one<{ state: string }>(
        `SELECT s.state FROM assurance_states s
           JOIN controls c ON c.id = s.subject_id
          WHERE c.organisation_id = $1 AND c.key = 'device.disk.encrypted'
            AND s.subject_kind = 'CONTROL'`,
        [tenant.organisationId],
      );
      return row?.state;
    });

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'soak-corp',
      records: [device('device-01'), device('device-02'), device('device-03')],
    });

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE controls SET enabled = false WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]);
      await ctx.query(
        `INSERT INTO controls (organisation_id, node_id, key, title, ruleset_key, rule_key)
         VALUES ($1, $2, 'device.disk.encrypted', 'Baseline: disk encryption',
                 'adericel-baseline', 'device.disk.encrypted')
         ON CONFLICT (organisation_id, key) DO UPDATE SET enabled = true`,
        [tenant.organisationId, tenant.rootNodeId],
      );
    });

    // Cycle one, to establish the baseline the growth assertions compare to.
    await harness.runJob('collect-integrations', tenant.organisationId);
    await harness.runJob('reassess-organisation', tenant.organisationId);
    afterFirstCycle = await counts();

    // Then the remaining days, each a successful collection of an unchanged
    // estate — the single most common thing this product will ever do.
    for (let day = 2; day <= DAYS; day += 1) {
      harness.clock.advance(DAY_MS);
      await harness.runJob('collect-integrations', tenant.organisationId);
      await harness.runJob('reassess-organisation', tenant.organisationId);
    }
    afterSoak = await counts();
  }, SOAK_TIMEOUT_MS);

  afterAll(async () => {
    if (afterFirstCycle !== undefined && afterSoak !== undefined) {
      process.stdout.write(
        `\nAfter 1 cycle vs ${DAYS} cycles over ${DAYS} simulated days:\n` +
          `  observations      ${afterFirstCycle.observations} -> ${afterSoak.observations}\n` +
          `  evidence          ${afterFirstCycle.evidence} -> ${afterSoak.evidence}\n` +
          `  claims            ${afterFirstCycle.claims} -> ${afterSoak.claims}\n` +
          `  assessments       ${afterFirstCycle.assessments} -> ${afterSoak.assessments}\n` +
          `  assurance_states  ${afterFirstCycle.assuranceStates} -> ${afterSoak.assuranceStates}\n` +
          `  outbox pending    ${afterFirstCycle.outboxPending} -> ${afterSoak.outboxPending}\n`,
      );
    }
    await harness?.close();
  });

  it(`establishes a satisfied baseline and keeps it for ${DAYS} days`, async () => {
    // The premise and the property in one. If the baseline were never
    // satisfied, every assertion in this file would be true of a suite
    // measuring nothing — the failure mode the chaos suite shipped with.
    expect(afterFirstCycle.assuranceStates).toBeGreaterThan(0);
    expect(
      await stateOf(),
      `after ${DAYS} days of successful daily collection of an unchanged, compliant estate, ` +
        'the control is no longer satisfied',
    ).toBe('SATISFIED');
  });

  it('stores one observation per distinct fact, not one per collection', () => {
    /**
     * THE DEFECT THIS SUITE EXISTS FOR, in its storage form.
     *
     * Refreshing recency so a stable estate stays proven could have been
     * implemented by writing a row every time. That would be correct and
     * ruinous: three devices collected daily for a year is a thousand rows
     * where three belong, and an MSP with a hundred customers would be paying
     * to store a hundred thousand identical records a year.
     *
     * Exactly equal, not "roughly". The estate did not change, so the number
     * of distinct facts did not change, so the row count must not have moved
     * at all. An inequality here would let a slow leak pass.
     */
    expect(
      afterSoak.observations,
      `${afterFirstCycle.observations} observations after one cycle, ${afterSoak.observations} ` +
        `after ${DAYS}. An unchanged estate must not accumulate a row per collection.`,
    ).toBe(afterFirstCycle.observations);

    expect(
      afterSoak.evidence,
      `${afterFirstCycle.evidence} evidence records after one cycle, ${afterSoak.evidence} ` +
        `after ${DAYS}.`,
    ).toBe(afterFirstCycle.evidence);

    expect(
      afterSoak.claims,
      `${afterFirstCycle.claims} claims after one cycle, ${afterSoak.claims} after ${DAYS}. ` +
        'A claim supersedes rather than accumulating; an unchanged value supersedes nothing.',
    ).toBe(afterFirstCycle.claims);
  });

  it('keeps the current-state projection one row per subject, however long it runs', () => {
    // `assurance_states` is a projection, not a history. If it grew with time
    // it would be a log wearing a projection's name, and every portfolio query
    // reading it would get slower for the rest of the deployment's life.
    expect(afterSoak.assuranceStates).toBe(afterFirstCycle.assuranceStates);
  });

  it('accumulates assessment history, because that is what history is for', () => {
    /**
     * The deliberate exception, asserted so that nobody "optimises" it away.
     *
     * Assessments are an append-only record of what Adericel determined and
     * when. They are *supposed* to grow: "was this control satisfied in March"
     * is a question a customer in a dispute will ask, and a projection cannot
     * answer it.
     *
     * So this asserts growth rather than forbidding it — and bounds it, because
     * growth that outpaces the cycles would mean something is writing several
     * assessments per control per run.
     */
    expect(
      afterSoak.assessments,
      'assessment history did not grow: a determination is not being recorded',
    ).toBeGreaterThan(afterFirstCycle.assessments);

    const perCycle = afterSoak.assessments / DAYS;
    expect(
      perCycle,
      `${afterSoak.assessments} assessments over ${DAYS} cycles is ${perCycle.toFixed(1)} per ` +
        'cycle for one enabled control plus its roll-ups. More than a handful means duplicate ' +
        'determinations are being written per run.',
    ).toBeLessThan(10);
  });

  it('does not let the outbox grow without bound while nothing dispatches', () => {
    /**
     * Honest about what this measures: nothing is dispatching here, so pending
     * events accumulate, and that is expected. What it checks is the *rate* —
     * an unchanged estate should publish few events per cycle, because almost
     * nothing happened.
     *
     * A product that published a state-change event on every reassessment of
     * an unchanged control would flood an MSP's notifications with "no change"
     * and teach them to ignore the channel, which is worse than silence.
     */
    const perCycle = (afterSoak.outboxPending - afterFirstCycle.outboxPending) / (DAYS - 1);
    expect(
      perCycle,
      `${perCycle.toFixed(1)} events published per cycle over an estate where nothing changed. ` +
        'An unchanged estate should be nearly silent; a stream of no-change events trains an ' +
        'operator to ignore the channel.',
    ).toBeLessThan(10);
  });
});
