# ADR-0011: Transactional outbox for domain events

**Status:** Accepted · **Date:** 2026-09-09

## Context

Things happen in Adericel that other things must react to: an assessment
changes state, so a finding opens; evidence expires, so a control becomes
UNKNOWN; an action is approved, so it becomes executable. Those reactions run
outside the request — in the worker, or in n8n.

The naïve implementation writes the state change to PostgreSQL and then
publishes an event to a broker. Between those two operations there is a window,
and the window has two failure modes: the state changed but no event was
published (the reaction never happens, silently), or the event was published and
the transaction rolled back (a reaction to something that did not occur).

For a product whose subject is remediation of security findings, "an approved
action was executed twice" and "an approved action was never executed" are both
serious.

## Decision

**Events are rows in `outbox_events`, written in the same transaction as the
state change they describe.**

There is no publish step in the request path. The state change and the intent to
notify commit together or not at all — the guarantee is atomic by construction
rather than by retry logic.

A worker (`apps/worker/src/dispatcher.ts`) claims batches with:

```sql
SELECT ... FROM outbox_events
 WHERE status = 'PENDING' AND available_at <= clock_timestamp()
 ORDER BY seq
 FOR UPDATE SKIP LOCKED
 LIMIT $1
```

`SKIP LOCKED` means several worker replicas can run concurrently without
coordination and without processing the same event twice. Delivery is retried
with exponential backoff up to `WORKER_MAX_DELIVERY_ATTEMPTS`, after which the
event moves to a dead-letter state — visible, replayable, and never discarded.

Delivery is **at least once**. Consumers are idempotent (ADR-0016); this is
stated as a contract rather than hoped for.

## Alternatives considered

**Redis, RabbitMQ or Kafka as the event bus.** Every one of them reintroduces
the dual-write problem this decision exists to remove. Kafka's transactions do
not span PostgreSQL. Rejected on correctness, not on operational weight —
though the operational weight also matters on a single VPS.

**PostgreSQL `LISTEN`/`NOTIFY`.** Attractive: no polling, no extra table. Fatal
flaw: notifications are not durable. A worker that is restarting when the
notification fires never learns about it, and nothing records that it missed
one. Used as an _optimisation_ to wake the poller early would be defensible;
used as the delivery mechanism it is not.

**Change data capture from the write-ahead log.** Genuinely elegant and gives
the same atomicity for free. Rejected for operational cost — a replication slot,
a CDC process, and a failure mode where an unconsumed slot fills the disk and
takes the database down. Wrong shape for a product that starts on one small
machine.

**Polling the domain tables directly for changes.** Requires every table to
carry dispatch state and makes "what happened" a diff rather than a fact.

## Consequences

- Latency is bounded by the poll interval (one second by default), not by a
  broker's push. For assurance workloads this is irrelevant; for anything
  interactive it would not be.
- `outbox_events` is a hot table with high churn. Completed rows are pruned on a
  retention window; the durable record of what happened is `event_log`, which is
  not pruned.
- Ordering is per-`seq`, which is global rather than per-aggregate. Strict
  per-entity ordering, if it is ever needed, is a partition key on the claim
  query — not a redesign.
- The worker is the only component that talks to n8n. n8n never reads the
  database.

## Security implications

Events carry organisation ids and are themselves tenant data: `outbox_events`
and `event_log` are covered by row-level security like everything else, and the
tenancy suite asserts it. An event payload contains identifiers and state
transitions, never credentials and never evidence bytes — a webhook delivery
that goes to the wrong endpoint discloses that something changed, not what it
was.

Outbound webhook deliveries are signed (HMAC-SHA256 over `timestamp.body`) and
carry a timestamp that the receiver checks, so a captured delivery cannot be
replayed indefinitely.

## Operational implications

Dead-lettered events are the primary operational signal that something is wrong
downstream. They are surfaced in the platform health view rather than only in
logs, and there is a recovery workflow in the n8n export that replays them
under an operator's control rather than automatically.

## Migration implications

Adding an event type is additive; consumers ignore what they do not recognise.
Changing an existing event's payload shape requires a new type, because
undelivered rows of the old shape may be in flight during the deployment.
