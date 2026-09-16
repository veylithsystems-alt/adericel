import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DIAGNOSTIC_SECTIONS,
  DISCLOSURE_KINDS,
  SEVERITY_DEFINITIONS,
  SUPPORT_CASE_STATES,
  SUPPORT_CATEGORIES,
  SUPPORT_QUEUES,
  SUPPORT_SEVERITIES,
  PROHIBITED_TRANSITIONS,
  type IdentificationMethod,
  type RequesterKind,
} from '@adericel/support';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import {
  decideDisclosure,
  moveCase,
  openCase,
  produceDiagnosticBundle,
} from '../services/support.js';

/**
 * Support routes.
 *
 * Support is a disclosure surface, so every route here is authenticated and
 * every disclosure decision is recorded — including the refusals. Nothing here
 * accepts a requester's claim about who they are: `requesterKind` and the
 * identification method are derived from the authenticated principal and their
 * grants, because "I'm from the customer" said convincingly is exactly the
 * attack §22 exists to stop.
 */

const orgParam = z.object({ organisationId: z.string().uuid() });
const caseParam = orgParam.extend({ caseId: z.string().uuid() });

const openSchema = z
  .object({
    category: z.enum(SUPPORT_CATEGORIES),
    severity: z.enum(SUPPORT_SEVERITIES),
    subject: z.string().min(5).max(200),
    description: z.string().min(1).max(8000),
  })
  // Strict, so an attempt to supply `requesterKind`, `queue` or
  // `directSupportEntitled` is refused rather than silently ignored. A client
  // asserting its own routing is a client choosing who answers it.
  .strict();

const moveSchema = z
  .object({
    to: z.enum(SUPPORT_CASE_STATES),
    reason: z.string().min(15).max(4000),
    customerVerified: z.boolean().optional(),
    queue: z.enum(SUPPORT_QUEUES).optional(),
  })
  .strict();

const discloseSchema = z.object({ kind: z.enum(DISCLOSURE_KINDS) }).strict();

const bundleSchema = z.object({ sections: z.array(z.enum(DIAGNOSTIC_SECTIONS)).min(1) }).strict();

