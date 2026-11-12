import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { AdericelError, toErrorBody } from '@adericel/shared';
import type { AppContext } from './context.js';
import { attachRequestContext, authenticate } from './middleware/request-context.js';
import { errorHandler } from './middleware/validation.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMspRoutes } from './routes/msps.js';
import { registerOrganisationRoutes } from './routes/organisations.js';
import { registerAssuranceRoutes } from './routes/assurance.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerPassportRoutes } from './routes/passport.js';
import { registerCommercialRoutes } from './routes/commercial.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerResolutionRoutes } from './routes/resolution.js';
import { registerContainmentRoutes } from './routes/containment.js';
import { registerBreakGlassRoutes } from './routes/break-glass.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerFindingRoutes } from './routes/findings.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import {
  registerLoopRoutes,
  registerPortfolioRoutes,
  registerTriageRoutes,
  registerValueRoutes,
} from './routes/portfolio.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { buildOpenApiDocument } from './openapi.js';

/**
 * HTTP application assembly.
 *
 * Ordering matters here: request context is attached before anything else so
 * that every log line and every error carries a correlation id, and the error
 * handler is installed before routes so a failure during route registration is
 * still reported in the standard shape.
 */
/**
 * A deployment's own route registrar.
 *
 * Deliberately the same shape as the product's own `register*Routes` functions,
 * so the company layer composes exactly as a product surface does and gets no
 * privileged hook of its own.
 */
export type RouteRegistrar = (server: FastifyInstance, app: AppContext) => void;

export interface BuildServerOptions {
  /**
   * Registrars a deployment adds on top of the product's own surfaces.
   *
   * Empty for every customer deployment. A company deployment passes Veylith's
   * control room here. There is no way to reach into the product and ask for
   * them: whatever is in this array is what the entry point chose to pass.
   */
  readonly additionalRoutes?: readonly RouteRegistrar[];
}

