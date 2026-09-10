# The Veylith Autonomous Operations Layer

**Report against the operating brief · 2026-09-10 · branch `claude/adericel-platform-build-k8noew`**

The brief asks for a brutally honest report. The short version: the authority
model, the escalation path and the measurement are real and tested. Almost none
of the company is actually automated yet, and the autonomy scorecard says so
rather than flattering the plan.

**Nothing here justifies calling Veylith or Adericel market-leading,
best-in-class, fully autonomous, production-ready, enterprise-ready, secure or
scalable.** Market-outclassing is the engineering objective; it is not a claim
the evidence supports today.

---

## IMPLEMENTED — what actually works

Everything in this section is exercised by tests that run in CI and was driven
against a live database and browser.

**A separate tenancy boundary for company data.** `veylith` schema, every table
platform-scope only. A tenant transaction can neither read nor write any of it;
three tests prove it, and were verified to fail when the policy is loosened.

**A five-valued authority model** (`packages/autonomy`). PERMIT,
REQUIRE_APPROVAL, ESCALATE, DENY, UNKNOWN. Pure, deterministic, hashed, no I/O.
34 tests, most of them attacks.

- UNKNOWN never resolves to permission, and the only function callers use to ask
  returns false for it — verified by breaking that function and watching four
  tests fail.
- An operation no rule covers is UNKNOWN. A policy with a permissive fallback is
  not expressible: the schema does not admit `PERMIT` there.
- An unregistered or disabled process is UNKNOWN, not maturity zero.
- A required fact that is **absent** is UNKNOWN; one that is **false** is DENY.
  "We never checked consent" cannot read the same as "consent was refused".
- Rules combine to the most restrictive result, so adding a rule can only narrow
  authority. A test adds an attacker's rule permitting everything irreversibly
  and confirms money, contracts, strategy and production deployment stay refused.

**One gate** (`operate`). It owns the effect callback, so an operation that
skips the gate does not run at all. Refusals raise an exception rather than
declining silently. The idempotency key is claimed before the effect, not after.
A permitted operation that throws records UNKNOWN_OUTCOME, never FAILED.

**The exception queue.** Dedupe by condition rather than occurrence; severity
rises on recurrence and never falls; response deadlines by severity; resolution
defaults to unverified; every transition audited in order.

**Measured autonomy.** Automation ratio, human intervention rate, exception
rate, autonomous resolution rate, verification rate, unknown outcomes, refusals
by outcome — all derived from the ledger. A ratio over no operations reports
null, not zero. Observed maturity can fall below recorded maturity and never
rise above it.

**The commercial pipeline.** Discovery, enrichment, deterministic qualification,
outreach preparation and sending — every state change through the gate. Consent
facts are read from the record, never asserted by the caller.

**The control room.** Six platform-scope routes and a page. Queue first, metrics
second. A simulator that says what the policy would decide and records nothing.

**The acceptance test.** A full operating cycle with six failures injected:
an unfinished record, a message with no lawful basis, a suppression, a gateway
timeout, a duplicate delivery, an operation beyond authority. All six behave.

## PARTIAL

- **Opportunities exist as a table and nothing drives them.** Discovery through
  outreach is wired; opportunity progression, proposals and contracts are schema
  only.
- **The process registry is seeded and static.** Nothing updates
  `current_maturity`; raising it is a deliberate human act with no route yet.
- **`business_events` has 38 event types and roughly a dozen are emitted.**
- **Verification is modelled and not driven.** Events and exceptions carry a
  verification state; nothing yet re-observes to confirm one.

## MOCKED

- **Outreach sending.** `sendOutreach` takes the sender as a callback. There is
  no email provider. The gate, consent checks, idempotency and failure handling
  are real; what they guard is a function the caller supplies.
- **Prospect enrichment.** Signals are passed in. No market data source is
  integrated.

## EXTERNAL DEPENDENCY

Nothing beyond what Adericel already needed. VAOL adds no third-party service.
When email, CRM, accounting or document signature are integrated, each needs its
own credentials and its own integration contract; none exist yet.

## NOT IMPLEMENTED

Marketing, support automation, billing operations beyond what Adericel already
does, finance operations, contract lifecycle, security monitoring of Veylith
itself, engineering operations automation, the internal knowledge system,
Veylith as its own Adericel customer (§35), and n8n orchestration for any of it.

The brief lists these as domains to build. What exists is the layer they would
all be built on, and the process registry naming each one with its human
boundary and target maturity.

## SECURITY LIMITATIONS

1. **The gate is bypassable by writing SQL.** It guards a code path, not the
   database. A component that inserts directly into `veylith.prospects` skips
   every check. There is no database-level constraint enforcing that state
   changes carry a policy decision, and there should eventually be one.
