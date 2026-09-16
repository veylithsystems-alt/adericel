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
 * The ten commercial states, end to end.
 *
 * Contract v3.1 §16. The properties under test are not that an account can be
 * restricted — that is easy — but that restricting it never reaches the
 * customer's assurance record, never becomes a containment, and never happens
 * without somebody's name and a reason attached.
 */

const available = await databaseAvailable();

const REASON = 'Invoice 4417 unpaid for 62 days after three dunning attempts and a call.';

describe.skipIf(!available)('commercial states', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let ownerToken: string;
  let subscriptionId: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'money-corp', frameworks: ['cyber-essentials'] });
    ownerToken = await signIn(harness, 'owner-money-corp@test.invalid');

    subscriptionId = await harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM subscriptions WHERE msp_id = $1`,
        [tenant.mspId],
        'Subscription',
      );
      return row.id;
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const move = async (
    payload: Record<string, unknown>,
    token = ownerToken,
  ): ReturnType<Harness['server']['inject']> =>
    harness.server.inject({
      method: 'POST',
      url: `/v1/msps/${tenant.mspId}/subscriptions/${subscriptionId}/commercial`,
      headers: bearer(token),
      payload: { reason: REASON, customerNotified: true, ...payload },
    });

  it('publishes what each state costs a customer, in words they would be told', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/commercial/states',
      headers: bearer(ownerToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      states: { state: string; readOwnRecord: boolean; exportOwnRecord: boolean }[];
      invariant: string;
    }>();

    expect(body.states).toHaveLength(10);
    // The invariant, published rather than merely held.
    for (const state of body.states) {
      expect(state.readOwnRecord).toBe(true);
      expect(state.exportOwnRecord).toBe(true);
    }
    expect(body.invariant).toMatch(/never stop being able to read and export/i);
  });

  it('refuses a move that is not legal from where the account actually is', async () => {
    // ACTIVE is restricted before it is suspended. Suspension stops assurance
    // being maintained and is not reached in one step from paying-and-current.
    const response = await move({ to: 'COMMERCIAL_SUSPENSION' });
    expect(response.statusCode).toBe(412);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/cannot become/i);
  });

  it('refuses a reason nobody could act on', async () => {
    const response = await move({ to: 'PAST_DUE', reason: 'unpaid' });
    expect(response.statusCode).toBe(400);
  });

  it('records who decided, and why, when the move is legal', async () => {
    const response = await move({ to: 'PAST_DUE' });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      from: string;
      to: string;
      customerImpact: string;
      assuranceImpact: { changesAnyOutcome: boolean; stopsBeingMaintained: boolean };
    }>();

    expect(body.from).toBe('ACTIVE');
    expect(body.to).toBe('PAST_DUE');
    // PAST_DUE restricts nothing. A late invoice is a fact about an account.
    expect(body.assuranceImpact.changesAnyOutcome).toBe(false);
    expect(body.assuranceImpact.stopsBeingMaintained).toBe(false);

    const row = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ decided_by_kind: string; decided_by: string | null; reason: string }>(
        `SELECT decided_by_kind, decided_by, reason FROM commercial_transitions
          WHERE subscription_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [subscriptionId],
        'Transition',
      ),
    );
    expect(row.decided_by_kind).toBe('OPERATOR');
    expect(row.decided_by).not.toBeNull();
    expect(row.reason).toBe(REASON);
  });

  it('refuses to stop maintaining assurance without telling the customer first', async () => {
    expect((await move({ to: 'COMMERCIAL_RESTRICTION' })).statusCode).toBe(201);

    const response = await move({ to: 'COMMERCIAL_SUSPENSION', customerNotified: false });
    expect(response.statusCode).toBe(412);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/must be told/i);
  });

  it('never touches the assurance record, even at suspension', async () => {
    /**
     * The property that matters most in this file.
     *
     * A customer who stops paying stops receiving new assurance. They never
     * stop being able to read what they already proved — holding a compliance
     * record hostage over an invoice is not a commercial lever.
     */
    const before = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(ownerToken),
    });
    expect(before.statusCode).toBe(200);

    expect((await move({ to: 'COMMERCIAL_SUSPENSION', customerNotified: true })).statusCode).toBe(
      201,
    );

    const after = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(ownerToken),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(before.json());
  });

  it('does not contain anything when it suspends', async () => {
    // §16. A commercial suspension is not a security event, so the estate's
    // containment level must be exactly where it was: C0.
    const row = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ containment_level: string }>(
        `SELECT containment_level FROM organisations WHERE id = $1`,
        [tenant.organisationId],
        'Organisation',
      ),
    );
    expect(row.containment_level).toBe('C0');

    const events = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ id: string }>(`SELECT id FROM containment_events WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]),
    );
    expect(events).toHaveLength(0);
  });

  it('cannot be moved by pairing your own MSP with somebody else’s subscription', async () => {
    // The MSP id in the path is authorised; the subscription id is not. Without
    // the ownership check an operator with a legitimate grant could move
    // another MSP's account, and the answer must not distinguish "not yours"
    // from "does not exist".
    const other = await seedTenant(harness, { slug: 'rival-corp', frameworks: [] });
    const otherSubscriptionId = await harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM subscriptions WHERE msp_id = $1`,
        [other.mspId],
        'Subscription',
      );
      return row.id;
    });

    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/msps/${tenant.mspId}/subscriptions/${otherSubscriptionId}/commercial`,
      headers: bearer(ownerToken),
      payload: { to: 'PAST_DUE', reason: REASON, customerNotified: true },
    });
    expect(response.statusCode).toBe(404);

    const untouched = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ status: string }>(
        `SELECT status FROM subscriptions WHERE id = $1`,
        [otherSubscriptionId],
        'Subscription',
      ),
    );
    expect(untouched.status).toBe('ACTIVE');
  });

  it('refuses a caller-supplied attribution outright', async () => {
    // Sending `decidedByKind: 'PROVIDER'` would be a person hiding behind a
    // payment processor. Attribution is derived from the session, and the
    // schema is strict so the attempt is refused rather than ignored.
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/msps/${tenant.mspId}/subscriptions/${subscriptionId}/commercial`,
      headers: bearer(ownerToken),
      payload: {
        to: 'PAYMENT_PLAN',
        reason: REASON,
        customerNotified: true,
        decidedByKind: 'PROVIDER',
        decidedByLabel: 'Stripe',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps the history, and will not let it be rewritten', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/msps/${tenant.mspId}/subscriptions/${subscriptionId}/commercial`,
      headers: bearer(ownerToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ state: string; history: { from: string; to: string }[] }>();
    expect(body.state).toBe('COMMERCIAL_SUSPENSION');
    expect(body.history.length).toBeGreaterThanOrEqual(3);

    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(`UPDATE commercial_transitions SET reason = 'routine'`, []),
      ),
    ).rejects.toThrow();

    await expect(
      harness.db.withPlatform(async (ctx) => ctx.query(`DELETE FROM commercial_transitions`, [])),
    ).rejects.toThrow();
  });

  it('is visible to the organisation whose service it changed', async () => {
    /**
     * It is their business being restricted. "Ask your MSP" is not an answer
     * when the record exists and names them.
     *
     * The seeded subscription is held at MSP scope, so this provisions an
     * organisation-scoped one and moves it — otherwise the tenant policy would
     * have nothing to match and the test would pass by having nothing to find.
     */
    const orgSubscriptionId = await harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO subscriptions (organisation_id, plan_key, status,
                                    price_per_organisation_minor,
                                    current_period_start, current_period_end)
         VALUES ($1, 'standard', 'ACTIVE', 19900, now(), now() + interval '1 month')
         RETURNING id`,
        [tenant.organisationId],
        'Organisation subscription',
      );
      return row.id;
    });

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(
        `INSERT INTO commercial_transitions
           (subscription_id, organisation_id, from_state, to_state, reason,
            customer_notified, decided_by_kind, decided_by_label)
         VALUES ($1, $2, 'ACTIVE', 'PAST_DUE', $3, true, 'SYSTEM', 'Dunning timer')`,
        [orgSubscriptionId, tenant.organisationId, REASON],
      );
    });

    const rows = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.many<{ id: string; to_state: string }>(
        `SELECT id, to_state FROM commercial_transitions`,
        [],
      ),
    );
    // Exactly the organisation's own row. The MSP-scoped transitions made
    // earlier in this file carry a null organisation_id and must not appear
    // here: a client sees what happened to them, not to their MSP.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_state).toBe('PAST_DUE');
  });
});
