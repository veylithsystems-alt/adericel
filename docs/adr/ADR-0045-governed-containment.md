# ADR-0045: Containment stops Adericel, not the customer

**Status:** Accepted · **Date:** 2026-09-16

## Context

Contract v3.1 §15 requires governed containment: a controlled security state
transition that limits harm while preserving evidence, attribution and a route
back. None existed. A compromised credential was handled with database access
under time pressure, unattributed — which is the "permanent hidden
administrator path" §28 forbids, arrived at by omission rather than design.

## Decision

**Six levels, three actors, one invariant.**

| Level | Name                | Adericel observes | Adericel acts | Customer writes |
| ----- | ------------------- | ----------------- | ------------- | --------------- |
| C0    | Observe only        | yes               | yes           | yes             |
| C1    | Restrict automation | **yes**           | no            | yes             |
| C2    | Isolate integration | no                | no            | yes             |
| C3    | Restrict operations | no                | no            | **no**          |
| C4    | Emergency           | no                | no            | no              |
| C5    | Platform protective | no                | no            | no              |

Authority is earned per level, as autonomy is:

- **AUTOMATIC** reaches C2 — enough to stop using a compromised credential, not
  enough to restrict a customer.
- **MSP** reaches C3 over its own customers. It owns that relationship and will
  be awake before Veylith is.
- **VEYLITH** reaches C5, over anything. C4 and C5 stop every estate and are not
  one partner's to declare.

## The invariant

**No level withholds an organisation's own assurance record. At any severity.**

Containment exists to stop Adericel doing things, not to stop customers knowing
things. An organisation locked out of its own record during an incident is an
organisation that cannot respond to it — and §16 is explicit that a failing
control is never a reason to deny access to evidence.

There is deliberately no column, flag or level that could switch this off. A
test asserts it across the whole level set, so a seventh level cannot be added
with it false for a good-sounding reason.

## Three axes that must not collapse

| Axis        | Question               | Where it lives           |
| ----------- | ---------------------- | ------------------------ |
| Commercial  | Has the MSP paid?      | `subscriptions.status`   |
| Containment | Is it safe to operate? | `*.containment_level`    |
| Assurance   | Is the control met?    | `assurance_states.state` |

Separate columns on separate tables, on purpose. `organisations.status` already
carries commercial meaning — which is exactly why containment does **not** reuse
it. Non-payment is never a containment; a containment is never a termination.

## Automation may enter containment and may never leave it

A system able to release its own restriction does not have containment; it has a
pause.

Automation may apply C1 and C2 on unambiguous, cheaply-reversible signals — a
credential in a public paste, a connector reaching outside its scope. It may
lift nothing, at any level, ever. And every automatic containment is flagged for
human review even when it was correct, because unreviewed automatic restriction
is how a system quietly develops a habit nobody chose.

## Recovery is harder than containment

Deliberately the opposite of how most systems behave, which make it easy to undo
an inconvenient restriction.

Containment is a judgement made under pressure with incomplete information.
Recovery is a claim that the cause is genuinely dealt with, recorded
permanently. It is refused without: findings somebody could defend in a review,
**re-observation** showing the trigger condition is clear, confirmation that
evidence from the containment period survived, and — for an accepted risk — the
name of the person accepting it. An accepted risk with no owner is an unresolved
risk somebody stopped talking about.

Recovery from C3 or above returns to C1, never straight to normal. Observation
resumes and automation stays off, so the estate is watched running before
Adericel is trusted to act on it again.

## What containment does to assurance

A contained estate reports **BLOCKED / CONTAINED**, not UNKNOWN.

Left alone, controls decay to UNKNOWN when collection stops — true, and deeply
misleading, because UNKNOWN reads as "nobody looked". Somebody looked, decided
it was not safe to keep looking, and wrote down why. An MSP scanning their
portfolio sees a deliberate decision rather than a customer who appears to have
quietly stopped being monitored.

C0 and C1 impair nothing: C1 stops Adericel _acting_ while keeping it
_watching_, so marking controls BLOCKED there would report a loss of assurance
that has not happened.

## Two faults found by building it

**The append-only trigger was never attached, and depended on an extension that
is not installed.** The first version used `hstore` to compare rows, and created
the function without a `CREATE TRIGGER`. Two faults hiding each other: the
function would have failed the moment it ran, and it never ran. Columns are now
compared explicitly — slower to write, impossible to be wrong about quietly —
and the trigger is attached and tested against a live database.

**C4 and C5 were defined and unreachable.** Veylith holds no standing authority
over an individual organisation (§29), so the organisation-scoped route
correctly refused platform operators — leaving the two highest levels with no
route that could apply them. A containment ceiling nobody can reach is not a
ceiling. `/v1/system/containment` exists because an e2e test went looking for
the path and there was none.

## Consequences

**Positive.** An incident now has a procedure, an authority model and a record,
instead of a database client and somebody's memory.

**Positive.** The history is append-only in the database, not by convention. A
platform administrator cannot rewrite it; the only permitted update is recording
that a person reviewed an automatic decision, and a review cannot be un-recorded.

**Negative.** Containment reduces coverage, visibly. A contained estate reports
BLOCKED controls and its coverage figure falls. That is correct — a control
Adericel is not permitted to assess is not covered — but an MSP will see it on
their portfolio and should not be surprised.

**Negative, and honest.** Nothing yet _raises_ an automatic containment. The
triggers, levels and authority exist and are tested; the detectors that would
fire them — credential-compromise detection, scope-anomaly detection — do not.
Containment today is a capability an operator uses deliberately, which is the
right order to build it in, but it is not yet autonomous and nothing should say
it is.

## Alternatives considered

**Reuse `organisations.status = 'SUSPENDED'`.** No schema change, and it
collapses commercial and security into one field — the exact failure §16 names.
Rejected.

**Let automation reach C3 on high-confidence triggers.** Faster response to
serious events. Rejected: C3 restricts what a customer can do, and a false
positive there is an outage Adericel caused to somebody who did nothing wrong.
Automation raises the signal; a person applies the restriction.

**Allow automatic recovery from C1 after a cooling period.** Attractive for
transient faults. Rejected: it makes containment a pause, and a system that can
quietly release its own restriction will eventually release one that mattered.
