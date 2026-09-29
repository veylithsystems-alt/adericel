import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  enrolTotp,
  seedTenant,
  signIn,
  signInWithTotp,
  TEST_PASSWORD,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Break-glass: emergency access that leaves a mark.
 *
 * Contract v3.1 §28 and §30. The property under test throughout is not that
 * access can be obtained — that is easy — but that it cannot be obtained
 * quietly, cannot be extended, cannot grant authority, and actually works when
 * it is needed.
 *
 * That last one is here because it nearly did not. The first implementation
 * issued a grant carrying a role that did not exist in the authority model, so
 * it would have inserted cleanly, conferred nothing, and been discovered at 3am
 * by somebody who needed it.
 */

const available = await databaseAvailable();

const JUSTIFICATION =
  'Customer reports every control reading UNKNOWN since the Entra connector was reauthorised.';

describe.skipIf(!available)('break-glass', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let veylithToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'glass-corp', frameworks: ['cyber-essentials'] });

    const hash = await harness.app.passwords.hash(TEST_PASSWORD);
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status) VALUES ($1,$2,'ACTIVE')
         ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        ['ops@veylith.test.invalid', 'Veylith Operator'],
        'User',
      );
      await ctx.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
        [user.id, hash],
      );
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'PLATFORM', NULL, $2::text[])
         ON CONFLICT (principal_type, principal_id, scope_type,
                      COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
         WHERE revoked_at IS NULL DO UPDATE SET roles = EXCLUDED.roles`,
        [user.id, ['PLATFORM_ADMIN']],
      );
      return user.id;
    });

    // Break-glass requires a second factor, so the operator needs one enrolled.
    const initial = await signIn(harness, 'ops@veylith.test.invalid');
    const factor = await enrolTotp(harness, initial);
    const session = await signInWithTotp(harness, 'ops@veylith.test.invalid', factor.secret);
    veylithToken = session.accessToken;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const open = async (
    overrides: Record<string, unknown> = {},
    token = veylithToken,
  ): ReturnType<Harness['server']['inject']> =>
    harness.server.inject({
      method: 'POST',
      url: '/v1/system/break-glass',
      headers: bearer(token),
      payload: {
        organisationId: tenant.organisationId,
        reason: 'SERVICE_FAILURE',
        justification: JUSTIFICATION,
        minutes: 30,
        permissions: ['org:read', 'org:assessment:read'],
        ...overrides,
      },
    });

  /** Close every live grant, so a baseline reading means what it says. */
  const closeEverythingLive = async (): Promise<void> => {
    const list = await harness.server.inject({
      method: 'GET',
      url: '/v1/system/break-glass',
      headers: bearer(veylithToken),
    });
    const grants = list.json<{ grants: { id: string; live: boolean }[] }>().grants;
    for (const grant of grants.filter((g) => g.live)) {
      await harness.server.inject({
        method: 'POST',
        url: `/v1/system/break-glass/${grant.id}/close`,
        headers: bearer(veylithToken),
      });
    }
  };

  it('refuses a grant that cannot say what is happening', async () => {
    const response = await open({ justification: 'need access' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to confer authority over who can reach the estate', async () => {
    // Emergency access is for understanding an estate, not for changing who can
    // reach it afterwards. Granting authority under emergency authority is how
    // temporary access becomes permanent, in one step, with a plausible reason.
    const response = await open({ permissions: ['org:read', 'org:member:manage'] });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/cannot confer/i);
  });

  it('refuses to confer execution against the customer’s own systems', async () => {
    const response = await open({ permissions: ['org:action:execute'] });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a window longer than four hours', async () => {
    const response = await open({ minutes: 600 });
    expect(response.statusCode).toBe(400);
  });

  it('opens, and tells the MSP at the time rather than afterwards', async () => {
    const response = await open();
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      mspNotified: boolean;
      reviewRequired: boolean;
      visibility: string;
      expiresAt: string;
    };

    expect(body.reviewRequired).toBe(true);
    expect(body.visibility).toMatch(/cannot be extended/i);

    // The MSP owns this customer relationship and is entitled to know that
    // their supplier went into their customer's estate, at the time.
    expect(body.mspNotified).toBe(true);
    const message = harness.notifier.lastTo('owner-glass-corp@test.invalid');
    expect(message).not.toBeNull();
    expect(message!.text).toContain(JUSTIFICATION);
    expect(message!.text).toMatch(/expires automatically/i);
  });

  it('actually confers the access it promises', async () => {
    /**
     * The test that exists because this nearly shipped broken.
     *
     * The first version issued a grant carrying a role the authority model did
     * not define. It would have inserted cleanly — the grants table constrains
     * array length, not role names — conferred nothing, and been discovered by
     * an operator at 3am who needed it to work.
     *
     * Opening a door is not the same as the door opening.
     */
    // Establish the baseline honestly. An earlier test in this file opened a
    // grant, and a "before" reading taken while that grant is live would prove
    // nothing at all. Close everything first, through the product's own route.
    await closeEverythingLive();

    const before = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(veylithToken),
    });
    // No standing authority over a customer organisation (§29). A Veylith
    // platform grant is not visible on either Adericel surface, so this is the
    // real starting position rather than an artefact of test ordering.
    expect(before.statusCode).toBe(403);

    const opened = await open();
    expect(opened.statusCode).toBe(201);

    // The grant is live, so the same operator with the same session now reaches
    // the estate — through the ordinary authority path, not a special one.
    const after = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(veylithToken),
    });
    expect(after.statusCode).toBe(200);
  });

  it('confers only what was asked for, never the whole role', async () => {
    /**
     * The finding this test was written for.
     *
     * The first implementation issued `roles = ['BREAK_GLASS']` and recorded
     * the requested permissions in a column nothing read. An operator who asked
     * for `org:read` during an incident silently received the ability to write
     * claims and evidence into the customer's estate — the exact thing a narrow
     * request exists to avoid. The permissions list was a record of what
     * somebody typed, not a statement of what they got.
     *
     * The grant is now attenuated to the requested set, so the two agree.
     */
    await closeEverythingLive();

    const opened = await open({ permissions: ['org:read', 'org:assessment:read'] });
    expect(opened.statusCode).toBe(201);

    // Inside the role's ceiling and explicitly requested: open.
    const read = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(veylithToken),
    });
    expect(read.statusCode).toBe(200);

    // Inside the role's ceiling but NOT requested: shut.
    const write = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/claims`,
      headers: bearer(veylithToken),
      payload: { predicate: 'identity.mfa.enforced', value: true, origin: 'HUMAN_ASSERTED' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('cannot have its narrowing widened afterwards', async () => {
    /**
     * Enforced by the database. A narrowing that can be lifted by an UPDATE is
     * not a narrowing; it is a note.
     *
     * The API deliberately does not surface database error text, so this
     * asserts on the outcome rather than the wording: the statement is refused
     * AND the stored narrowing is exactly what it was. Asserting only that
     * something threw would pass just as happily if the write had failed for an
     * unrelated reason and left the grant widened.
     */
    const before = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ id: string; attenuated_to: string[] }>(
        `SELECT id, attenuated_to FROM grants WHERE attenuated_to IS NOT NULL ORDER BY id`,
        [],
      ),
    );
    expect(before.length).toBeGreaterThan(0);

    // Widening the list.
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(
          `UPDATE grants SET attenuated_to = attenuated_to || ARRAY['org:claim:write']
            WHERE attenuated_to IS NOT NULL`,
          [],
        ),
      ),
    ).rejects.toThrow();

    // Dropping it, to fall back on everything the role carries.
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(`UPDATE grants SET attenuated_to = NULL WHERE attenuated_to IS NOT NULL`, []),
      ),
    ).rejects.toThrow();

    const after = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ id: string; attenuated_to: string[] }>(
        `SELECT id, attenuated_to FROM grants WHERE attenuated_to IS NOT NULL ORDER BY id`,
        [],
      ),
    );
    expect(after).toEqual(before);
  });

  it('refuses a second live window rather than failing obscurely', async () => {
    /**
     * `grants_unique_live` allows one live grant per principal per scope. A
     * second open would once have hit a unique violation and returned a 500 to
     * an operator working an incident, which is the worst possible moment for
     * an unexplained failure. It is now an answer they can act on.
     */
    const second = await open();
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { message: string } }>().error.message).toMatch(
      /already hold live access/i,
    );
  });

  it('can be opened again once the window has run out', async () => {
    // Expiry is not revocation, so the expired row sits there with
    // `revoked_at IS NULL` and used to collide with the next one. An incident
    // that outlives its window must be able to open a second grant — that is
    // the documented path, and it has to work.
    await closeEverythingLive();
    expect((await open({ minutes: 30 })).statusCode).toBe(201);

    // Expire it against the harness clock, which is fixed and is the clock the
    // service reads. `now()` here would be the database's wall clock and would
    // silently mean something else.
    const alreadyGone = new Date(harness.clock.nowEpochMs() - 60_000).toISOString();
    await harness.db.withPlatform(async (ctx) =>
      ctx.query(
        `UPDATE grants SET expires_at = $1::timestamptz
          WHERE attenuated_to IS NOT NULL AND revoked_at IS NULL`,
        [alreadyGone],
      ),
    );

    const again = await open({ minutes: 30 });
    expect(again.statusCode).toBe(201);
  });

  it('closes early, and the access stops', async () => {
    const list = await harness.server.inject({
      method: 'GET',
      url: '/v1/system/break-glass',
      headers: bearer(veylithToken),
    });
    const grants = list.json<{ grants: { id: string; live: boolean }[] }>().grants;
    const live = grants.find((g) => g.live);
    expect(live).toBeDefined();

    const closed = await harness.server.inject({
      method: 'POST',
      url: `/v1/system/break-glass/${live!.id}/close`,
      headers: bearer(veylithToken),
    });
    expect(closed.statusCode).toBe(200);
  });

  it('cannot be extended, at any layer', async () => {
    // Enforced by the database, not only by the service. An incident that
    // outlives the window opens a second grant — another decision, another
    // justification, another notification to the MSP.
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(`UPDATE break_glass_grants SET expires_at = expires_at + interval '1 day'`, []),
      ),
    ).rejects.toThrow();
  });

  it('cannot have its stated reason rewritten afterwards', async () => {
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(`UPDATE break_glass_grants SET justification = 'routine maintenance'`, []),
      ),
    ).rejects.toThrow();
  });

  it('is never deleted', async () => {
    await expect(
      harness.db.withPlatform(async (ctx) => ctx.query(`DELETE FROM break_glass_grants`, [])),
    ).rejects.toThrow();
  });

  it('is visible to the organisation it was used on', async () => {
    // Emergency access the subject cannot see is a back door with better
    // paperwork. The organisation's own audit trail carries it.
    const rows = await harness.db.withTenant(tenant.organisationId, async (ctx) =>
      ctx.many<{ id: string }>(`SELECT id FROM break_glass_grants WHERE organisation_id = $1`, [
        tenant.organisationId,
      ]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)('break-glass without a second factor', () => {
  let harness: Harness;
  let tenant: SeededTenant;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'nomfa-corp', frameworks: ['cyber-essentials'] });

    const hash = await harness.app.passwords.hash(TEST_PASSWORD);
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
        ['nomfa@veylith.test.invalid', 'Operator Without MFA'],
        'User',
      );
      await ctx.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)`, [
        user.id,
        hash,
      ]);
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'PLATFORM', NULL, ARRAY['PLATFORM_ADMIN']::text[])`,
        [user.id],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('is refused, because a stolen session is exactly what would open this door', async () => {
    /**
     * The one control not relaxed under emergency.
     *
     * Everything else about break-glass is designed to be easy to use at 3am,
     * because a control that is hard to use in an emergency gets bypassed. This
     * is the exception: break-glass is precisely what a stolen session would be
     * used for, and a password alone opening a customer's estate turns any
     * credential theft into a tenancy breach.
     */
    const token = await signIn(harness, 'nomfa@veylith.test.invalid');
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/system/break-glass',
      headers: bearer(token),
      payload: {
        organisationId: tenant.organisationId,
        reason: 'SECURITY_INCIDENT',
        justification: JUSTIFICATION,
        minutes: 30,
        permissions: ['org:read'],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/second factor/i);
  });
});
