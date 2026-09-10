import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AdericelError,
  generateRecoveryCodes,
  generateTotpSecret,
  recoveryCodeDigestInput,
  newOpaqueToken,
  totpProvisioningUri,
  verifyTotp,
} from '@adericel/shared';
import {
  MFA_REQUIRED_PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  type Role,
} from '@adericel/domain';
import type { AppContext } from '../context.js';
import { hashRefreshToken, issueAccessToken } from '../auth/tokens.js';
import { audit, requirePrincipal } from '../middleware/request-context.js';
import { parseBody } from '../middleware/validation.js';

/**
 * Authentication routes.
 *
 * Sign-in is deliberately uniform in its failure behaviour: an unknown email,
 * a wrong password and a locked account all produce the same response after the
 * same work, so the endpoint does not become an account-enumeration oracle.
 */

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512) });

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

/**
 * How long a completed password check stays good for while the second factor is
 * presented. Long enough to find a phone; short enough that a challenge token
 * captured in transit is not a standing invitation.
 */
const MFA_CHALLENGE_TTL_SECONDS = 300;

/**
 * Attempts allowed against one challenge. Six digits is a million codes, so
 * five guesses is not a meaningful brute-force surface — but an attacker with a
 * stolen password and unlimited attempts against a stationary window is, and
 * this closes it without locking out a person typing badly.
 */
const MFA_MAX_ATTEMPTS = 5;

const mfaVerifySchema = z
  .object({
    challengeToken: z.string().min(1).max(512),
    code: z.string().min(1).max(16).optional(),
    recoveryCode: z.string().min(1).max(32).optional(),
  })
  .refine((body) => Boolean(body.code) !== Boolean(body.recoveryCode), {
    message: 'Provide exactly one of code or recoveryCode',
  });

const totpCodeSchema = z.object({ code: z.string().min(1).max(16) });

interface SessionSubject {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly msp_id: string | null;
}

type MfaMethod = 'NONE' | 'TOTP' | 'RECOVERY_CODE';

/**
 * Mint a session and its tokens.
 *
 * Shared by password-only login and by the second-factor path so that the two
 * cannot drift apart — the difference between them is one column, and a
 * duplicated implementation is how that column ends up set in both.
 */
