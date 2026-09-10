import { randomBytes } from 'node:crypto';
import { publish } from '@adericel/graph';
import { signupVerificationMessage, type NotificationMessage } from '@adericel/notifications';
import { AdericelError, type Logger } from '@adericel/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { provisionOrganisation } from './onboarding.js';
import { seedOnboardingTasks } from './onboarding-tasks.js';

/**
 * Self-serve account creation.
 *
 * Before this existed, Adericel could assess, decide, act and verify — and
 * could not be bought. Every route required an authenticated principal, no
 * route created a user, and every tenant that had ever existed came from a test
 * fixture or a seed script.
 *
 * Two shapes of customer arrive here and the flow is deliberately the same for
 * both, because the difference is only what provisioning creates at the end:
 *
 *   MSP     An operator who will onboard organisations of their own.
 *   DIRECT  One business assuring itself.
 *
 * Three rules govern everything in this file:
 *
 *   1. The caller never learns whether an address is already registered. Signup
 *      is unauthenticated, so its responses are an enumeration oracle unless
 *      every path returns the same thing.
 *   2. The caller never chooses their own authority. Roles, MSP membership and
 *      organisation are decided here or by an inviter, never by the request.
 *   3. A token is shown once and stored only as a keyed digest, exactly like
 *      the API keys and refresh tokens it sits alongside.
 */

export const SIGNUP_TOKEN_TTL_HOURS = 24;

/** Trial length and scope. Entitlement, not billing: no card, no charge. */
export const TRIAL_DAYS = 30;
export const TRIAL_ORGANISATION_LIMIT = 5;

export const signupRequestSchema = z.object({
  email: z.string().email().max(320),
  contactName: z.string().min(1).max(200),
  accountKind: z.enum(['MSP', 'DIRECT']),
  organisationName: z.string().min(1).max(200),
  countryCode: z.string().length(2).optional(),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const signupCompletionSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(200),
});

/** High-entropy, URL-safe, and never stored. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The one response the signup endpoint ever gives.
 *
 * Identical whether the address is new, already registered, or already has a
 * pending signup. Anything else lets an unauthenticated caller enumerate the
 * customer base one address at a time.
 */
export interface SignupAccepted {
  readonly accepted: true;
  readonly message: string;
  /**
   * Present only when the deployment's notification channel cannot reach a
   * person — a development setup. Never populated in production, where
   * start-up refuses such a channel outright.
   */
  readonly developmentToken?: string;
}

const ACCEPTED_MESSAGE =
  'If that address can be used, a confirmation link is on its way. The link works once and ' +
  'expires in 24 hours.';

async function deliver(
  app: AppContext,
  logger: Logger,
  message: NotificationMessage,
): Promise<void> {
  const result = await app.notifier.send(message);
  if (!result.delivered) {
    // Not fatal to the signup — the record exists and the customer can ask for
    // another link — but it must never pass unnoticed, because from the
    // customer's side an undelivered link and a broken product are the same.
    logger.error(
      { to: message.to, kind: message.kind, channel: result.channel, detail: result.detail },
      'notification was not delivered',
    );
  }
}

export async function requestSignup(
  app: AppContext,
  request: SignupRequest,
  context: { readonly correlationId: string; readonly logger: Logger; readonly ip: string | null },
): Promise<SignupAccepted> {
  const token = mintToken();
  const tokenHash = app.tokens.hash('signup-verification', token);
  const expiresAt = new Date(
    app.clock.nowEpochMs() + SIGNUP_TOKEN_TTL_HOURS * 3_600_000,
  ).toISOString();

  const created = await app.db.withPlatform(async (ctx) => {
    const existingUser = await ctx.one<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1)`,
      [request.email],
    );
    // An address that already has an account gets no new signup and no hint
    // that this is why. The person who owns it can sign in or reset.
    if (existingUser) return null;

    // A second request supersedes the first rather than leaving two live
    // tokens: the most recent link is the one that works.
    await ctx.query(
      `UPDATE signups SET status = 'SUPERSEDED'
       WHERE lower(email) = lower($1) AND status = 'PENDING'`,
      [request.email],
    );

    return ctx.oneOrFail<{ id: string }>(
      `INSERT INTO signups
         (email, contact_name, account_kind, organisation_name, country_code, token_hash,
          expires_at, requested_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        request.email,
        request.contactName,
        request.accountKind,
        request.organisationName,
        request.countryCode ?? null,
        tokenHash,
        expiresAt,
        context.ip,
      ],
      'Signup',
    );
  });

  if (created) {
    await deliver(
      app,
      context.logger,
      signupVerificationMessage({
        to: request.email,
        contactName: request.contactName,
        organisationName: request.organisationName,
        accountKind: request.accountKind,
        verifyUrl: `${app.config.api.publicUrl.replace(/\/+$/, '')}/signup/verify?token=${token}`,
        expiresInHours: SIGNUP_TOKEN_TTL_HOURS,
        correlationId: context.correlationId,
      }),
    );
  }

  return {
    accepted: true,
    message: ACCEPTED_MESSAGE,
    // Development convenience only, and gated on the channel being one that
    // cannot reach a person — which production start-up refuses.
    ...(created && !app.notifier.deliversToPeople ? { developmentToken: token } : {}),
  };
}

