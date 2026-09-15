import { invitationMessage } from '@adericel/notifications';
import { z } from 'zod';
import { ROLES, type Role } from '@adericel/domain';
import { AdericelError, type Logger } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { mintToken } from './signup.js';

/**
 * Invitations.
 *
 * An account with one person in it cannot approve anything: the proposer may
 * never be the approver, so a single-user tenant can assess and propose and
 * then stop. Inviting a second person is not an administrative nicety, it is
 * what makes the second half of the product reachable.
 *
 * An invitation is an offer of named authority within one scope, decided
 * entirely by the inviter. The recipient supplies a name and a password and
 * nothing else — never their own roles, never their own scope — because an
 * invitation the recipient can amend is not an invitation, it is a form of
 * self-service privilege escalation.
 */

export const INVITATION_TTL_HOURS = 168;

export const invitationRequestSchema = z.object({
  email: z.string().email().max(320),
  roles: z.array(z.string().min(1)).min(1).max(6),
  message: z.string().max(1000).optional(),
});

export const invitationAcceptanceSchema = z.object({
  token: z.string().min(20).max(200),
  displayName: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
});

export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  readonly scopeType: 'MSP' | 'ORGANISATION';
  readonly scopeId: string;
  readonly roles: readonly string[];
  readonly status: string;
  readonly expiresAt: string;
  readonly invitedBy: string;
  readonly createdAt: string;
}

function assertRolesGrantable(roles: readonly string[], scopeType: 'MSP' | 'ORGANISATION'): Role[] {
  const valid = roles.filter((role): role is Role => (ROLES as readonly string[]).includes(role));
  if (valid.length !== roles.length) {
    throw new AdericelError('VALIDATION_FAILED', 'One or more roles are not recognised', {
      safeDetails: { roles },
    });
  }
  // PLATFORM_ADMIN is the operator of Adericel itself, not of any customer. It
  // is not grantable through a customer-facing invitation at any scope.
  if (valid.includes('PLATFORM_ADMIN')) {
    throw new AdericelError('FORBIDDEN', 'PLATFORM_ADMIN cannot be granted by invitation');
  }
  const prefix = scopeType === 'MSP' ? 'MSP_' : 'ORG_';
  const misplaced = valid.filter((role) => !role.startsWith(prefix) && role !== 'AUTOMATION');
  if (misplaced.length > 0) {
    throw new AdericelError(
      'VALIDATION_FAILED',
      `Roles ${misplaced.join(', ')} cannot be granted at ${scopeType} scope`,
      { safeDetails: { scopeType, roles: misplaced } },
    );
  }
  return valid;
}

