import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdericelError, newOpaqueToken } from '@adericel/shared';
import { ROLE_PERMISSIONS, permissionsForRoles, type Role } from '@adericel/domain';
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
      }>(
        `SELECT u.id, u.email, u.display_name, u.status, u.msp_id,
                c.password_hash, c.failed_attempts, c.locked_until
         FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
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

      const refreshToken = newOpaqueToken(48);
      const session = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, source_ip, issued_at, expires_at)
         VALUES ($1, $2, $3, $4::inet, $5::timestamptz, $5::timestamptz + ($6 || ' seconds')::interval)
         RETURNING id`,
        [
          user.id,
          hashRefreshToken(refreshToken),
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
          request.ip,
          now,
          String(app.config.auth.refreshTokenTtlSeconds),
        ],
        'Session',
      );

      return {
        ok: true as const,
        user,
        sessionId: session.id,
        refreshToken,
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

    const accessToken = issueAccessToken(
      app.config.auth.jwtSecret,
      {
        sub: outcome.user.id,
        sid: outcome.sessionId,
        iss: app.config.auth.issuer,
        aud: app.config.auth.audience,
        name: outcome.user.display_name,
        email: outcome.user.email,
        mspId: outcome.user.msp_id,
      },
      Math.floor(app.clock.nowEpochMs() / 1000),
      app.config.auth.accessTokenTtlSeconds,
    );

    await audit(app, request, {
      action: 'auth:login',
      resourceType: 'User',
      resourceId: outcome.user.id,
      metadata: { sessionId: outcome.sessionId },
    });

    return reply.status(200).send({
      accessToken,
      refreshToken: outcome.refreshToken,
      expiresIn: app.config.auth.accessTokenTtlSeconds,
      tokenType: 'Bearer',
      user: {
        id: outcome.user.id,
        email: outcome.user.email,
        displayName: outcome.user.display_name,
        mspId: outcome.user.msp_id,
      },
    });
  });

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
        [hashRefreshToken(body.refreshToken), now],
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
          hashRefreshToken(nextToken),
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
