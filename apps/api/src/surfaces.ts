import { SURFACES, type Surface } from '@adericel/domain';

/**
 * Which surface each route belongs to.
 *
 * Adericel serves three populations with strictly different entitlements
 * (see `packages/domain/src/surface.ts`). A route that has not been classified
 * is a route whose boundary nobody decided, so the resolver fails closed:
 * unknown path means no surface, and no surface means every authorisation
 * question on it is refused.
 *
 * Classification is by path shape, because the path already names the scope,
 * and a rule survives the addition of a route where a hand-written table would
 * silently miss it. The exceptions are listed individually and each one says
 * why. `tests/security/information-boundary.test.ts` enumerates every
 * registered route and fails if any of them resolves to nothing, and locks the
 * classification so a change to it is a visible change rather than a side
 * effect.
 */

/** Routes with no surface because they carry no authority at all. */
export type RouteClass = Surface[] | 'PUBLIC' | 'COMMON';

/**
 * Routes reachable without a session. Each verifies its own credential — a
 * password, a signed webhook body, or a share token — and each is separately
 * rate limited.
 */
const PUBLIC_ROUTES = new Set([
  'POST /v1/auth/login',
  'POST /v1/auth/mfa/verify',
  'POST /v1/auth/refresh',
  'POST /v1/signup',
  'POST /v1/signup/complete',
  'POST /v1/invitations/accept',
  'GET /v1/assurance/:token',
  'POST /v1/assurance/verify',
  'POST /v1/webhooks/billing',
  'POST /v1/webhooks/observations',
  'POST /v1/webhooks/ping',
  'GET /health/live',
  'GET /health/ready',
  'GET /openapi.json',
  'GET /v1/system/version',
  'GET /',
]);

/**
 * Authenticated routes that disclose nothing about any tenant, MSP or the
 * company — so they belong to no surface and need none.
 *
 * Two kinds only:
 *   - the caller's own identity and their own second factor, and
 *   - static reference data that is identical for every caller: the connector
 *     catalogue, the published rulesets, the graph schema, the price list.
 *
 * Anything that varies by who is asking is not common, and does not belong
 * here.
 */
const COMMON_ROUTES = new Set([
  'GET /v1/auth/me',
  'GET /v1/auth/roles',
  'POST /v1/auth/logout',
  'GET /v1/auth/mfa',
  'POST /v1/auth/mfa/totp',
  'POST /v1/auth/mfa/totp/confirm',
  'DELETE /v1/auth/mfa/totp',
  'GET /v1/capabilities',
  'GET /v1/rulesets',
  'GET /v1/connectors',
  'GET /v1/graph/schema',
  'GET /v1/plans',
]);

/**
 * Routes whose path shape would classify them one way but whose meaning is
 * another. Each is here on purpose.
 */
const OVERRIDES: Record<string, RouteClass> = {
  // Creating a direct (non-MSP) organisation is Veylith taking on a customer.
  // It is company work that happens to be spelled with an Adericel noun.
  'POST /v1/organisations': ['VEYLITH_INTERNAL'],
  // The platform's own liveness detail and queue depth. Knowing how deep
  // Adericel's outbox is tells a customer nothing they are entitled to and
  // tells an attacker something about load.
  'GET /v1/system/health': ['VEYLITH_INTERNAL'],
  'GET /v1/system/outbox': ['VEYLITH_INTERNAL'],
};

const ALL_SURFACES: Surface[] = [...SURFACES];

/**
 * Resolve a route to the surfaces it may be served on.
 *
 * Returns `null` for a path that has not been classified, which the caller must
 * treat as a refusal.
 */
export function classifyRoute(method: string, path: string): RouteClass | null {
  const key = `${method.toUpperCase()} ${path}`;

  const override = OVERRIDES[key];
  if (override) return override;
  if (PUBLIC_ROUTES.has(key)) return 'PUBLIC';
  if (COMMON_ROUTES.has(key)) return 'COMMON';

  // The company's own control room. Platform scope, company facts, no tenants.
  if (path.startsWith('/v1/veylith/')) return ['VEYLITH_INTERNAL'];

  // An MSP's own plane: its roster, its baselines, its commercial position.
  // Invisible to the client organisations underneath it.
  if (path.startsWith('/v1/msps/')) return ['ADERICEL_MSP'];

  // One organisation. Reachable by the MSP that operates it and by the
  // organisation's own staff — the same facts, reached through two different
  // grants, and never spanning more than the one organisation named in the
  // path.
  if (path.startsWith('/v1/organisations/:organisationId')) {
    return ['ADERICEL_MSP', 'ADERICEL_CLIENT'];
  }

  return null;
}

/** The surfaces a route may be served on, or an empty list if it has none. */
export function surfacesForRoute(method: string, path: string): readonly Surface[] {
  const classification = classifyRoute(method, path);
  if (classification === null) return [];
  if (classification === 'PUBLIC') return [];
  if (classification === 'COMMON') return ALL_SURFACES;
  return classification;
}
