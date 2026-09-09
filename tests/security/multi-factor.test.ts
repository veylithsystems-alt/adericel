import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCodeForStep, totpStep } from '@adericel/shared';
import {
  bearer,
  createHarness,
  databaseAvailable,
  enrolTotp,
  seedTenant,
  signIn,
  signInWithTotp,
  TEST_PASSWORD,
  TOTP_PERIOD_MS,
  type Harness,
} from '../helpers/harness.js';

/**
 * Multi-factor authentication.
 *
 * The happy path is the least interesting part. What matters is that the
 * failure modes hold: a challenge conveys no authority, an unconfirmed factor
 * cannot satisfy one, a code cannot be replayed inside its own window, and a
 * recovery code works exactly once.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('multi-factor authentication', () => {
  let harness: Harness;
  // One user per phase. Enrolment is not reversible within a describe block —
  // once a user has a factor, `signIn` no longer returns a token for them — so
  // sharing a user between the "before enrolment" and "after enrolment" cases
  // would make the tests order-dependent in a way that is invisible until it
  // breaks.
  const beforeEnrolment = 'owner-mfa-corp@test.invalid';
  const withFactor = 'approver-mfa-corp@test.invalid';
  const forRemoval = 'analyst-mfa-corp@test.invalid';
  const forAudit = 'owner-mfa-two@test.invalid';

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    await seedTenant(harness, { slug: 'mfa-corp', records: [] });
    await seedTenant(harness, { slug: 'mfa-two', records: [] });
  });

  afterAll(async () => {
    await harness.close();
  });

  const login = (payload: Record<string, unknown>) =>
    harness.server.inject({ method: 'POST', url: '/v1/auth/login', payload });

  const verify = (payload: Record<string, unknown>) =>
    harness.server.inject({ method: 'POST', url: '/v1/auth/mfa/verify', payload });

  const currentCode = (secret: string) =>
    totpCodeForStep(secret, totpStep(harness.clock.nowEpochMs()));

  describe('before enrolment', () => {
    it('signs in with a password alone and says the session has no factor', async () => {
      const response = await login({ email: beforeEnrolment, password: TEST_PASSWORD });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { mfaRequired: boolean; accessToken: string };
      expect(body.mfaRequired).toBe(false);
      expect(body.accessToken).toBeTruthy();

      const status = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/mfa',
        headers: bearer(body.accessToken),
      });
      expect(status.json()).toMatchObject({
        enrolled: false,
        sessionSatisfied: false,
        recoveryCodesRemaining: 0,
      });
    });

    it('names the permissions that will require a factor, from the same source that enforces them', async () => {
      const token = await signIn(harness, beforeEnrolment);
      const status = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/mfa',
        headers: bearer(token),
      });
      expect((status.json() as { requiredFor: string[] }).requiredFor).toContain(
        'org:action:approve',
      );
    });
  });

  describe('enrolment', () => {
    it('refuses to let an unconfirmed factor satisfy a login', async () => {
      const token = await signIn(harness, beforeEnrolment);
      const begin = await harness.server.inject({
        method: 'POST',
        url: '/v1/auth/mfa/totp',
        headers: bearer(token),
      });
      expect(begin.statusCode).toBe(201);

      // Enrolment started but never confirmed. Login must not challenge, and
      // the secret must not be usable — otherwise starting an enrolment would
      // itself be the bypass.
      const response = await login({ email: beforeEnrolment, password: TEST_PASSWORD });
      expect((response.json() as { mfaRequired: boolean }).mfaRequired).toBe(false);
    });

    it('rejects a wrong code at confirmation without enrolling anything', async () => {
      const token = await signIn(harness, beforeEnrolment);
      await harness.server.inject({
        method: 'POST',
        url: '/v1/auth/mfa/totp',
        headers: bearer(token),
      });
      const confirm = await harness.server.inject({
        method: 'POST',
        url: '/v1/auth/mfa/totp/confirm',
        headers: bearer(token),
        payload: { code: '000000' },
      });
      expect(confirm.statusCode).toBe(400);

      const status = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/mfa',
        headers: bearer(token),
      });
      expect((status.json() as { enrolled: boolean }).enrolled).toBe(false);
    });

    it('issues ten recovery codes exactly once and elevates the current session', async () => {
      const token = await signIn(harness, beforeEnrolment);
      const { recoveryCodes } = await enrolTotp(harness, token);
      expect(recoveryCodes).toHaveLength(10);

      const status = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/mfa',
        headers: bearer(token),
      });
      // Confirming enrolled the factor and elevated this session, so somebody
      // enrolling in order to approve does not have to sign out and back in.
      expect(status.json()).toMatchObject({
        enrolled: true,
        sessionSatisfied: true,
        recoveryCodesRemaining: 10,
      });

      // There is no endpoint that returns them again.
      const body = JSON.stringify(status.json());
      for (const code of recoveryCodes) expect(body).not.toContain(code);
    });
  });

  describe('sign-in with a factor enrolled', () => {
    let secret: string;
    let recoveryCodes: readonly string[];

    beforeAll(async () => {
      const token = await signIn(harness, withFactor);
      const enrolled = await enrolTotp(harness, token);
      secret = enrolled.secret;
      recoveryCodes = enrolled.recoveryCodes;
    });

    it('returns a challenge rather than tokens', async () => {
      const response = await login({ email: withFactor, password: TEST_PASSWORD });
      expect(response.statusCode).toBe(200);
      const body = response.json() as Record<string, unknown>;
      expect(body.mfaRequired).toBe(true);
      expect(body.challengeToken).toBeTruthy();
      // The password was correct. That is all the challenge asserts.
      expect(body.accessToken).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    });

    it('refuses a challenge token used as a bearer token', async () => {
      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      const response = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: bearer(challengeToken),
      });
      expect(response.statusCode).toBe(401);
    });

    it('completes with a valid code', async () => {
      const tokens = await signInWithTotp(harness, withFactor, secret);
      expect(tokens.accessToken).toBeTruthy();

      const status = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/mfa',
        headers: bearer(tokens.accessToken),
      });
      expect((status.json() as { sessionSatisfied: boolean }).sessionSatisfied).toBe(true);
    });

    it('refuses to replay a code inside its own window', async () => {
      // Move to a step nothing has used yet. The harness clock only moves when
      // told to, so without this the step was already consumed by the previous
      // sign-in — which is the system working and the test being wrong.
      harness.clock.advance(TOTP_PERIOD_MS);
      const step = totpStep(harness.clock.nowEpochMs());
      // First use consumes the step.
      await signInWithTotp(harness, withFactor, secret, { step });

      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      const replay = await verify({ challengeToken, code: totpCodeForStep(secret, step) });
      expect(replay.statusCode).toBe(401);
    });

    it('consumes a challenge, so it cannot be used twice', async () => {
      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      const step = totpStep(harness.clock.nowEpochMs()) + 1;
      const first = await verify({ challengeToken, code: totpCodeForStep(secret, step) });
      expect(first.statusCode).toBe(200);

      const second = await verify({ challengeToken, code: totpCodeForStep(secret, step + 1) });
      expect(second.statusCode).toBe(401);
    });

    it('burns the challenge after five wrong codes', async () => {
      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await verify({ challengeToken, code: '000000' })).statusCode).toBe(401);
      }
      // Even the right code no longer works: the target does not stay still.
      const correct = await verify({
        challengeToken,
        code: totpCodeForStep(secret, totpStep(harness.clock.nowEpochMs()) + 5),
      });
      expect(correct.statusCode).toBe(401);
    });

    it('does not leak whether the challenge or the code was wrong', async () => {
      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      const badCode = await verify({ challengeToken, code: '000000' });
      const badChallenge = await verify({ challengeToken: 'not-a-real-challenge', code: '000000' });
      expect(badCode.statusCode).toBe(badChallenge.statusCode);
      expect((badCode.json() as { error: { message: string } }).error.message).toBe(
        (badChallenge.json() as { error: { message: string } }).error.message,
      );
    });

    it('accepts a recovery code once and never again', async () => {
      const code = recoveryCodes[0] as string;
      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      const first = await verify({ challengeToken, recoveryCode: code });
      expect(first.statusCode).toBe(200);
      expect((first.json() as { recoveryCodesRemaining: number }).recoveryCodesRemaining).toBe(9);

      const next = (await login({ email: withFactor, password: TEST_PASSWORD })).json() as {
        challengeToken: string;
      };
      const second = await verify({ challengeToken: next.challengeToken, recoveryCode: code });
      expect(second.statusCode).toBe(401);
    });

    it('refuses a request carrying both a code and a recovery code', async () => {
      const { challengeToken } = (
        await login({ email: withFactor, password: TEST_PASSWORD })
      ).json() as {
        challengeToken: string;
      };
      const response = await verify({
        challengeToken,
        code: currentCode(secret),
        recoveryCode: recoveryCodes[1] as string,
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('removing a factor', () => {
    it('requires a current code, not merely a live session', async () => {
      const token = await signIn(harness, forRemoval);
      const { secret } = await enrolTotp(harness, token);

      // A session-only removal is what an attacker who has taken over a session
      // would attempt, and it must not work.
      const withoutCode = await harness.server.inject({
        method: 'DELETE',
        url: '/v1/auth/mfa/totp',
        headers: bearer(token),
        payload: { code: '000000' },
      });
      expect(withoutCode.statusCode).toBe(400);

      const withCode = await harness.server.inject({
        method: 'DELETE',
        url: '/v1/auth/mfa/totp',
        headers: bearer(token),
        // The step used to confirm enrolment has already been consumed, so a
        // code for the current step is a replay and is correctly refused. The
        // next step is the first one a real user would reach.
        payload: { code: totpCodeForStep(secret, totpStep(harness.clock.nowEpochMs()) + 1) },
      });
      expect(withCode.statusCode).toBe(204);

      // Removing the factor drops every session's elevated state.
      const status = await harness.server.inject({
        method: 'GET',
        url: '/v1/auth/mfa',
        headers: bearer(token),
      });
      expect(status.json()).toMatchObject({
        enrolled: false,
        sessionSatisfied: false,
        recoveryCodesRemaining: 0,
      });
    });
  });

  describe('the audit trail', () => {
    it('records a password check awaiting a factor as PENDING, not as a success', async () => {
      const owner = forAudit;
      const token = await signIn(harness, owner);
      const { secret } = await enrolTotp(harness, token);
      await login({ email: owner, password: TEST_PASSWORD });

      const outcomes = await harness.db.withPlatform(async (ctx) =>
        ctx.many<{ outcome: string; reason: string | null }>(
          `SELECT outcome, reason FROM audit_log
            WHERE action = 'auth:login' ORDER BY seq DESC LIMIT 1`,
        ),
      );
      expect(outcomes[0]).toMatchObject({
        outcome: 'PENDING',
        reason: 'second-factor-required',
      });
      expect(secret).toBeTruthy();
    });
  });
});

describe.skipIf(available)('multi-factor authentication (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
