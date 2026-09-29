import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * The resolution queue, end to end.
 *
 * UNKNOWN as a first-class state is the product's strongest position and, on
 * its own, incomplete. Telling an MSP that sixteen controls are undecided is
 * honest; leaving them to work out what to do about it moves the cost of
 * finding out rather than reducing it.
 *
 * Four properties carry this file, and each one is a way this feature could
 * look right and be useless:
 *
 *   1. **A never-assessed control appears.** It has no row in the
 *      current-state projection, so a queue built from that projection reports
 *      a freshly onboarded organisation as having nothing undecided — the most
 *      dangerous sentence this product could produce.
 *   2. **Fan-out beats severity.** One gap darkening five controls outranks a
 *      lone CRITICAL, because resolving it is five controls of progress for
 *      one piece of work. No per-control view ever shows that.
 *   3. **A dated commitment changes the order.** And Adericel never invents
 *      one: a queue that assumed a deadline would mark everything blocking,
 *      and an operator would learn to ignore the ranking.
 *   4. **Nothing unactionable sits in the work queue.** An item nobody can act
 *      on teaches an operator to distrust the queue, and a distrusted queue is
 *      how the real items get missed.
 */

const available = await databaseAvailable();

interface QueueItem {
  controlId: string;
  controlKey: string;
  kind: string;
  kindMeaning: string;
  becauseUnknown: string;
  resolvedBy: string;
  owner: string;
  ownerDetail: string;
  materiality: string;
  materialityBecause: string[];
  ifUnresolved: string;
  nextAction: string;
  uncertaintyReduction: {
    controlsUnblocked: number;
    controlsDecidedOutright: number;
    caveat: string;
  };
  rank: number;
  actionable: boolean;
}

interface QueueBody {
  organisationId: string;
  work: QueueItem[];
  notActionable: QueueItem[];
  summary: string;
  limitations: string[];
}

/**
 * `device.managed` is a required predicate of five Cyber Essentials rules.
 *
 * Not a contrivance for the test — it is the shape of the scheme. One
 * device-management source answers a great deal, and its absence is why a
 * large part of the queue is dark on a typical new estate.
 */
const DEVICE_MANAGED_CONTROLS = [
  'ce.firewalls.host',
  'ce.secure_config.device_unlock',
  'ce.secure_config.autorun_disabled',
  'ce.updates.automatic_enabled',
  'ce.malware.protection_active',
];

/** CRITICAL, and the only control waiting on its predicate. */
const LONE_CRITICAL = 'ce.updates.applied_within_14_days';

/**
 * Controls that need a person rather than a source, so the routing branches
 * have something real to route.
 */
const OTHER_CONTROLS = [
  'ce.access.mfa_on_cloud_services',
  'ce.access.admin_separation',
  'ce.secure_config.no_default_credentials',
  'ce.firewalls.boundary',
];

/** Every control this scenario states, and nothing else. */
const SCENARIO_CONTROLS = [...DEVICE_MANAGED_CONTROLS, LONE_CRITICAL, ...OTHER_CONTROLS];