2. **Prompt injection is unaddressed because no LLM is wired in.** The moment one
   is, enrichment and classification become paths for external text to influence
   a decision. The authority model is the right shape to contain it — AI can
   supply facts, never decide — but nothing tests that yet.
3. **No rate limit across the whole company.** Limits are per rule. An attacker
   who found several permitted operations could exercise them concurrently.
4. **Exception evidence is stored unencrypted** and may contain whatever a failing
   automation put in it. No redaction pass exists.
5. ~~**Nothing binds a policy decision to the operation it authorised.**~~
   **Fixed.** Decisions and events now carry an operation digest covering the
   full identity of what was authorised, including the payload, and
   `findUnboundEvents` reports any event whose decision covers something else.
6. **The `veylith` schema is in the same database as customer data.** Separation
   is by RLS policy and grant, which is the same mechanism protecting tenant
   isolation — well tested, but one mechanism rather than two.

## AUTONOMY LIMITATIONS — where humans remain necessary, and why

| Boundary                        | Why it is not a gap to close                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banking authority               | No autonomous system should hold it. The rule is written to be unremovable, and a test asserts it holds at every maturity, with every fact asserted true, even when a permitting rule also matches. |
| Accepting contractual liability | Legal judgement. The system prepares and routes.                                                                                                                                                    |
| Strategy                        | The company decides what it does.                                                                                                                                                                   |
| First-contact wording           | Reputational. Approved once per template, not per send.                                                                                                                                             |
| Security containment            | ESCALATE, not approval — the right response is a person taking charge, not a rubber stamp on a decision they have not understood.                                                                   |
| Production deployment           | Approval, always.                                                                                                                                                                                   |
| Suspending a paying customer    | Disproportionate to the most common billing event there is.                                                                                                                                         |

## COMMERCIAL LIMITATIONS — what cannot yet be claimed

- **No customer has used any of this.** Zero MSPs, zero deployments, zero revenue.
- **No pricing has been validated.** The figures in the commercial specification
  are hypotheses. Nothing in the repository supports calling them market rate.
- **No time saving has been measured**, so no claim of the form "saves N hours"
  can be made. The evidence ledger the brief asks for is a table with no rows.
- **The autonomy figures describe a test cycle, not a business.** 88% of 17
  synthetic operations is a working gate, not an operating company.
- **Integration economics are unmeasured.** The brief asks for connector #1
  versus #5 versus #10. Adericel ships five connectors; nobody timed them.

## TEST RESULTS

```
Test Files   43 passed (43)
Tests       784 passed | 6 skipped (790)
Build       tsc -b clean across 14 packages
Migrations  19 applied to a virgin database and to one at 0017
Web         builds clean; control room rendered against live data
```

New in this work: 34 autonomy policy tests, 27 VAOL authority tests, 13 control
room tests, 20 operating cycle tests.

Three guards were verified by breaking them and confirming the tests fail:
the UNKNOWN rule, the tenancy barrier, and (earlier) source conflict detection.

## AUTONOMY SCORECARD

Current maturity is **L0 for every process** because nothing is running in
production. This is measured, not assumed: the registry is seeded at zero and
only the acceptance test raises anything.

| Process                   | Current         | Target | Boundary                 | Intervention rate | Known failure modes                                          | Next step                       |
| ------------------------- | --------------- | ------ | ------------------------ | ----------------- | ------------------------------------------------------------ | ------------------------------- |
| market.prospect_discovery | L0 (L3 in test) | L4     | Which markets to enter   | 0% in test        | No data source; enrichment is supplied                       | Integrate a company data source |
| sales.qualification       | L0 (L3 in test) | L4     | Strategic accounts       | 0% in test        | Refuses incomplete records — correct, but nothing fills them | Automate enrichment first       |
| sales.outreach            | L0 (L3 in test) | L3     | First-contact wording    | 0% in test        | No sender; no bounce or reply handling                       | Integrate an email provider     |
| sales.proposal            | L0              | L3     | Pricing and commitments  | —                 | Not implemented                                              | Templates and an approval route |
| legal.contract            | L0              | L2     | All legal judgement      | —                 | Prepare only, by design                                      | Signature integration           |
| onboarding.tenant         | L0              | L5     | Exceptions only          | —                 | Adericel's own signup does this; not driven through VAOL     | Route signup through the gate   |
| onboarding.integrations   | L0              | L4     | Customer consent         | —                 | Not implemented                                              | Microsoft consent flow          |
| customer_ops.health       | L0              | L5     | Exceptions only          | —                 | Not implemented                                              | Consume integration health      |
| customer_ops.reporting    | L0              | L4     | Unsupported claims       | —                 | Not implemented                                              | Passport already exists         |
| support.triage            | L0              | L5     | Exceptions only          | —                 | Not implemented                                              | Needs an inbound channel        |
| support.resolution        | L0              | L4     | Customer environments    | —                 | Not implemented                                              | —                               |
| billing.subscription      | L0              | L4     | Disputes and refunds     | —                 | Adericel bills; not through the gate                         | Route billing through the gate  |
| billing.dunning           | L0              | L4     | Suspension, write-off    | —                 | Grace period exists in Adericel                              | Wire to the gate                |
| finance.payments          | L0              | **L0** | All of it                | —                 | **Refused by design**                                        | None. Ever.                     |
| security.monitoring       | L0              | L4     | Critical events          | —                 | Not implemented                                              | Adericel can assess Veylith     |
| security.response         | L0              | L3     | Containment              | —                 | ESCALATE only, by design                                     | Define escalation contacts      |
| engineering.ci            | L0              | L5     | Exceptions only          | —                 | Not implemented                                              | —                               |
| engineering.dependencies  | L0              | L4     | Authority-path changes   | —                 | Not implemented                                              | —                               |
| engineering.deployment    | L0              | L2     | All deployment authority | —                 | Approval only, by design                                     | —                               |
| product.feedback          | L0              | L4     | Prioritisation           | —                 | Not implemented                                              | —                               |
| strategy.direction        | L0              | **L1** | All of it                | —                 | **Refused by design**                                        | None.                           |

