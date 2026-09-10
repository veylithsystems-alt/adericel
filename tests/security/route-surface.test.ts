import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every route, accounted for.
 *
 * Authentication that is applied route by route is authentication that gets
 * forgotten route by route. Reading the files by eye finds the ones you look
 * at; this finds the one added at half past five on a Friday.
 *
 * A route is acceptable only if it declares an authentication hook, or is named
 * here as deliberately public. The allowlist is the point: making a route
 * public becomes an edit to a security test rather than an omission.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ROUTES = join(ROOT, 'apps', 'api', 'src', 'routes');

/**
 * Routes that must work without a session, each with the reason.
 *
 * Every one of these is a place an unauthenticated caller reaches, so each is
 * also a place that needs its own rate limit and its own care with what it
 * discloses.
 */
const DELIBERATELY_PUBLIC: Record<string, string> = {
  'POST /v1/auth/login': 'You cannot sign in with a session you do not have yet.',
  'POST /v1/auth/mfa/verify': 'The second step of signing in.',
  'POST /v1/auth/refresh': 'Exchanges a refresh token, which is the credential.',
  'POST /v1/signup': 'Self-serve signup, by design (§15 of the product brief).',
  'POST /v1/signup/complete': 'Completes signup from an emailed token.',
  'POST /v1/invitations/accept': 'Accepted from an emailed token by someone with no account.',
  'GET /v1/assurance/:token': 'A shared Assurance Passport. The token is the credential.',
  'POST /v1/assurance/verify': 'Lets a third party verify a passport hash they hold.',
  // The webhook routes carry no session and are not unauthenticated: each
  // verifies a signature over the raw body before it does anything. Session
  // authentication would be the wrong mechanism — the caller is a machine that
  // has no account here.
  'POST /v1/webhooks/billing': 'Signed by the payment provider; verified over the raw body.',
  'POST /v1/webhooks/observations':
    'Signed by the pushing system; verified before the body is parsed.',
  'POST /v1/webhooks/ping': 'Signed like the others; lets an integrator prove connectivity.',
  'GET /health/live': 'Liveness. Must answer before anything else in the process works.',
  'GET /health/ready': 'Readiness, including dependencies. Same reason as liveness.',
  'GET /openapi.json': 'The API description is public, and describing it discloses nothing.',
  'GET /v1/system/version': 'Build identity, needed for support and incident response.',
  'GET /': 'A service banner naming the product and pointing at the documentation.',
};

/**
 * Routes whose caller is a machine proving itself with a signature rather than
 * a session. They must verify that signature before parsing anything.
 */
const SIGNATURE_VERIFIED = [
  'POST /v1/webhooks/billing',
  'POST /v1/webhooks/observations',
  'POST /v1/webhooks/ping',
];

interface Route {
  readonly method: string;
  readonly path: string;
  readonly authenticated: boolean;
  readonly file: string;
}

