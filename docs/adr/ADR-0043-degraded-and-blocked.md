# ADR-0043: A broken source is not an unknown

**Status:** Accepted · **Date:** 2026-09-15 · **Extends:** ADR-0003

## Context

Contract v3.1 §6 requires Adericel to distinguish `DEGRADED` and `BLOCKED` from
`UNKNOWN`, and states that these semantic distinctions must not be collapsed for
convenience.

They were collapsed. A connector that had started failing produced `UNKNOWN`
with reason `COLLECTION_FAILED`. That was honest — Adericel genuinely could not
say — but on a portfolio view it was indistinguishable from a control nobody had
ever assessed.

The difference is operational, and it is the whole reason the contract names it:

| State      | What it means                                               | Who fixes it                           |
| ---------- | ----------------------------------------------------------- | -------------------------------------- |
| `UNKNOWN`  | Adericel holds insufficient evidence                        | Connect a source; talk to the customer |
| `DEGRADED` | The mechanism that supplied the evidence has broken         | An engineer, with a ticket             |
| `BLOCKED`  | Adericel is not permitted, or is waiting on somebody who is | A person with authority                |

For an MSP running a hundred customers that is the difference between a
conversation with a client and a ticket for their own team. Collapsing the three
costs them the ability to tell which they are looking at.

## Decision

**`DEGRADED` and `BLOCKED` become assurance states, and impairment enters the
Truth Engine as input.**

1. **Two new states**, peers of `UNKNOWN` rather than reasons underneath it.
2. **Two new reason vocabularies.** `DEGRADED_REASONS` name a repair
   (`CREDENTIAL_EXPIRED`, `SCHEMA_DRIFT`, …). `BLOCKED_REASONS` name a person
   (`AUTHORITY_MISSING`, `CONSENT_REQUIRED`, `CONTAINED`, …). No code appears in
   both, and a test enforces that.
3. **Impairment is an engine input**, carried in the input digest.
4. **Impairment may only downgrade `UNKNOWN`.** It never touches a determinate
   state.
5. **`isUnsubstantiated()`** joins `isUnknown()` as the predicate callers should
   reach for.
6. **Coverage counts impaired controls against it**, exactly as unknowns are.

## Why impairment is an input rather than a lookup

The engine performs no I/O, reads no clock and holds no state (ADR-0002). It
cannot ask whether a connector is healthy, and it must not: a function that
consults live health is not replayable, and replay is the property that lets
Adericel reconstruct what it believed on a past date.

So impairment arrives the way every other fact about the world arrives — as
data, inside the digest. Re-running a historical assessment reproduces the state
Adericel reported at the time, _including that a source was broken then_, rather
than silently re-deciding it against today's health.

It is in the digest because it changes the answer. Two assessments with
different states sharing an input digest is the one thing the digest exists to
prevent.

## Why impairment may only downgrade UNKNOWN

The tempting alternative is to mark a control `DEGRADED` whenever its connector
is unhealthy, including when the control currently reads `SATISFIED`.

That is wrong, and wrong in the direction that matters. The control _is_
satisfied on the evidence held. Reporting otherwise would make a fault in
Adericel look like a finding about the customer.

Evidence that has actually gone stale because collection stopped is already
handled upstream: the claim becomes ineligible, the control falls to `UNKNOWN`
on its own, and only then can this honestly call it `DEGRADED`. A broken
connector therefore surfaces here once it has actually cost Adericel the ability
to determine something. Until then it surfaces in connector health and the
coverage ladder, which is where it belongs.

## A test that proved nothing

The first version of the safety suite asserted the rule against `SATISFIED` and
`NOT_SATISFIED` only. Both have no missing predicates, so `applyImpairment`
returned on its "nothing relevant is impaired" branch and the guard was never
reached. **Deleting the guard broke no test.** A green suite that survived
removal of the property it claimed to protect — precisely what v3.1 §35 calls
inadequate.

The case that bites is a determination that _also_ carries missing predicates:
one account demonstrably without MFA, another unreadable because the connector
broke half way through. The control genuinely fails. Without the guard the
impairment rewrites that failure into `DEGRADED`, reporting a collection fault
and **hiding an account that really is unprotected**.

That is now the test, and removing the guard fails exactly it.

## Consequences

**Positive.** An MSP can tell "we cannot see this" from "this is broken" from
"we are not allowed to look", and route each to the right person.

**Positive.** `CONTAINED` exists as a blocked reason ahead of the containment
work, so a contained estate will report that it was deliberately not assessed
rather than quietly reading `UNKNOWN` as though nobody had looked.

**Positive, and unplanned.** Widening the enum made two exhaustive switches fail
to compile, which is exactly what should happen. The type system named both.

**Negative.** Seven call sites compared `state === 'UNKNOWN'` to mean "not
substantiated". Each would have silently treated the new states as substantiated
— a failure that produces a _more confident_ answer rather than an error, and so
would not have announced itself. All seven were found and moved to
`isUnsubstantiated`; the same hazard applies to any future call site, which is
why the predicate is documented rather than left to judgement.

**Negative.** Coverage figures fall where sources are impaired. That is correct
— a control Adericel is not permitted to assess is not covered, however good the
reason — but it means a containment event will visibly reduce coverage, and
nobody should be surprised by it.

**Migration.** Historical rows keep their `UNKNOWN` state and their existing
reason untouched. A past assessment recorded what Adericel believed at the time,
and rewriting it to match a later vocabulary would falsify the historical record
this product exists to keep.

## Alternatives considered

**Keep them as UNKNOWN reasons.** Cheapest, and what the code already did.
Rejected: v3.1 §6 is explicit, and reason codes are not surfaced in aggregation,
so a portfolio view would still show one undifferentiated block of unknown.

**Derive DEGRADED in the assessment service, after the engine.** Avoids touching
the protected core. Rejected: it makes the state a presentation concern decided
outside the Truth Engine, and the assessment stored in history would not match
what the engine produced.

**A separate `health` field alongside `state`.** Rejected: two fields describing
one thing is how they drift, and every consumer would have to remember to read
both. The one that forgot would report a satisfied control.
