# ADR-0048: Support is a disclosure surface, and it routes to the MSP

**Status:** Accepted · **Date:** 2026-09-16

## Context

Contract v3.1 §20 states plainly that support is a mandatory part of Adericel
assurance infrastructure, not a bolt-on to it, and moves it into the build order
at Phase 5 — ahead of the questionnaire autopilot. §21–26 specify the domain:
entities, 14 categories, 12 queues, 4 severities, 20 case states, prohibited
transitions, identity and entitlement validation, tenant-scoped diagnostics,
connector-health-driven proactive support, versioned knowledge and routing.

None of it existed. Zero matches for `SupportCase` anywhere in the repository.

§20 is right that this is assurance rather than service: a customer who cannot
get an answer about why a control reads UNKNOWN has an assurance problem, and
both the question and the answer come from the same evidence.

## Decision

**Two properties shape every file, and everything else follows from them.**

### 1. The §2 distribution boundary, expressed in support

Adericel is sold to MSPs. An end customer's request goes to their MSP unless a
signed agreement says otherwise. Veylith answering an MSP's customer directly is
channel conflict wearing a helpdesk.

This is structural rather than a matter of policy:

- `routeCase()` has no argument through which a requester can ask to be handled
  by Veylith. The only lever is `directSupportEntitled`, which is loaded from a
  signed record.
- `mayAssign()` refuses to move such a case into a Veylith queue afterwards.
  Routing decides where a case starts; **reassignment is how a boundary is
  actually crossed** — somebody triaging a backlog drags a case toward the team
  with the expertise, and the MSP finds out their supplier has been talking to
  their customer.
- Proactive cases (§24 — connector health, failed actions) go to the **MSP**,
  not to Veylith. The MSP owns the relationship, usually owns the credential
  that broke, and will be awake. A supplier finding out about their own
  customer's problem from their supplier is a relationship they do not keep.

**One exception, and it is deliberate.** A `SECURITY_CONCERN` reaches Veylith
security directly, whoever raised it. If the platform is the thing that is
compromised, routing through the MSP costs time and may route through an
affected party. It discloses nothing: the case is a report, and reaching the
estate still requires break-glass (ADR-0046).

**Decision D2, as recommended: build the gate, grant it to nobody.**
`direct_support_entitlements` exists because §22 requires an entitlement gate
regardless, and retrofitting one is where tenant-isolation bugs come from. It
ships empty, and a test asserts there is no `INSERT` into it anywhere in the
application — so the first agreement is a reviewed change rather than a code
path that was already sitting there.

### 2. Support is a disclosure surface

Every answer given in a case says something about somebody's estate. §22
therefore requires identity and entitlement **before disclosure**, not before
closure.

The failure this prevents is specific and common: somebody rings up, sounds
plausible, says they are from the customer, and is told which controls the
organisation is failing. That is a tenancy breach conducted entirely through a
helpdesk, and **no amount of row-level security prevents it, because the person
disclosing is authorised.**

So:

- Nothing about any organisation is disclosed while a case is `RECEIVED`,
  `IDENTITY_PENDING` or `ENTITLEMENT_PENDING` — including whether the
  organisation exists. Asserted over the whole cross product of state × kind ×
  requester, not the one case anybody would think to check.
- An identification **expires**. A case that runs three weeks and discloses an
  estate in week three on the strength of an email link clicked in week one is
  relying on something that was true once. A signed-in session is good for an
  hour, an email challenge for a day, an MSP vouching for a week.
- `DISCLOSURE_CEILING` caps what each party is _ever_ told. A client never
  learns their MSP's commercial position — the same reason the client surface
  excludes `MSP_PORTFOLIO`. A Veylith agent is never told a customer's assurance
  state, estate detail, evidence or personal data, which is §29 holding at the
  surface where it is most likely to erode, because the agent is trying to help
  and the data would help.
- `support_disclosures` records **every** decision, refused as well as
  permitted, and the organisation can read it. A gate whose refusals leave no
  trace cannot distinguish "nobody asked" from "somebody asked eleven times",
  and those are very different facts about an afternoon. A disclosure log the
  subject cannot read is a log for the discloser's benefit.

## The prohibited transitions

§21 asks for these specifically. Each is prohibited because allowing it would
let the system record something that did not happen.

