import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  signInWithMfa,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * A person's right to be erased, and the two ways it can be exercised.
 *
 * WHY THIS SUITE EXISTS
 *
 * `eraseDataSubject` was a complete, careful implementation — it pseudonymises
 * an approval rather than destroying a customer's record of who authorised a
 * change to their systems, and explains why — and it had **no route**.
 * Organisation-level erasure was wired; one person's right was implemented,
 * tested, documented and unreachable. The reachability check found it.
 *
 * Both paths exist now, because a login is a precondition of self-service and
 * the people most likely to need erasing are the ones who have left:
 *
 *   - **Self-service.** The person erases themselves. Veylith Systems is the
 *     controller for a platform user's own account data, so acting directly on
 *     their request is lawful and right.
 *   - **On their behalf.** An MSP owner erases a member who can no longer sign
 *     in.
 *
 * WHAT HAS NO ROUTE, DELIBERATELY
 *
 * A person observed inside a customer's estate — an account name, a device
 * owner, a mailbox. `DATA_SUBJECT_KINDS` says it plainly: for them Veylith is
 * a processor, the controller is the customer, and their request is answered by
 * the customer with Adericel's assistance. A self-service route for that case
 * would mean acting on an unauthenticated claim to be a named person, outside
 * the processing agreement — and it would let somebody erase the record of a
 * privileged account by claiming to be its owner. The absence is a decision,
 * and the test at the bottom of this file states it so nobody adds one by
 * accident.
 */

const available = await databaseAvailable();

