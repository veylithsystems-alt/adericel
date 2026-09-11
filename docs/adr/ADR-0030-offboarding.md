# ADR-0030: A customer leaves with their record, and the record survives them

**Status:** Accepted · **Date:** 2026-09-10

## Context

The customer lifecycle had a beginning and no end.

`OFFBOARDING` and `CLOSED` existed in the organisation status enum.
`CUSTOMER_OFFBOARDED` existed as a business event type. Nothing anywhere could
reach any of them. A customer who left was, in practice, a row that stayed
`ACTIVE` forever — keeping its sealed credentials, keeping its Assurance
Passport answering to third parties, and keeping its place in an MSP's
portfolio count and monthly bill.

Two failures were available here, in opposite directions, and both are worse
than they look.

**Destroying the record.** A customer's evidence, determinations and history are
the thing they may need most — for an audit, an insurance claim, a dispute with
the MSP they just left. The moment they are least able to argue about it is
exactly the moment it is most likely to be deleted, because that is the moment
nobody in the room is on their side.

**Keeping the assertions.** An organisation nobody can close goes on being
observed, billed and — through a shared passport — go on telling an insurer that
an estate Adericel stopped watching is satisfied. That is the same manufactured
certainty ADR-0027 refuses for billing lapse, and offboarding is the stronger
case: the customer has actively left.

## Decision

**Export first. Stop asserting immediately. Destroy credentials. Keep the
record. Close only when all of that is done.**

The order is the decision, and it is deliberately the opposite of the convenient
one. Convenience says: stop the work, revoke the access, tidy up, and produce an
export if anybody asks for one.

1. **Assurance stops when offboarding starts**, not when it completes.
   Collection and assessment end at the first step, because every further
   determination would be about an estate nobody is watching.

2. **The export is taken before anything is revoked**, and closure is refused
   without one. The database enforces that ordering with a `CHECK` constraint
   independently of the service, so a bug in the application still cannot
   produce a closed organisation whose customer never received their record.

3. **A truncated export cannot be the final record.** The bundle states its own
   completeness; the final export refuses to be recorded if any table hit its
   row cap. An MSP handing a customer "everything Adericel holds" that omits
   thirty thousand evidence artefacts has given them a document that lies about
   its own scope.

4. **Every shared passport is revoked**, so a third party holding a link is told
   the record is no longer maintained rather than receiving an answer.

5. **Credentials are destroyed, not disabled.** The ciphertext is the liability
   and nothing will legitimately use it again.

6. **API keys are deliberately untouched.** A key belongs to an MSP, not to one
   of its customers. Revoking them during one customer's offboarding would take
   out every other customer that MSP manages — an outage caused by a customer
   choosing to leave. Withdrawing an MSP's keys has an MSP-level blast radius
   and belongs at the MSP level.

7. **Closure is not erasure.** Determinations, evidence, the audit trail and the
   event log are kept. They stand as statements about the instants they were
   made, and an investigation or an insurance claim is exactly when they matter.
   Erasure is a separate, explicit, later act with its own recorded request.

The checklist is **recomputed from real state** rather than ticked off. A step
marked complete because somebody believed it was is how a checklist becomes
decoration.

## Consequences

A customer can leave, and can prove what they left with: the hash of the bundle
Adericel handed over is recorded, so a document produced years later can be
checked against it.

Closure is slower than a single button, and refuses more often. Both are
intended. The alternative is a button that, pressed in frustration on a Friday
afternoon, destroys the only copy of a record somebody is about to need.

An MSP cannot use Adericel to hold a customer hostage. The commercial moat is
the product; it is not the data.
