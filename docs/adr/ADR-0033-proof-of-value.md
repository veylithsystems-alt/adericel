# ADR-0033: Adericel counts what it did; the MSP prices it

**Status:** Accepted · **Date:** 2026-09-10

## Context

An MSP does not buy an assurance dashboard. They buy back the hours their
engineers currently spend proving that a hundred customers are secure. The
question that decides whether Adericel is worth £199 per organisation per month
is therefore not "is the interface good" but:

> What does maintaining defensible assurance for 100 customers cost, without
> Adericel and with it?

Answering that requires a number of the shape _"180 staff-hours a month became
35"_. And that is exactly where a product built on refusing to overstate
certainty can destroy its own credibility in a single sentence, because the
tempting way to produce the "180" is to invent it.

A vendor asserting what an MSP's own business used to cost is manufactured
certainty aimed at the person paying — the worst possible place to put it. It is
the same failure as converting UNVERIFIED to PASS, with money attached.

## Decision

**Adericel measures what it did. The MSP supplies what that work is worth. The
arithmetic is shown, never asserted.**

The split is absolute and lives in separate files so that nobody can later add a
plausible default to one and have it silently become a claim about the other.

### What Adericel asserts

`packages/value/ledger.ts` counts rows: observations collected, evidence
produced, claims asserted, changes detected, determinations made, findings
raised, remediations executed unattended, verifications concluded, passports
issued, assurance enquiries answered. Every figure is a count somebody can go
and look at.

`packages/value/intervention.ts` counts what people still had to do, from the
audit trail — deliberately biased against Adericel. A human action that maps to
no task is still counted, as `unclassified`, because dropping it would shrink
the residual and inflate the saving.

`packages/value/quality.ts` measures whether the assurance actually got better:
evidence freshness, gap age, determination coverage, staleness. A vendor would
not choose these metrics, which is the argument for them.

### What Adericel refuses to assert

Durations. There is **no default anywhere in the package**. A task nobody has
priced is `UNKNOWN`, contributes nothing to any total, and is reported as
unpriced. The database enforces it too: a duration must carry a source and a
written basis, or the row is refused.

`INDUSTRY_REFERENCE` is a valid source and is deliberately excluded from any
headline figure. A published survey is fine for illustrating what the arithmetic
would look like; it is not this MSP's own cost, and presenting it as one would
be a claim about somebody else's business wearing this customer's name.

### The baseline is derived, not asserted

The report never claims to know what the MSP's last year cost. It computes:

```
hours if entirely manual = hours displaced + hours still spent
```

That is the total volume of work that **demonstrably happened this period**,
priced by the MSP. Adericel is saying "here is the work that got done, here is
which part of it you did, and here is your own number for what the rest would
have taken you". Every input is either a row count or something the MSP typed.

### The projection refuses more often than it produces

`project()` declines rather than disclaims. Below three organisations it refuses
outright, in terms that name the comparison: presenting a projection from two
customers to a hundred "would be the same failure as reporting an unverified
control as satisfied". With nothing priced it refuses. Where it does produce a
figure it is labelled `PROJECTED`, carries the sample it came from, and states
the assumptions it is making about how portfolios scale.

### Determining UNKNOWN is not a saving

Found by running the machine rather than by reasoning about it. On a realistic
five-customer portfolio, 75 of 85 determinations came back UNKNOWN — the estates
were barely observed — and every one was being counted as displaced work.

An engineer who read the same evidence and concluded they could not tell would
still have the job in front of them. So UNKNOWN determinations no longer count
toward displaced labour, and a portfolio where fewer than half of determinations
reach a conclusion gets a caveat saying, in the report's own words, that the
saving is "a saving on the labour of not knowing".

That change cut the demonstration's headline from 468 released hours a month to 193. The smaller number is the true one.

## Alternatives considered

**Ship a benchmark baseline.** Every competitor does it: "the industry average
MSP spends N hours per customer". It produces a bigger number instantly and it
is a claim about somebody else. An MSP who checks it against their own timesheets
and finds it wrong will not trust anything else in the document — and they should
not.

**Estimate the unpriced tasks from the priced ones.** Statistically reasonable
and quietly dishonest: the reader cannot tell which figures they supplied and
which were filled in. Reporting the model as, say, 60% complete is less
impressive and lets them decide.

**Let the projection extrapolate from one customer with a warning.** Warnings on
a number are read as decoration around the number. Refusing is the only form of
caution that survives being pasted into a slide.

## Consequences

The headline figure is smaller than it could be, and every part of it can be
checked by the person being sold to. That is the trade, and for a product whose
entire proposition is that it does not overstate what it knows, it is not a
close call: a proof-of-value engine that will produce a big number when pressed
is worth nothing to the buyer, and worth less than nothing the first time one is
audited.

`tests/e2e/proof-of-value.test.ts` drives five customer organisations under one
MSP through the whole cycle and asserts the rules hold on real data. Building it
found that the test harness could not create more than one organisation per MSP,
which meant no test in this repository had ever exercised the portfolio shape
every real customer has.

`pnpm proof-of-value` runs the demonstration and prints the figures, including
the caveats the report raises about itself.

What is still missing is the thing no code can supply: a real MSP's real
durations, measured against their real portfolio. Until then this machine can
say precisely what Adericel did and precisely how the sum would work. It cannot
say what it is worth, and it will not pretend to.