describe.skipIf(!available)('the resolution queue', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  /** An analyst: reads the queue, and may not commit the business to a date. */
  let token: string;
  /** An owner: the only person who may record a commitment. */
  let ownerToken: string;

  /** Record a state row for one control, as an assessment would. */
  const setState = async (
    controlKey: string,
    state: string,
    reasons: {
      unknownReason?: string | null;
      degradedReason?: string | null;
      blockedReason?: string | null;
    } = {},
  ): Promise<void> => {
    await harness.db.withPlatform(async (ctx) => {
      const control = await ctx.oneOrFail<{ id: string; ruleset_key: string; rule_key: string }>(
        `SELECT id, ruleset_key, rule_key FROM controls
          WHERE organisation_id = $1 AND key = $2`,
        [tenant.organisationId, controlKey],
        'Control',
      );
      // A state row requires an assessment, because a determination with no
      // record of how it was reached is exactly what this product refuses to
      // store. The fixture therefore writes both.
      const assessment = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO assessments
           (organisation_id, subject_kind, subject_id, state, unknown_reason, rationale,
            trigger, engine_version, ruleset_key, ruleset_version, ruleset_hash, rule_key,
            input_digest, assessed_at)
         VALUES ($1, 'CONTROL', $2, 'UNKNOWN', 'NOT_YET_ASSESSED', 'Fixture', 'TEST',
                 '1.0.0', $3, '1.0.0', 'sha256:fixture', $4, 'sha256:fixture', now())
         RETURNING id`,
        [tenant.organisationId, control.id, control.ruleset_key, control.rule_key],
        'Assessment',
      );
      await ctx.query(
        `INSERT INTO assurance_states
           (organisation_id, subject_kind, subject_id, state, unknown_reason, degraded_reason,
            blocked_reason, assessment_id, since, last_assessed_at)
         VALUES ($1, 'CONTROL', $2, $3, $4, $5, $6, $7, now(), now())
         ON CONFLICT (organisation_id, subject_kind, subject_id) DO UPDATE
           SET state = EXCLUDED.state,
               unknown_reason = EXCLUDED.unknown_reason,
               degraded_reason = EXCLUDED.degraded_reason,
               blocked_reason = EXCLUDED.blocked_reason,
               assessment_id = EXCLUDED.assessment_id,
               last_assessed_at = EXCLUDED.last_assessed_at`,
        [
          tenant.organisationId,
          control.id,
          state,
          reasons.unknownReason ?? null,
          reasons.degradedReason ?? null,
          reasons.blockedReason ?? null,
          assessment.id,
        ],
      );
    });
  };

  const queue = async (): Promise<QueueBody> => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/unknowns`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as QueueBody;
  };

  const find = (body: QueueBody, key: string): QueueItem => {
    const item = [...body.work, ...body.notActionable].find(
      (candidate) => candidate.controlKey === key,
    );
    if (!item) throw new Error(`${key} is not in the queue (work: ${body.work.length})`);
    return item;
  };

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, {
      slug: 'unknown-corp',
      frameworks: ['cyber-essentials'],
    });
    token = await signIn(harness, 'analyst-unknown-corp@test.invalid');
    ownerToken = await signIn(harness, 'owner-unknown-corp@test.invalid');

    /**
     * The scenario is stated here, not inherited.
     *
     * Provisioning applies the default baseline, whose controls overlap the
     * Cyber Essentials ones on several predicates. A fan-out assertion written
     * over both would pass or fail on whatever the baseline happens to contain
     * this month, which is a test that measures the fixture rather than the
     * feature. So the baseline controls are disabled — `enabled` is a real
     * column the queue already filters on — and exactly the controls this
     * scenario talks about are enabled in their place.
     */
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE controls SET enabled = false WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]);
      for (const key of SCENARIO_CONTROLS) {
        await ctx.query(
          `INSERT INTO controls (organisation_id, node_id, key, title, ruleset_key, rule_key)
           VALUES ($1, $2, $3, $4, 'cyber-essentials', $3)
           ON CONFLICT (organisation_id, key) DO UPDATE
             SET enabled = true, ruleset_key = 'cyber-essentials', rule_key = EXCLUDED.rule_key`,
          [tenant.organisationId, tenant.rootNodeId, key, `Cyber Essentials: ${key}`],
        );
      }
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('shows every never-assessed control rather than reporting nothing to do', async () => {
    /**
     * The defect this test exists for.
     *
     * A newly onboarded organisation has controls and no state rows at all. A
     * queue driven from `assurance_states` would come back empty and would say
     * so in a sentence an MSP would read as good news.
     */
    const body = await queue();

    // Every control in the scenario, and none of the disabled baseline ones.
    expect(body.work.length + body.notActionable.length).toBe(SCENARIO_CONTROLS.length);
    expect(body.summary).not.toMatch(/Nothing is currently undecided/);
    expect(body.summary).toMatch(/unknown\(s\) can be resolved/);

    const lone = find(body, LONE_CRITICAL);
    expect(lone.kind).toBe('MISSING');
    expect(lone.becauseUnknown).toMatch(/has not been assessed yet/);
  });

  it('gives every item all eight things, with nothing left empty', async () => {
    const body = await queue();
    expect(body.work.length).toBeGreaterThan(0);
    for (const item of [...body.work, ...body.notActionable]) {
      expect(item.kind, item.controlKey).toBeTruthy();
      expect(item.kindMeaning.length, item.controlKey).toBeGreaterThan(20);
      expect(item.becauseUnknown.length, item.controlKey).toBeGreaterThan(20);
      expect(item.resolvedBy.length, item.controlKey).toBeGreaterThan(20);
      expect(item.owner, item.controlKey).toBeTruthy();
      expect(item.materialityBecause.length, item.controlKey).toBeGreaterThan(0);
      expect(item.ifUnresolved.length, item.controlKey).toBeGreaterThan(20);
      expect(item.nextAction.length, item.controlKey).toBeGreaterThan(20);
      // The caveat travels with the numbers, every time. A count shown without
      // it is the sentence that becomes "73% confident" in somebody's deck.
      expect(item.uncertaintyReduction.caveat, item.controlKey).toMatch(/not a probability/);
    }
  });

  it('ranks the gap that darkens five controls above a lone CRITICAL one', async () => {
    /**
     * The property that changes how an MSP works.
     *
     * `ce.updates.applied_within_14_days` is CRITICAL and is one control of
     * progress. The device-management gap sits on MEDIUM and LOW controls and
     * is five. An operator working strictly by severity does the less valuable
     * thing first, all day, and cannot see that from a per-control screen.
     */
    const body = await queue();
    const lone = find(body, LONE_CRITICAL);
    const fannedOut = find(body, 'ce.firewalls.host');

    expect(fannedOut.uncertaintyReduction.controlsUnblocked).toBe(DEVICE_MANAGED_CONTROLS.length);
    expect(lone.uncertaintyReduction.controlsUnblocked).toBe(1);
    expect(fannedOut.rank).toBeGreaterThan(lone.rank);

    // And the reason is stated, not merely applied. An operator has to be able
    // to disagree with the reasoning rather than with a number.
    expect(fannedOut.materialityBecause.join(' ')).toMatch(/reason 5 controls cannot be decided/);

    const order = body.work.map((item) => item.controlKey);
    expect(order.indexOf('ce.firewalls.host')).toBeLessThan(order.indexOf(LONE_CRITICAL));
  });

  it('routes a broken credential to the MSP with the specific repair', async () => {
    await setState('ce.access.mfa_on_cloud_services', 'DEGRADED', {
      degradedReason: 'CREDENTIAL_EXPIRED',
    });
    const item = find(await queue(), 'ce.access.mfa_on_cloud_services');

    // The stored reason is the authority. Deriving it from connector health
    // would flatten this to "collection is failing" and lose the one word an
    // engineer acts on.
    expect(item.kind).toBe('UNCOLLECTABLE');
    expect(item.owner).toBe('MSP');
    expect(item.nextAction).toMatch(/Reauthorise/i);
  });

  it('tells an operator to stop looking when a person owes a decision', async () => {
    await setState('ce.access.admin_separation', 'BLOCKED', {
      blockedReason: 'CONSENT_REQUIRED',
    });
    const item = find(await queue(), 'ce.access.admin_separation');

    expect(item.kind).toBe('AWAITING_DECISION');
    expect(item.owner).toBe('CLIENT');
    expect(item.nextAction).toMatch(/consent/i);
    // The instruction that would waste an engineer's afternoon on a connector
    // that is working perfectly.
    expect(item.nextAction).not.toMatch(/configure|re-run|reauthoris/i);
  });

  it('keeps an unactionable control out of the work queue without discarding it', async () => {
    await setState('ce.secure_config.no_default_credentials', 'UNKNOWN', {
      unknownReason: 'NO_APPLICABLE_RULE',
    });
    const body = await queue();

    expect(body.notActionable.map((item) => item.controlKey)).toContain(
      'ce.secure_config.no_default_credentials',
    );
    expect(body.work.map((item) => item.controlKey)).not.toContain(
      'ce.secure_config.no_default_credentials',
    );

    // Still true, so still reported. A CRITICAL control nobody can observe is
    // a real hole in the assurance position and belongs in a report.
    const item = find(body, 'ce.secure_config.no_default_credentials');
    expect(item.actionable).toBe(false);
    expect(item.owner).toBe('NOBODY');
    expect(body.summary).toMatch(/cannot be closed from inside/);
  });

  it('says plainly that no commitment is recorded, rather than inventing one', async () => {
    const body = await queue();
    expect(body.limitations.join(' ')).toMatch(/No dated commitment is recorded/);
    for (const item of body.work) {
      expect(item.materiality, item.controlKey).not.toBe('BLOCKING');
    }
  });

  it('refuses a commitment dated in the past', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/commitments`,
      headers: bearer(ownerToken),
      payload: {
        kind: 'CERTIFICATION_ASSESSMENT',
        label: 'Cyber Essentials assessment that already happened',
        dueAt: new Date(harness.clock.nowEpochMs() - 86_400_000).toISOString(),
      },
    });
    // Recording it would silently change no ranking, which reads to an
    // operator as the feature not working.
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(
      /must be in the future/,
    );
  });

  it('promotes the queue to BLOCKING once a dated commitment is imminent', async () => {
    const before = await queue();
    expect(before.work.every((item) => item.materiality !== 'BLOCKING')).toBe(true);

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/commitments`,
      headers: bearer(ownerToken),
      payload: {
        kind: 'CERTIFICATION_ASSESSMENT',
        label: 'Cyber Essentials assessment booked with the certification body',
        dueAt: new Date(harness.clock.nowEpochMs() + 9 * 86_400_000).toISOString(),
        frameworkKey: 'cyber-essentials',
      },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { effect: string }).effect).toMatch(/BLOCKING/);

    const after = await queue();
    expect(after.work.filter((item) => item.materiality === 'BLOCKING').length).toBeGreaterThan(0);
    expect(after.limitations.join(' ')).not.toMatch(/No dated commitment is recorded/);

    // The consequence is stated in the words somebody would have to say to the
    // customer, not as a restatement of the state.
    const blocking = after.work.find((item) => item.materiality === 'BLOCKING');
    expect(blocking?.ifUnresolved).toMatch(/cannot be met honestly/);
    expect(blocking?.materialityBecause.join(' ')).toMatch(/in 9 day\(s\)/);

    // An unactionable item is capped, and a deadline does not lift the cap.
    // Nothing inside Adericel can close it, so it must not start competing
    // with work somebody can do today.
    for (const item of after.notActionable) {
      expect(item.materiality, item.controlKey).not.toBe('BLOCKING');
    }
  });

  it('explains one control on its own, and refuses one that is decided', async () => {
    const control = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM controls WHERE organisation_id = $1 AND key = $2`,
        [tenant.organisationId, 'ce.firewalls.host'],
        'Control',
      ),
    );
    const found = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/controls/${control.id}/resolution`,
      headers: bearer(token),
    });
    expect(found.statusCode).toBe(200);
    expect((found.json() as QueueItem).controlKey).toBe('ce.firewalls.host');

    // A control that is decided has nothing to resolve, and says so rather
    // than returning an empty plan that would read as a gap.
    await setState('ce.firewalls.boundary', 'SATISFIED');
    const decided = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM controls WHERE organisation_id = $1 AND key = $2`,
        [tenant.organisationId, 'ce.firewalls.boundary'],
        'Control',
      ),
    );
    const missing = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/controls/${decided.id}/resolution`,
      headers: bearer(token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('never serves another MSP the queue for an organisation it does not run', async () => {
    const other = await seedTenant(harness, {
      slug: 'rival-unknown-corp',
      frameworks: ['cyber-essentials'],
    });
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${other.organisationId}/unknowns`,
      headers: bearer(token),
    });
    // A different MSP entirely. The queue names controls, states and reasons —
    // every one of them assurance data about somebody else's estate.
    expect(response.statusCode).toBe(403);
  });
});
