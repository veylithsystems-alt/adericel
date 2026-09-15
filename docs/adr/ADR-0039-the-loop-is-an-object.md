# ADR-0039: The loop is a recorded object, not emergent behaviour

**Status:** Accepted · **Date:** 2026-09-15

## Context

Adericel collected, determined, triaged, remediated and verified. It did all of
it correctly, as separate scheduled jobs and separate routes.

Which meant the thing an MSP is actually buying — _connect, discover, collect,
establish truth, find the exceptions, prioritise, fix what is safe, verify,
prove, repeat_ — existed only as emergent behaviour. Nobody could point at it,
time it, or count what it did.

Emergent behaviour cannot be measured. And "how much work does this take off my
desk" is the question this product lives or dies on, so a loop nobody can
measure is a commercial claim nobody can substantiate.

There was a second problem underneath. The most commercially important number an
MSP owner has is **how many customers one engineer can carry**, because it is
the number that decides whether the next fifteen customers need another salary.
That number was uncomputable: it needs exception load per customer, and exception
load only existed as whatever the queue happened to hold at the moment somebody
looked.

## Decision

**One pass of the loop is a recorded object with per-stage counts and timings,
and capacity is computed from the load it measures.**

`runLoopCycle` executes the whole loop across a portfolio and writes a
`loop_cycles` row: observations, evidence, claims, changes detected,
determinations made and unknown, exceptions open and needing a person,
remediations proposed, autonomous and approved, verifications confirmed and
refuted, plus wall-clock per stage.

Three properties matter more than the counts:

**It never approves anything.** Remediation that policy permits unattended runs;
remediation needing a person waits, and appears in the next queue. A loop that
could approve its own actions would be the AI-to-API-to-green pattern the whole
architecture refuses.

**It never silently drops a customer.** A customer whose connector is gone, or
whose assessment failed, is recorded in `organisations_skipped` with a reason.
Dropping them would remove them from the denominator of every metric downstream,
which is how a coverage figure quietly becomes a lie.

**It only acts where Adericel is being paid to.** Lapsed and offboarding
customers are excluded, so the billing lifecycle's only lever cannot be quietly
bypassed by the loop (ADR-0027).

### Capacity

```
customers per engineer = engineer hours per month
                       ÷ hours of exception work per customer per month
```

Adericel measures the load. The MSP supplies minutes per response type and
engineer hours per month. Neither has a default, and the figure is **refused**
rather than approximated when the window is under 14 days, the portfolio under 3
customers, an occurring response type is unpriced, or the only duration
available is an industry benchmark.

Pricing is by _response type_ — DECIDE, CONFIGURE, INVESTIGATE, ASK_CUSTOMER —
rather than by exception kind. That is how the work actually divides: a morning
of fifteen decisions is a different day from a morning of three investigations,
and an MSP can time four categories far more readily than fifteen.

The result is floored, never rounded, and always carries the statement that it
counts assurance work alone. An engineer runs fewer customers than this in
practice, and the figure says so rather than letting a reader assume otherwise.

### Two corrections found by running it

**Arrivals, not the standing queue.** The first version counted whatever the
queue held and divided by the window length. A standing backlog read as a
trickle, and the hundred-customer portfolio produced 433 customers per engineer.
Load is now counted from each exception's own `since` timestamp — the condition
arose inside the window — which is a true arrival rate. The standing queue is
reported separately, because "am I underwater today" is a real and different
question, and a queue much larger than the arrival rate now raises a caveat
saying work is accumulating.

**An absurd number destroys the honest ones beside it.** After that fix the
demonstration still produced 433, and correctly: a synthetic portfolio with few
controls really does generate almost no exception work. The arithmetic was
right and printing it bare was wrong. Above 150 the figure now carries what it
actually means — _assurance work is no longer what limits this team_ — because
onboarding, account management and the telephone bind long before the exception
queue does, and none of those is something Adericel can see. `capacity`
reports `assuranceIsTheConstraint: false` in that case, which is itself the
useful finding.

## Alternatives considered

**Leave the loop as scheduled jobs and infer the metrics from the tables.**
Possible, and it is what the value report already does for a time window. It
cannot answer "how long does one pass take across a hundred customers", which is
the scaling question, and it cannot distinguish a customer that was skipped from
one that had nothing to do.

**Let the loop approve low-risk remediations to raise the automation figure.**
It would make every number better and it is the one change that would make the
product untrustworthy. Refused, and ADR-0015 already refused it.

**Ship a default for engineer hours — 130 is a reasonable month.** It would make
the headline figure always available, and it would mean the most important
number in the product was one Adericel invented about somebody else's payroll.

## Consequences

The capacity endpoint returns a refusal for most MSPs most of the time, until
they have supplied four numbers and run for a fortnight. That is the correct
behaviour and it will feel like a missing feature.

`docs/commercial/the-nine-metrics.md` states which commercial measures the code
supplies, which need the MSP's input, and which — willingness to pay, and
whether an MSP is demonstrably better off — cannot be answered by code at all.