Two processes have a target at or below their current level on purpose.
`finance.payments` and `strategy.direction` are marked as not automation
candidates, contribute nothing to the backlog, and the policy refuses them
outright.

## DEFINITION OF DONE — against the brief's twenty criteria

| #   | Criterion                                        | State                                                         |
| --- | ------------------------------------------------ | ------------------------------------------------------------- |
| 1   | Operating model explicitly represented           | Yes — 21 processes, as data                                   |
| 2   | Autonomous workflows for routine processes       | **Partial** — the pipeline only                               |
| 3   | Human authority enforced technically             | Yes, and adversarially tested                                 |
| 4   | Exceptions surfaced automatically                | Yes                                                           |
| 5   | Material actions auditable                       | Yes                                                           |
| 6   | Automation idempotent                            | Yes, claim-before-effect                                      |
| 7   | Failure recovery exists                          | **Partial** — detection and escalation; no automatic recovery |
| 8   | Security boundaries tested                       | Yes                                                           |
| 9   | Adericel's invariants intact                     | Yes — 779 tests, none changed in meaning                      |
| 10  | n8n remains orchestration                        | Yes — untouched, and VAOL does not depend on it               |
| 11  | AI cannot bypass deterministic authority         | **Untested** — no AI is wired in                              |
| 12  | Control room exposes company state               | Yes                                                           |
| 13  | Human intervention measurable                    | Yes                                                           |
| 14  | Automation effectiveness measurable              | Yes                                                           |
| 15  | Manual processes identified                      | Yes — the scorecard above                                     |
| 16  | Repository builds and tests                      | Yes                                                           |
| 17  | Existing tests still pass                        | Yes                                                           |
| 18  | New security tests pass                          | Yes                                                           |
| 19  | End-to-end autonomous workflows demonstrated     | Yes — the acceptance test                                     |
| 20  | Claims backed by tests or labelled unimplemented | Yes — that is this document                                   |

## GAP REGISTER — every remaining manual dependency

1. Finding prospects. 2. Researching them. 3. Writing outreach content.
2. Approving it. 5. Replying to responses. 6. Running discovery calls.
3. Demonstrations. 8. Pricing. 9. Contracts and signature. 10. Connecting a
   customer's Microsoft tenant. 11. Everything in support. 12. Invoicing decisions.
4. All payments. 14. Veylith's own security monitoring. 15. All deployment.
5. Product prioritisation. 17. Strategy.

Items 13, 15 and 17 are intended to stay manual. The rest are the backlog.

## WHAT I WOULD DO NEXT, IN ORDER

1. **Route Adericel's own signup and billing through the gate.** Those workflows
   Those workflows already exist and already run; putting them behind `operate`
   would take the automation ratio from a test figure to a real one.
2. **An email provider**, which unblocks the whole outreach half of the pipeline.
3. **Veylith as its own Adericel customer** (§35). The dogfooding the brief asks
   for, and the fastest route to security monitoring.
4. **A database constraint** that a state change carries a policy decision.

---

### The honest summary

The company now has an authority model it cannot talk itself out of, an
escalation path that exists before the automation that needs it, and honest
measurement that will report bad news. That is the foundation the brief asks for
and it is genuinely built.

What it does not have is a company running on it. One MSP would teach more than
another ten thousand lines of this.