export async function createInvitation(
  app: AppContext,
  input: {
    readonly email: string;
    readonly roles: readonly string[];
    readonly message: string | null;
    readonly scopeType: 'MSP' | 'ORGANISATION';
    readonly scopeId: string;
    readonly invitedByUserId: string;
    readonly invitedByName: string;
  },
  context: { readonly correlationId: string; readonly logger: Logger },
): Promise<{ readonly invitation: InvitationSummary; readonly developmentToken?: string }> {
  const roles = assertRolesGrantable(input.roles, input.scopeType);
  const token = mintToken();
  const tokenHash = app.tokens.hash('invitation', token);
  const expiresAt = new Date(
    app.clock.nowEpochMs() + INVITATION_TTL_HOURS * 3_600_000,
  ).toISOString();

  const created = await app.db.withPlatform(async (ctx) => {
    const scopeName = await resolveScopeName(app, ctx, input.scopeType, input.scopeId);

    const alreadyMember = await ctx.one<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN grants g ON g.principal_type = 'USER' AND g.principal_id = u.id
        AND g.revoked_at IS NULL AND g.scope_type = $2 AND g.scope_id = $3
       WHERE lower(u.email) = lower($1)`,
      [input.email, input.scopeType, input.scopeId],
    );
    if (alreadyMember) {
      // Unlike signup, this endpoint is authenticated and the caller already
      // administers the scope, so naming the situation costs nothing and saves
      // them wondering why nothing arrived.
      throw new AdericelError('CONFLICT', 'That person already has access to this scope');
    }

    // A re-invitation replaces the outstanding one, so only the newest link works.
    await ctx.query(
      `UPDATE invitations SET status = 'REVOKED'
       WHERE lower(email) = lower($1) AND scope_type = $2 AND scope_id = $3 AND status = 'PENDING'`,
      [input.email, input.scopeType, input.scopeId],
    );

    const row = await ctx.oneOrFail<{ id: string; created_at: Date }>(
      `INSERT INTO invitations
         (email, scope_type, scope_id, msp_id, organisation_id, roles, token_hash, invited_by,
          message, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10)
       RETURNING id, created_at`,
      [
        input.email,
        input.scopeType,
        input.scopeId,
        input.scopeType === 'MSP' ? input.scopeId : null,
        input.scopeType === 'ORGANISATION' ? input.scopeId : null,
        roles,
        tokenHash,
        input.invitedByUserId,
        input.message,
        expiresAt,
      ],
      'Invitation',
    );
    return { id: row.id, createdAt: row.created_at.toISOString(), scopeName };
  });

  const result = await app.notifier.send(
    invitationMessage({
      to: input.email,
      inviterName: input.invitedByName,
      scopeName: created.scopeName,
      roles,
      acceptUrl: `${app.config.api.publicUrl.replace(/\/+$/, '')}/invitations/accept?token=${token}`,
      expiresInHours: INVITATION_TTL_HOURS,
      message: input.message,
      correlationId: context.correlationId,
    }),
  );
  if (!result.delivered) {
    context.logger.error(
      { to: input.email, channel: result.channel, detail: result.detail },
      'invitation was not delivered',
    );
  }

  return {
    invitation: {
      id: created.id,
      email: input.email,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      roles,
      status: 'PENDING',
      expiresAt,
      invitedBy: input.invitedByName,
      createdAt: created.createdAt,
    },
    ...(app.notifier.deliversToPeople ? {} : { developmentToken: token }),
  };
}

async function resolveScopeName(
  app: AppContext,
  ctx: { one: <T>(sql: string, params: unknown[]) => Promise<T | null> },
  scopeType: 'MSP' | 'ORGANISATION',
  scopeId: string,
): Promise<string> {
  const table = scopeType === 'MSP' ? 'msps' : 'organisations';
  const row = await ctx.one<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [scopeId]);
  return row?.name ?? 'an Adericel account';
}

export interface AcceptedInvitation {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly scopeType: 'MSP' | 'ORGANISATION';
  readonly scopeId: string;
  readonly roles: readonly string[];
  readonly mfaRequired: boolean;
}

export async function acceptInvitation(
  app: AppContext,
  input: {
    readonly token: string;
    readonly displayName: string;
    readonly password: string;
  },
): Promise<AcceptedInvitation> {
  const now = app.clock.nowIso();
  const tokenHash = app.tokens.hash('invitation', input.token);
  const passwordHash = await app.passwords.hash(input.password);

  const invalid = (): never => {
    throw new AdericelError(
      'VALIDATION_FAILED',
      'That invitation link is not valid. It may have been used, revoked or expired. ' +
        'Ask whoever invited you to send another.',
    );
  };

  const accepted = await app.db.withPlatform(async (ctx) => {
    // Claimed inside the transaction, so two presentations of the same link
    // cannot both create a user.
    const invitation = await ctx.one<{
      id: string;
      email: string;
      scope_type: 'MSP' | 'ORGANISATION';
      scope_id: string;
      msp_id: string | null;
      roles: string[];
      expires_at: Date;
    }>(
      `SELECT id, email, scope_type, scope_id, msp_id, roles, expires_at
       FROM invitations WHERE token_hash = $1 AND status = 'PENDING'
       FOR UPDATE`,
      [tokenHash],
    );
    if (!invitation) return null;
    if (invitation.expires_at.getTime() <= app.clock.nowEpochMs()) {
      await ctx.query(`UPDATE invitations SET status = 'EXPIRED' WHERE id = $1`, [invitation.id]);
      return null;
    }

    // The address is fixed by the inviter. A recipient who forwards their link
    // cannot turn it into access for a different person.
    const existing = await ctx.one<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE lower(email) = lower($1)`,
      [invitation.email],
    );

    let userId: string;
    if (existing) {
      if (existing.status !== 'ACTIVE') {
        throw new AdericelError('FORBIDDEN', 'That account is not active');
      }
      // An existing user joining another scope keeps their own credentials.
      // Accepting an invitation must not be a password reset for an account
      // somebody else controls.
      userId = existing.id;
    } else {
      const user = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO users (email, display_name, msp_id, status)
         VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
        [invitation.email, input.displayName, invitation.msp_id],
        'User',
      );
      await ctx.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
        user.id,
        passwordHash,
      ]);
      userId = user.id;
    }

    await ctx.query(
      `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
       VALUES ('USER', $1, $2, $3, $4::text[])
       ON CONFLICT (principal_type, principal_id, scope_type,
                    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
         WHERE revoked_at IS NULL
       DO UPDATE SET roles = EXCLUDED.roles`,
      [userId, invitation.scope_type, invitation.scope_id, invitation.roles],
    );

    await ctx.query(
      `UPDATE invitations
       SET status = 'ACCEPTED', accepted_at = $2::timestamptz, accepted_user_id = $3
       WHERE id = $1 AND status = 'PENDING'`,
      [invitation.id, now, userId],
    );

    return {
      userId,
      email: invitation.email,
      scopeType: invitation.scope_type,
      scopeId: invitation.scope_id,
      roles: invitation.roles,
      isNewUser: !existing,
    };
  });

  if (!accepted) invalid();

  return {
    userId: accepted!.userId,
    email: accepted!.email,
    displayName: input.displayName,
    scopeType: accepted!.scopeType,
    scopeId: accepted!.scopeId,
    roles: accepted!.roles,
    // Approval requires a second factor, so an approver who has not enrolled
    // one has authority they cannot yet use. Saying so here is the difference
    // between a working account and a confused one.
    mfaRequired: accepted!.roles.includes('ORG_APPROVER'),
  };
}
