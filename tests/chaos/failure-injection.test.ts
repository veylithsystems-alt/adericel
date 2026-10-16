import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * What Adericel does when the things it depends on fail.
 *
 * Every other suite asks whether the product works. This one asks what it says
 * when it cannot, which is a different question and the one that decides
 * whether an MSP can rely on it.
 *
 * THE FAILURES THAT MATTER ARE THE QUIET ONES
 *
 * A connector that throws is easy: somebody sees a red light. The dangerous
 * failures look like success — a source returning ninety per cent of the
 * estate, a field that quietly stops being reported, a vendor that renames its
 * fields and keeps answering. Each can be mistaken for a healthy collection
 * that happens to look good, and each is a way a security product tells a
 * customer they are fine when nobody actually looked.
 *
 * So two properties are under test throughout, and they pull in opposite
 * directions, which is why both are needed:
 *
 *   1. No failure of any dependency may produce a determination more
 *      favourable than the evidence supports.
 *   2. No *absence* of failure may produce one less favourable. A healthy
 *      estate, collected successfully, must stay PROVEN — indefinitely.
 *
 * The second is not padding. Writing only the first is how this suite began,
 * and it passed ten green tests while the product quietly decayed every stable
 * fact to UNKNOWN inside a week: "the failure did not produce a pass" is also
 * true of a system that can never pass at all. Both halves, or neither means
 * anything.
 *
 * WHAT THIS SUITE FOUND
 *
 * Six defects, every one of them invisible from outside the system:
 *
 *   - A flawless estate, collected successfully every day, went UNKNOWN on day
 *     seven and stayed there. Content deduplication dropped re-observations
 *     before anything could record that we had looked again.
 *   - Evidence was deduplicated by content across subjects, so identically
 *     configured devices shared one proof record. A customer asking for the
 *     proof about their laptop got a record about somebody else's, and a
 *     device that silently dropped out kept looking fresh.
 *   - Nothing supplied impairment to the engine, so DEGRADED and BLOCKED were
 *     unreachable and every broken connector reported INSUFFICIENT_EVIDENCE —
 *     "connect something" — when the real answer was "this credential expired".
 *   - `degraded_reason` and `blocked_reason` were never written.
 *   - Schema drift was undetectable: a collection that read nothing was
 *     recorded as a success.
 *   - A connector could under-declare its own predicates, silently disabling
 *     impairment for them.
 */

const available = await databaseAvailable();

/**
 * The one control this suite talks about, and nothing else.
 *
 * `device.disk.encrypted` is a baseline rule over `Device` subjects with `ALL`
 * aggregation, applicable only to a device reporting `device.managed`. That
 * makes it the right instrument: a connector that stops answering, stops
 * mentioning a device, or stops reporting one fact about it changes the input
 * to this rule in three different ways, each with a different correct answer.
 * Asserting over a whole framework instead would mean the suite passed or
 * failed on whatever else the ruleset happened to contain.
 */
const SCENARIO_CONTROL = 'device.disk.encrypted';

/**
 * Two devices, identically configured, both passing.
 *
 * Identical on purpose. A uniform estate is the normal shape of a small
 * business — forty laptops from the same image — and it is the shape that
 * exposed evidence being shared between subjects. A fixture where every device
 * differed would have hidden it.
 *
 * The payload keys are the connector's own vendor-shaped fields, not predicate
 * names: `diskEncrypted`, which normalisation maps to `device.disk.encrypted`.
 * Writing predicate names here produces observations that store correctly and
 * derive no claims at all, which looks like a working fixture and tests
 * nothing.
 */
const device = (externalId: string) => ({
  kind: 'DEVICE_STATE',
  subjectExternalId: externalId,
  payload: { managed: true, diskEncrypted: true, firewallEnabled: true },
});

