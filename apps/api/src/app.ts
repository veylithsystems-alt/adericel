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
import { registerFindingRoutes } from './routes/findings.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { buildOpenApiDocument } from './openapi.js';
import './fastify.js';

/**
 * HTTP application assembly.
 *
 * Ordering matters here: request context is attached before anything else so
 * that every log line and every error carries a correlation id, and the error
 * handler is installed before routes so a failure during route registration is
 * still reported in the standard shape.
 */
export async function buildServer(app: AppContext): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    trustProxy: app.config.api.trustProxy,
    bodyLimit: app.config.api.bodyLimitBytes,
    disableRequestLogging: true,
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
    hsts: app.config.nodeEnv === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await server.register(cors, {
    origin: app.config.api.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-api-key', 'idempotency-key', 'x-correlation-id'],
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
    errorResponseBuilder: () => ({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
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
  registerFindingRoutes(server, app);
  registerGraphRoutes(server, app);
  registerIntegrationRoutes(server, app);
  registerPortfolioRoutes(server, app);
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
