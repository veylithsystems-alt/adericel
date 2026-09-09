import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdericelError, toErrorBody, isAdericelError, errorFields } from '@adericel/shared';
import { z, type ZodType } from 'zod';
import type { AppContext } from '../context.js';

/**
 * Request validation and error translation.
 *
 * Every input crosses a Zod schema before it reaches domain code. Unparsed
 * input is the origin of most injection and confusion bugs, so there is no
 * route in this API that reads `request.body` directly.
 */

export function parseBody<T>(request: FastifyRequest, schema: ZodType<T>): T {
  const result = schema.safeParse(request.body);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function parseQuery<T>(request: FastifyRequest, schema: ZodType<T>): T {
  const result = schema.safeParse(request.query);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function parseParams<T>(request: FastifyRequest, schema: ZodType<T>): T {
  const result = schema.safeParse(request.params);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function validationError(error: z.ZodError): AdericelError {
  return new AdericelError('VALIDATION_FAILED', 'Request validation failed', {
    safeDetails: {
      issues: error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    },
  });
}

export const uuidParam = z.object({ id: z.string().uuid() });
export const organisationParam = z.object({ organisationId: z.string().uuid() });
export const organisationChildParam = z.object({
  organisationId: z.string().uuid(),
  id: z.string().uuid(),
});

/**
 * Error handler.
 *
 * Clients receive a stable machine-readable code and only the details the error
 * explicitly marked safe. Everything else — stack traces, driver messages,
 * upstream response bodies — stays in the log, where it is redacted.
 */
export function errorHandler(app: AppContext) {
  return function handler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
    const correlationId = request.adericel?.correlationId;
    const logger = request.adericel?.logger ?? app.logger;

    if (isAdericelError(error)) {
      // A tenant-isolation refusal is a security event, not a routine 403.
      const level = error.code === 'TENANT_MISMATCH' ? 'error' : error.status >= 500 ? 'error' : 'warn';
      logger[level](
        {
          code: error.code,
          status: error.status,
          method: request.method,
          path: request.routeOptions?.url ?? request.url,
          ...errorFields(error),
        },
        'request failed',
      );
      void reply.status(error.status).send(toErrorBody(error, correlationId));
      return;
    }

    if (error instanceof z.ZodError) {
      const translated = validationError(error);
      void reply.status(translated.status).send(toErrorBody(translated, correlationId));
      return;
    }

    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      const mapped = new AdericelError(
        fastifyError.statusCode === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED',
        fastifyError.message ?? 'Request rejected',
      );
      void reply.status(fastifyError.statusCode).send(toErrorBody(mapped, correlationId));
      return;
    }

    logger.error(
      {
        method: request.method,
        path: request.routeOptions?.url ?? request.url,
        ...errorFields(error),
      },
      'unhandled error',
    );
    const internal = new AdericelError('INTERNAL_ERROR', 'An unexpected error occurred');
    void reply.status(500).send(toErrorBody(internal, correlationId));
  };
}
