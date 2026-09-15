# ADR-0006: PostgreSQL as the single primary store

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel holds a graph (organisations, assets, identities, controls and the
relationships between them), an append-only event history, evidence metadata,
assessment results, and an audit log. Those have genuinely different access
shapes, and the standard answer is a store for each: a graph database for
traversal, a queue for events, a document store for evidence, a time-series
store for history.

That answer produces a system where a single logical write spans four stores
with no shared transaction, and where "was the event published if and only if
the state changed?" has no correct answer.

## Decision

**One PostgreSQL 16 instance is the primary store for everything.** Object bytes
(evidence files) live in S3-compatible storage; every other durable fact is a
PostgreSQL row.

Specifically:

- The assurance graph is nodes and edges in relational tables, traversed with
  recursive CTEs (`packages/graph/src/traversal.ts`).
- Domain events are rows in `outbox_events`, written in the same transaction as
  the state change they describe (ADR-0011).
- Tenant isolation is enforced by row-level security in the same database that
  holds the data (ADR-0007).
- Evidence records, assessments, actions and the audit log are ordinary tables
  with `bigserial` sequence columns for total ordering (ADR-0010).

## Alternatives considered

**Neo4j or another graph database for the OAG.** The traversals Adericel
performs are shallow — an organisation to its assets to their controls, or a
control back to the evidence supporting it. They are two to four hops with
tenant filtering, which is exactly the shape a relational database with the
right indexes handles well. A dedicated graph store would add a second
consistency boundary and a second tenant-isolation mechanism to get right, for a
traversal depth that never justified it.

**Redis or a broker for events.** Rejected because it makes the outbox
impossible: if the event goes to Redis and the state change goes to PostgreSQL,
there is a window where one exists and the other does not, and it is the window
in which an approval gets executed twice or not at all. See ADR-0011.

**A document store for evidence metadata.** Evidence has a strict shape with
foreign keys into the graph and into policy. Relaxing that buys flexibility
nobody asked for and loses referential integrity that catches real bugs.

## Consequences

- Any state change and its consequences can be made atomic. This is the single
  most valuable property in the system.
- Backup is one `pg_dump` plus an object-store sync, not four coordinated
  snapshots that cannot be made mutually consistent.
- Operational burden is one database to tune, monitor and secure — decisive for
  a product that starts on one small VPS (`docs/operations/vps-sizing.md`).
- PostgreSQL becomes a single point of failure. Accepted knowingly: it is
  cheaper to make one well-understood database highly available later than to
  make four stores consistent now.
- Very deep graph traversal would be slow. Not a use case Adericel has; if it
  becomes one, that is a reason to reconsider, and the ADR should be superseded
  rather than worked around.

## Security implications

One store means one place where tenant isolation must be correct, and it can be
enforced by the database itself rather than by every caller remembering to.
Row-level security with `FORCE` applies to a query no matter which code path
issued it — a guarantee no application-level scheme provides.

## Operational implications

PostgreSQL 16 is the floor: the deployment relies on `FORCE ROW LEVEL SECURITY`,
`gen_random_uuid()` without an extension, and `SET LOCAL` behaviour that the
tenancy layer depends on. Connection pooling is bounded per service
(`DATABASE_POOL_MAX`) because `work_mem` is per operation, not per server.

## Migration implications

Splitting a component out later is possible in this direction and not the other:
extracting evidence metadata to its own store is a bounded change, whereas
merging four stores into one is a rewrite. Starting merged keeps that option
open.
