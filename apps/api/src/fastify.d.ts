import type { preHandlerHookHandler } from 'fastify';

/**
 * Fastify decorations used across route modules.
 *
 * `authenticate` is registered once in `app.ts`, so every route opts into
 * authentication the same way and a route that forgets it is visible in review
 * as a missing `preHandler`.
 */
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
  }
}

export {};