/** Every injection knob off. Each test states its own fault from this base. */
const HEALTHY = {
  failCollectionWith: null,
  driftFieldNames: false,
  omitSubjects: [] as string[],
  omitFields: [] as string[],
  reportsObservedAt: true,
};

/** Longer than the rule's `maxEvidenceAgeDays` of 7. */
const PAST_FRESHNESS_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

interface StateRow {
  readonly state: string;
  readonly unknown_reason: string | null;
  readonly degraded_reason: string | null;
  readonly blocked_reason: string | null;
}

describe.skipIf(!available)('what Adericel says when its dependencies fail', () => {
  let harness: Harness;
  let tenant: SeededTenant;

  /** Reconfigure the integration, as an operator changing a connector would. */
  const inject = async (patch: Record<string, unknown>): Promise<void> => {
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(
        `UPDATE integrations SET configuration = configuration || $2::jsonb WHERE id = $1`,
        [tenant.integrationId, JSON.stringify({ ...HEALTHY, ...patch })],
      );
    });
  };

  /**
   * One full cycle, exactly as the worker runs it.
   *
   * Deliberately not wrapped in a catch. A swallowed error here is how a chaos
   * suite ends up asserting that nothing happened because nothing ran — which
   * is what the first version of this file did, with job names that matched no
   * registered handler, for ten green tests that touched no product code.
   */
  const collectAndAssess = async (): Promise<void> => {
    await harness.runJob('collect-integrations', tenant.organisationId);
    await harness.runJob('reassess-organisation', tenant.organisationId);
  };

  const stateOf = async (controlKey = SCENARIO_CONTROL): Promise<StateRow | null> =>
    harness.db.withPlatform(async (ctx) =>
      ctx.one<StateRow>(
        `SELECT s.state, s.unknown_reason, s.degraded_reason, s.blocked_reason
           FROM assurance_states s
           JOIN controls c ON c.id = s.subject_id
          WHERE c.organisation_id = $1 AND c.key = $2 AND s.subject_kind = 'CONTROL'`,
        [tenant.organisationId, controlKey],
      ),
    );

  const integrationStatus = async (): Promise<string> =>
    harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ status: string }>(
        `SELECT status FROM integrations WHERE id = $1`,
        [tenant.integrationId],
        'Integration',
      );
      return row.status;
    });

  /**
   * Re-seed from scratch for each test.
   *
   * Every assertion here is about a transition from a known-good state, and
   * several advance the clock past the freshness window. Sharing one tenant
   * across them means test order decides the answers, and a suite whose
   * results depend on its own history cannot be read.
   */
  const freshTenant = async (
    slug: string,
    /**
     * Configuration for the *baseline* collection, not just for what follows.
     *
     * Needed because some properties are about the shape of the very first
     * observation. A test that seeded a healthy baseline and then switched the
     * source's behaviour would be asserting about evidence written before the
     * switch — which is how the first version of the no-timestamp test came to
     * fail its own premise check, correctly.
     */
    baselineConfig: Record<string, unknown> = {},
  ): Promise<void> => {
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug,
      records: [device('device-01'), device('device-02')],
    });

    // State the scenario rather than inherit it. Provisioning with no
    // framework leaves an organisation with no controls at all, so a suite
    // written over whatever the fixture happened to seed would be asserting
    // about an empty estate.
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE controls SET enabled = false WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]);
      await ctx.query(
        `INSERT INTO controls (organisation_id, node_id, key, title, ruleset_key, rule_key)
         VALUES ($1, $2, $3, $4, 'adericel-baseline', $3)
         ON CONFLICT (organisation_id, key) DO UPDATE
           SET enabled = true, ruleset_key = 'adericel-baseline', rule_key = EXCLUDED.rule_key`,
        [
          tenant.organisationId,
          tenant.rootNodeId,
          SCENARIO_CONTROL,
          `Baseline: ${SCENARIO_CONTROL}`,
        ],
      );
    });

    await inject(baselineConfig);
    await collectAndAssess();

    // A guard on every guard below. If the baseline is not actually satisfied,
    // "the failure did not produce a pass" is true of a suite that tests
    // nothing, and nobody goes looking at a green run.
    const baseline = await stateOf();
    expect(baseline, 'nothing was ever assessed: the scenario did not set up').not.toBeNull();
    expect(baseline?.state, 'the control is not satisfied before any failure is injected').toBe(
      'SATISFIED',
    );
  };

  beforeAll(async () => {
    harness = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  describe('a healthy estate that never changes', () => {
    it('stays proven for as long as it keeps being observed', async () => {
      /**
       * THE DEFECT THIS TEST EXISTS FOR, and the worst one the suite found.
       *
       * Nothing is injected. Nothing is broken. The connector answers
       * correctly every single day with the same true answer, as a real estate
       * does — almost every security fact is stable, which is the point of
       * securing it.
       *
       * Adericel went UNKNOWN on day seven and stayed there forever. Content
       * deduplication meant an unchanged payload recorded nothing, so no
       * evidence was refreshed, so the recency of every stable fact froze at
       * its first collection and aged out of its freshness window. An MSP
       * would have onboarded a customer, watched a clean board for a week, and
       * then watched it all go dark while every connector reported healthy.
       *
       * Twenty days, well past the rule's seven-day window, because the
       * failure only appears once the window has passed — and a test that
       * stopped at day six would have been green on the broken code.
       */
      await freshTenant('steady-corp');

      for (let day = 1; day <= 20; day += 1) {
        harness.clock.advance(24 * 60 * 60 * 1000);
        await collectAndAssess();
        const state = await stateOf();
        expect(
          state?.state,
          `day ${day}: a successfully collected, unchanged, satisfied estate stopped being proven`,
        ).toBe('SATISFIED');
      }
    }, 300_000);

    it('stays proven when the source reports no timestamp of its own', async () => {
      /**
       * The other half of the same property, and it was untested.
       *
       * Evidence usability is anchored on `observed_at ?? collected_at`. A
       * source that reports when a fact became true is carried by
       * `observed_at`; one that does not — a configuration export, a settings
       * snapshot, a policy listing, which say what is the case and not when it
       * became the case — is carried by `collected_at` alone.
       *
       * The fixture always reported a timestamp, so the test above passed with
       * the `collected_at` refresh deliberately broken. The mutation harness
       * caught it: the mutation survived, which means the guard had no test
       * over it. This is that test.
       */
      await freshTenant('untimestamped-corp', { reportsObservedAt: false });

      // The premise, asserted rather than assumed. If the source turned out to
      // report a timestamp anyway, this test would be a duplicate of the one
      // above and would prove nothing about the path it exists for.
      const anchored = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ observed_at: Date | null }>(
          `SELECT observed_at FROM evidence WHERE organisation_id = $1`,
          [tenant.organisationId],
        ),
      );
      expect(anchored.length).toBeGreaterThan(0);
      for (const row of anchored) {
        expect(row.observed_at, 'the source reported a timestamp after all').toBeNull();
      }

      for (let day = 1; day <= 20; day += 1) {
        harness.clock.advance(24 * 60 * 60 * 1000);
        await collectAndAssess();
        expect(
          (await stateOf())?.state,
          `day ${day}: an estate whose source reports no timestamp stopped being proven`,
        ).toBe('SATISFIED');
      }
    }, 300_000);

    it('keeps one evidence record per subject, not one per collection', async () => {
      // The other half of the same property. Refreshing recency must not be
      // achieved by storing a row per run: an estate collected hourly for a
      // year would be nine thousand identical rows per device, and the
      // deduplication this product does is worth keeping.
      await freshTenant('thrifty-corp');
      for (let run = 0; run < 5; run += 1) {
        harness.clock.advance(60 * 60 * 1000);
        await collectAndAssess();
      }

      const rows = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ source_reference: string | null; count: string }>(
          `SELECT source_reference, count(*)::text AS count
             FROM evidence WHERE organisation_id = $1
            GROUP BY source_reference ORDER BY source_reference`,
          [tenant.organisationId],
        ),
      );
      expect(rows.map((row) => row.source_reference)).toEqual(['device-01', 'device-02']);
      for (const row of rows) {
        expect(Number(row.count), `${row.source_reference} accumulated a row per run`).toBe(1);
      }
    }, 300_000);

    it('never offers evidence about one subject as proof about another', async () => {
      /**
       * An attribution failure, not an optimisation.
       *
       * Both devices are configured identically, so their payloads are
       * byte-identical. Evidence identity was content-only, so they shared one
       * record: `source_reference` named whichever was collected first, and it
       * was attached to both. A customer asking for the proof that *their*
       * laptop was encrypted was handed a record about somebody else's — and
       * for a product that sells walking a conclusion back to the response
       * that produced it, that is a correctness failure at the centre of the
       * claim.
       */
      await freshTenant('uniform-corp');

      const shared = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ id: string; subjects: string }>(
          `SELECT e.id,
                  (SELECT count(*)::text FROM evidence_subjects es WHERE es.evidence_id = e.id)
                    AS subjects
             FROM evidence e WHERE e.organisation_id = $1`,
          [tenant.organisationId],
        ),
      );
      expect(shared.length).toBeGreaterThan(0);
      for (const row of shared) {
        expect(
          Number(row.subjects),
          'one evidence record is attached to several subjects: it cannot be proof about all of them',
        ).toBe(1);
      }
    }, 300_000);
  });

  describe('a source that refuses to answer', () => {
    /**
     * Every classified refusal, and the repair each one names.
     *
     * The pairing is the test. A product that reported all six as "collection
     * failing" would be telling an engineer to go and look, when the stored
     * code already knows whether the job is re-authorising a credential,
     * granting a scope, asking the customer to consent again, or waiting out a
     * throttle. That distinction is the difference between a queue an MSP
     * works and a queue an MSP ignores.
     */
    const REFUSALS = [
      { code: 'CREDENTIAL_INVALID', expect: 'DEGRADED', reason: 'CREDENTIAL_EXPIRED' },
      { code: 'PERMISSION_DENIED', expect: 'DEGRADED', reason: 'COLLECTION_FAILING' },
      { code: 'RATE_LIMITED', expect: 'DEGRADED', reason: 'RATE_LIMITED' },
      { code: 'TIMEOUT', expect: 'DEGRADED', reason: 'SOURCE_UNAVAILABLE' },
      { code: 'SOURCE_UNAVAILABLE', expect: 'DEGRADED', reason: 'SOURCE_UNAVAILABLE' },
      // Not an engineering fault, and the only one routed to somebody with
      // authority instead: the customer has to agree, and no amount of
      // engineering will substitute for that.
      { code: 'CONSENT_WITHDRAWN', expect: 'BLOCKED', reason: 'CONSENT_REQUIRED' },
    ] as const;

    for (const refusal of REFUSALS) {
      it(`names the repair for ${refusal.code} rather than saying "connect something"`, async () => {
        await freshTenant(`refuse-${refusal.code.toLowerCase().replace(/_/g, '-')}-corp`);

        await inject({ failCollectionWith: refusal.code });
        await collectAndAssess();

        // Visible immediately, before any determination changes. The estate is
        // still proven on evidence that is still fresh — which is the correct
        // answer — so connector health is the only thing that can tell an
        // operator to act today rather than in a week.
        expect(
          await integrationStatus(),
          'a refused collection left the integration healthy',
        ).not.toBe('CONNECTED');
        expect(
          (await stateOf())?.state,
          'the determination changed while its evidence was still inside the freshness window',
        ).toBe('SATISFIED');

        // Now past the window. The evidence can no longer be refreshed, so the
        // determination has to go — and it has to go to the state that names
        // the repair, not to the one that reads as "nobody has looked".
        harness.clock.advance(PAST_FRESHNESS_WINDOW_MS);
        await collectAndAssess();

        const state = await stateOf();
        expect(state?.state, refusal.code).toBe(refusal.expect);
        expect(state?.state, 'a refused collection produced a pass').not.toBe('SATISFIED');
        const named =
          refusal.expect === 'DEGRADED' ? state?.degraded_reason : state?.blocked_reason;
        expect(named, `${refusal.code} reached an operator without naming a repair`).toBe(
          refusal.reason,
        );
      }, 300_000);
    }

    it('leaves the failure legible to an operator rather than silent', async () => {
      await freshTenant('audible-corp');
      await inject({ failCollectionWith: 'CREDENTIAL_INVALID' });
      await collectAndAssess();

      const runs = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ status: string; error_code: string | null }>(
          `SELECT status, error_code FROM integration_runs
            WHERE integration_id = $1 ORDER BY started_at DESC LIMIT 3`,
          [tenant.integrationId],
        ),
      );
      // A failed collection that recorded nothing would be indistinguishable
      // from one that never ran, and an MSP would have no way to notice.
      const failed = runs.filter((run) => run.status !== 'SUCCEEDED');
      expect(failed.length).toBeGreaterThan(0);
      // The code, not the sentence. Nothing downstream can act on prose, and
      // pattern-matching a vendor's error message to guess the repair is how a
      // regular expression ends up deciding what Adericel tells a customer.
      expect(failed[0]?.error_code).toBe('CREDENTIAL_INVALID');
    }, 300_000);
  });

  describe('a source that answers, and says nothing', () => {
    it('treats a collection that read nothing as drift, not as a success', async () => {
      /**
       * The most dangerous failure available to this product.
       *
       * The vendor ships a v2 API and renames its fields. The request
       * succeeds. The response is well-formed. Observations are stored. Every
       * light stays green — and not one claim comes out, so the affected
       * controls sit on their last reading and then go dark, looking exactly
       * like a customer who never connected anything.
       *
       * It is detectable without knowing anything about the vendor:
       * observations arrived whose kind the normaliser has mappings for, and
       * not one claim came out of them. No healthy estate produces that.
       */
      await freshTenant('v2-corp');

      // An hour on from the baseline collection, so "the most recent run" is a
      // well-defined thing to assert about: `integration_runs.started_at` comes
      // from the injected clock, and two collections at the same instant tie.
      harness.clock.advance(60 * 60 * 1000);
      await inject({ driftFieldNames: true });
      await collectAndAssess();

      expect(
        await integrationStatus(),
        'a collection that read nothing was recorded as healthy',
      ).toBe('DEGRADED');
      const run = await harness.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ status: string; error_code: string | null }>(
          `SELECT status, error_code FROM integration_runs
            WHERE integration_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [tenant.integrationId],
          'Integration run',
        ),
      );
      expect(run.status).toBe('PARTIAL');
      expect(run.error_code).toBe('SCHEMA_DRIFT');

      harness.clock.advance(PAST_FRESHNESS_WINDOW_MS);
      await collectAndAssess();
      const state = await stateOf();
      expect(state?.state).toBe('DEGRADED');
      expect(state?.degraded_reason).toBe('SCHEMA_DRIFT');
    }, 300_000);

    it('keeps detecting drift on the runs after the first', async () => {
      // Deduplication nearly hid this. A source returning the same drifted
      // payload every hour was flagged once and then looked healthy forever,
      // because every later run was "all duplicates" and the drift check had
      // nothing to look at.
      await freshTenant('v2-again-corp');
      await inject({ driftFieldNames: true });
      for (let run = 0; run < 3; run += 1) {
        harness.clock.advance(60 * 60 * 1000);
        await collectAndAssess();
        expect(await integrationStatus(), `run ${run + 1} stopped reporting the drift`).toBe(
          'DEGRADED',
        );
      }
    }, 300_000);
  });

  describe('a source that answers, incompletely', () => {
    it('does not keep reporting a subject it stopped returning', async () => {
      /**
       * The quietest failure in the set. Collection succeeds, reports no
       * error, and simply does not mention `device-02`. Nothing is broken from
       * the connector's point of view.
       *
       * Holding the device's last reading while it is still fresh is correct —
       * a device missing from one response is not yet evidence of anything.
       * Holding it forever is not, and that is what happened while identically
       * configured devices shared one evidence record: every collection of
       * `device-01` refreshed the proof about `device-02`, so the dropout was
       * permanently invisible.
       */
      await freshTenant('ninety-percent-corp');

      harness.clock.advance(60 * 60 * 1000);
      await inject({ omitSubjects: ['device-02'] });
      await collectAndAssess();

      const observed = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ external_id: string }>(
          `SELECT DISTINCT n.external_id
             FROM observations o
             JOIN graph_nodes n ON n.id = o.subject_node_id
            WHERE o.organisation_id = $1 AND o.collected_at = $2::timestamptz`,
          [tenant.organisationId, harness.clock.nowIso()],
        ),
      );
      expect(observed.map((row) => row.external_id)).not.toContain('device-02');

      harness.clock.advance(PAST_FRESHNESS_WINDOW_MS);
      await collectAndAssess();
      expect(
        (await stateOf())?.state,
        'a device that stopped being reported was still counted as proven',
      ).not.toBe('SATISFIED');
    }, 300_000);

    it('treats a fact that stopped arriving as unanswered, not as false', async () => {
      /**
       * Worse than a missing subject: the subject is present and looks
       * healthy, and one fact about it has quietly gone missing. A rule that
       * read the absent key as falsy would report FAILING — wrong, but
       * visible. A rule that skipped it would report SATISFIED on a question
       * nobody answered.
       *
       * UNKNOWN specifically, not FAILING. An absent fact is not a negative
       * fact, and telling a customer their disks are unencrypted because a
       * field stopped arriving would be its own kind of lie.
       */
      await freshTenant('missing-field-corp');

      await inject({ omitFields: ['diskEncrypted'] });
      await collectAndAssess();
      harness.clock.advance(PAST_FRESHNESS_WINDOW_MS);
      await collectAndAssess();

      const state = await stateOf();
      expect(state?.state).not.toBe('SATISFIED');
      expect(state?.state).not.toBe('NOT_SATISFIED');
      expect(['UNKNOWN', 'DEGRADED', 'PARTIALLY_SATISFIED']).toContain(state?.state);
    }, 300_000);
  });

  describe('recovery is earned, not assumed', () => {
    it('returns to proven only after a successful collection, not on repair alone', async () => {
      /**
       * The failure a dashboard most wants to get wrong. Clearing the fault
       * does not make the estate healthy — it makes it observable again. The
       * determination has to come from a collection that actually ran.
       */
      await freshTenant('mended-corp');

      await inject({ failCollectionWith: 'CREDENTIAL_INVALID' });
      await collectAndAssess();
      harness.clock.advance(PAST_FRESHNESS_WINDOW_MS);
      await collectAndAssess();
      const broken = await stateOf();
      expect(broken?.state).toBe('DEGRADED');

      // Repair the connector, and do not collect.
      await inject({});
      expect(
        (await stateOf())?.state,
        'the determination improved on repair alone, before anything was observed',
      ).toBe(broken?.state);

      // Now collect. Only now may it recover.
      await collectAndAssess();
      const recovered = await stateOf();
      expect(recovered?.state).toBe('SATISFIED');
      expect(
        recovered?.degraded_reason,
        'a recovered control kept its stale repair note',
      ).toBeNull();
    }, 300_000);
  });
});
