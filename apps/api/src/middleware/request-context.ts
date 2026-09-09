import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission, Principal } from '@adericel/domain';
import type { TenantContext } from '@adericel/graph';
import { recordAudit } from '@adericel/graph';
import { AdericelError, newCorrelationId, type Logger } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { decide, organisationOwner, principalFromAccessToken, principalFromApiKey } from '../auth/principal.js';

/**
 * Per-request state.
 *
 * `organisationId` is only ever set by `requireOrganisation`, which derives it
 * from the authenticated principal's grants. Nothing reads a tenant identifier
 * straight from the request body or a header.
 */
export interface RequestContext {
  readonly correlationId: string;
  readonly requestId: string;
  readonly logger: Logger;
  principal: Principal | null;
  organisationId: string | null;
  organisationMspId: string | null;
  auditAction: string | null;
  auditResourceType: string | null;
  auditResourceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    adericel: RequestContext;
  }
}

export function attachRequestContext(app: AppContext) {
  return async function onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // A caller-supplied correlation id is honoured so a trace started in n8n or
    // an MSP platform continues through Adericel. It is validated first: an
    // unvalidated value would end up in logs and in the database.
    const supplied = request.headers['x-correlation-id'];
    const correlationId =
      typeof supplied === 'string' && /^[0-9a-f-]{36}$/i.test(supplied)
        ? supplied
        : newCorrelationId();

    request.adericel = {
      correlationId,
      requestId: request.id,
      logger: app.logger.child({ correlationId, requestId: request.id }),
      principal: null,
      organisationId: null,
      organisationMspId: null,
      auditAction: null,
      auditResourceType: null,
      auditResourceId: null,
    };

    reply.header('x-correlation-id', correlationId);
    reply.header('x-request-id', request.id);
  };
}

/**
 * Authenticate the caller.
 *
 * Both credential kinds resolve to the same Principal shape, so every
 * downstream authorisation check is identical whether the caller is a person, a
 * workflow, or another platform.
 */
export function authenticate(app: AppContext) {
  return async function preHandler(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    const apiKeyHeader = request.headers['x-api-key'];

    if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
      request.adericel.principal = await principalFromApiKey(app, apiKeyHeader);
    } else if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      const token = header.slice(7).trim();
      // A key presented as a bearer token is accepted, because that is what
      // most HTTP clients and n8n credentials do by default.
      request.adericel.principal = token.startsWith('adk_')
        ? await principalFromApiKey(app, token)
        : await principalFromAccessToken(app, token);
    } else {
      throw new AdericelError('UNAUTHENTICATED', 'Authentication required');
    }

    request.adericel.logger.debug(
      {
        principalType: request.adericel.principal.principalType,
        principalId: request.adericel.principal.principalId,
      },
      'authenticated',
    );
  };
}

export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.adericel.principal;
  if (!principal) throw new AdericelError('UNAUTHENTICATED', 'Authentication required');
  return principal;
}

/**
 * Establish the organisation this request operates on.
 *
 * The route supplies a candidate id (usually from the path). Ownership is then
 * loaded from the database and the principal's grants are evaluated against it.
 * Only after that does the id become the request's tenant context — which is in
 * turn the only value ever passed to `db.withTenant`.
 */
export async function requireOrganisation(
  app: AppContext,
  request: FastifyRequest,
  candidateOrganisationId: string,
  permission: Permission,
): Promise<string> {
  const principal = requirePrincipal(request);

  const owner = await organisationOwner(app, candidateOrganisationId);
  if (!owner) {
    // Reported as a denial rather than a 404 so that probing for organisation
    // ids cannot distinguish "does not exist" from "not yours".
    await writeDenial(app, request, permission, candidateOrganisationId, 'Organisation not found');
    throw new AdericelError('FORBIDDEN', 'No access to the requested organisation');
  }

  const answer = decide(
    principal,
    { permission, organisationId: candidateOrganisationId, organisationMspId: owner.mspId },
    app.clock,
  );

  if (!answer.allowed) {
    await writeDenial(app, request, permission, candidateOrganisationId, answer.reason);
    throw new AdericelError('FORBIDDEN', 'No access to the requested organisation', {
      safeDetails: { permission },
    });
  }

  if (owner.status === 'CLOSED') {
    throw new AdericelError('PRECONDITION_FAILED', 'Organisation is closed');
  }

  request.adericel.organisationId = candidateOrganisationId;
  request.adericel.organisationMspId = owner.mspId;
  return candidateOrganisationId;
}

