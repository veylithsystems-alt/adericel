# ADR-0008: Identity carries no authority

**Status:** Accepted · **Date:** 2026-09-09

## Context

The brief states the chain that must be verifiable for every operation: who →
authenticated as → authorised for → which organisation → which resource → which
operation → under which policy. Most systems collapse this into two steps —
authenticate, then check a role — and lose the middle, which is where
multi-tenancy lives.

The specific failure to avoid: a token that says `organisation: acme` and an
application that believes it.

## Decision

**A token proves identity. It grants nothing.**

An Adericel access token carries the principal's id, its type (user, service,
API key) and its session. It carries **no organisation, no MSP, and no role**.
Everything that determines authority is loaded from the database at the moment
of the request and evaluated against the resource actually being addressed
(`apps/api/src/middleware/request-context.ts`).

The sequence for every tenant-scoped request:

1. Verify the token's signature, algorithm, issuer, audience and expiry.
2. Load the principal and confirm the session is live and not revoked.
3. Read the organisation id **from the route**, and load that organisation's
   ownership (which MSP owns it) from the database.
4. Load the principal's grants and evaluate them against that ownership.
5. Check the specific permission for the operation (`authorise()` in
   `packages/domain/src/authz.ts`).
6. Open a transaction, set the tenancy GUCs, and only then touch data.

A failure at step 4 or 5 is written to the audit log against the organisation
the caller _attempted_ to reach, so an attempt is recorded even though nothing
was returned.

JWT verification is implemented directly (`packages/shared/src/crypto.ts`) with
HS256 asserted rather than read from the token header, and with constant-time
signature comparison. The `alg: none` and algorithm-confusion families are not
mitigated; they are unrepresentable.

## Alternatives considered

**Claims in the token (organisation, roles, permissions).** Standard, fast,
avoids a database read per request. Rejected: it makes revocation take until
token expiry, it makes a stolen token portable across tenants for its lifetime,
and it puts the authorisation decision in a place the server does not control at
the moment it matters. The saved round trip is not worth any of that.

**OAuth 2.0 / OIDC with an external provider as the only path.** Correct for
enterprise SSO and planned as an additional authentication method. Rejected as
the _only_ method because an MSP onboarding its first three staff should not
need an identity provider, and because federated identity still only answers
"who", leaving this ADR's actual subject untouched.

**RBAC alone.** Roles are necessary and not sufficient: `ORG_APPROVER` is a role,
but whether this approver may approve _this_ action also depends on who proposed
it (ADR-0015). Permissions are therefore checked against the resource, not just
the principal.

## Consequences

- One or two extra queries per request. Measured at well under a millisecond
  locally, and it buys immediate revocation and no portable authority.
- Roles are permission sets, deliberately not hierarchical. `ORG_APPROVER` holds
  `org:action:approve` and specifically **not** `org:action:propose`: separation
  of duty is expressed by roles that do not contain each other rather than by a
  ladder where the top role can do everything.
- `ORG_ANALYST` holds `org:action:execute`. Executing an already-approved action
  adds no authority beyond the approval that authorised it, and requiring an
  approver to also be present to press the button produces exactly one outcome:
  approvers who press the button, which defeats four-eyes.
- Session refresh rotates the refresh token on use, so replay of a captured
  refresh token invalidates the legitimate session and is visible.

## Security implications

Failed authentication returns an identical response for unknown email, wrong
password and locked account, after the same amount of work, so the endpoint does
not enumerate accounts. Lockout is recorded per credential with an explicit
`locked_until`, and the SQL is written so a failed attempt cannot accidentally
extend or clear an existing lock.

Passwords are hashed with a per-credential salt and an optional deployment-wide
pepper held outside the database (`AUTH_PASSWORD_PEPPER`), so a database-only
disclosure is not sufficient for offline cracking.

## Operational implications

Access tokens are short (one hour by default) and refresh tokens long (fourteen
days). Because authority is resolved per request, shortening the access token
further buys very little — revoking a grant already takes effect immediately.

## Migration implications

Adding an authentication method (OIDC, SAML, passkeys) affects step 1 only.
Steps 2 to 6 are unchanged, which is the point of keeping authority out of the
token.
