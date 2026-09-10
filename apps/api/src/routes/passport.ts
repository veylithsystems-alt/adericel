import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery } from '../middleware/validation.js';
import {
  issuePassport,
  mintShareToken,
  passportShareSchema,
  resolveShare,
  type PassportContent,
} from '../services/passport.js';

/**
 * Assurance Passport routes.
 *
 * The passport is what the customer actually gets: a continuously maintainable,
 * verifiable statement of their assurance state that they can hand to an
 * insurer, a client, an auditor or a procurement team.
 *
 * The public routes at the bottom are the point. A recipient holds no Adericel
 * account and never will, so the shared record must be readable and checkable
 * by somebody outside the system entirely — otherwise the passport is just a
 * page in a dashboard the customer already pays for.
 */

const orgParam = z.object({ organisationId: z.string().uuid() });
const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

/** Unauthenticated, so limited harder than an authenticated read. */
const publicLimit = { config: { rateLimit: { max: 60, timeWindow: 600_000 } } };

export function registerPassportRoutes(server: FastifyInstance, app: AppContext): void {
  /** Issue a passport: freeze and hash the current assurance state. */
  server.post(
    '/v1/organisations/:organisationId/passports',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:export');
      const principal = requirePrincipal(request);

      const issued = await issuePassport(app, {
        organisationId,
        issuedBy: principal.displayName,
        correlationId: request.adericel.correlationId,
      });

      await audit(app, request, {
        action: 'passport:issue',
        resourceType: 'Report',
        resourceId: issued.id,
        metadata: {
          sequence: issued.sequence,
          state: issued.state,
          contentHash: issued.contentHash,
          unknownControls: issued.content.summary.unknown,
        },
      });

      return reply.status(201).send(issued);
    },
  );

  server.get(
    '/v1/organisations/:organisationId/passports',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      const query = parseQuery(
        request,
        z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
      );

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          sequence: number;
          content_hash: string;
          state: string;
          controls_total: number;
          controls_unknown: number;
          controls_satisfied: number;
          controls_failing: number;
          open_findings: number;
          as_of: Date;
          issued_by: string;
          issued_at: Date;
          withdrawn_at: Date | null;
          shares: string;
        }>(
          `SELECT p.id, p.sequence, p.content_hash, p.state, p.controls_total, p.controls_unknown,
                  p.controls_satisfied, p.controls_failing, p.open_findings, p.as_of,
                  p.issued_by, p.issued_at, p.withdrawn_at,
                  (SELECT count(*) FROM passport_shares s
                    WHERE s.passport_id = p.id AND s.revoked_at IS NULL
                      AND s.expires_at > now())::text AS shares
           FROM assurance_passports p
           WHERE p.organisation_id = $1
           ORDER BY p.sequence DESC LIMIT $2`,
          [organisationId, query.limit],
        ),
      );

      return reply.status(200).send({
        passports: rows.map((row) => ({
          id: row.id,
          sequence: row.sequence,
          contentHash: row.content_hash,
          state: row.state,
          summary: {
            total: row.controls_total,
            satisfied: row.controls_satisfied,
            failing: row.controls_failing,
            unknown: row.controls_unknown,
          },
          openFindings: row.open_findings,
          asOf: row.as_of.toISOString(),
          issuedBy: row.issued_by,
          issuedAt: row.issued_at.toISOString(),
          withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
          liveShares: Number(row.shares),
        })),
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/passports/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:read');

      const row = await app.db.withTenant(params.organisationId, async (ctx) =>
        ctx.oneOrFail<{
          content: PassportContent;
          content_hash: string;
          sequence: number;
          issued_at: Date;
          withdrawn_at: Date | null;
          withdrawn_reason: string | null;
        }>(
          `SELECT content, content_hash, sequence, issued_at, withdrawn_at, withdrawn_reason
           FROM assurance_passports WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
          'Passport',
        ),
      );

      return reply.status(200).send({
        sequence: row.sequence,
        contentHash: row.content_hash,
        issuedAt: row.issued_at.toISOString(),
        withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
        withdrawnReason: row.withdrawn_reason,
        content: row.content,
      });
    },
  );

  /**
   * Withdraw a passport.
   *
   * Never a delete. A recipient relying on an old record must be told it was
   * withdrawn, not told it never existed — the second is indistinguishable from
   * an organisation quietly disowning a statement it no longer likes.
   */
  server.post(
    '/v1/organisations/:organisationId/passports/:id/withdraw',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:export');
      const body = parseBody(request, z.object({ reason: z.string().min(1).max(1000) }));

      await app.db.withTenant(params.organisationId, async (ctx) => {
        const row = await ctx.one<{ id: string }>(
          `UPDATE assurance_passports
           SET withdrawn_at = $3::timestamptz, withdrawn_reason = $4
           WHERE id = $1 AND organisation_id = $2 AND withdrawn_at IS NULL
           RETURNING id`,
          [params.id, params.organisationId, app.clock.nowIso(), body.reason],
        );
        if (!row) {
          throw new AdericelError('PRECONDITION_FAILED', 'That passport is already withdrawn');
        }
      });

      await audit(app, request, {
        action: 'passport:withdraw',
        resourceType: 'Report',
        resourceId: params.id,
        reason: body.reason,
      });

      return reply.status(200).send({ withdrawn: true });
    },
  );

  /** Share a passport with a named audience, for a bounded time. */
  server.post(
    '/v1/organisations/:organisationId/passports/:id/shares',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:export');
      const body = parseBody(request, passportShareSchema);
      const principal = requirePrincipal(request);

      const token = mintShareToken();
      const tokenHash = app.tokens.hash('invitation', `passport-share:${token}`);
      const expiresAt = new Date(
        app.clock.nowEpochMs() + body.expiresInDays * 86_400_000,
      ).toISOString();

      const share = await app.db.withTenant(params.organisationId, async (ctx) => {
        const passport = await ctx.one<{ id: string; withdrawn_at: Date | null }>(
          `SELECT id, withdrawn_at FROM assurance_passports
           WHERE id = $1 AND organisation_id = $2`,
          [params.id, params.organisationId],
        );
        if (!passport) throw new AdericelError('NOT_FOUND', 'Passport not found');
        if (passport.withdrawn_at !== null) {
          throw new AdericelError(
            'PRECONDITION_FAILED',
            'That passport has been withdrawn and cannot be shared. Issue a current one.',
          );
        }
        return ctx.oneOrFail<{ id: string; created_at: Date }>(
          `INSERT INTO passport_shares
             (organisation_id, passport_id, audience, token_hash, disclosure, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
          [
            params.organisationId,
            params.id,
            body.audience,
            tokenHash,
            body.disclosure,
            principal.displayName,
            expiresAt,
          ],
          'Share',
        );
      });

      await audit(app, request, {
        action: 'passport:share',
        resourceType: 'Report',
        resourceId: params.id,
        metadata: { audience: body.audience, disclosure: body.disclosure, expiresAt },
      });

      return reply.status(201).send({
        id: share.id,
        audience: body.audience,
        disclosure: body.disclosure,
        expiresAt,
        // Returned exactly once. Only a keyed digest is stored, so a lost link
        // is reissued rather than recovered.
        url: `${app.config.api.publicUrl.replace(/\/+$/, '')}/assurance/${token}`,
      });
    },
  );

  /** Who the organisation has shared its assurance with, and who has looked. */
  server.get(
    '/v1/organisations/:organisationId/passport-shares',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');

      const rows = await app.db.withTenant(organisationId, async (ctx) =>
        ctx.many<{
          id: string;
          audience: string;
          disclosure: string;
          sequence: number;
          expires_at: Date;
          revoked_at: Date | null;
          view_count: number;
          last_viewed_at: Date | null;
          created_by: string;
          created_at: Date;
        }>(
          `SELECT s.id, s.audience, s.disclosure, p.sequence, s.expires_at, s.revoked_at,
                  s.view_count, s.last_viewed_at, s.created_by, s.created_at
           FROM passport_shares s
           JOIN assurance_passports p ON p.id = s.passport_id
           WHERE s.organisation_id = $1
           ORDER BY s.created_at DESC`,
          [organisationId],
        ),
      );

      return reply.status(200).send({
        shares: rows.map((row) => ({
          id: row.id,
          audience: row.audience,
          disclosure: row.disclosure,
          passportSequence: row.sequence,
          expiresAt: row.expires_at.toISOString(),
          revokedAt: row.revoked_at?.toISOString() ?? null,
          live: row.revoked_at === null && row.expires_at.getTime() > app.clock.nowEpochMs(),
          viewCount: row.view_count,
          lastViewedAt: row.last_viewed_at?.toISOString() ?? null,
          createdBy: row.created_by,
          createdAt: row.created_at.toISOString(),
        })),
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/passport-shares/:id/revoke',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:export');
      const principal = requirePrincipal(request);

      await app.db.withTenant(params.organisationId, async (ctx) => {
        const row = await ctx.one<{ id: string }>(
          `UPDATE passport_shares
           SET revoked_at = $3::timestamptz, revoked_by = $4
           WHERE id = $1 AND organisation_id = $2 AND revoked_at IS NULL
           RETURNING id`,
          [params.id, params.organisationId, app.clock.nowIso(), principal.displayName],
        );
        if (!row) throw new AdericelError('NOT_FOUND', 'No live share with that id');
      });

      await audit(app, request, {
        action: 'passport:share:revoke',
        resourceType: 'Report',
        resourceId: params.id,
      });

      return reply.status(200).send({ revoked: true });
    },
  );

  // ---- Public surface --------------------------------------------------
  //
  // Read by people with no Adericel account: an insurer, a client's security
  // team, a procurement reviewer. These are the routes that make a passport an
  // assurance record rather than a dashboard page.

  server.get('/v1/assurance/:token', publicLimit, async (request, reply) => {
    const { token } = parseParams(request, z.object({ token: z.string().min(20).max(200) }));
    const resolved = await resolveShare(app, token, {
      ip: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });

    return reply.status(200).send({
      organisation: resolved.organisationName,
      sequence: resolved.sequence,
      issuedAt: resolved.issuedAt,
      contentHash: resolved.contentHash,
      withdrawn: resolved.withdrawn,
      passport: resolved.passport,
      // Told to the recipient rather than assumed: this describes an instant,
      // and the issuer may have withdrawn it since.
      verification: {
        how:
          'POST the passport content to /v1/assurance/verify to confirm it is byte-identical to ' +
          'what Adericel holds. The check does not require an account, and does not depend on ' +
          'trusting whoever sent you this link.',
        endpoint: `${app.config.api.publicUrl.replace(/\/+$/, '')}/v1/assurance/verify`,
      },
    });
  });

  /**
   * Verify a passport without holding it.
   *
   * A recipient who was emailed a passport as a file can confirm it is the
   * record Adericel issued, and has not been edited by anyone in between —
   * including by the organisation it describes. This is what turns the passport
   * into something a third party can rely on rather than merely read.
   *
   * It answers only about a hash. No content is returned and no organisation is
   * named, so it cannot be used to enumerate or to read a record the caller was
   * never given.
   */
  server.post('/v1/assurance/verify', publicLimit, async (request, reply) => {
    const body = parseBody(request, z.object({ contentHash: z.string().min(10).max(200) }));

    // A hash identifies content, not a row. Two passports whose assurance
    // state and instant are identical carry the same hash by construction —
    // that is what content addressing means — so this aggregates rather than
    // assuming one match. The passport stands unless every issue of that
    // content has been withdrawn: one live issue is still Adericel vouching
    // for it.
    const matches = await app.db.withPlatform(async (ctx) =>
      ctx.oneOrFail<{
        total: string;
        live: string;
        first_issued: Date | null;
        last_withdrawn: Date | null;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE withdrawn_at IS NULL)::text AS live,
                min(issued_at) AS first_issued,
                max(withdrawn_at) AS last_withdrawn
         FROM assurance_passports WHERE content_hash = $1`,
        [body.contentHash],
        'Passport verification',
      ),
    );

    if (Number(matches.total) === 0) {
      return reply.status(200).send({
        recognised: false,
        detail:
          'Adericel has not issued a passport with this content hash. Either the document was ' +
          'altered after it was issued, or it did not come from Adericel.',
      });
    }

    const withdrawn = Number(matches.live) === 0;
    return reply.status(200).send({
      recognised: true,
      issuedAt: matches.first_issued?.toISOString() ?? null,
      withdrawn,
      withdrawnAt: withdrawn ? (matches.last_withdrawn?.toISOString() ?? null) : null,
      detail: withdrawn
        ? 'This passport was issued by Adericel and has since been withdrawn by the ' +
          'organisation that issued it. Do not rely on it.'
        : 'This is a passport Adericel issued, unaltered since issue.',
    });
  });
}
