# The nine metrics, answered honestly

_What the repository can measure, what needs the MSP's own numbers, and what
cannot be answered without a real pilot._

The question this document exists to answer is: **can one real MSP run its
entire assurance operation through Adericel, and be demonstrably better off?**

Nine measures were asked for. They do not all have the same status, and
pretending they do would be the first dishonest thing in a product whose whole
proposition is not overstating what it knows. They fall into three groups.

---

## Group 1 — measured by the code, today

Counted from rows somebody can go and look at. No modelling, no estimation, no
MSP input required.

| Measure                                                                      | Where it comes from                                                                                                                                                                  | Route                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **Evidence collection reduction**                                            | `loop_cycles.observations_collected` and `evidence_created` per cycle, against `evidence_supplied_by_human` in the value ledger                                                      | `GET /v1/msps/:id/value/report`        |
| **Issues discovered that manual processes missed**                           | `changes_detected` — claims that superseded a prior claim, i.e. the estate moved and nobody reported it. Plus `verifications_refuted`: fixes that claimed success and did not happen | `GET /v1/msps/:id/loop/cycles`         |
| **Remediation time**                                                         | `actions.proposed_at` → `executed_at` → `verified_at`, per action                                                                                                                    | `GET /v1/organisations/:id/actions`    |
| **Customer reporting time** and **audit/insurance evidence production time** | Assurance Passport issuance is one request. The measure is the _manual_ time it replaces, which is Group 2                                                                           | `POST /v1/organisations/:id/passports` |

The loop is now a recorded object rather than emergent behaviour, which is what
made most of this measurable at all. Each cycle carries per-stage timings, so a
scaling problem appears as a stage rather than as a feeling that the product got
slower.

**Also measured, and less flattering:** `determinations_unknown`,
`organisations_skipped` with reasons, and the exception queue's own count of
what still needs a person. A cycle that could not complete a customer says so
rather than dropping them from the denominator of everything downstream.

---

## Group 2 — computable, once the MSP supplies its own numbers

The code measures the volume. Only the MSP can say what the volume is worth.
This is ADR-0033's discipline applied to the loop: **Adericel counts what it
did; the MSP prices it.** There is no default anywhere, and an unpriced input
produces a refusal rather than an estimate.

| Measure                               | What Adericel counts                              | What the MSP must supply                                                 |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| **Hours saved**                       | Operations performed, by task                     | Minutes per task (`enquiry.answer`, `evidence.collect`, and nine others) |
| **Review-time reduction**             | Exceptions raised, by what the operator has to do | Minutes per response type: DECIDE, CONFIGURE, INVESTIGATE, ASK_CUSTOMER  |
| **Customers one engineer can manage** | Exception load per customer per month             | The above, plus engineer hours available per month                       |

### The headline number

`GET /v1/msps/:id/capacity` returns **customers per engineer**, computed as:

```
engineer hours per month ÷ hours of exception work per customer per month
```

Floored, never rounded — an engineer who can carry 47.8 customers can carry 47,
and rounding up puts a real person over capacity on the strength of a decimal.

It **refuses** to answer when:

- the observation window is under 14 days (a quiet fortnight would double it);
- the portfolio is under 3 customers (one unusual customer becomes the model);
- a response type that actually occurred has no supplied duration;
- nobody has said how many hours an engineer has in a month;
- the only duration available is an industry figure, which is a claim about
  somebody else's business.

And when it does answer it states, every time, that it counts assurance work
alone — not the meetings, the onboarding calls, or the customer who telephones.
**An engineer runs fewer customers than this figure in practice**, and the
figure says so.

---

## Group 3 — cannot be answered by code at all

Named here rather than quietly omitted or approximated.

**Actual willingness to pay.** This is not a measurement, it is an outcome of a
sales conversation. No instrumentation produces it. It is answered by quoting a
price to a real MSP and finding out.

**Whether the MSP is demonstrably better off.** The repository can now produce
every input to that judgement — work displaced, work remaining, assurance
quality, coverage, capacity. It cannot make the judgement, because "better off"
includes whether their engineers trust the queue, whether their clients notice,
and whether the renewal conversation got easier. Those are observations about
people.

---

## What would close the gap

One MSP. Four things from them, none of which need development:

1. **Timings.** Fifteen minutes with a stopwatch across a fortnight of their
   queue gives every Group 2 figure.
2. **Engineer hours.** One number and a sentence explaining it.
3. **A fortnight of real running.** Below fourteen days the capacity figure is
   refused, and correctly so.
4. **A price quoted, and their answer.** The only source for Group 3.

Until that has happened, this repository can say precisely what Adericel did and
precisely how the arithmetic would work. It cannot say what it is worth, and it
will not pretend to.

---

## What is deliberately not reported

- Any figure derived from an industry benchmark and presented as this MSP's.
- Hours saved computed from UNKNOWN determinations. Displacing the labour of
  producing UNKNOWN is not a saving, and the value report says so in its own
  words when more than half of determinations fail to reach a conclusion.
- A capacity figure from a sample too small to support one.
- Any claim about insurance outcomes.
