// Side-effect import: carries the Fastify augmentations into this app's
// declaration output, so a consumer composing a surface onto the product sees
// `server.authenticate` and `request.adericel` as the product's own routes do.
import './fastify-augmentation.js';

export { buildServer, type BuildServerOptions, type RouteRegistrar } from './app.js';
/**
 * The composition primitives an additional surface needs.
 *
 * `audit`, `requirePlatform` and the parsing helpers were internal while the
 * only consumer was a file living inside this app. Moving the company's routes
 * out of the product's source tree makes them part of the product's surface,
 * which is the honest cost of the separation: a surface composed from outside
 * must be able to audit, to require platform scope, and to validate input the
 * same way every product surface does. The alternative was leaving a company
 * file inside `apps/api/src`, which is what made the product unextractable.
 */
export { audit, requirePlatform } from './middleware/request-context.js';
export { parseBody, parseParams, parseQuery } from './middleware/validation.js';
export { createAppContext, type AppContext } from './context.js';
export { buildOpenApiDocument } from './openapi.js';
export * from './auth/tokens.js';
export * from './services/onboarding.js';
export * from './services/export.js';
export * from './services/health.js';
export * from './surfaces.js';
export * from './services/retention.js';
export * from './services/erasure.js';
export * from './services/operating-loop.js';
export * from './services/capacity.js';
export * from './services/support.js';
