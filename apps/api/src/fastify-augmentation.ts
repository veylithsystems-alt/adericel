/**
 * Fastify augmentations the product's own surfaces rely on.
 *
 * A `.ts` module rather than a `.d.ts` file, deliberately. A standalone
 * declaration file applies only to the compilation that includes it, so when
 * the company's routes moved out of `apps/api/src` into their own workspace
 * they lost `server.authenticate` and the build failed — correctly, and
 * confusingly. Declared in a module that `index.ts` imports for its side
 * effect, the augmentation is emitted into this app's declaration output and
 * reaches every consumer that composes a surface onto the product.
 */
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
