import {
  authorise,
  type AuthorisationAnswer,
  type Grant,
  type Permission,
  type Principal,
  type Role,
} from '@adericel/domain';
import type { PlatformContext } from '@adericel/graph';
import { AdericelError, parseApiKey, type Clock } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { verifyAccessToken } from './tokens.js';

/**
 * Principal resolution.
 *
 * Authority is never carried in the credential. A token identifies who the
 * caller is; the grants that decide what they may do are loaded from the
 * database on every request. Revoking a grant therefore takes effect on the
 * next request rather than when the token expires.
 */

interface GrantRow {
  scope_type: string;
  scope_id: string | null;
  roles: string[];
  expires_at: Date | null;
}

async function loadGrants(
  ctx: PlatformContext,
  principalType: 'USER' | 'API_KEY' | 'SERVICE',
  principalId: string,
  nowIso: string,
): Promise<Grant[]> {
  const rows = await ctx.many<GrantRow>(
    `SELECT scope_type, scope_id, roles, expires_at
     FROM grants
     WHERE principal_type = $1 AND principal_id = $2
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > $3::timestamptz)`,
    [principalType, principalId, nowIso],
  );
  return rows.map((row) => ({
    scopeType: row.scope_type as Grant['scopeType'],
    scopeId: row.scope_id,
    roles: row.roles as Role[],
    expiresAt: row.expires_at?.toISOString() ?? null,
  }));
}

export async function principalFromAccessToken(app: AppContext, token: string): Promise<Principal> {
  const claims = verifyAccessToken(app.config.auth.jwtSecret, token, {
    issuer: app.config.auth.issuer,
    audience: app.config.auth.audience,
    nowEpochSeconds: Math.floor(app.clock.nowEpochMs() / 1000),
  });

  return app.db.withPlatform(async (ctx) => {
    const user = await ctx.one<{
      id: string;
      status: string;
      display_name: string;
      email: string;
      msp_id: string | null;
    }>(`SELECT id, status, display_name, email, msp_id FROM users WHERE id = $1`, [claims.sub]);
    if (!user) throw new AdericelError('UNAUTHENTICATED', 'User no longer exists');
    if (user.status !== 'ACTIVE') {
      throw new AdericelError('UNAUTHENTICATED', `User account is ${user.status.toLowerCase()}`);
    }

    // The session must still be live. A signed-out or revoked session cannot be
    // resurrected by an access token that has not yet expired.
    const session = await ctx.one<{ id: string; mfa_satisfied_at: Date | null }>(
      `SELECT id, mfa_satisfied_at FROM sessions
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3::timestamptz`,
      [claims.sid, claims.sub, app.clock.nowIso()],
    );
    if (!session) throw new AdericelError('UNAUTHENTICATED', 'Session has been revoked or expired');

    // Read from the session row rather than from a token claim. A claim would
    // be a statement the client controls, and revoking a factor would not take
    // effect until the access token expired.
    const mfaSatisfied = session.mfa_satisfied_at !== null;

    const grants = await loadGrants(ctx, 'USER', user.id, app.clock.nowIso());

    return {
      principalType: 'USER',
      principalId: user.id,
      displayName: user.display_name,
      email: user.email,
      mspId: user.msp_id,
      grants,
      sessionId: claims.sid,
      apiKeyId: null,
      viaDelegation: false,
      mfaSatisfied,
    };
  });
}

export async function principalFromApiKey(app: AppContext, presented: string): Promise<Principal> {
  const parsed = parseApiKey(presented);
  if (!parsed) throw new AdericelError('UNAUTHENTICATED', 'Malformed API key');

  return app.db.withPlatform(async (ctx) => {
    const row = await ctx.one<{
      id: string;
      secret_hash: string;
      name: string;
      msp_id: string | null;
      expires_at: Date | null;
    }>(
      `SELECT id, secret_hash, name, msp_id, expires_at
       FROM api_keys WHERE key_id = $1 AND revoked_at IS NULL`,
      [parsed.keyId],
    );

    // Compute the candidate hash regardless of whether the key id was found, so
    // a valid key id is not distinguishable from an invalid one by timing.
    const candidate = app.tokens.hash('api-key', parsed.secret);
    if (!row || row.secret_hash !== candidate) {
      throw new AdericelError('UNAUTHENTICATED', 'Invalid API key');
    }
    if (row.expires_at && row.expires_at.getTime() <= app.clock.nowEpochMs()) {
      throw new AdericelError('UNAUTHENTICATED', 'API key has expired');
    }

    await ctx.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
    const grants = await loadGrants(ctx, 'API_KEY', row.id, app.clock.nowIso());

    return {
      principalType: 'API_KEY',
      principalId: row.id,
      displayName: `API key: ${row.name}`,
      email: null,
      mspId: row.msp_id,
      grants,
      sessionId: null,
      apiKeyId: row.id,
      // An API key has no second factor and never will. The permissions that
      // require one are also the permissions a non-human principal cannot hold
      // at all (HUMAN_ONLY_PERMISSIONS), so this is belt and braces rather than
      // the only thing standing in the way.
      viaDelegation: false,
      mfaSatisfied: false,
    };
  });
}

/**
 * Resolve which MSP owns an organisation.
 *
 * Loaded from the database rather than taken from the request, because an MSP
 * grant only reaches a customer organisation when the ownership is proven.
 */
export async function organisationOwner(
  app: AppContext,
  organisationId: string,
): Promise<{ mspId: string | null; status: string } | null> {
  return app.db.withPlatform(async (ctx) => {
    const row = await ctx.one<{ msp_id: string | null; status: string }>(
      `SELECT msp_id, status FROM organisations WHERE id = $1`,
      [organisationId],
    );
    return row ? { mspId: row.msp_id, status: row.status } : null;
  });
}

export interface AuthorisationRequest {
  readonly permission: Permission;
  readonly organisationId?: string | null;
  readonly mspId?: string | null;
  readonly organisationMspId?: string | null;
}

export function decide(
  principal: Principal,
  request: AuthorisationRequest,
  clock: Clock,
): AuthorisationAnswer {
  return authorise(
    principal,
    {
      permission: request.permission,
      ...(request.organisationId === undefined ? {} : { organisationId: request.organisationId }),
      ...(request.mspId === undefined ? {} : { mspId: request.mspId }),
    },
    {
      atIso: clock.nowIso(),
      ...(request.organisationMspId === undefined
        ? {}
        : { organisationMspId: request.organisationMspId }),
    },
  );
}
