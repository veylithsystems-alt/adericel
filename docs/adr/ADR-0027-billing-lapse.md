# ADR-0027: When the money stops, Adericel stops asserting — and keeps the record

**Status:** Accepted · **Date:** 2026-09-10

## Context

Billing was written and never wired. There was no checkout route, no webhook
endpoint, and no ledger of provider events — and, more importantly, no answer to
a question that decides whether this product can be trusted at all:

**What does Adericel do when a customer stops paying?**

Before this, the answer was: nothing. Assessments kept running. The assurance
state kept reading as current. And an Assurance Passport shared with an insurer
kept saying _satisfied_ about an estate Adericel had stopped observing.

That is the precise failure the company exists to refuse. A passport's whole
value to a third party is that the record is **currently maintained**; one that
goes on asserting currency after collection has stopped is manufacturing
certainty, which §8 forbids in the product and cannot be excused in the billing
system because the billing system is where the incentive to look away lives.

The opposite error is as bad and more tempting. Deleting a customer's evidence
because their card expired destroys the record they may need most — for an
audit, an insurance claim, a dispute — and a company that does that is not a
system of record. It is also the moment a customer is least able to argue.

## Decision

**Adericel stops asserting currency and keeps the record.**

Concretely, when a subscription lapses:

- **Collection and assessment stop.** Enforced in `organisationsToProcess`, the
  single function every scheduled job routes through, so a job added next year
  inherits the rule instead of having to remember it. A job that names an
  organisation explicitly is checked too, or an operator re-running a collection
  by hand would quietly resume assurance nobody is paying for.
- **Nothing is deleted.** Evidence, claims, assessments, recorded inputs and
  issued passports all remain, in full, and the customer can still read them.
- **No determination changes.** What was determined stands as a statement about
  the instant it was made. Adericel does not retroactively decide it was wrong,
  and does not flip anything to a failure.
- **Everyone who could be misled is told.** The customer's assurance view says
  it. So does a shared passport, _before_ the passport itself, because it
  changes what every figure below it means.
- **A passport issued while unmaintained says so inside its hashed content.**
  This closes the obvious exploit: stop paying, let collection stop, then mint a
  freshly dated passport carrying months-old determinations and hand it to an
  insurer as a current record. The fact sits in the content, so it is covered by
  the content hash and cannot be stripped without the document failing
  verification. The interpretation leads with it in capitals.
- **A failed payment is a grace period, not a punishment.** Fourteen days. An
  expired card is the most common billing event there is, and suspending an
  estate over one is disproportionate. Cancellation has no grace period: the
  customer said stop.

Every message about this is careful to say what it does not mean:

> This says nothing about whether their security is good or bad — only that
> Adericel has stopped looking.

An unmaintained record must not read as a failing one. That distinction is the
same one the Truth Engine draws between NOT_SATISFIED and UNKNOWN, applied to
the commercial relationship.

## Provider event handling

Payment providers retry, duplicate and reorder, and a subscription system that
assumes otherwise corrupts itself quietly.

- **Exactly once.** The event ledger insert is the idempotency gate and comes
  first; a conflicting insert means the event has been seen, and the correct
  response is 200 without acting — the provider retried because it did not get
  our 200, not because anything changed. A non-2xx would make it retry forever.
- **In the provider's order.** An event stamped earlier than the last one
  applied is recorded and discarded. Last-write-wins would let a renewal queued
  behind a cancellation resurrect a cancelled subscription.
- **Cancellation is terminal.** A final-period invoice settling afterwards is
  ordinary and must not reactivate anything.
- **Unmatched events are recorded, not lost.** An event for a subscription
  Adericel has never heard of is a real signal — a provider misconfiguration —
  and discarding it makes the problem undiagnosable.
- **Grace expiry is a scheduled job, not an event.** A customer whose payment
  failed and who then hears nothing more from the provider must still lapse, and
  an event that never arrives cannot trigger anything.

## Alternatives considered

**Suspend access entirely.** Locks a customer out of their own record at the
moment they may most need it, and does nothing about the passports already in
third-party hands, which is where the actual misleading happens.

**Keep assessing and let them owe.** Gives away the product and, worse, keeps
asserting currency about an estate on behalf of someone with no contract.

**Delete after a retention period.** Defensible for personal data under a
retention policy; indefensible as a consequence of non-payment.

**Refuse to issue a passport while unmaintained.** Considered and rejected as
paternalistic: it is their record and an honest stale snapshot is a legitimate
thing to want. Marking it inside the hashed content achieves the same protection
for third parties without denying the customer their own history.

## Consequences

**Positive.** A third party can rely on a shared passport, because a passport
that has stopped being maintained says so and cannot be edited to hide it. A
customer who lapses and returns finds everything intact.

**Negative.** `assurance_maintained` is denormalised onto `organisations`
because it is read on the hot path — every assurance view, every passport, every
scheduled collection. It can therefore drift from the subscription that governs
it. Mitigated by having exactly two writers, both in the billing lifecycle, and
by the scheduled job recomputing it; not eliminated.

## Security implications

The webhook endpoint is unauthenticated by necessity — a payment provider holds
no Adericel credential — so the signature is the whole control. What a forged
event buys is the ability to activate your own subscription, which is the
product for free. Production start-up therefore refuses a Stripe deployment
without a webhook secret rather than accepting unsigned events.

Signature verification runs over the raw bytes. A separate finding while
building this: the raw-body accumulator concatenated on every chunk to measure
the length, which is quadratic in the number of chunks — and the sender chooses
the chunk size. Against a 1 MB body limit, one unauthenticated request sent a
byte at a time forced roughly 550 GB of memcpy, all of it before any signature
was checked. It now keeps a running total.

Checkout resolves the subscription from the authenticated scope, never from the
request body: a caller who could name the subscription could pay a token amount
against somebody else's.
