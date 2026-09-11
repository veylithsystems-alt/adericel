# ADR-0024: An approval authorises one specific request

**Status:** Accepted · **Date:** 2026-09-10

## Context

ADR-0015 establishes four-eyes control: a person other than the proposer must
approve a change before Adericel dispatches it. The approval record referenced
the action row and nothing else.

An action row is mutable. Nothing in the current code changes an action's
parameters, target or type after proposal, so nothing was exploitable — but the
guarantee rested on the absence of a feature rather than on a control. "Let the
approver adjust the parameters before approving" is an obvious and reasonable
thing for somebody to build, and the day it exists, an approval becomes a
signature on a blank cheque with nothing in the system positioned to notice.

The failure mode is the worst kind: a human genuinely approved something, the
audit trail records a genuine approval, and a different change was executed.

The same reasoning applies to the approval's own record. `action_executions`
already stored a `request_digest`, computed at execution time — a record of what
ran, never compared against what was authorised.

## Decision

**The request is digested at proposal, the digest is copied onto the approval,
and execution refuses to dispatch unless the live row still hashes to it.**

- `actions.request_digest` covers the action type, risk class, integration,
  target node, target external id and parameters — everything that determines
  what will be done and to whom. It is written at proposal and never updated.
- `approvals.request_digest` carries the same value. An approval authorises that
  request and no other.
- `execute` re-derives the digest from the row as it stands, and compares it
  with both. Any disagreement cancels the action and dispatches nothing.
- The refusal is **returned, not thrown**. Execution runs inside a transaction,
  so raising would roll back the cancellation and the transition record, leaving
  a tampered action sitting in `AUTHORISED` for the next attempt to find. The
  API layer turns the returned refusal into a 412 after the transaction commits.
- Rows predating the migration carry an `unbound:pre-0013` sentinel and are
  executed as before. Refusing them would strand in-flight approvals across an
  upgrade. Everything proposed afterwards is bound: the column is NOT NULL and
  its default is dropped, so an insert that omits the digest fails loudly.

Defeating this now requires either a SHA-256 preimage or a consistent rewrite of
three rows in two tables, rather than one `UPDATE`.

## Alternatives considered

**Make the action row immutable at the database level.** Attractive, and
insufficient: state, attempt counts, timestamps and error details legitimately
change throughout the lifecycle. A rule that only some columns are frozen is a
digest by another name, with no record of what the frozen values were.

**Re-check the parameters against the finding at execution.** Only works for
actions derived from a finding, and says nothing about the target or the action
type.

**Sign the approval with the approver's key.** Stronger, and it presumes a key
infrastructure Adericel does not have. The digest gets most of the value now and
is what such a signature would cover later.

## Related decision: a terminal action does not close the question forever

Found while testing the above. Proposals converge on one action through a
derived idempotency key, so two schedulers reacting to the same finding cannot
dispatch twice. But the key was permanent: once the action reached a terminal
state, a further proposal of the same remediation collided with the unique index
and failed with an opaque database conflict.

The consequence was severe for a continuously-monitoring product. A rejected
remediation could never be proposed again, leaving the finding open with no
route to resolution. Worse, a _successful_ remediation had the same effect: if
the problem recurred — someone turns MFA back off — Adericel could never
remediate a recurrence of anything it had ever fixed.

Proposal now searches the base key and every attempt derived from it, reuses
whichever is still in flight, and otherwise mints the next attempt (`key:2`,
`key:3`). Convergence within a window is preserved; the permanent lock is not.

## Consequences

**Positive.** Four-eyes now means what it says. An approval cannot be
transplanted onto a different change, a different target, or a more dangerous
action type. Recurrence is remediable.

**Negative.** A legitimate edit to a proposed action requires a fresh proposal
and a fresh approval. That is the intended cost: an amended change is a
different change and deserves to be reviewed as one.

## Security implications

This closes a privilege-escalation path that did not require any privilege
escalation: get a low-risk change approved, then execute a disruptive one under
that authority. It is tested directly — parameters swapped, target swapped, and
action type swapped from `identity.mfa.require` to `identity.account.disable` —
in `tests/security/action-authority.test.ts`.

Separately, `org:exception:approve` joins `org:action:approve` in
`HUMAN_ONLY_PERMISSIONS`. Approving an exception is the decision that a control
may remain unsatisfied; it carries the same weight as authorising a change and
was previously defended only at the route rather than in the authorisation
layer.

## Operational implications

A refusal appears as a cancelled action with the reason recorded on the
transition, an audit entry carrying the refusal code, and an error log naming
both digests. `AUTHORISATION_MISMATCH` should be treated as a security event: in
normal operation it cannot occur.
