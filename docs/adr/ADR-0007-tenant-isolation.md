# ADR-0007: Defence-in-depth tenant isolation

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel is multi-tenant in two dimensions at once. An MSP is an **operator**
boundary: its staff act across many organisations. An organisation is a **data**
boundary: its assurance data must never be visible to another organisation, and
usually not to another MSP's staff either.

A cross-tenant read or write is not a bug in this product. It is a critical
security failure, and the kind that is discovered by a customer rather than by a
test.

The common implementation — every query carries `WHERE organisation_id = $1`,
sourced from a request parameter — fails in two ways. It trusts the caller to
name their own tenant, and it fails open: the one query that forgets the clause
returns everything.

## Decision

**Three independent layers, each of which must fail before data crosses a
boundary.**

**Layer 1 — Authorisation resolves the tenant; the caller never asserts it.**
`requireOrganisation()` (`apps/api/src/middleware/request-context.ts`) takes the
organisation id from the route, loads its ownership from the database, and
evaluates the authenticated principal's grants against it. A caller-provided
tenant id is treated as a _request_, never as a fact. A principal with no grant
covering that organisation gets a denial that is written to the audit log
against the candidate organisation, so an attempt is visible even though the
access was not.

**Layer 2 — Row-level security in PostgreSQL, with `FORCE`.**
Migration `0006_row_level_security.sql` enables `ROW LEVEL SECURITY` and
`FORCE ROW LEVEL SECURITY` on every tenant table. `FORCE` matters: without it,
the table owner bypasses the policy, and the table owner is exactly who runs
migrations. Policies are expressed through `adericel.tenant_visible()`, which
reads transaction-local settings (`adericel.organisation_id`,
`adericel.scope`) set with `SET LOCAL` inside the transaction that the
authorisation layer opened.

The application connects as a role that is **not** the owner of the tables,
specifically so that the policy applies to it.

**Layer 3 — Fail closed.** With no GUC set, `tenant_visible()` returns false and
every tenant table returns zero rows. A query issued outside the tenancy
middleware does not leak; it returns nothing, which is loud enough to find in
development and harmless in production.

## Alternatives considered

**A database per tenant.** The strongest isolation available, and the reason it
was rejected is MSP portfolio intelligence: "show me every organisation in your
portfolio with an unknown backup control" becomes a fan-out across hundreds of
connections. It also makes migrations an N-way operation with partial-failure
states. Reconsider at the point where a single tenant's regulatory position
demands physical separation — the architecture does not prevent it for that
tenant.

**A schema per tenant.** Most of the operational cost of a database per tenant
with materially weaker isolation, since `search_path` manipulation is a
one-mistake bypass.

**Application-level filtering only.** The industry default and the source of
most cross-tenant incidents. Rejected because it fails open.

**RLS only, without the application layer.** Rejected because RLS answers "may
this connection see this row?" and not "should this principal be acting in this
organisation at all?" — and because a single point of enforcement is a single
point of failure. The brief is explicit that RLS is one layer, not the strategy.

## Consequences

- Every tenant-scoped query runs inside a transaction that sets the GUCs. This
  is enforced by the repository layer, not by convention.
- There is a measurable cost: an extra round trip per request for the ownership
  load, and policy evaluation per row. Both are small next to a network hop and
  are accepted without argument.
- The `tests/tenancy` suite is a first-class deliverable. Thirteen tests assert
  that isolation holds for reads, writes, aggregates, traversals, and the outbox
  — and that it still holds when the application layer is deliberately bypassed.

## Security implications

The MSP dimension is where this gets subtle. An MSP operator legitimately reads
across organisations, so the scope GUC admits an MSP scope. That widening is
bounded by the MSP's own ownership set, loaded from the database, and it is the
part of the model that most repays review. It is tested directly: an MSP
principal must not reach an organisation owned by a different MSP.

## Operational implications

`DATABASE_APPLICATION_ROLE` must not be the table owner. A deployment that
points the application at the owner role silently loses layer 2 while every test
still passes, because the application layer is intact. The migration creates the
role and the runbook says so.

## Migration implications

New tenant tables must enable RLS and `FORCE` in the same migration that creates
them. A test asserts that every table carrying an `organisation_id` column has a
policy, so a forgotten table fails CI rather than production.