export async function requireMsp(
  app: AppContext,
  request: FastifyRequest,
  mspId: string,
  permission: Permission,
): Promise<string> {
  const principal = requirePrincipal(request);
  const answer = decide(principal, { permission, mspId }, app.clock);
  if (!answer.allowed) {
    await writeDenial(app, request, permission, mspId, answer.reason);
    throw new AdericelError('FORBIDDEN', 'No access to the requested MSP', {
      safeDetails: { permission },
    });
  }
  return mspId;
}

export async function requirePlatform(
  app: AppContext,
  request: FastifyRequest,
  permission: Permission,
): Promise<void> {
  const principal = requirePrincipal(request);
  const answer = decide(principal, { permission }, app.clock);
  if (!answer.allowed) {
    await writeDenial(app, request, permission, null, answer.reason);
    throw new AdericelError('FORBIDDEN', 'Platform permission required', {
      safeDetails: { permission },
    });
  }
}

/**
 * Record a denial.
 *
 * A refused request is often the most interesting entry in the audit log — it
 * is what an investigation into a compromised MSP account actually looks at —
 * so denials are written with the same care as successes.
 */
async function writeDenial(
  app: AppContext,
  request: FastifyRequest,
  permission: Permission,
  resourceId: string | null,
  reason: string,
): Promise<void> {
  const principal = request.adericel.principal;
  try {
    await app.db.withPlatform(async (ctx) =>
      recordAudit(
        ctx,
        {
          organisationId: null,
          mspId: principal?.mspId ?? null,
          actorType: principal?.principalType ?? 'ANONYMOUS',
          actorId: principal?.principalId ?? 'anonymous',
          actorDisplay: principal?.displayName ?? 'anonymous',
          action: `authorise:${permission}`,
          resourceType: 'Authorisation',
          resourceId,
          outcome: 'DENIED',
          reason,
          requestId: request.id,
          correlationId: request.adericel.correlationId,
          sourceIp: request.ip,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
          metadata: { method: request.method, path: request.routeOptions?.url ?? request.url },
        },
        app.clock.nowIso(),
      ),
    );
  } catch (error) {
    // Audit failure must not mask the denial itself.
    request.adericel.logger.error(
      { err: (error as Error).message },
      'failed to record authorisation denial',
    );
  }
}

/** Record a successful, audit-worthy operation. */
export async function audit(
  app: AppContext,
  request: FastifyRequest,
  entry: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    outcome?: 'SUCCESS' | 'FAILURE';
    reason?: string | null;
    metadata?: Record<string, unknown>;
    ctx?: TenantContext;
  },
): Promise<void> {
  const principal = request.adericel.principal;
  const payload = {
    organisationId: request.adericel.organisationId,
    mspId: request.adericel.organisationMspId ?? principal?.mspId ?? null,
    actorType: principal?.principalType ?? 'ANONYMOUS',
    actorId: principal?.principalId ?? 'anonymous',
    actorDisplay: principal?.displayName ?? 'anonymous',
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    outcome: entry.outcome ?? ('SUCCESS' as const),
    reason: entry.reason ?? null,
    requestId: request.id,
    correlationId: request.adericel.correlationId,
    sourceIp: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    metadata: entry.metadata ?? {},
  };

  // When the caller is already inside a tenant transaction the audit entry
  // joins it, so the record and the change it describes commit together.
  if (entry.ctx) {
    await recordAudit(entry.ctx, payload, app.clock.nowIso());
    return;
  }
  await app.db.withPlatform(async (ctx) => recordAudit(ctx, payload, app.clock.nowIso()));
}
