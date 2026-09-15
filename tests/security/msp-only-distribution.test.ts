import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  TEST_PASSWORD,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Adericel is distributed through MSPs, and only through MSPs.
 *
 * Contract v3.0 §2 and §37. This is a commercial constraint with a security
 * shape: an organisation with no MSP is a customer relationship Veylith holds
 * directly, and the product is built on the promise that it holds none.
 *
 * Two paths previously created one — a public signup carrying
 * `accountKind: 'DIRECT'`, and a platform route that passed `mspId: null` and
 * called itself "direct (non-MSP)". Both are removed. These tests exist so
 * that removing them stays removed: a future refactor that reintroduces either
 * fails here rather than in an MSP's security review.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('no direct-to-SME path exists', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let platformToken: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'msp-only-corp', frameworks: ['cyber-essentials'] });

    // Veylith's own operator: the most authority the company has. If anyone
    // could create a direct customer relationship it would be this principal,
    // which is exactly why the test uses it.
    const hash = await harness.app.passwords.hash(TEST_PASSWORD);
    await harness.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, status) VALUES ($1, $2, 'ACTIVE')
         ON CONFLICT (lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        ['ops@veylith.test.invalid', 'Veylith Operator'],
        'User',
      );
      await ctx.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
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
    });
    platformToken = await signIn(harness, 'ops@veylith.test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('refuses a signup that asks for a direct account', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: {
        email: 'owner@small-business.test.invalid',
        contactName: 'A Business Owner',
        accountKind: 'DIRECT',
        organisationName: 'Small Business Ltd',
      },
    });

    // The field no longer exists in the schema. A caller sending it is either
    // an old client or somebody probing, and either way the answer is the same:
    // there is no such account shape.
    expect(response.statusCode).toBe(400);
  });

  it('creates an MSP for an ordinary signup, never a bare organisation', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: {
        email: 'operator@an-msp.test.invalid',
        contactName: 'An MSP Operator',
        organisationName: 'An MSP Ltd',
      },
    });
    expect(response.statusCode).toBe(202);

    const token = (response.json() as { developmentToken?: string }).developmentToken;
    expect(token, 'the test notifier should surface the token').toBeDefined();

    const completed = await harness.server.inject({
      method: 'POST',
      url: '/v1/signup/complete',
      payload: { token, password: 'A-long-enough-password-2026!' },
    });
    expect(completed.statusCode).toBe(201);

    const account = (completed.json() as { account: { mspId: string | null } }).account;
    // Not merely present — an MSP was created. The direct shape had this null.
    expect(account.mspId).not.toBeNull();
  });

  it('refuses to provision an organisation without an MSP through the platform route', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/organisations',
      headers: bearer(platformToken),
      payload: { name: 'A Direct Customer Ltd', countryCode: 'GB' },
    });

    // mspId is required. The route used to pass null and describe itself as
    // creating a "direct (non-MSP) organisation". A platform administrator is
    // the one principal with the authority to have done it.
    expect(response.statusCode).toBe(400);
  });

  it('the database refuses an MSP-less organisation even if application code regresses', async () => {
    // The structural guarantee. Application checks are the first line; this is
    // the one that survives a refactor which forgets them.
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(
          `INSERT INTO organisations (msp_id, name, slug, status, country_code)
           VALUES (NULL, 'Bypass Ltd', 'bypass-ltd', 'ACTIVE', 'GB')`,
          [],
        ),
      ),
    ).rejects.toThrow();
  });

  it('every seeded organisation belongs to an MSP', async () => {
    const orphans = await harness.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{ count: string }>(
        `SELECT count(*)::text AS count FROM organisations WHERE msp_id IS NULL`,
        [],
        'Orphan check',
      ),
    );
    expect(Number(orphans.count)).toBe(0);
    expect(tenant.mspId).toBeTruthy();
  });

  it('records no account-shape choice anywhere a new signup can reach', async () => {
    // A signup row may only be MSP. The column is retained for historical rows
    // — rewriting history to match a later policy is the habit this product
    // exists to refuse — but nothing new can be any other shape.
    await expect(
      harness.db.withPlatform(async (ctx) =>
        ctx.query(
          `INSERT INTO signups
             (email, contact_name, account_kind, organisation_name, token_hash, expires_at)
           VALUES ('x@y.invalid','X','DIRECT','Z','hash', now() + interval '1 hour')`,
          [],
        ),
      ),
    ).rejects.toThrow();
  });
});
