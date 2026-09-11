# The 100-customer proof

A separate part of the repository, deliberately.

Everything under `proof/` exists to demonstrate one claim against the real
product: that an MSP can operate assurance across a hundred customers through
Adericel, dealing with exceptions rather than inspecting customers, and that
removing Adericel would put measurable work back on their desk.

Nothing here is imported by the product. `packages/` and `apps/` do not depend
on it, and it has no route into a running deployment. That separation is the
point: a demonstration harness that could be reached from production code would
eventually be reached from production code.

## What this is not

It is not a fixture, a seeded dashboard, or a set of pre-computed numbers. The
portfolio is built by calling the real API and running the real engine — collect,
determine, detect change, propose, approve, execute, re-observe, verify — against
a real PostgreSQL database. Every figure printed comes out of the same queries an
MSP operator would hit.

A static demonstration would be easy, would look identical, and would prove
nothing.

## Layout

```
proof/
  archetypes.ts   20 customer shapes, each a deliberate assurance condition
  portfolio.ts    builds the 100-customer estate by driving the real API
  scenario.ts     runs the operating cycle across the portfolio
  failures.ts     breaks things on purpose, and asserts it stays honest
  report.ts       prints what the portfolio actually shows
```

## Running it

```
pnpm proof            # build the portfolio, run the cycle, print the findings
pnpm proof:failures   # the failure-injection pass
```

Both require the test database.

## The standard it is held to

The same one as the product. If the demonstration cannot make the claim without
a number that has been rounded in Adericel's favour, an UNKNOWN counted as a
pass, or a customer quietly excluded because they made the average look bad,
then the claim is not true yet and the honest thing is for the demonstration to
say so.
