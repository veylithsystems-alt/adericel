import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { accessTokenFor, issueSession } from './auth.js';
import { audit, requireOrganisation, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import {
  completeSignup,
  requestSignup,
  signupCompletionSchema,
  signupRequestSchema,
} from '../services/signup.js';
import {
  acceptInvitation,
  createInvitation,
  invitationAcceptanceSchema,
  invitationRequestSchema,
} from '../services/invitations.js';
import { listOnboardingTasks, refreshOnboardingTasks } from '../services/onboarding-tasks.js';

/**
 * Self-serve onboarding.
 *
 * Four of these five routes are unauthenticated, which is unavoidable — an
 * account cannot present a credential it does not yet have — and is why they
 * are rate-limited harder than anything else in the API, never distinguish a
 * known address from an unknown one, and never let the caller name their own
 * authority.
 *
 * The design goal is measurable: the time from "I gave you my email" to "I am
 * looking at an evidence-backed statement about my own estate", unattended and
 * without a sales call. Everything here exists to shorten that, without
 * shortening it by asserting things nobody has checked.
 */

const orgParam = z.object({ organisationId: z.string().uuid() });
const mspParam = z.object({ mspId: z.string().uuid() });

/** Signup and verification are the most abusable surface in the product. */
const signupLimit = { config: { rateLimit: { max: 5, timeWindow: 600_000 } } };
const verifyLimit = { config: { rateLimit: { max: 20, timeWindow: 600_000 } } };

export function registerOnboardingRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * Begin a signup.
   *
   * Always answers the same way. A caller cannot learn from the response
   * whether an address already has an account, has a signup pending, or is
   * entirely new — this endpoint is unauthenticated, so any difference is a
   * customer-list oracle.
   */
  server.post('/v1/signup', signupLimit, async (request, reply) => {
    const body = parseBody(request, signupRequestSchema);
    const result = await requestSignup(app, body, {
      correlationId: request.adericel.correlationId,
      logger: request.adericel.logger,
      ip: request.ip,
    });
    // 202: the request has been accepted for processing, and deliberately says
    // nothing about whether an account will result.
    return reply.status(202).send(result);
  });

  /**
   * Complete a signup.
   *
   * Creates the account and signs the person in, rather than returning them to
   * a login page to type a password they set four seconds ago.
   */
  server.post('/v1/signup/complete', verifyLimit, async (request, reply) => {
    const body = parseBody(request, signupCompletionSchema);
    const completion = await completeSignup(app, body, {
      correlationId: request.adericel.correlationId,
      logger: request.adericel.logger,
    });

    const { accessToken, expiresIn, refreshToken } = await app.db.withPlatform(async (ctx) => {
      const subject = {
        id: completion.userId,
        email: completion.email,
        display_name: completion.displayName,
        msp_id: completion.mspId,
      };
      const session = await issueSession(app, ctx, subject, request, 'NONE');
      return { ...accessTokenFor(app, subject, session.sessionId), ...session };
    });

    await audit(app, request, {
      action: 'signup:complete',
      resourceType: 'Organisation',
      resourceId: completion.organisationId,
      metadata: { accountKind: completion.accountKind, selfServe: true },
    });

    return reply.status(201).send({
      accessToken,
      refreshToken,
      expiresIn,
      account: {
        userId: completion.userId,
        email: completion.email,
        accountKind: completion.accountKind,
        mspId: completion.mspId,
        organisationId: completion.organisationId,
        organisationSlug: completion.organisationSlug,
        controlsCreated: completion.controlsCreated,
      },
      // Said plainly at the moment it will otherwise be misread. Every control
      // is UNKNOWN because nothing has been observed, not because anything is
      // broken, and the next step is the one that changes it.
      posture: {
        state: 'UNKNOWN',
        explanation:
          `${completion.controlsCreated} controls are in place and every one of them currently ` +
          'reads UNKNOWN. Adericel has not observed your estate yet, so it will not say ' +
          'anything about it. Connect a source and the determinations begin.',
        nextStep: 'Connect your first source',
      },
    });
  });

  /**
   * The onboarding ledger.
   *
   * Recomputed from real state on every read, so a task can never be complete
   * because an endpoint was once called successfully.
   */
  server.get(
    '/v1/organisations/:organisationId/onboarding',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      await app.db.withTenant(organisationId, async (ctx) =>
        refreshOnboardingTasks(ctx, organisationId, app.clock.nowIso()),
      );

      // Whether a second approver exists is an identity fact, and identity sits
      // outside the tenant boundary by design: grants are what decide tenancy,
      // so they cannot themselves be tenant-scoped.
      const approvers = await app.db.withPlatform(async (ctx) => {
        // Enrolment is read from the factor table rather than the flag on
        // `users`. The flag is a denormalisation; whether a person can actually
        // present a factor is a property of a confirmed, unrevoked row.
        const rows = await ctx.many<{ id: string; has_factor: boolean }>(
          `SELECT DISTINCT u.id,
                  EXISTS (SELECT 1 FROM user_mfa_factors f
                          WHERE f.user_id = u.id
                            AND f.confirmed_at IS NOT NULL
                            AND f.revoked_at IS NULL) AS has_factor
           FROM users u
           JOIN grants g ON g.principal_type = 'USER' AND g.principal_id = u.id
            AND g.revoked_at IS NULL
           WHERE u.status = 'ACTIVE'
             AND 'ORG_APPROVER' = ANY(g.roles)
             AND ((g.scope_type = 'ORGANISATION' AND g.scope_id = $1)
                  OR (g.scope_type = 'MSP' AND g.scope_id =
                      (SELECT msp_id FROM organisations WHERE id = $1)))`,
          [organisationId],
        );
        return rows;
      });
      const usableApprovers = approvers.filter((row) => row.has_factor).length;

      await app.db.withTenant(organisationId, async (ctx) => {
        await ctx.query(
          `UPDATE onboarding_tasks
           SET state = CASE WHEN $2 THEN 'COMPLETED' ELSE state END,
               completed_at = CASE WHEN $2 THEN COALESCE(completed_at, $3::timestamptz) END,
               detail = $4
           WHERE organisation_id = $1 AND key = 'approver.second'`,
          [
            organisationId,
            usableApprovers >= 1,
            app.clock.nowIso(),
            `${usableApprovers} approver(s) with a second factor enrolled`,
          ],
        );
      });

      const refreshed = await app.db.withTenant(organisationId, async (ctx) =>
        listOnboardingTasks(ctx, organisationId),
      );
      const outstanding = refreshed.filter((t) => t.required && t.state !== 'COMPLETED');

      return reply.status(200).send({
        tasks: refreshed,
        complete: outstanding.length === 0,
        nextStep: outstanding.find((t) => t.state === 'PENDING')?.key ?? null,
        // The single most commercially damaging fact about a half-onboarded
        // tenant, stated rather than left to be discovered: without a second
        // person, Adericel can assess and propose and nothing else.
        canAuthoriseChange: usableApprovers >= 1,
        approvers: {
          withSecondFactor: usableApprovers,
          total: approvers.length,
          note:
            usableApprovers >= 1
              ? null
              : 'No approver with a second factor exists, so no remediation can be authorised. ' +
                'Adericel will still assess, explain and propose.',
        },
      });
    },
  );

  type InviteRequest = Parameters<typeof requirePrincipal>[0];

  const inviteRoute = async (
    request: InviteRequest,
    scopeType: 'MSP' | 'ORGANISATION',
    scopeId: string,
  ) => {
    const principal = requirePrincipal(request);
    if (principal.principalType !== 'USER') {
      // Authority is granted by people. A key that could invite could grant
      // itself a second pair of eyes, which is the whole control defeated in
      // one call.
      throw new AdericelError('FORBIDDEN', 'Only a signed-in user may invite someone');
    }
    const body = parseBody(request, invitationRequestSchema);
    return createInvitation(
      app,
      {
        email: body.email,
        roles: body.roles,
        message: body.message ?? null,
        scopeType,
        scopeId,
        invitedByUserId: principal.principalId,
        invitedByName: principal.displayName,
      },
      { correlationId: request.adericel.correlationId, logger: request.adericel.logger },
    );
  };

  server.post(
    '/v1/organisations/:organisationId/invitations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:member:manage');
      const result = await inviteRoute(request, 'ORGANISATION', organisationId);
      await audit(app, request, {
        action: 'invitation:create',
        resourceType: 'Organisation',
        resourceId: organisationId,
        metadata: { roles: result.invitation.roles },
      });
      return reply.status(201).send(result);
    },
  );

  server.post(
    '/v1/msps/:mspId/invitations',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { mspId } = parseParams(request, mspParam);
      const { requireMsp } = await import('../middleware/request-context.js');
      await requireMsp(app, request, mspId, 'msp:member:manage');
      const result = await inviteRoute(request, 'MSP', mspId);
      await audit(app, request, {
        action: 'invitation:create',
        resourceType: 'Msp',
        resourceId: mspId,
        metadata: { roles: result.invitation.roles },
      });
      return reply.status(201).send(result);
    },
  );

  /** Accept an invitation and sign in. Unauthenticated by necessity. */
  server.post('/v1/invitations/accept', verifyLimit, async (request, reply) => {
    const body = parseBody(request, invitationAcceptanceSchema);
    const accepted = await acceptInvitation(app, body);

    const tokens = await app.db.withPlatform(async (ctx) => {
      const user = await ctx.oneOrFail<{
        id: string;
        email: string;
        display_name: string;
        msp_id: string | null;
      }>(
        `SELECT id, email, display_name, msp_id FROM users WHERE id = $1`,
        [accepted.userId],
        'User',
      );
      const session = await issueSession(app, ctx, user, request, 'NONE');
      return { ...accessTokenFor(app, user, session.sessionId), ...session };
    });

    return reply.status(201).send({
      ...tokens,
      membership: {
        scopeType: accepted.scopeType,
        scopeId: accepted.scopeId,
        roles: accepted.roles,
      },
      // An approver without a factor holds authority they cannot use. Saying so
      // here is the difference between a working account and a confused one.
      mfaRequired: accepted.mfaRequired,
      ...(accepted.mfaRequired
        ? {
            note:
              'You have been invited as an approver. Adericel will not accept an approval from ' +
              'a session that presented only a password, so enrol a second factor before you ' +
              'are asked to authorise anything.',
          }
        : {}),
    });
  });
}