async function issueSession(
  app: AppContext,
  ctx: {
    query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
    oneOrFail: <T>(text: string, values: readonly unknown[], resource: string) => Promise<T>;
  },
  user: SessionSubject,
  request: { headers: Record<string, unknown>; ip: string },
  mfaMethod: MfaMethod,
): Promise<{ sessionId: string; refreshToken: string }> {
  const now = app.clock.nowIso();
  const refreshToken = newOpaqueToken(48);
  const session = await ctx.oneOrFail<{ id: string }>(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, source_ip, issued_at, expires_at,
                           mfa_method, mfa_satisfied_at)
     VALUES ($1, $2, $3, $4::inet, $5::timestamptz, $5::timestamptz + ($6 || ' seconds')::interval,
             $7, CASE WHEN $7 = 'NONE' THEN NULL ELSE $5::timestamptz END)
     RETURNING id`,
    [
      user.id,
      hashRefreshToken(app.tokens, refreshToken),
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      request.ip,
      now,
      String(app.config.auth.refreshTokenTtlSeconds),
      mfaMethod,
    ],
    'Session',
  );
  return { sessionId: session.id, refreshToken };
}

function accessTokenFor(
  app: AppContext,
  user: SessionSubject,
  sessionId: string,
): { accessToken: string; expiresIn: number } {
  return {
    accessToken: issueAccessToken(
      app.config.auth.jwtSecret,
      {
        sub: user.id,
        sid: sessionId,
        iss: app.config.auth.issuer,
        aud: app.config.auth.audience,
        name: user.display_name,
        email: user.email,
        mspId: user.msp_id,
      },
      Math.floor(app.clock.nowEpochMs() / 1000),
      app.config.auth.accessTokenTtlSeconds,
    ),
    expiresIn: app.config.auth.accessTokenTtlSeconds,
  };
}

/**
 * Challenge tokens are opaque and stored hashed, like refresh tokens, and under
 * a distinct prefix so a challenge digest can never match a session digest.
 */
function hashChallengeToken(app: AppContext, token: string): string {
  return hashRefreshToken(app.tokens, `mfa-challenge:${token}`);
}

export function registerAuthRoutes(server: FastifyInstance, app: AppContext): void {
  server.post('/v1/auth/login', async (request, reply) => {
    const body = parseBody(request, loginSchema);
    const now = app.clock.nowIso();

    const outcome = await app.db.withPlatform(async (ctx) => {
      const user = await ctx.one<{
        id: string;
        email: string;
        display_name: string;
        status: string;
        msp_id: string | null;
        password_hash: string | null;
        failed_attempts: number;
        locked_until: Date | null;
        mfa_factor_id: string | null;
      }>(
        `SELECT u.id, u.email, u.display_name, u.status, u.msp_id,
                c.password_hash, c.failed_attempts, c.locked_until,
                f.id AS mfa_factor_id
         FROM users u
         LEFT JOIN user_credentials c ON c.user_id = u.id
         LEFT JOIN user_mfa_factors f
                ON f.user_id = u.id AND f.revoked_at IS NULL AND f.confirmed_at IS NOT NULL
         WHERE lower(u.email) = lower($1)`,
        [body.email],
      );

      // Always run a verification, even with no user, so the response time does
      // not distinguish a known email from an unknown one.
      const storedHash =
        user?.password_hash ??
        'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      const passwordValid = await app.passwords.verify(body.password, storedHash);

      if (!user || !user.password_hash) return { ok: false as const, reason: 'no-user' };
      if (user.locked_until && user.locked_until.getTime() > app.clock.nowEpochMs()) {
        return { ok: false as const, reason: 'locked' };
      }
      if (user.status !== 'ACTIVE') return { ok: false as const, reason: 'inactive' };

      if (!passwordValid) {
        const attempts = user.failed_attempts + 1;
        await ctx.query(
          // Both parameters are cast explicitly: PostgreSQL cannot infer a type
          // when two placeholders are compared to each other, and an inference
          // failure here would turn a wrong password into a 500.
          `UPDATE user_credentials
           SET failed_attempts = $2::integer,
               locked_until = CASE WHEN $2::integer >= $3::integer
                                   THEN now() + ($4::text || ' minutes')::interval
                                   ELSE locked_until END
           WHERE user_id = $1`,
          [user.id, attempts, MAX_FAILED_ATTEMPTS, String(LOCKOUT_MINUTES)],
        );
        return { ok: false as const, reason: 'bad-password' };
      }

      await ctx.query(
        `UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
        [user.id],
      );
      await ctx.query(`UPDATE users SET last_login_at = $2::timestamptz WHERE id = $1`, [
        user.id,
        now,
      ]);

      // A user with an enrolled factor gets a challenge, not a session. The
      // password check succeeded; that is all the challenge asserts, and it
      // conveys no authority of its own.
      if (user.mfa_factor_id) {
        const challengeToken = newOpaqueToken(48);
        await ctx.query(
          `INSERT INTO mfa_challenges (user_id, token_hash, source_ip, user_agent, expires_at)
           VALUES ($1, $2, $3::inet, $4, $5::timestamptz + ($6 || ' seconds')::interval)`,
          [
            user.id,
            hashChallengeToken(app, challengeToken),
            request.ip,
            typeof request.headers['user-agent'] === 'string'
              ? request.headers['user-agent']
              : null,
            now,
            String(MFA_CHALLENGE_TTL_SECONDS),
          ],
        );
        return { ok: true as const, mfaRequired: true as const, user, challengeToken };
      }

      const issued = await issueSession(app, ctx, user, request, 'NONE');
      return {
        ok: true as const,
        mfaRequired: false as const,
        user,
        sessionId: issued.sessionId,
        refreshToken: issued.refreshToken,
      };
    });

    if (!outcome.ok) {
      await audit(app, request, {
        action: 'auth:login',
        resourceType: 'User',
        resourceId: null,
        outcome: 'FAILURE',
        reason: outcome.reason,
        metadata: { email: body.email.toLowerCase() },
      });
      // One message for every failure mode.
      throw new AdericelError('UNAUTHENTICATED', 'Invalid credentials');
    }

    if (outcome.mfaRequired) {
      await audit(app, request, {
        action: 'auth:login',
        resourceType: 'User',
        resourceId: outcome.user.id,
        outcome: 'PENDING',
        reason: 'second-factor-required',
      });
      return reply.status(200).send({
        mfaRequired: true,
        challengeToken: outcome.challengeToken,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
        methods: ['TOTP', 'RECOVERY_CODE'],
      });
    }

    const { accessToken, expiresIn } = accessTokenFor(app, outcome.user, outcome.sessionId);

    await audit(app, request, {
      action: 'auth:login',
      resourceType: 'User',
      resourceId: outcome.user.id,
      metadata: { sessionId: outcome.sessionId, mfa: 'NONE' },
    });

    return reply.status(200).send({
      mfaRequired: false,
      accessToken,
      refreshToken: outcome.refreshToken,
      expiresIn,
      tokenType: 'Bearer',
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        displayName: outcome.user.display_name,
        mspId: outcome.user.msp_id,
      },
    });
  });

  /**
   * Present the second factor and complete sign-in.
   *
   * Failure here is deliberately uniform in the same way login is: a wrong
   * code, an expired challenge, a consumed challenge and an already-used
   * recovery code all produce one message. The one thing that is *not* uniform
   * is the attempt counter, because an attacker with a stolen password and
   * unlimited guesses against a stationary window is a real threat.
   */
  server.post('/v1/auth/mfa/verify', async (request, reply) => {
    const body = parseBody(request, mfaVerifySchema);
    const now = app.clock.nowIso();

    const outcome = await app.db.withPlatform(async (ctx) => {
      const challenge = await ctx.one<{
        id: string;
        user_id: string;
        attempts: number;
        email: string;
        display_name: string;
        msp_id: string | null;
        status: string;
      }>(
        `SELECT ch.id, ch.user_id, ch.attempts, u.email, u.display_name, u.msp_id, u.status
           FROM mfa_challenges ch
           JOIN users u ON u.id = ch.user_id
          WHERE ch.token_hash = $1
            AND ch.consumed_at IS NULL
            AND ch.expires_at > $2::timestamptz
          FOR UPDATE OF ch`,
        [hashChallengeToken(app, body.challengeToken), now],
      );
      if (!challenge) return { ok: false as const, reason: 'no-challenge' };
      if (challenge.status !== 'ACTIVE') return { ok: false as const, reason: 'inactive' };

      if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
        // Burn the challenge outright. The user starts again from the password,
        // which is a small inconvenience and removes the stationary target.
        await ctx.query(`UPDATE mfa_challenges SET consumed_at = $2::timestamptz WHERE id = $1`, [
          challenge.id,
          now,
        ]);
        return { ok: false as const, reason: 'too-many-attempts' };
      }

      await ctx.query(`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1`, [
        challenge.id,
      ]);

      const user: SessionSubject = {
        id: challenge.user_id,
        email: challenge.email,
        display_name: challenge.display_name,
        msp_id: challenge.msp_id,
      };

      if (body.recoveryCode) {
        // Recovery codes are consumed by hash in a single statement, so two
        // simultaneous presentations of the same code cannot both succeed.
        const consumed = await ctx.one<{ id: string }>(
          `UPDATE user_recovery_codes
              SET used_at = $3::timestamptz
            WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
            RETURNING id`,
          [
            challenge.user_id,
            app.tokens.hash('recovery-code', recoveryCodeDigestInput(body.recoveryCode)),
            now,
          ],
        );
        if (!consumed) return { ok: false as const, reason: 'bad-recovery-code' };

        await ctx.query(`UPDATE mfa_challenges SET consumed_at = $2::timestamptz WHERE id = $1`, [
          challenge.id,
          now,
        ]);
        const remaining = await ctx.one<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM user_recovery_codes
            WHERE user_id = $1 AND used_at IS NULL`,
          [challenge.user_id],
        );
        const issued = await issueSession(app, ctx, user, request, 'RECOVERY_CODE');
        return {
          ok: true as const,
          user,
          method: 'RECOVERY_CODE' as const,
          recoveryCodesRemaining: Number(remaining?.count ?? '0'),
          ...issued,
        };
      }

      const factor = await ctx.one<{
        id: string;
        secret_sealed: string;
        last_used_step: string | null;
      }>(
        `SELECT id, secret_sealed, last_used_step::text
           FROM user_mfa_factors
          WHERE user_id = $1 AND factor_type = 'TOTP'
            AND revoked_at IS NULL AND confirmed_at IS NOT NULL
          FOR UPDATE`,
        [challenge.user_id],
      );
      if (!factor) return { ok: false as const, reason: 'no-factor' };

      const secret = app.secrets.decrypt(factor.secret_sealed, challenge.user_id);
      const verified = verifyTotp(secret, body.code ?? '', {
        nowEpochMs: app.clock.nowEpochMs(),
        lastUsedStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
      });
      if (!verified) return { ok: false as const, reason: 'bad-code' };

      // Recording the step is what makes the code single use. It happens in the
      // same transaction as the session, so a crash cannot mint a session while
      // leaving the code replayable.
      await ctx.query(
        `UPDATE user_mfa_factors
            SET last_used_step = $2::bigint, last_used_at = $3::timestamptz
          WHERE id = $1`,
        [factor.id, String(verified.step), now],
      );
      await ctx.query(`UPDATE mfa_challenges SET consumed_at = $2::timestamptz WHERE id = $1`, [
        challenge.id,
        now,
      ]);

      const issued = await issueSession(app, ctx, user, request, 'TOTP');
      return { ok: true as const, user, method: 'TOTP' as const, ...issued };
    });

    if (!outcome.ok) {
      await audit(app, request, {
        action: 'auth:mfa:verify',
        resourceType: 'User',
        resourceId: null,
        outcome: 'FAILURE',
        reason: outcome.reason,
      });
      throw new AdericelError('UNAUTHENTICATED', 'Invalid or expired verification');
    }

    const { accessToken, expiresIn } = accessTokenFor(app, outcome.user, outcome.sessionId);

    await audit(app, request, {
      action: 'auth:mfa:verify',
      resourceType: 'User',
      resourceId: outcome.user.id,
      metadata: { sessionId: outcome.sessionId, method: outcome.method },
    });

    return reply.status(200).send({
      accessToken,
      refreshToken: outcome.refreshToken,
      expiresIn,
      tokenType: 'Bearer',
      mfaMethod: outcome.method,
      ...('recoveryCodesRemaining' in outcome
        ? { recoveryCodesRemaining: outcome.recoveryCodesRemaining }
        : {}),
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        displayName: outcome.user.display_name,
        mspId: outcome.user.msp_id,
      },
    });
  });

  /** What the caller has enrolled, and whether this session presented it. */
  server.get('/v1/auth/mfa', { preHandler: server.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const state = await app.db.withPlatform(async (ctx) => {
      const factor = await ctx.one<{ label: string; confirmed_at: Date | null; created_at: Date }>(
        `SELECT label, confirmed_at, created_at FROM user_mfa_factors
          WHERE user_id = $1 AND factor_type = 'TOTP' AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [principal.principalId],
      );
      const remaining = await ctx.one<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM user_recovery_codes
          WHERE user_id = $1 AND used_at IS NULL`,
        [principal.principalId],
      );
      return { factor, remaining: Number(remaining?.count ?? '0') };
    });

    return reply.status(200).send({
      enrolled: Boolean(state.factor?.confirmed_at),
      pendingEnrolment: Boolean(state.factor && !state.factor.confirmed_at),
      label: state.factor?.label ?? null,
      enrolledAt: state.factor?.confirmed_at?.toISOString() ?? null,
      recoveryCodesRemaining: state.remaining,
      sessionSatisfied: principal.mfaSatisfied,
      // Stated by the API rather than assumed by the interface, so the reason a
      // button is disabled comes from the same place that enforces it.
      requiredFor: [...MFA_REQUIRED_PERMISSIONS].sort(),
    });
  });

  /**
   * Begin enrolment.
   *
   * Returns the secret exactly once, unconfirmed. The factor cannot satisfy a
   * challenge until the user has proved they can generate a code from it —
   * otherwise enrolment itself would be the bypass, since anyone who can reach
   * this endpoint could create a factor they never have to present.
   */
  server.post('/v1/auth/mfa/totp', { preHandler: server.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.principalType !== 'USER') {
      throw new AdericelError('FORBIDDEN', 'Only a user account can enrol a second factor');
    }

    const secret = generateTotpSecret();
    await app.db.withPlatform(async (ctx) => {
      // Any earlier unconfirmed attempt is discarded rather than accumulated: a
      // pile of half-finished enrolments is a pile of live secrets.
      await ctx.query(
        `DELETE FROM user_mfa_factors
          WHERE user_id = $1 AND factor_type = 'TOTP' AND confirmed_at IS NULL`,
        [principal.principalId],
      );
      await ctx.query(
        `INSERT INTO user_mfa_factors (user_id, factor_type, label, secret_sealed)
         VALUES ($1, 'TOTP', $2, $3)`,
        [
          principal.principalId,
          'Authenticator app',
          // Sealed with the user id as additional authenticated data, so the
          // row cannot be moved to another user and decrypted there.
          app.secrets.encrypt(secret, principal.principalId),
        ],
      );
    });

    await audit(app, request, {
      action: 'auth:mfa:enrol:begin',
      resourceType: 'User',
      resourceId: principal.principalId,
    });

    return reply.status(201).send({
      secret,
      provisioningUri: totpProvisioningUri({
        secretBase32: secret,
        accountName: principal.email ?? principal.displayName,
        issuer: 'Adericel',
      }),
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
    });
  });

  /**
   * Complete enrolment by presenting a code.
   *
   * Confirming also marks the current session as having satisfied MFA, so
   * somebody who enrols in order to approve something does not have to sign out
   * and back in to do it. And it revokes any previously confirmed factor, so
   * there is never more than one live secret.
   */
  server.post(
    '/v1/auth/mfa/totp/confirm',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = parseBody(request, totpCodeSchema);
      const now = app.clock.nowIso();

      const result = await app.db.withPlatform(async (ctx) => {
        const factor = await ctx.one<{ id: string; secret_sealed: string }>(
          `SELECT id, secret_sealed FROM user_mfa_factors
            WHERE user_id = $1 AND factor_type = 'TOTP'
              AND revoked_at IS NULL AND confirmed_at IS NULL
            ORDER BY created_at DESC LIMIT 1
            FOR UPDATE`,
          [principal.principalId],
        );
        if (!factor) return null;

        const secret = app.secrets.decrypt(factor.secret_sealed, principal.principalId);
        const verified = verifyTotp(secret, body.code, { nowEpochMs: app.clock.nowEpochMs() });
        if (!verified) return null;

        await ctx.query(
          `UPDATE user_mfa_factors SET revoked_at = $2::timestamptz
            WHERE user_id = $1 AND factor_type = 'TOTP'
              AND revoked_at IS NULL AND confirmed_at IS NOT NULL`,
          [principal.principalId, now],
        );
        await ctx.query(
          `UPDATE user_mfa_factors
              SET confirmed_at = $2::timestamptz,
                  last_used_step = $3::bigint,
                  last_used_at = $2::timestamptz
            WHERE id = $1`,
          [factor.id, now, String(verified.step)],
        );

        // Fresh recovery codes; any previous set is discarded so that codes
        // printed for an old factor cannot unlock the new one.
        await ctx.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [
          principal.principalId,
        ]);
        const codes = generateRecoveryCodes();
        for (const code of codes) {
          await ctx.query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
            principal.principalId,
            app.tokens.hash('recovery-code', recoveryCodeDigestInput(code)),
          ]);
        }

        if (principal.sessionId) {
          await ctx.query(
            `UPDATE sessions SET mfa_satisfied_at = $2::timestamptz, mfa_method = 'TOTP'
              WHERE id = $1`,
            [principal.sessionId, now],
          );
        }

        return { codes };
      });

      if (!result) {
        await audit(app, request, {
          action: 'auth:mfa:enrol:confirm',
          resourceType: 'User',
          resourceId: principal.principalId,
          outcome: 'FAILURE',
          reason: 'bad-code',
        });
        throw new AdericelError('VALIDATION_FAILED', 'That code did not match. Try the next one.');
      }

      await audit(app, request, {
        action: 'auth:mfa:enrol:confirm',
        resourceType: 'User',
        resourceId: principal.principalId,
      });

      return reply.status(200).send({
        enrolled: true,
        // Shown once. There is no endpoint that returns them again, because a
        // recovery code readable from a live session is not a recovery code.
        recoveryCodes: result.codes,
      });
    },
  );

  /**
   * Remove the second factor.
   *
   * Requires a current code, not merely a live session: an attacker who has
   * taken over a session should not be able to quietly remove the control that
   * would have stopped them, and "I am already signed in" is exactly the
   * authority they would have.
   */
  server.delete(
    '/v1/auth/mfa/totp',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = parseBody(request, totpCodeSchema);
      const now = app.clock.nowIso();

      const removed = await app.db.withPlatform(async (ctx) => {
        const factor = await ctx.one<{
          id: string;
          secret_sealed: string;
          last_used_step: string | null;
        }>(
          `SELECT id, secret_sealed, last_used_step::text FROM user_mfa_factors
          WHERE user_id = $1 AND factor_type = 'TOTP'
            AND revoked_at IS NULL AND confirmed_at IS NOT NULL
          FOR UPDATE`,
          [principal.principalId],
        );
        if (!factor) return false;

        const secret = app.secrets.decrypt(factor.secret_sealed, principal.principalId);
        const verified = verifyTotp(secret, body.code, {
          nowEpochMs: app.clock.nowEpochMs(),
          lastUsedStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
        });
        if (!verified) return false;

        await ctx.query(`UPDATE user_mfa_factors SET revoked_at = $2::timestamptz WHERE id = $1`, [
          factor.id,
          now,
        ]);
        await ctx.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [
          principal.principalId,
        ]);
        // Every session that relied on this factor loses its elevated state.
        await ctx.query(
          `UPDATE sessions SET mfa_satisfied_at = NULL, mfa_method = 'NONE'
          WHERE user_id = $1 AND revoked_at IS NULL`,
          [principal.principalId],
        );
        return true;
      });

      await audit(app, request, {
        action: 'auth:mfa:remove',
        resourceType: 'User',
        resourceId: principal.principalId,
        outcome: removed ? 'SUCCESS' : 'FAILURE',
        reason: removed ? null : 'bad-code',
      });

      if (!removed) throw new AdericelError('VALIDATION_FAILED', 'That code did not match.');
      return reply.status(204).send();
    },
  );

  server.post('/v1/auth/refresh', async (request, reply) => {
    const body = parseBody(request, refreshSchema);
    const now = app.clock.nowIso();

    const result = await app.db.withPlatform(async (ctx) => {
      const session = await ctx.one<{
        id: string;
        user_id: string;
        display_name: string;
        email: string;
        msp_id: string | null;
        status: string;
      }>(
        `SELECT s.id, s.user_id, u.display_name, u.email, u.msp_id, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz`,
        [hashRefreshToken(app.tokens, body.refreshToken), now],
      );
      if (!session || session.status !== 'ACTIVE') return null;

      // Refresh tokens rotate. A replayed token no longer matches any live
      // session, which turns theft of an old token into a dead end.
      const nextToken = newOpaqueToken(48);
      await ctx.query(
        `UPDATE sessions
         SET refresh_token_hash = $2, last_used_at = $3::timestamptz,
             expires_at = $3::timestamptz + ($4 || ' seconds')::interval
         WHERE id = $1`,
        [
          session.id,
          hashRefreshToken(app.tokens, nextToken),
          now,
          String(app.config.auth.refreshTokenTtlSeconds),
        ],
      );
      return { session, nextToken };
    });

    if (!result) throw new AdericelError('UNAUTHENTICATED', 'Invalid or expired refresh token');

    const accessToken = issueAccessToken(
      app.config.auth.jwtSecret,
      {
        sub: result.session.user_id,
        sid: result.session.id,
        iss: app.config.auth.issuer,
        aud: app.config.auth.audience,
        name: result.session.display_name,
        email: result.session.email,
        mspId: result.session.msp_id,
      },
      Math.floor(app.clock.nowEpochMs() / 1000),
      app.config.auth.accessTokenTtlSeconds,
    );

    return reply.status(200).send({
      accessToken,
      refreshToken: result.nextToken,
      expiresIn: app.config.auth.accessTokenTtlSeconds,
      tokenType: 'Bearer',
    });
  });

  server.post('/v1/auth/logout', { preHandler: server.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    if (principal.sessionId) {
      await app.db.withPlatform(async (ctx) => {
        await ctx.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [
          principal.sessionId,
        ]);
      });
    }
    await audit(app, request, {
      action: 'auth:logout',
      resourceType: 'Session',
      resourceId: principal.sessionId,
    });
    return reply.status(204).send();
  });

  /**
   * The caller's own identity and effective authority.
   *
   * The UI uses this to decide what to render, but it is the API — not the UI —
   * that enforces every one of these permissions on each request.
   */
  server.get('/v1/auth/me', { preHandler: server.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const nowIso = app.clock.nowIso();

    const scopes = await app.db.withPlatform(async (ctx) => {
      const organisationIds = principal.grants
        .filter((g) => g.scopeType === 'ORGANISATION' && g.scopeId)
        .map((g) => g.scopeId as string);
      const mspIds = principal.grants
        .filter((g) => g.scopeType === 'MSP' && g.scopeId)
        .map((g) => g.scopeId as string);

      const organisations = await ctx.many<{
        id: string;
        name: string;
        slug: string;
        msp_id: string | null;
      }>(
        `SELECT id, name, slug, msp_id FROM organisations
         WHERE id = ANY($1::uuid[]) OR ($2::uuid[] IS NOT NULL AND msp_id = ANY($2::uuid[]))
         ORDER BY name`,
        [organisationIds, mspIds],
      );
      const msps = await ctx.many<{ id: string; name: string; slug: string }>(
        `SELECT id, name, slug FROM msps WHERE id = ANY($1::uuid[]) ORDER BY name`,
        [mspIds],
      );
      return { organisations, msps };
    });

    const roles = [...new Set(principal.grants.flatMap((g) => g.roles))] as Role[];

    return reply.status(200).send({
      principal: {
        type: principal.principalType,
        id: principal.principalId,
        displayName: principal.displayName,
        email: principal.email,
        mspId: principal.mspId,
      },
      grants: principal.grants.map((grant) => ({
        scopeType: grant.scopeType,
        scopeId: grant.scopeId,
        roles: grant.roles,
        expiresAt: grant.expiresAt,
      })),
      permissions: [...permissionsForRoles(roles)].sort(),
      organisations: scopes.organisations.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        mspId: o.msp_id,
      })),
      msps: scopes.msps,
      serverTime: nowIso,
    });
  });

  /** The role catalogue, so an administrator can see exactly what a role conveys. */
  server.get('/v1/auth/roles', { preHandler: server.authenticate }, async (_request, reply) =>
    reply.status(200).send({
      roles: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({
        role,
        permissions,
      })),
    }),
  );
}