| Prohibited                 | Because                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| anything → `RESOLVED`      | Resolution is reached only through `AWAITING_VERIFICATION`. A system that lets an engineer mark their own work resolved measures how confident engineers are.                 |
| `CLOSED` → `IN_PROGRESS`   | A closed case is a finished record. Work that continues is a new case linked to the old one, so the history shows two episodes rather than one that never ended.              |
| `RECEIVED` → `IN_PROGRESS` | Identity and entitlement come first. Starting work before establishing who is asking is how a stranger gets told which controls are failing.                                  |
| anything → `CLOSED`        | Closure comes from `RESOLVED`, or from `ROUTED_TO_MSP` where the MSP took it on. A case that stops mattering is `WITHDRAWN` or `REJECTED` — different facts, not resolutions. |

A further rule falls out of severity rather than the table: **an S1 or S2 is
resolved when the customer says it is.** Those are the severities where
something Adericel asserted or maintained was wrong or stale, and the customer
is the only party who can confirm it no longer is.

And three states deliberately **cannot** be withdrawn. A security report the
reporter withdraws is exactly what somebody probing the platform would do
afterwards; a data-subject request carries a statutory clock and is not
cancelled by the requester going quiet; a contractual question, once raised, is
answered.

## Diagnostic bundles

§23. The bundle is the single most dangerous artefact a support system produces:
broad by construction — that is what makes it useful — it leaves the platform,
and it is assembled at speed by somebody under pressure.

- **Tenant-scoped.** One organisation per bundle, named inside it and checked on
  assembly and on verification. A bundle spanning two tenants is not a
  convenience; it is a cross-tenant disclosure with a filename.
- **Integrity-protected.** Content-hashed over canonical JSON. A support artefact
  that can be altered in transit is a way to make an engineer chase a fault that
  does not exist — or to stop them seeing the one that does. Verification checks
  the hash **and** the tenant, because an intact bundle naming another tenant is
  an intact cross-tenant disclosure.
- **Redacted by construction, and it refuses rather than redacts.** Collectors
  return shaped data from named columns — never `SELECT *`, and never a
  connector's `last_error`, because a provider's error text routinely echoes the
  request that failed and that is how a token ends up in a field called
  "message". A field-name denylist is the second line, and it throws rather than
  dropping the field: a bundle that silently omitted something would read as
  complete, and what an engineer concludes from an absence is not what is true.
- **Not stored.** The record says a bundle was produced, for which tenant, with
  what hash. Keeping every bundle would make one table the largest concentration
  of estate detail in the platform, for the convenience of not asking again.

## Found while building it

Two, both by running it:

- **The version collector was refused by RLS.** Reading
  `public.schema_migrations` from the application failed with a tenant-isolation
  error — correctly. The ledger belongs to the migration runner, and an
  application role that could read it is one grant away from writing it. What an
  engineer actually needs is which build and which rulesets produced the
  assessment in front of them, and the process knows that already.
- **A leak assertion was catching the disclaimer.** Scanning the whole
  serialised bundle for the word "credential" hit the sentence promising there
  are none. The scan now covers `content`, which is what the collectors produce
  and therefore the only part that can widen without anyone noticing.

## Named honestly

The counts match §21 (14 categories, 12 queues, 4 severities, 20 states). Where
the contract's exact wording was not available to the author at the time of
writing, the **name** is derived from Adericel's own vocabulary and should be
reconciled against §21 before the first MSP sees it. The rules were the
priority: a wrong label is cheap to change, a wrong transition rule is not.

## What this does not build

Stated rather than implied. §25 — versioned knowledge, known issues and the AI
drafting boundary — is not here, and neither are the remaining diagnostic
collectors. Both are P2 in the gap report and tracked as **RR-065**. The
sections that have no collector return empty rather than being omitted, so a
bundle says it asked and found nothing instead of letting a reader assume there
was nothing to find.

## Evidence

- `packages/support/src/case.ts` · `routing.ts` · `entitlement.ts` ·
  `diagnostics.ts` — 52 property tests across four suites.
- `database/migrations/0031_support_domain.sql` — five tables, three
  append-only triggers, RLS on all of them, verified down and up.
- `tests/security/support-disclosure.test.ts` — 10 tests. Support does not widen
  the surface boundaries; nothing is said before somebody is identified, over
  the whole cross product; the distribution boundary has no back door.
- `tests/e2e/support-cases.test.ts` — 20 tests end to end.
- Proved by mutation: letting end-customer routing reach Veylith fails 3;
  ignoring case state in the disclosure gate fails 1; stopping the bundle
  scanner from recursing fails 3; resolving an S1 without the customer fails 1;
  dropping the case-ownership check on the route fails 1; not recording refused
  disclosures fails 1; letting a bundle cross tenants fails 1.

Closes U1, U2, U3, U4 and U8. Partially closes U5 (the `SYSTEM` requester routes
proactive cases; nothing yet raises them — RR-066).