export interface SignupCompletion {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly accountKind: 'MSP' | 'DIRECT';
  readonly mspId: string | null;
  readonly organisationId: string;
  readonly organisationSlug: string;
  readonly controlsCreated: number;
}

/**
 * Complete a signup: the moment a tenant comes into existence.
 *
 * Everything is created or nothing is. A half-created account — a user with no
 * organisation, an MSP with no owner — would be a support ticket that the
 * customer has to raise before they can do anything at all.
 */
export async function completeSignup(
  app: AppContext,
  input: { readonly token: string; readonly password: string },
  context: { readonly correlationId: string; readonly logger: Logger },
): Promise<SignupCompletion> {
  const now = app.clock.nowIso();
  const tokenHash = app.tokens.hash('signup-verification', input.token);

  const signup = await app.db.withPlatform(async (ctx) =>
    ctx.one<{
      id: string;
      email: string;
      contact_name: string;
      account_kind: 'MSP' | 'DIRECT';
      organisation_name: string;
      country_code: string | null;
      expires_at: Date;
    }>(
      `SELECT id, email, contact_name, account_kind, organisation_name, country_code, expires_at
       FROM signups WHERE token_hash = $1 AND status = 'PENDING'`,
      [tokenHash],
    ),
  );

  // One message for an unknown, spent and expired token alike. Distinguishing
  // them tells a holder of a stolen link which of those it is.
  const invalid = (): never => {
    throw new AdericelError(
      'VALIDATION_FAILED',
      'That confirmation link is not valid. It may have been used already or expired. ' +
        'Request a new one.',
    );
  };

  if (!signup) invalid();
  if (signup!.expires_at.getTime() <= app.clock.nowEpochMs()) {
    await app.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE signups SET status = 'EXPIRED' WHERE id = $1`, [signup!.id]);
    });
    invalid();
  }

  const passwordHash = await app.passwords.hash(input.password);

  const identity = await app.db.withPlatform(async (ctx) => {
    // Claim the signup first, inside this transaction. Two simultaneous
    // presentations of the same link cannot both proceed: the second finds no
    // PENDING row to update and is rejected as spent.
    const claimed = await ctx.one<{ id: string }>(
      `UPDATE signups SET status = 'COMPLETED', completed_at = $2::timestamptz
       WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [signup!.id, now],
    );
    if (!claimed) return null;

    let mspId: string | null = null;
    if (signup!.account_kind === 'MSP') {
      const msp = await ctx.oneOrFail<{ id: string }>(
        `INSERT INTO msps (name, slug, contact_email)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          signup!.organisation_name,
          await allocateMspSlug(ctx, signup!.organisation_name),
          signup!.email,
        ],
        'MSP',
      );
      mspId = msp.id;
    }

    const user = await ctx.oneOrFail<{ id: string }>(
      `INSERT INTO users (email, display_name, msp_id, status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [signup!.email, signup!.contact_name, mspId],
      'User',
    );
    await ctx.query(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`, [
      user.id,
      passwordHash,
    ]);

    return { userId: user.id, mspId };
  });

  if (!identity) invalid();

  // Provisioning runs outside the identity transaction because it manages its
  // own, and because a failure here must leave a recoverable account rather
  // than an unusable token.
  const organisation = await provisionOrganisation(app, {
    mspId: identity!.mspId,
    input: {
      name: signup!.organisation_name,
      countryCode: signup!.country_code ?? null,
      industry: null,
      sizeBand: null,
      settings: {},
      // Deliberately none. Adopting a framework the customer has not chosen
      // would present requirements they never asked to be measured against.
      frameworks: [],
      applyMspBaseline: false,
    },
    actor: signup!.email,
    actorUserId: identity!.userId,
    correlationId: context.correlationId,
  });

  await app.db.withPlatform(async (ctx) => {
    // Start a trial.
    //
    // Without one a self-serve operator signs up successfully and is refused at
    // the first thing they try to do — creating a customer — with "no active
    // subscription for this MSP". Onboarding that completes and then blocks is
    // worse than onboarding that fails, because the customer has already
    // decided the product works.
    //
    // The trial is entitlement, not billing: no payment method, no charge, and
    // a hard expiry that the entitlement check already enforces.
    await ctx.query(
      `INSERT INTO plans (key, tier, name, price_per_organisation_minor, currency,
                          included_organisations)
       VALUES ('trial', 'PILOT', 'Trial', 0, 'GBP', 0)
       ON CONFLICT (key) DO NOTHING`,
    );
    const trialEnds = new Date(app.clock.nowEpochMs() + TRIAL_DAYS * 86_400_000).toISOString();
    if (identity!.mspId) {
      await ctx.query(
        `INSERT INTO subscriptions
           (msp_id, plan_key, status, price_per_organisation_minor, organisation_limit,
            trial_ends_at, current_period_start, current_period_end)
         VALUES ($1, 'trial', 'TRIAL', 0, $2, $3::timestamptz, $4::timestamptz, $3::timestamptz)`,
        [identity!.mspId, TRIAL_ORGANISATION_LIMIT, trialEnds, now],
      );
    } else {
      await ctx.query(
        `INSERT INTO subscriptions
           (organisation_id, plan_key, status, price_per_organisation_minor, organisation_limit,
            trial_ends_at, current_period_start, current_period_end)
         VALUES ($1, 'trial', 'TRIAL', 0, 1, $2::timestamptz, $3::timestamptz, $2::timestamptz)`,
        [organisation.id, trialEnds, now],
      );
    }

    // The first user of an account owns it. Every other authority in the
    // account is granted by a person, never claimed by one.
    if (identity!.mspId) {
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'MSP', $2, ARRAY['MSP_OWNER']::text[])`,
        [identity!.userId, identity!.mspId],
      );
    } else {
      await ctx.query(
        `INSERT INTO grants (principal_type, principal_id, scope_type, scope_id, roles)
         VALUES ('USER', $1, 'ORGANISATION', $2, ARRAY['ORG_ADMIN']::text[])`,
        [identity!.userId, organisation.id],
      );
    }
    await ctx.query(`UPDATE signups SET msp_id = $2, organisation_id = $3 WHERE id = $1`, [
      signup!.id,
      identity!.mspId,
      organisation.id,
    ]);
  });

  await app.db.withTenant(organisation.id, async (ctx) => {
    await seedOnboardingTasks(ctx, {
      organisationId: organisation.id,
      accountKind: signup!.account_kind,
      nowIso: now,
    });
    await publish(
      ctx,
      {
        type: 'OrganisationOnboardingCompleted',
        organisationId: organisation.id,
        mspId: identity!.mspId,
        subjectType: 'Organisation',
        subjectId: organisation.id,
        payload: {
          accountKind: signup!.account_kind,
          organisationName: organisation.name,
          controlsCreated: organisation.controlsCreated,
          frameworks: organisation.frameworksAdopted,
          selfServe: true,
        },
        correlationId: context.correlationId,
        actor: signup!.email,
      },
      now,
    );
  });

  return {
    userId: identity!.userId,
    email: signup!.email,
    displayName: signup!.contact_name,
    accountKind: signup!.account_kind,
    mspId: identity!.mspId,
    organisationId: organisation.id,
    organisationSlug: organisation.slug,
    controlsCreated: organisation.controlsCreated,
  };
}

async function allocateMspSlug(
  ctx: { one: <T>(sql: string, params: unknown[]) => Promise<T | null> },
  name: string,
): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 50) || 'operator';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await ctx.one<{ id: string }>(
      `SELECT id FROM msps WHERE lower(slug) = lower($1)`,
      [candidate],
    );
    if (!clash) return candidate;
  }
  throw new AdericelError('CONFLICT', 'Could not allocate a unique operator slug');
}

export { mintToken };
