# ADR-0010: Distinct temporal dimensions

**Status:** Accepted · **Date:** 2026-09-09

## Context

A single `updated_at` column cannot answer any of the questions this product
exists to answer. "Was this control satisfied in March?" and "when did we find
out it was not?" and "what was our understanding on the day of the incident?"
are three different questions about three different clocks, and collapsing them
loses information that cannot be reconstructed.

There is also a subtler problem specific to PostgreSQL: `now()` returns the
transaction start time. Several rows written inside one transaction share a
timestamp exactly, so ordering by it is arbitrary — and the rows in question are
an action's state transitions, where "arbitrary order" means the history reads
as though execution preceded approval.

## Decision

**Time is modelled as several named dimensions, and ordering is a sequence, not
a timestamp.**

The dimensions, each stored separately where it applies:

| Dimension                         | Meaning                                     |
| --------------------------------- | ------------------------------------------- |
| `observed_at`                     | When the fact was true in the outside world |
| `collected_at`                    | When Adericel obtained it                   |
| `valid_from` / `valid_until`      | The window over which the evidence speaks   |
| `assessed_at`                     | When the Truth Engine evaluated             |
| `recorded_at`                     | When the row was written                    |
| `effective_from` / `effective_to` | The period a state was Adericel's belief    |

`observed_at` and `collected_at` are routinely different — a nightly export
describes yesterday — and treating them as one is how a system reports a
posture it has not actually seen for a week.

**Ordering** on every append-only table (`action_transitions`, `audit_log`,
`event_log`, `outbox_events`, `assessments`) is a `bigserial seq` column, with
`clock_timestamp()` rather than `now()` for the recorded time. `seq` is the sort
key; the timestamp is for humans. Migration `0007_monotonic_ordering.sql`.

**History is not destroyed.** Assurance states are not updated in place; a new
state row closes the previous one's effective period. Asking what Adericel
believed on a date is a query, not an inference.

## Alternatives considered

**A single `updated_at`.** Discussed above. It is the default and it is wrong
for this domain.

**Full bitemporal modelling (valid time × transaction time on every table).**
The academically correct answer, and rejected as disproportionate: it doubles
the temporal columns on tables where only one dimension is ever queried, and the
query complexity lands on every developer forever. The dimensions above are
bitemporal where it matters — evidence validity and assurance state — and simple
elsewhere.

**Event sourcing as the primary model.** Attractive, since the event log already
exists. Rejected because rebuilding current state by replay makes the most
common query — "what is the state now?" — the most expensive one, and because a
schema change then means rewriting a replay function rather than a migration.
The event log is a record, not the source of state.

**`timestamptz` ordering with microsecond precision.** Insufficient: the problem
is not resolution, it is that `now()` is constant within a transaction.

## Consequences

- Every append-only table has a `seq`. Queries order by it; nothing orders by
  time alone.
- Reporting "as at" a past date is supported directly rather than approximated.
- Tables grow. See ADR-0009 and the sizing document; the answer is never to
  prune assessments.
- Developers must choose the right dimension when writing a row. The column
  names are long and explicit for exactly that reason.

## Security implications

An audit log whose ordering is arbitrary is not an audit log. The `seq` column
makes the sequence of events non-repudiable in the ordinary case, and gaps in it
are detectable — a deleted row leaves a hole.

Timestamps supplied by an external integration are recorded as `observed_at` and
are never trusted for ordering. A vendor that reports a future date does not
reorder Adericel's history.

## Operational implications

`bigserial` sequences are not transactional: a rolled-back transaction consumes
values and leaves gaps. Gaps are therefore expected and are not evidence of
deletion on their own; the audit tooling reports them without alarming.

Clock skew on the host affects `clock_timestamp()` but not `seq`. Ordering
survives a badly synchronised server, which is the property that matters.

## Migration implications

Adding a temporal dimension to an existing table means deciding what the value
is for historical rows. In every case so far the answer has been NULL with a
meaning of "not recorded", never a back-filled guess — a fabricated
`observed_at` is worse than an absent one.
