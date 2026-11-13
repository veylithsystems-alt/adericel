# Adericel — commercial brief

_Autonomous organisational security assurance infrastructure. A product of
Veylith Systems Ltd._
_Status: **pre-pilot.** No customer has used it. Last reviewed 13 October 2026._

## Target buyer

**A UK managed service provider with 20–150 managed customer organisations**,
selling security or compliance services and employing between one and five
people on them. The buyer is the owner or the technical director — somebody who
feels the cost of assurance work personally.

Not the SME. Adericel is sold to the MSP and operated by the MSP across its
customers; there is no direct-to-SME path, and the code enforces that
(`ASSUMPTION`: this is the right commercial shape. It is a deliberate bet that
MSPs are reachable and SMEs are not, and it has not been tested with a buyer).

## The problem

An MSP that sells security assurance has to answer the same question for every
customer, every month: **is this control actually met, right now, and can we
prove it?** Today that is answered by a person opening consoles, taking
screenshots, and filling a spreadsheet. Three costs follow:

1. **It does not scale.** The work is linear in customers, so the practice grows
   by hiring, which is why most MSPs cap their security offering well below
   their customer count.
2. **It goes stale the moment it is finished.** A screenshot is true on the day
   it was taken, and a customer's estate moves daily.
3. **It cannot survive a challenge.** Asked by an insurer or an auditor to show
   how a conclusion was reached, a spreadsheet cell cannot answer.

The competing products mostly solve (1) by producing a score. Adericel's bet is
that **a score is the problem, not the solution**: it converts "we did not look"
into a number that reads like a finding, which is exactly the failure an MSP
gets sued over.

## The offer

A continuously maintained, evidence-backed assurance position for every managed
customer, with four things no competitor combines:

- **`UNKNOWN` is a first-class answer**, and every one of them carries why it is
  unknown, what evidence would resolve it, who can provide that, how material it
  is, and what happens if nobody does. Never a score. Never a traffic light that
  hides a gap.
- **A broken connector names its repair.** "The Entra credential expired", not
  "collection failing" and not a silent gap.
- **An Assurance Passport** — a signed, portable record a customer can hand to
  an insurer or a prospect, verifiable without Veylith Systems being involved or
  trusted.
- **Self-hostable, with no Veylith commercial machinery in the image**, enforced
  by test. An MSP that wants the platform on its own infrastructure gets it.

## Price hypothesis

**ASSUMPTION throughout. No price has been quoted to anybody.** The figures
below are the defaults in `packages/domain/src/billing.ts`, which is a decision
recorded in code, not a validated price.

| Plan       | Per managed customer / month | Volume                              |
| ---------- | ---------------------------- | ----------------------------------- |
| Pilot      | £0, up to 3 customers        | —                                   |
| Standard   | £199                         | £179 at 25, £159 at 50, £139 at 100 |
| Enterprise | £129                         | £99 at 250                          |

Revenue is `MSP platform entitlement + (managed customers × customer
entitlement) + add-ons`. Deliberately not flat-per-MSP: the platform and the
managed customer are distinct commercial units, so revenue grows with the MSP's
own book rather than with how many MSPs can be signed.

**The assumptions underneath the price, each of which could be wrong:**

- An MSP will pay £199/customer/month for assurance it currently does by hand.
  **UNKNOWN.** The honest test is quoting it.
- An MSP charges its own customers enough for this to leave margin. **UNKNOWN**
  — it depends on their pricing, which we have not seen.
- Volume breaks at 25/50/100 match where MSPs actually sit. **ASSUMPTION**, from
  no survey.

## Evidence obtained so far

**MEASURED — about the software, not about customer value:**

| What                                    | Value                                       | Where to look                       |
| --------------------------------------- | ------------------------------------------- | ----------------------------------- |
| Tests passing                           | 1,705 across 108 files                      | `pnpm test`                         |
| Guards proved by deliberate breakage    | 41 mutations, all killed                    | `pnpm test:mutation`                |
| Capabilities at `PROVEN`                | **0 of 15**                                 | `docs/product/CAPABILITY_STATUS.md` |
| Critical defects found by chaos testing | 4, in code with 1,677 tests passing over it | `tests/chaos/`                      |

**BUILT, not measured:** the Truth Engine, tenant isolation with forced RLS, the
Assurance Passport and its independent verification, containment, break-glass,
the resolution queue, questionnaire intake, backup and restore, a 100-customer
synthetic portfolio, and the n8n orchestration export. Each is `OPERATIONAL` or
`VERIFIED` in the capability register, and each has three to four statuses above
it that remain unestablished.

**The most important measured fact, and it is unflattering.** Failure-injection
testing — added late, and the only suite that moves the clock — found six
defects, four critical. The worst: a perfectly healthy estate, collected
successfully every day, lost every determination on day seven and never
recovered. 1,677 tests passed over it. The lesson is not that the code is now
sound; it is that **whole dimensions of this product remain untested, and each
one opened so far has contained a critical defect.** Scale and sustained
operation are the two still unopened.

**What is UNKNOWN and matters commercially:**

- Whether an MSP will buy it. Nobody has been asked.
- Hours actually saved. The code counts operations; only an MSP can price them,
  and the product refuses to estimate rather than inventing a default.
- Customers one engineer can manage. Computable from
  `GET /v1/msps/:id/capacity`, but only with an MSP's own minutes-per-task.
- Behaviour at 100 concurrent customers. **Untested** (`RR-085`).

## Next milestone

**One pilot MSP, 3–5 customers, free, on a written pilot basis, within 90 days.**

It is the only thing that moves a single capability from `OPERATIONAL` to
`PROVEN`, and the only source of every commercially important number above.

Gating it, in order:

1. **Load and soak testing** (~1 week). The next untested dimension. The chaos
   result is the argument: untested dimensions here contain critical defects.
2. **A second technical reviewer.** Worth the cost specifically because a
   product-killing defect shipped with full green CI.
3. **The legal set** — DPIA, ICO registration, professional indemnity cover, a
   processing agreement. Wall-clock time, not engineering, so it runs in
   parallel and starts now.
4. **A signed release record** naming what was and was not established.

**Not gating it:** more features. The gap between here and a first customer is
not functionality.

**What would falsify the business.** An MSP that reviews it and says the manual
work is cheaper than £199/customer, or that a score is what their own customers
want. Either would be worth knowing in week one rather than year two, so the
pilot conversation leads with the price and with `UNKNOWN`, not with a demo.