export function registerSupportRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * The support vocabulary: severities and what each one promises, and the
   * transitions that are prohibited and why.
   *
   * Reference data, identical for every caller, naming no organisation. The
   * prohibitions are published deliberately — a customer is entitled to know
   * that nobody can mark their S1 resolved without them.
   */
  server.get('/v1/support/model', { preHandler: server.authenticate }, async (_req, reply) =>
    reply.status(200).send({
      severities: SUPPORT_SEVERITIES.map((severity) => SEVERITY_DEFINITIONS[severity]),
      categories: SUPPORT_CATEGORIES,
      prohibitedTransitions: PROHIBITED_TRANSITIONS,
      routing:
        'Adericel is delivered through MSPs. A request from an end customer goes to their ' +
        'MSP unless a signed agreement gives Veylith direct support responsibility. A ' +
        'security concern is the one exception and reaches Veylith security directly.',
      disclosure:
        'Support is a disclosure surface. Identity and entitlement are established before ' +
        'anything about an organisation is said — including whether it exists — and every ' +
        'disclosure decision, permitted or refused, is recorded where the organisation can ' +
        'read it.',
    }),
  );

  server.post(
    '/v1/organisations/:organisationId/support/cases',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, orgParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      const body = parseBody(request, openSchema);

      const record = await openCase(
        app,
        {
          organisationId,
          category: body.category,
          severity: body.severity,
          subject: body.subject,
          description: body.description,
        },
        supportPrincipalFor(app, request),
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'support:case:open',
        resourceType: 'SupportCase',
        resourceId: record.id,
        metadata: { category: record.category, severity: record.severity, queue: record.queue },
      });

      return reply.status(201).send(record);
    },
  );

  server.post(
    '/v1/organisations/:organisationId/support/cases/:caseId/transitions',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId, caseId } = parseParams(request, caseParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      await assertCaseBelongsToOrganisation(app, caseId, organisationId);

      const body = parseBody(request, moveSchema);
      const principal = requirePrincipal(request);

      const moved = await moveCase(
        app,
        {
          caseId,
          to: body.to,
          reason: body.reason,
          ...(body.customerVerified === undefined
            ? {}
            : { customerVerified: body.customerVerified }),
          ...(body.queue === undefined ? {} : { queue: body.queue }),
        },
        {
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          label: principal.displayName,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'support:case:transition',
        resourceType: 'SupportCase',
        resourceId: caseId,
        metadata: { from: moved.from, to: moved.to },
      });

      return reply.status(200).send(moved);
    },
  );

  /**
   * Ask whether something may be disclosed on this case.
   *
   * A route rather than an internal call, because the answer is what a support
   * agent needs before they type — and because asking is itself recorded. An
   * entitlement gate whose refusals leave no trace cannot distinguish "nobody
   * asked" from "somebody asked eleven times", and those are very different
   * facts about an afternoon.
   */
  server.post(
    '/v1/organisations/:organisationId/support/cases/:caseId/disclosure-check',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId, caseId } = parseParams(request, caseParam);
      await requireOrganisation(app, request, organisationId, 'org:read');
      await assertCaseBelongsToOrganisation(app, caseId, organisationId);

      const body = parseBody(request, discloseSchema);
      const principal = requirePrincipal(request);
      const requester = supportPrincipalFor(app, request);

      const decision = await decideDisclosure(
        app,
        {
          caseId,
          kind: body.kind,
          requester,
          // Derived from the grant that got this request through
          // `requireOrganisation`, never from the body.
          concernsRequestersOwnOrganisation: requester.requesterKind === 'END_CUSTOMER',
          requesterMspRunsOrganisation: requester.requesterKind === 'MSP',
        },
        {
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          label: principal.displayName,
        },
        request.adericel.correlationId,
      );

      return reply.status(decision.permitted ? 200 : 403).send(decision);
    },
  );

  server.post(
    '/v1/organisations/:organisationId/support/cases/:caseId/diagnostics',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId, caseId } = parseParams(request, caseParam);
      await requireOrganisation(app, request, organisationId, 'org:integration:read');
      await assertCaseBelongsToOrganisation(app, caseId, organisationId);

      const body = parseBody(request, bundleSchema);
      const principal = requirePrincipal(request);

      const bundle = await produceDiagnosticBundle(
        app,
        { caseId, organisationId, sections: body.sections },
        {
          userId: principal.principalType === 'USER' ? principal.principalId : null,
          label: principal.displayName,
        },
        request.adericel.correlationId,
      );

      await audit(app, request, {
        action: 'support:diagnostics:produce',
        resourceType: 'SupportCase',
        resourceId: caseId,
        metadata: { sections: bundle.sections, contentHash: bundle.contentHash },
      });

      return reply.status(201).send(bundle);
    },
  );
}

/**
 * What kind of requester this authenticated principal is, and how they were
 * identified.
 *
 * Both derived. A signed-in session is the strongest identification there is
 * and is recorded as such; anything weaker belongs to a channel this route
 * does not serve, and will carry its own identification record when it exists.
 */
function supportPrincipalFor(
  app: AppContext,
  request: FastifyRequest,
): {
  requesterKind: RequesterKind;
  userId: string | null;
  label: string;
  mspId: string | null;
  identifiedBy: IdentificationMethod;
  identifiedAtIso: string | null;
} {
  const principal = requirePrincipal(request);
  const servedSurface = request.adericel.servedSurface;

  return {
    // The surface the grant was honoured on says which party this is, and it
    // is fixed by the route rather than claimed by the caller.
    requesterKind: servedSurface === 'ADERICEL_MSP' ? 'MSP' : 'END_CUSTOMER',
    userId: principal.principalType === 'USER' ? principal.principalId : null,
    label: principal.displayName,
    mspId: principal.mspId,
    identifiedBy: 'AUTHENTICATED_SESSION',
    // Now. The session was verified on this request, so the identification is
    // as fresh as the request is — which is what makes an authenticated
    // session the strongest method and the only one this route accepts.
    identifiedAtIso: app.clock.nowIso(),
  };
}

/**
 * Prove the case belongs to the organisation in the path.
 *
 * The organisation is authorised; the case id is not. Without this, a user with
 * a legitimate grant over their own organisation could read or move another
 * tenant's case by pairing their own id with somebody else's case id.
 */
async function assertCaseBelongsToOrganisation(
  app: AppContext,
  caseId: string,
  organisationId: string,
): Promise<void> {
  const row = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ id: string }>(`SELECT id FROM support_cases WHERE id = $1 AND organisation_id = $2`, [
      caseId,
      organisationId,
    ]),
  );
  // The same answer as a case that does not exist, so a caller cannot probe
  // for other tenants' case ids.
  if (!row) throw new AdericelError('NOT_FOUND', 'No such case');
}
