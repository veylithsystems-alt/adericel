# ADR-0015: Four-eyes control is structural

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel executes changes on customers' production systems. The control that
makes that defensible is that a second, named human agreed. The brief is
explicit that this must not be simulatable by an AI agent.

The way four-eyes controls usually fail is not that someone bypasses them. It is
that they are implemented as a check the caller performs, and then a code path
appears that does not perform it — a bulk operation, an "auto-approve for
low-risk" setting, a service account created to make the tests easier.

There is a second failure mode this ADR originally missed: the approval is
genuine, the audit trail is genuine, and the change that executes is not the
change that was approved, because the record the approval points at is mutable.
ADR-0024 closes that by binding the approval to a digest of the request.

## Decision

**Four-eyes is enforced by the shape of the model, not by a check somewhere.**

Four independent properties, each sufficient on its own to prevent the failure:

**1. The proposer cannot approve.** An approval decision records the deciding
principal, and the service refuses a decision from the principal who proposed
the action. Refusal is an `AdericelError`, raised in the domain service, so
every caller — API, worker, workflow — hits it.

**2. Approval is a permission that proposal-holding roles do not have.**
`ORG_APPROVER` holds `org:action:approve` and does **not** hold
`org:action:propose`. Roles are permission sets, not a hierarchy, so there is no
"admin" that transitively acquires both by being senior (ADR-0008).

**3. A non-human principal cannot hold the permission.** `org:action:approve`
is grantable to `USER` principals only. A service principal or API key cannot be
granted it — not "is not granted it by default", but cannot be. An n8n workflow,
an AI agent, and an integration all authenticate as non-human principals, so
none of them can approve. This is the property the brief demands and it is worth
stating plainly: **there is no configuration in which Adericel approves its own
actions.**

**4. Refusals are audited.** A refused approval is written to the audit log
against the organisation the attempt targeted. Earlier this was not true —
service-level refusals returned an error before the audit middleware ran, so the
most security-relevant event in the system was the one event that left no trace.
Denials are now captured at the error boundary (`auditDenialFromError()`), which
means a refusal is recorded regardless of which layer raised it.

## Alternatives considered

**A configurable approval threshold, including zero for low-risk actions.**
Rejected. "Low risk" is judged when the rule is written, not when the action
runs, and the setting exists to be turned off under delivery pressure. Autonomy
level (ADR-0014) can widen what may be _proposed automatically_; it cannot
remove the approver.

**Approval by an AI agent acting under delegated human authority.** Rejected
categorically. It is the exact thing the brief prohibits, and the reason is not
that models are unreliable — it is that accountability requires a person who can
be asked why.

**Approval as a queue outside Adericel (ticketing, chat).** Attractive for
adoption, and rejected as the source of truth because the approving identity
would then be asserted by a third party over a webhook. Notification into those
systems is supported; the decision is recorded in Adericel by an authenticated
principal.

**Break-glass override.** Not implemented. A deployment that needs an emergency
change has the vendor's own console, and that leaves an audit trail in the
vendor's system where an incident review will look for it.

## Consequences

- A single-operator MSP cannot execute actions. This is a genuine adoption cost
  and it is the correct behaviour: an organisation with one person has no
  four-eyes control, and pretending otherwise would be selling assurance
  theatre. Such an operator can still use every observation, assessment and
  reporting capability, and can perform remediation by hand.
- Approvals are a distinct table with their own decisions and audit trail, not a
  column on the action.
- The end-to-end test asserts the negative cases directly: a proposer's own
  approval is refused, and execution before approval is refused.

## Security implications

The approving principal's identity is resolved from their authenticated session
at the moment of decision, and cannot be supplied in the request body. An
approval therefore cannot be forged by a caller who can reach the endpoint but
is not the approver.

## Operational implications

Actions awaiting approval are surfaced prominently rather than buried in a
queue, because the failure mode of a good approval control is that nobody
notices there is something to approve, and the operational answer to that is
never to lower the bar.

## Migration implications

Adding an approval policy (two approvers for a risk class, a specific named
approver) extends the approvals model without changing the four properties
above. Weakening any of them would supersede this ADR, and should be visible as
exactly that.
