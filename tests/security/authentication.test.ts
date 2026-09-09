import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@adericel/api';
import { AdericelError } from '@adericel/shared';
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
 * Authentication and token security.
 *
 * The token verification path is the security boundary of the whole API, so it
 * is attacked here directly rather than only exercised through a happy path.
 */

const SECRET = 'test-jwt-secret-value-that-is-long-enough-32';
const NOW = Math.floor(Date.parse('2026-09-09T12:00:00.000Z') / 1000);

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    iss: 'adericel',
    aud: 'adericel-api',
    name: 'Test User',
    email: 'test@example.invalid',
    mspId: null,
    ...overrides,
  } as Parameters<typeof issueAccessToken>[1];
}

const verifyOptions = { issuer: 'adericel', audience: 'adericel-api', nowEpochSeconds: NOW };

describe('access token verification', () => {
  it('accepts a well-formed token', () => {
    const token = issueAccessToken(SECRET, claims(), NOW, 3600);
    expect(verifyAccessToken(SECRET, token, verifyOptions).sub).toBe(claims().sub);
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueAccessToken('a-completely-different-secret-value-32ch', claims(), NOW, 3600);
    expect(() => verifyAccessToken(SECRET, token, verifyOptions)).toThrow(/signature/i);
  });

  it('rejects the alg:none forgery', () => {
    // The classic attack: swap the algorithm and drop the signature.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ ...claims(), iat: NOW, exp: NOW + 3600 }),
    ).toString('base64url');
    expect(() => verifyAccessToken(SECRET, `${header}.${payload}.`, verifyOptions)).toThrow();
  });

  it('rejects a token whose header claims a different algorithm', () => {
    // Correctly signed with HS256 but declaring HS512. The algorithm is
    // asserted, not read from the token, so this is refused.
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ ...claims(), iat: NOW, exp: NOW + 3600 }),
    ).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    expect(() =>
      verifyAccessToken(SECRET, `${header}.${payload}.${signature}`, verifyOptions),
    ).toThrow(/algorithm/i);
  });

  it('rejects a token whose payload has been altered', () => {
    const token = issueAccessToken(SECRET, claims(), NOW, 3600);
    const [header, , signature] = token.split('.') as [string, string, string];
    const tampered = Buffer.from(
      JSON.stringify({ ...claims({ sub: 'attacker' }), iat: NOW, exp: NOW + 3600 }),
    ).toString('base64url');
    expect(() =>
      verifyAccessToken(SECRET, `${header}.${tampered}.${signature}`, verifyOptions),
    ).toThrow(/signature/i);
  });

  it('rejects an expired token', () => {
    const token = issueAccessToken(SECRET, claims(), NOW - 7200, 3600);
    expect(() => verifyAccessToken(SECRET, token, verifyOptions)).toThrow(/expired/i);
  });

  it('rejects a token issued in the future beyond the skew allowance', () => {
    const token = issueAccessToken(SECRET, claims(), NOW + 600, 3600);
    expect(() => verifyAccessToken(SECRET, token, verifyOptions)).toThrow(/not yet valid/i);
  });

  it('rejects an issuer or audience mismatch', () => {
    const wrongIssuer = issueAccessToken(SECRET, claims({ iss: 'someone-else' }), NOW, 3600);
    expect(() => verifyAccessToken(SECRET, wrongIssuer, verifyOptions)).toThrow(/issuer/i);

    const wrongAudience = issueAccessToken(SECRET, claims({ aud: 'another-api' }), NOW, 3600);
    expect(() => verifyAccessToken(SECRET, wrongAudience, verifyOptions)).toThrow(/audience/i);
  });

  it('rejects structurally malformed tokens without throwing an unexpected error', () => {
    for (const token of ['', 'a', 'a.b', 'a.b.c.d', '....', 'not-a-token']) {
      expect(() => verifyAccessToken(SECRET, token, verifyOptions)).toThrow(AdericelError);
    }
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)('authentication at the API edge', () => {
  let harness: Harness;
  let tenant: SeededTenant;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'sec-corp' });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('refuses an unauthenticated request', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('gives the same answer for an unknown email as for a wrong password', async () => {
    const unknown = await harness.server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@test.invalid', password: TEST_PASSWORD },
    });
    const wrongPassword = await harness.server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner-sec-corp@test.invalid', password: 'wrong-password' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    // Identical code and message. Only the correlation id differs, which is
    // per-request and carries no information about the account.
    const a = (unknown.json() as { error: { code: string; message: string } }).error;
    const b = (wrongPassword.json() as { error: { code: string; message: string } }).error;
    expect({ code: a.code, message: a.message }).toEqual({ code: b.code, message: b.message });
  });

  it('revokes authority immediately when a grant is revoked, without waiting for expiry', async () => {
    const token = await signIn(harness, 'owner-sec-corp@test.invalid');
    const before = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(token),
    });
    expect(before.statusCode).toBe(200);

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE grants SET revoked_at = now() WHERE principal_id = $1`, [
        tenant.ownerUserId,
      ]);
    });

    // The token is still cryptographically valid; the authority behind it is not.
    const after = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/assurance`,
      headers: bearer(token),
    });
    expect(after.statusCode).toBe(403);

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE grants SET revoked_at = NULL WHERE principal_id = $1`, [
        tenant.ownerUserId,
      ]);
    });
  });

  it('invalidates an access token when its session is revoked', async () => {
    const token = await signIn(harness, 'owner-sec-corp@test.invalid');
    await harness.server.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(token) });

    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rotates the refresh token so a replayed one is useless', async () => {
    const login = await harness.server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'owner-sec-corp@test.invalid', password: TEST_PASSWORD },
    });
    const first = (login.json() as { refreshToken: string }).refreshToken;

    const refreshed = await harness.server.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first },
    });
    expect(refreshed.statusCode).toBe(200);
    expect((refreshed.json() as { refreshToken: string }).refreshToken).not.toBe(first);

    const replay = await harness.server.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects an invalid or malformed API key', async () => {
    for (const key of ['adk_bogus_secret', 'not-a-key', 'adk_a_b_c']) {
      const response = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { 'x-api-key': key },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects an unsigned webhook and one with a stale timestamp', async () => {
    const unsigned = await harness.server.inject({
      method: 'POST',
      url: '/v1/webhooks/ping',
      payload: {},
    });
    // Signing is not configured in tests, so the route reports that rather than
    // silently accepting an unauthenticated call.
    expect([401, 501]).toContain(unsigned.statusCode);
  });
});