/** Parse the route registrations out of a source file. */
function routesIn(file: string): Route[] {
  const source = readFileSync(join(ROUTES, file), 'utf8');
  const found: Route[] = [];
  const pattern = /server\.(get|post|put|patch|delete)\(\s*([\s\S]{0,400}?)\)\s*,?\s*async|server\.(get|post|put|patch|delete)\(\s*([\s\S]{0,400}?)=>/g;

  // Simpler and more reliable: find each registration and read the next 400
  // characters, which comfortably covers the path and the options object.
  const registration = /server\.(get|post|put|patch|delete)\(/g;
  let match: RegExpExecArray | null;
  while ((match = registration.exec(source)) !== null) {
    const window = source.slice(match.index, match.index + 400);
    const path = /['"`](\/[^'"`]*)['"`]/.exec(window)?.[1];
    if (!path) continue;
    found.push({
      method: match[1]!.toUpperCase(),
      path,
      authenticated: /preHandler:\s*(server\.authenticate|\[[^\]]*server\.authenticate)/.test(window),
      file,
    });
  }
  void pattern;
  return found;
}

function allRoutes(): Route[] {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const appFile = readFileSync(join(ROOT, 'apps', 'api', 'src', 'app.ts'), 'utf8');
  const fromApp: Route[] = [];
  const registration = /server\.(get|post|put|patch|delete)\(/g;
  let match: RegExpExecArray | null;
  while ((match = registration.exec(appFile)) !== null) {
    const window = appFile.slice(match.index, match.index + 400);
    const path = /['"`](\/[^'"`]*)['"`]/.exec(window)?.[1];
    if (!path) continue;
    fromApp.push({
      method: match[1]!.toUpperCase(),
      path,
      authenticated: /preHandler:\s*(server\.authenticate|\[[^\]]*server\.authenticate)/.test(window),
      file: 'app.ts',
    });
  }
  return [...files.flatMap(routesIn), ...fromApp];
}

const routes = allRoutes();

describe('the API surface', () => {
  it('finds a plausible number of routes, so a parsing failure cannot pass silently', () => {
    // Without this, a regex that matched nothing would make every other test
    // in this file vacuously true.
    expect(routes.length).toBeGreaterThan(40);
  });

  it('authenticates every route that is not deliberately public', () => {
    const unprotected = routes
      .filter((route) => !route.authenticated)
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => DELIBERATELY_PUBLIC[key] === undefined);

    expect([...new Set(unprotected)].sort()).toEqual([]);
  });

  it('keeps the public allowlist honest', () => {
    // An entry left behind after a route is protected or removed makes the
    // allowlist look larger than the real attack surface.
    const actual = new Set(
      routes.filter((r) => !r.authenticated).map((r) => `${r.method} ${r.path}`),
    );
    const stale = Object.keys(DELIBERATELY_PUBLIC).filter((key) => !actual.has(key));
    expect(stale).toEqual([]);
  });

  it('gives every public route a stated reason', () => {
    for (const [route, reason] of Object.entries(DELIBERATELY_PUBLIC)) {
      expect(reason.length, route).toBeGreaterThan(20);
    }
  });

  it('verifies a signature on every machine-called route', () => {
    // These have no session, so the signature is the whole of their
    // authentication. One that parsed first and verified later would be
    // processing attacker-supplied structure before establishing who sent it.
    const sources = readdirSync(ROUTES)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(ROUTES, f), 'utf8'))
      .join('\n');
    for (const route of SIGNATURE_VERIFIED) {
      const path = route.split(' ')[1]!;
      const escaped = path.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
      const window = new RegExp(`['"\`]${escaped}['"\`][\\s\\S]{0,900}`).exec(sources)?.[0] ?? '';
      expect(/verifySignature|stripe-signature|constructEvent|timingSafeEqual/.test(window), route)
        .toBe(true);
    }
  });

  it('applies a rate limit to every route through a global plugin', () => {
    // Registered as a plugin rather than per route. Per-route limits are a
    // tightening on top; relying on them alone would mean a new route is
    // unlimited until somebody remembers.
    const app = readFileSync(join(ROOT, 'apps', 'api', 'src', 'app.ts'), 'utf8');
    expect(app).toMatch(/server\.register\(rateLimit/);
    // Keyed by principal rather than address, so several engineers behind one
    // office address do not exhaust each other's budget.
    expect(app).toMatch(/keyGenerator/);
  });

  it('locks the account out on repeated credential failures', () => {
    // A rate limit keyed by principal cannot protect the login route, because
    // an unauthenticated caller has no principal and falls back to their
    // address — which an attacker can change. Password guessing needs a
    // per-account counter, and this is it.
    const auth = readFileSync(join(ROUTES, 'auth.ts'), 'utf8');
    expect(auth).toMatch(/failed_attempts/);
    expect(auth).toMatch(/locked_until/);
    expect(auth).toMatch(/MAX_FAILED_ATTEMPTS/);
    // The same applies to the second factor: unlimited guesses at a six-digit
    // code is not a second factor.
    expect(auth).toMatch(/MFA_MAX_ATTEMPTS/);
  });

  it('gives the hot public routes their own tighter limit', () => {
    const sources = readdirSync(ROUTES)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(ROUTES, f), 'utf8'))
      .join('\n');
    // Signup, passport resolution and webhooks are the routes an attacker
    // probes first, and the ones where the global budget is too generous.
    for (const helper of ['signupLimit', 'publicLimit', 'webhookLimit', 'webhookRateLimit']) {
      expect(sources, helper).toContain(helper);
    }
  });
});

describe('tenant-scoped routes', () => {
  it('checks an organisation permission on every organisation route', () => {
    // A route that reads :organisationId from the path and never calls
    // requireOrganisation trusts a caller-supplied tenant id, which is the
    // single most damaging mistake available in this codebase.
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(ROUTES, file), 'utf8');
      const registration = /server\.(get|post|put|patch|delete)\(/g;
      let match: RegExpExecArray | null;
      while ((match = registration.exec(source)) !== null) {
        // The handler body, up to the next registration or the end.
        const rest = source.slice(match.index);
        const nextIndex = rest.slice(1).search(/\n {2}server\.(get|post|put|patch|delete)\(/);
        const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex + 1);
        const path = /['"`](\/[^'"`]*)['"`]/.exec(body)?.[1] ?? '';
        if (!path.includes(':organisationId')) continue;

        // Two acceptable patterns, and no third.
        //
        // Either the route resolves the organisation directly through
        // requireOrganisation, or it is scoped to an MSP and proves the
        // organisation belongs to that MSP before touching it. The second is
        // legitimate — an MSP reading one of its own customers — but only when
        // the ownership check is actually there. `requireMsp` alone would let a
        // caller pass any organisation id at all.
        const viaOrganisation = /requireOrganisation\(/.test(body);
        const viaMspOwnership =
          /requireMsp\(/.test(body) && /\bmsp_id\s*=\s*\$\d/.test(body);

        if (!viaOrganisation && !viaMspOwnership) {
          offenders.push(`${match[1]!.toUpperCase()} ${path} (${file})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('checks a platform permission on every company route', () => {
    const source = readFileSync(join(ROUTES, 'veylith.ts'), 'utf8');
    const registration = /server\.(get|post|put|patch|delete)\(/g;
    const offenders: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = registration.exec(source)) !== null) {
      const rest = source.slice(match.index);
      const nextIndex = rest.slice(1).search(/\n {2}server\.(get|post|put|patch|delete)\(/);
      const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex + 1);
      const path = /['"`](\/[^'"`]*)['"`]/.exec(body)?.[1] ?? '';
      if (!/requirePlatform\(/.test(body)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