describe.skipIf(!available)("a person's right to be erased", () => {
  let harness: Harness;
  let tenant: SeededTenant;
  /**
   * A tenant whose users this suite burns.
   *
   * Erasure is irreversible and `signInWithMfa` enrols a factor, which cannot
   * be done twice for one account. So the tests that actually erase somebody
   * get their own tenant rather than sharing one and depending on the order
   * they happen to run in.
   */
  let burnable: SeededTenant;
  /**
   * One MFA-enrolled owner token, obtained once.
   *
   * `signInWithMfa` enrols a second factor, and enrolling twice for one
   * account is refused — correctly, by the harness. Sharing the token means
   * these tests do not depend on which of them happens to run first.
   */
  let ownerToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'erase-corp' });
    burnable = await seedTenant(harness, { slug: 'burn-corp' });
    ownerToken = await signInWithMfa(harness, 'owner-erase-corp@test.invalid');
    // A session for somebody the self-erasure must leave alone. Sessions exist
    // only once a person has signed in, so without this the "erased the wrong
    // person" check would compare nothing to nothing.
    await signIn(harness, 'owner-burn-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const sessionsFor = async (userId: string): Promise<number> =>
    harness.db.withPlatform(async (ctx) => {
      const row = await ctx.oneOrFail<{ count: string }>(
        `SELECT count(*)::text AS count FROM sessions WHERE user_id = $1`,
        [userId],
        'Session count',
      );
      return Number(row.count);
    });

  describe('erasing yourself', () => {
    it('refuses without a second factor, because it cannot be undone', async () => {
      const token = await signIn(harness, 'analyst-erase-corp@test.invalid');
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/me/erasure',
        headers: bearer(token),
        payload: { reason: 'I am leaving and want my account data removed.' },
      });
      // A stolen session must not be enough.
      expect(response.statusCode).toBe(403);
      expect(await sessionsFor(tenant.analystUserId)).toBeGreaterThan(0);
    });

    it('refuses a reason nobody could weigh a year later', async () => {
      const token = await signInWithMfa(harness, 'approver-erase-corp@test.invalid');
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/me/erasure',
        headers: bearer(token),
        payload: { reason: 'ok' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('erases the caller, and takes no target to erase anybody else', async () => {
      /**
       * The safety argument, stated as a test.
       *
       * This route has no user identifier in it. The subject is the
       * authenticated principal, so there is no parameter to tamper with — a
       * route that took a target and checked it matched the caller would be one
       * refactor away from not checking. Passing a different user's id in the
       * body must change nothing.
       */
      const token = await signInWithMfa(harness, 'approver-burn-corp@test.invalid');
      const before = await sessionsFor(burnable.ownerUserId);
      expect(before, 'the owner has no session, so this test would prove nothing').toBeGreaterThan(
        0,
      );

      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/me/erasure',
        headers: bearer(token),
        payload: {
          reason: 'Exercising my right to erasure after leaving the business.',
          // Ignored, because the route reads no target. Present precisely to
          // prove it is ignored.
          userId: burnable.ownerUserId,
        },
      });
      expect(response.statusCode).toBe(200);

      const report = response.json() as { deleted: Record<string, number> };
      expect(Object.keys(report.deleted).length).toBeGreaterThan(0);

      // The caller is gone; the user named in the body is untouched.
      expect(await sessionsFor(burnable.approverUserId)).toBe(0);
      expect(
        await sessionsFor(burnable.ownerUserId),
        'a user named in the request body was erased: the route is reading a target',
      ).toBe(before);
    });
  });

  describe('erasing a member on their behalf', () => {
    it('refuses to reach into another MSP', async () => {
      /**
       * A cross-tenant erasure would be the most destructive act available
       * through this API. Refused as not found rather than as forbidden,
       * because confirming the person exists would itself disclose something
       * about another MSP's staff.
       */
      const other = await seedTenant(harness, { slug: 'other-erase-corp' });

      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${tenant.mspId}/members/${other.analystUserId}/erasure`,
        headers: bearer(ownerToken),
        payload: { reason: 'Attempting to erase somebody in a different MSP.' },
      });
      expect(response.statusCode).toBe(404);
      expect(await sessionsFor(other.analystUserId)).toBeGreaterThanOrEqual(0);

      const stillThere = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [other.analystUserId]),
      );
      expect(stillThere, 'a user in another MSP was erased').not.toBeNull();
    });

    it('erases a member who can no longer sign in', async () => {
      // The reason the route exists: somebody who has left cannot use the
      // self-service path, and still holds the right.
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/msps/${tenant.mspId}/members/${tenant.analystUserId}/erasure`,
        headers: bearer(ownerToken),
        payload: { reason: 'Left the business in March and asked for erasure by email.' },
      });
      expect(response.statusCode).toBe(200);

      const credentials = await harness.db.withPlatform(async (ctx) =>
        ctx.one<{ user_id: string }>(`SELECT user_id FROM user_credentials WHERE user_id = $1`, [
          tenant.analystUserId,
        ]),
      );
      expect(credentials, 'the credentials survived an erasure').toBeNull();
    });

    it('records who asked and why, before it acts', async () => {
      /**
       * Audited first, not last. The erasure removes the subject's sessions,
       * so for a self-erasure the request's own principal stops resolving
       * part-way through — and an interrupted erasure must still leave a
       * record that it was attempted, by whom, and why.
       */
      const entries = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ action: string; reason: string | null }>(
          `SELECT action, reason FROM audit_log
            WHERE action LIKE 'data_subject.erasure%' ORDER BY occurred_at`,
        ),
      );
      expect(entries.map((e) => e.action)).toContain('data_subject.erasure.self');
      expect(entries.map((e) => e.action)).toContain('data_subject.erasure.on_behalf');
      for (const entry of entries) {
        expect(entry.reason, 'an erasure was recorded without a reason').not.toBeNull();
        expect((entry.reason ?? '').length).toBeGreaterThanOrEqual(10);
      }
    });
  });

  describe('a person inside a customer estate has no route here', () => {
    it('exposes no erasure path keyed on an observed identity', async () => {
      /**
       * The deliberate absence, asserted so it cannot be filled in by
       * accident.
       *
       * Adericel is a processor for these people. Their controller is the
       * customer, and the domain says their request is answered by the
       * customer with Adericel's assistance. A route that erased an observed
       * identity on request would be acting outside the processing agreement,
       * and would accept an unauthenticated claim to be a named person — which
       * is how somebody would erase the record of a privileged account by
       * claiming to be its owner.
       *
       * Listed from the server's own route table rather than grepped, so a
       * route added anywhere is caught.
       */
      const routes = harness.server
        .printRoutes({ commonPrefix: false })
        .split('\n')
        .map((line) => line.trim());
      const offending = routes.filter(
        (line) =>
          /eras/i.test(line) && /(subject|identity|account|mailbox|person)/i.test(line) === true,
      );
      expect(
        offending,
        'an erasure route keyed on an observed estate identity exists. Adericel is a processor ' +
          'for those people; the request is answered by the customer, with our assistance.',
      ).toEqual([]);
    });
  });
});
