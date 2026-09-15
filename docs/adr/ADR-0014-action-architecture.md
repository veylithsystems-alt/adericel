# ADR-0014: Explicit action lifecycle with mandatory verification

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel does not only observe; it changes things — disabling a stale
privileged account, enforcing multi-factor authentication on a group, revoking a
legacy authentication protocol. These are operations on a customer's production
identity and endpoint estate, performed by software, on behalf of an MSP.

Two failure modes are unacceptable. The first is "the model suggested it, so it
happened". The second is quieter and more common: the action ran, the API
returned 200, and the system reported success — without ever checking whether
the world actually changed. A remediation that reports success it has not
verified is worse than no remediation, because it closes the finding.

## Decision

**An action moves through an explicit state machine, and `EXECUTED` is not a
success state.**

```
PROPOSED → APPROVED → EXECUTING → EXECUTED → VERIFYING → CONFIRMED
    ↓          ↓          ↓                      ↓
 REJECTED  CANCELLED   FAILED          UNVERIFIED · ROLLBACK_REQUIRED · TIMED_OUT
```

The transitions are declared as data in `packages/domain/src/action.ts` and
every move is checked against them. There is no code path that sets a state
directly.

The properties that matter:

**Execution does not report success.** `EXECUTED` means the call was made. The
action then enters `VERIFYING`, and only **re-observation through the connector
— reading the world back, not reading the response — can move it to
`CONFIRMED`.** If verification cannot confirm the change, the action lands in
`UNVERIFIED` and says so. It does not become `CONFIRMED` because the vendor
returned 200.

**Every transition is recorded.** `action_transitions` is append-only with a
`seq` for ordering (ADR-0010), carrying who or what caused it, when, and why.
The history reads as a narrative and cannot be reordered.

**Nothing is proposed that cannot be done.** A proposal names a connector
capability that exists, on a subject that exists, in an organisation the
proposer is authorised for.

**Approval is separate and structural.** See ADR-0015.

**Actions are idempotent.** See ADR-0016.

## Alternatives considered

**Fire-and-forget execution with a status field.** The common implementation.
Rejected: it makes "did it work?" unanswerable, and it makes the finding-closure
logic a lie.

**Verification as an optional per-action setting.** Rejected because it would be
switched off for the actions where it matters most — the noisy, high-volume ones
— and because "verification optional" is not a product this brief describes.

**Automatic rollback on failed verification.** Considered seriously and
rejected. An automatic rollback is itself an unverified change to production,
made in a state where the system has just demonstrated it does not know what the
world looks like. `ROLLBACK_REQUIRED` surfaces the situation to a human with the
full transition history instead. Rollback is offered, not performed.

## Consequences

- An action takes longer to reach a terminal state, because verification
  requires a real collection round trip against the vendor.
- Findings close on `CONFIRMED` and on reassessment, never on `EXECUTED`.
- `UNVERIFIED` is a real, common outcome — vendor propagation delays are
  ordinary — and the interface treats it as information rather than as an error.
- The action model is deliberately not a general workflow engine. Adding a state
  is a schema and code change, reviewed, rather than configuration.

## Security implications

The execution path is the highest-privilege thing Adericel does. It is
constrained at four points: the proposer must hold `org:action:propose`, a
different principal must approve, the connector must declare the capability, and
the execution runs under credentials scoped to that one integration.

An action carries a risk class. High-risk classes require explicit approval
regardless of the organisation's autonomy level, so autonomy configuration can
widen what runs automatically only within a ceiling it cannot raise.

## Operational implications

Actions stuck in `VERIFYING` past a timeout become `TIMED_OUT` rather than
remaining pending forever, and appear in the operational view. This is a normal
condition for vendors with slow propagation, and the timeout is per capability.

## Migration implications

The transition table is data, so adding a state is a migration plus a constant.
Removing one is not possible while historical rows reference it — old actions
keep their recorded states, which is the point.