export async function buildServer(
  app: AppContext,
  options?: BuildServerOptions,
): Promise<FastifyInstance> {
  const server = Fastify({
    // Fastify's own request logging is disabled; Adericel emits one structured
    // line per request in the onResponse hook, with the correlation id attached.
    logger: false,
    trustProxy: app.config.api.trustProxy,
    bodyLimit: app.config.api.bodyLimitBytes,
    genReqId: () => crypto.randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  server.setErrorHandler(errorHandler(app));

  server.setNotFoundHandler((request, reply) => {
    const error = new AdericelError('NOT_FOUND', 'No such endpoint', {
      safeDetails: { method: request.method, path: request.url.split('?')[0] },
    });
    void reply.status(404).send(toErrorBody(error, request.adericel?.correlationId));
  });

  await server.register(helmet, {
    // The API serves JSON and file downloads only; a restrictive CSP costs
    // nothing here and blocks content sniffing turning a download into script.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], sandbox: [] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      app.config.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await server.register(cors, {
    origin: app.config.api.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-api-key',
      'idempotency-key',
      'x-correlation-id',
    ],
    exposedHeaders: ['x-correlation-id', 'x-request-id', 'x-content-hash'],
    maxAge: 600,
  });

  await server.register(rateLimit, {
    max: app.config.api.rateLimit.max,
    timeWindow: app.config.api.rateLimit.windowMs,
    // Rate limits are per credential, not per IP: several MSP engineers behind
    // one office address must not exhaust each other's budget, and a workflow
    // with its own key gets its own allowance.
    keyGenerator: (request) => {
      const principal = request.adericel?.principal;
      if (principal) return `${principal.principalType}:${principal.principalId}`;
      const apiKey = request.headers['x-api-key'];
      if (typeof apiKey === 'string') return `key:${apiKey.slice(0, 16)}`;
      return `ip:${request.ip}`;
    },
    // The status code has to travel on the thrown object. The plugin hands its
    // built response to the error handler rather than sending it directly, and
    // a body with no `statusCode` was falling through to the unhandled branch —
    // so exceeding a rate limit produced 500 INTERNAL_ERROR rather than 429
    // RATE_LIMITED. A throttled client cannot tell a limit from a fault, and a
    // 500 is exactly the response a client is most likely to retry hard.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      error: 'Too Many Requests',
      message: `Too many requests. Retry after ${context.after}.`,
    }),
  });

  await server.register(multipart, {
    limits: {
      fileSize: app.config.storage.maxUploadBytes,
      files: 1,
      fields: 10,
    },
  });

  server.addHook('onRequest', attachRequestContext(app));

  server.addHook('onResponse', async (request, reply) => {
    // One structured line per request. The correlation id ties it to the events
    // and audit entries the request produced.
    request.adericel?.logger.info(
      {
        method: request.method,
        path: request.routeOptions?.url ?? request.url.split('?')[0],
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        principalType: request.adericel.principal?.principalType ?? null,
        organisationId: request.adericel.organisationId,
      },
      'request',
    );
  });

  server.decorate('authenticate', authenticate(app));

  registerAuthRoutes(server, app);
  registerMspRoutes(server, app);
  registerOrganisationRoutes(server, app);
  registerAssuranceRoutes(server, app);
  registerEvidenceRoutes(server, app);
  registerActionRoutes(server, app);
  registerOnboardingRoutes(server, app);
  registerPassportRoutes(server, app);
  registerContainmentRoutes(server, app);
  registerCommercialRoutes(server, app);
  registerSupportRoutes(server, app);
  registerResolutionRoutes(server, app);
  registerBreakGlassRoutes(server, app);
  registerBillingRoutes(server, app);
  registerFindingRoutes(server, app);
  registerGraphRoutes(server, app);
  registerIntegrationRoutes(server, app);
  /**
   * Anything a deployment composes on top, registered last among the routes.
   *
   * This is where Veylith's own control room arrives on a company deployment —
   * and the point is that **this file cannot name it.** The product app used to
   * hold a company route file and a dynamic import behind a flag, which kept
   * the company layer out of the product's module graph but not out of its
   * source tree: `apps/api` declared the company package in its manifest and
   * its TypeScript project referenced it, so the product could not be extracted
   * into its own repository without editing manifests on the way out. A
   * separation that needs a patch script to hold is one that eventually does
   * not hold.
   *
   * So the composition is inverted. The product knows only that a deployment
   * may hand it extra registrars; the company's own entry point is the
   * deployment that hands it the company ones, and it depends on this app
   * rather than the other way round. `tests/unit/architecture.test.ts` asserts
   * the product names nothing company, in its source and in its manifests.
   */
  for (const register of options?.additionalRoutes ?? []) {
    register(server, app);
  }
  registerPortfolioRoutes(server, app);
  /**
   * Proof of value is product, not company.
   *
   * It counts what Adericel did for an MSP's clients and prices it only with
   * durations the MSP supplied. That is the MSP showing their client what they
   * are paying for — it is the most useful thing in the product for renewal
   * conversations, and withholding it from a self-hosted deployment would be
   * withholding the argument for the deployment.
   *
   * `@adericel/value` therefore stays in the product. `@adericel/vaol` —
   * Veylith's own gate, ledger and pipeline — does not.
   */
  registerValueRoutes(server, app);
  registerTriageRoutes(server, app);
  registerLoopRoutes(server, app);
  registerObservabilityRoutes(server, app);
  registerWebhookRoutes(server, app);

  server.get('/openapi.json', async (_request, reply) =>
    reply.status(200).send(buildOpenApiDocument(app)),
  );

  server.get('/', async (_request, reply) =>
    reply.status(200).send({
      service: 'Adericel',
      description: 'Autonomous organisational security assurance infrastructure',
      apiVersion: 'v1',
      release: app.config.releaseVersion,
      documentation: '/openapi.json',
      health: '/health/ready',
    }),
  );

  await server.ready();
  return server;
}
