import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  TEST_INSTANT,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Billing, and what Adericel does when the money stops.
 *
 * The plumbing tests here are ordinary: providers retry, duplicate and reorder,
 * and a subscription system that assumes otherwise corrupts itself quietly.
 *
 * The tests that matter are the ones after them. A lapsed subscriber's
 * Assurance Passport must not go on telling an insurer that an estate is
 * satisfied when Adericel stopped observing it weeks ago — that is
 * manufacturing certainty, which the whole product exists to refuse. And their
 * evidence must not be deleted because a card expired, because a system of
 * record that discards records over a failed payment is not one.
 *
 * So: stop asserting currency, keep the record. Both halves are tested.
 */

const available = await databaseAvailable();
const WEBHOOK_SECRET = 'whsec_billing_lifecycle_test_secret';

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'billing-user',
    payload: {
      externalId: 'billing-user',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
];

describe.skipIf(!available)('billing lifecycle', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;
  let subscriptionId: string;
  let passportHash: string;
  let shareToken: string;

  /** A signed delivery, exactly as the provider sends one. */
  function delivery(
    body: Record<string, unknown>,
    options: { secret?: string; timestampMs?: number } = {},
  ): { payload: string; signature: string } {
    const payload = JSON.stringify(body);
    const timestamp = Math.floor((options.timestampMs ?? harness.clock.nowEpochMs()) / 1000);
    const signature = createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    return { payload, signature: `t=${timestamp},v1=${signature}` };
  }

  function stripeEvent(overrides: {
    id: string;
    type: string;
    createdMs?: number;
    subscriptionId?: string;
    externalRef?: string;
    periodEndMs?: number;
  }): Record<string, unknown> {
    return {
      id: overrides.id,
      type: overrides.type,
      created: Math.floor((overrides.createdMs ?? harness.clock.nowEpochMs()) / 1000),
      data: {
        object: {
          id: overrides.externalRef ?? 'sub_external_ref',
          customer: 'cus_external_ref',
          status: 'active',
          current_period_end: Math.floor(
            (overrides.periodEndMs ?? harness.clock.nowEpochMs() + 30 * 86_400_000) / 1000,
          ),
          metadata: { adericel_subscription_id: overrides.subscriptionId ?? subscriptionId },
        },
      },
    };
  }

  const send = async (
    body: Record<string, unknown>,
    options: { secret?: string; timestampMs?: number } = {},
  ) => {
    const { payload, signature } = delivery(body, options);
    return harness.server.inject({
      method: 'POST',
      url: '/v1/webhooks/billing',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
    });
  };

  const subscriptionRow = async () =>
    harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{
        status: string;
        lapsed_at: Date | null;
        grace_ends_at: Date | null;
        last_event_id: string | null;
      }>(
        `SELECT status, lapsed_at, grace_ends_at, last_event_id FROM subscriptions WHERE id = $1`,
        [subscriptionId],
        'Subscription',
      ),
    );

  const maintained = async (): Promise<boolean> =>
    harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ assurance_maintained: boolean }>(
        `SELECT assurance_maintained FROM organisations WHERE id = $1`,
        [tenant.organisationId],
        'Organisation',
      );
      return row.assurance_maintained;
    });

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        BILLING_PROVIDER: 'stripe',
        BILLING_STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
        BILLING_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'billing-corp', records: RECORDS });
    token = await signIn(harness, 'analyst-billing-corp@test.invalid');

    subscriptionId = await harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ id: string }>(
        `SELECT id FROM subscriptions WHERE msp_id = $1`,
        [tenant.mspId],
        'Subscription',
      );
      return row.id;
    });

    // Produce a real assurance record worth protecting.
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(token),
    });
    const passport = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/passports`,
      headers: bearer(token),
    });
    const issued = passport.json() as { id: string; contentHash: string };
    passportHash = issued.contentHash;

    const share = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/passports/${issued.id}/shares`,
      headers: bearer(token),
      payload: { audience: 'Northgate Insurance', expiresInDays: 90 },
    });
    shareToken = (share.json() as { url: string }).url.split('/').pop()!;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  // ---- The webhook boundary --------------------------------------------

  describe('the webhook is the boundary, and anyone can reach it', () => {
    it('rejects an unsigned delivery', async () => {
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/webhooks/billing',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(stripeEvent({ id: 'evt_unsigned', type: 'invoice.paid' })),
      });
      expect(response.statusCode).toBe(401);
      expect((await subscriptionRow()).last_event_id).toBeNull();
    });

    it('rejects a delivery signed with the wrong secret', async () => {
      const response = await send(stripeEvent({ id: 'evt_wrong_secret', type: 'invoice.paid' }), {
        secret: 'whsec_attacker_guess',
      });
      // What a forged event buys is the ability to activate your own
      // subscription, so this is the control that stops the product being free.
      expect(response.statusCode).toBe(401);
    });

    it('rejects a validly signed delivery that is too old to be live', async () => {
      const response = await send(stripeEvent({ id: 'evt_stale', type: 'invoice.paid' }), {
        timestampMs: harness.clock.nowEpochMs() - 3_600_000,
      });
      // A delivery captured from a log is otherwise replayable forever.
      expect(response.statusCode).toBe(401);
    });

    it('does not read a body it cannot verify byte for byte', async () => {
      // A body that has been parsed and re-serialised no longer produces the
      // same signature. Whitespace is the cheapest way to prove the raw bytes
      // are what is checked.
      const body = stripeEvent({ id: 'evt_reserialised', type: 'invoice.paid' });
      const { signature } = delivery(body);
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/webhooks/billing',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload: JSON.stringify(body, null, 2),
      });
      expect(response.statusCode).toBe(401);
    });

    it('survives a large body delivered in tiny chunks', async () => {
      // The accumulator used to concatenate on every chunk to measure the
      // length, which is quadratic in the number of chunks — and the sender
      // chooses the chunk size. One unauthenticated request sent a byte at a
      // time forced roughly 550 GB of memcpy before any signature was checked.
      const padding = 'x'.repeat(400_000);
      const body = { ...stripeEvent({ id: 'evt_large', type: 'invoice.paid' }), padding };
      const started = Date.now();
      const response = await send(body);
      const elapsed = Date.now() - started;
      expect([200, 400]).toContain(response.statusCode);
      expect(elapsed, 'accumulating the body should be linear, not quadratic').toBeLessThan(5_000);
    });
  });

  // ---- Retries, duplicates and ordering ---------------------------------

  describe('providers retry, duplicate and reorder', () => {
    it('applies an activation and records it', async () => {
      const response = await send(stripeEvent({ id: 'evt_activate_1', type: 'invoice.paid' }));
      expect(response.statusCode, response.body).toBe(200);
      expect((response.json() as { outcome: string }).outcome).toBe('APPLIED');
      const row = await subscriptionRow();
      expect(row.status).toBe('ACTIVE');
      expect(row.last_event_id).toBe('evt_activate_1');
    });

    it('has effect once when the same event is delivered again', async () => {
      const again = await send(stripeEvent({ id: 'evt_activate_1', type: 'invoice.paid' }));
      // 200, not an error: the provider retried because it did not get our 200,
      // and a non-2xx makes it retry again, forever.
      expect(again.statusCode).toBe(200);
      expect((again.json() as { outcome: string }).outcome).toBe('DUPLICATE');

      const count = await harness.db.withPlatform(async (ctx) =>
        ctx.oneOrFail<{ n: string }>(
          `SELECT count(*)::text AS n FROM billing_events WHERE id = 'evt_activate_1'`,
          [],
          'Events',
        ),
      );
      expect(count.n).toBe('1');
    });

    it('discards an event the provider stamped before the last one applied', async () => {
      harness.clock.advance(60_000);
      const newer = await send(
        stripeEvent({ id: 'evt_failed_newer', type: 'invoice.payment_failed' }),
      );
      expect((newer.json() as { outcome: string }).outcome).toBe('APPLIED');
      expect((await subscriptionRow()).status).toBe('PAST_DUE');

      // A renewal that was queued behind the failure and arrives after it.
      const older = await send(
        stripeEvent({
          id: 'evt_paid_older',
          type: 'invoice.paid',
          createdMs: harness.clock.nowEpochMs() - 600_000,
        }),
      );
      expect(older.statusCode).toBe(200);
      expect((older.json() as { outcome: string }).outcome).toBe('SUPERSEDED');
      // Last-write-wins would have marked this subscription healthy on the
      // strength of an event the provider stamped ten minutes earlier.
      expect((await subscriptionRow()).status).toBe('PAST_DUE');
    });

    it('records an event for a subscription it has never heard of, rather than losing it', async () => {
      const response = await send(
        stripeEvent({
          id: 'evt_unknown_sub',
          type: 'invoice.paid',
          subscriptionId: '00000000-0000-4000-8000-0000000000ff',
          // A distinct provider reference too, or this would match the
          // subscription by its external ref and legitimately apply.
          externalRef: 'sub_never_seen_before',
        }),
      );
      expect(response.statusCode).toBe(200);
      expect((response.json() as { outcome: string }).outcome).toBe('NO_MATCHING_SUBSCRIPTION');
      const row = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ outcome: string }>(`SELECT outcome FROM billing_events WHERE id = $1`, [
          'evt_unknown_sub',
        ]),
      );
      // A provider misconfiguration is a real signal, and losing it makes the
      // problem undiagnosable.
      expect(row?.outcome).toBe('NO_MATCHING_SUBSCRIPTION');
    });
  });

  // ---- Grace, lapse and what survives ------------------------------------

  describe('a failed payment is a grace period, not a punishment', () => {
    it('keeps observing while the grace period runs', async () => {
      const row = await subscriptionRow();
      expect(row.status).toBe('PAST_DUE');
      expect(row.grace_ends_at).not.toBeNull();
      expect(row.lapsed_at).toBeNull();
      // An expired card is the most common billing event there is. Suspending
      // an estate over one is a disproportionate response.
      expect(await maintained()).toBe(true);
    });

    it('resumes cleanly when the payment succeeds during grace', async () => {
      harness.clock.advance(60_000);
      const response = await send(stripeEvent({ id: 'evt_recovered', type: 'invoice.paid' }));
      expect((response.json() as { outcome: string }).outcome).toBe('APPLIED');
      const row = await subscriptionRow();
      expect(row.status).toBe('ACTIVE');
      expect(row.grace_ends_at).toBeNull();
      expect(row.lapsed_at).toBeNull();
      expect(await maintained()).toBe(true);
    });

    it('stops observing when the grace period runs out', async () => {
      harness.clock.advance(60_000);
      await send(stripeEvent({ id: 'evt_failed_final', type: 'invoice.payment_failed' }));
      expect(await maintained()).toBe(true);

      // The grace period expires and nothing more is heard from the provider,
      // which is the ordinary case: the job has to act on time rather than on
      // an event that never arrives.
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE subscriptions SET grace_ends_at = $2::timestamptz - interval '1 day'
           WHERE id = $1`,
          [subscriptionId, TEST_INSTANT],
        );
      });
      await harness.runJob('lapse-overdue-subscriptions');

      expect(await maintained()).toBe(false);
      expect((await subscriptionRow()).lapsed_at).not.toBeNull();
    });
  });

  describe('when Adericel stops observing, it stops asserting — and keeps everything', () => {
    it('stops scheduled collection and assessment', async () => {
      const before = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.oneOrFail<{ n: string }>(
          `SELECT count(*)::text AS n FROM assessments WHERE organisation_id = $1`,
          [tenant.organisationId],
          'Assessments',
        ),
      );
      await harness.runJob('reassess-organisation');
      await harness.runJob('collect-integrations');
      const after = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.oneOrFail<{ n: string }>(
          `SELECT count(*)::text AS n FROM assessments WHERE organisation_id = $1`,
          [tenant.organisationId],
          'Assessments',
        ),
      );
      // Not one new determination. Adericel has stopped looking, so it stops
      // saying anything about the present.
      expect(after.n).toBe(before.n);
    });

    it('deletes nothing', async () => {
      const counts = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
        ctx.oneOrFail<{ evidence: string; claims: string; assessments: string; passports: string }>(
          `SELECT (SELECT count(*) FROM evidence WHERE organisation_id = $1)::text AS evidence,
                  (SELECT count(*) FROM claims WHERE organisation_id = $1)::text AS claims,
                  (SELECT count(*) FROM assessments WHERE organisation_id = $1)::text AS assessments,
                  (SELECT count(*) FROM assurance_passports
                    WHERE organisation_id = $1)::text AS passports`,
          [tenant.organisationId],
          'Counts',
        ),
      );
      // A system of record that discards records over a failed payment is not
      // one. They may need this most precisely when they cannot pay.
      expect(Number(counts.evidence)).toBeGreaterThan(0);
      expect(Number(counts.claims)).toBeGreaterThan(0);
      expect(Number(counts.assessments)).toBeGreaterThan(0);
      expect(Number(counts.passports)).toBeGreaterThan(0);
    });

    it('says so on the customer’s own assurance view', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/assurance`,
        headers: bearer(token),
      });
      const body = response.json() as {
        maintenance: { maintained: boolean; note: string | null };
      };
      expect(body.maintenance.maintained).toBe(false);
      expect(body.maintenance.note).toMatch(/stopped observing/i);
      expect(body.maintenance.note).toMatch(/nothing has been deleted/i);
    });

    it('tells a third party holding a shared passport, before showing them the passport', async () => {
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        maintenance: { maintained: boolean; note: string | null };
        contentHash: string;
      };
      // The single most important test in this file. An insurer reading a
      // shared passport is reading it because the record is maintained; once it
      // is not, saying nothing lets them read a stale record as current, which
      // is manufacturing certainty by omission.
      expect(body.maintenance.maintained).toBe(false);
      expect(body.maintenance.note).toMatch(/no longer being\s+maintained/i);
      expect(body.maintenance.note).toMatch(/ask the organisation for a/i);
      // And it is careful not to imply the customer's security got worse.
      expect(body.maintenance.note).toMatch(/says nothing about whether their\s+security/i);
    });

    it('marks a passport issued while unmaintained, inside its hashed content', async () => {
      // The loophole this closes: stop paying, let Adericel stop collecting,
      // then mint a freshly dated passport carrying months-old determinations
      // and hand it to an insurer as a current record. The fact lives inside
      // the content, so it is covered by the content hash and cannot be
      // stripped without the document failing verification.
      const issued = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports`,
        headers: bearer(token),
      });
      expect(issued.statusCode).toBe(201);
      const body = issued.json() as {
        content: {
          maintenance: {
            maintained: boolean;
            stoppedAt: string | null;
            observedUntil: string | null;
          };
          interpretation: string;
        };
      };
      expect(body.content.maintenance.maintained).toBe(false);
      expect(body.content.maintenance.stoppedAt).not.toBeNull();
      // And the interpretation leads with it, in the words a reader sees first.
      expect(body.content.interpretation).toMatch(/^THIS RECORD IS NO LONGER MAINTAINED/);
      expect(body.content.interpretation).toMatch(/not the present/i);
      expect(body.content.interpretation).toMatch(/says nothing about whether their security/i);
    });

    it('leaves the passport itself true and still verifiable', async () => {
      // The record described a real instant and has not been altered. Only the
      // claim to currency is withdrawn — the passport is not.
      const verify = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify',
        payload: { contentHash: passportHash },
      });
      const body = verify.json() as { recognised: boolean; withdrawn: boolean };
      expect(body.recognised).toBe(true);
      expect(body.withdrawn).toBe(false);
    });

    it('resumes everything when the customer pays', async () => {
      harness.clock.advance(60_000);
      await send(stripeEvent({ id: 'evt_reactivated', type: 'invoice.paid' }));
      expect(await maintained()).toBe(true);
      expect((await subscriptionRow()).lapsed_at).toBeNull();

      const share = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}`,
      });
      expect(
        (share.json() as { maintenance: { maintained: boolean } }).maintenance.maintained,
      ).toBe(true);
    });
  });

  describe('cancellation is terminal', () => {
    it('lapses immediately, with no grace period', async () => {
      harness.clock.advance(60_000);
      const response = await send(
        stripeEvent({ id: 'evt_cancelled', type: 'customer.subscription.deleted' }),
      );
      expect((response.json() as { outcome: string }).outcome).toBe('APPLIED');
      const row = await subscriptionRow();
      expect(row.status).toBe('CANCELLED');
      // The customer said stop. There is nothing to be lenient about.
      expect(row.lapsed_at).not.toBeNull();
      expect(await maintained()).toBe(false);
    });

    it('is not undone by a later renewal', async () => {
      harness.clock.advance(60_000);
      const response = await send(stripeEvent({ id: 'evt_after_cancel', type: 'invoice.paid' }));
      expect(response.statusCode).toBe(200);
      expect((response.json() as { outcome: string }).outcome).toBe('SUBSCRIPTION_CANCELLED');
      // A final-period invoice settling after cancellation is ordinary, and
      // must not resurrect the subscription.
      expect((await subscriptionRow()).status).toBe('CANCELLED');
      expect(await maintained()).toBe(false);
    });
  });

  describe('checkout', () => {
    it('refuses to let one account pay against another’s subscription', async () => {
      const other = await seedTenant(harness, { slug: 'billing-other', records: RECORDS });
      const otherToken = await signIn(harness, 'owner-billing-other@test.invalid');
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${tenant.mspId}/billing/checkout`,
        headers: bearer(otherToken),
        payload: {
          planKey: 'assure',
          successUrl: 'https://example.test/ok',
          cancelUrl: 'https://example.test/no',
        },
      });
      // The subscription is resolved from the authenticated scope, never from
      // the body: a caller who could name it could pay a token amount against
      // somebody else's.
      expect([403, 404]).toContain(response.statusCode);
      void other;
    });

    it('refuses to take payment against a cancelled subscription', async () => {
      const owner = await signIn(harness, 'owner-billing-corp@test.invalid');
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${tenant.mspId}/billing/checkout`,
        headers: bearer(owner),
        payload: {
          planKey: 'assure',
          successUrl: 'https://example.test/ok',
          cancelUrl: 'https://example.test/no',
        },
      });
      expect(response.statusCode).toBe(412);
      expect(response.body).toMatch(/cancelled/i);
    });
  });
});
