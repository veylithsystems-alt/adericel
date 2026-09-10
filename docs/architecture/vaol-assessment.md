# VAOL — architecture assessment before implementation

**Required by §3 of the operating brief: inspect before modifying.**

## What exists and is reusable

| Asset | State | Reuse |
| --- | --- | --- |
| PostgreSQL + forced RLS, `withTenant`/`withPlatform` | Solid | Yes — but see the tenancy finding below |
| Transactional outbox (`FOR UPDATE SKIP LOCKED`) | Solid | Yes, directly |
| `scheduled_jobs` with cron, locking, last-status | Solid | Yes, directly |
| Domain event log with actor/correlation/idempotency | Solid | Pattern reused, vocabulary is not |
| Action lifecycle: propose → authorise → execute → verify | Solid | Pattern reused |
| Approval + four-eyes + MFA step-up | Solid | Pattern reused |
| Autonomy levels L0–L5 | Solid | Reused directly |
| `packages/policy` action policy engine | Solid **for Adericel** | See finding 2 |
| Envelope encryption, sealed credentials | Solid | Yes, directly |
| Integration fabric, capability manifests | Solid | Yes — VAOL consumes it |
| `exceptions` table | **Not reusable** | It is an *assurance* exception (a control deliberately waived), not an operational exception queue. Different thing, same word. |

## Finding 1 — internal company state is not tenant data

Every table in `adericel` carries `organisation_id` and forced RLS. That is correct
for customer data and **wrong** for Veylith's own operating state.

A prospect that is not yet a customer has no `organisation_id`. A lead, an
outreach record, an internal exception, a policy decision about whether to send
an email — none of these belong to a tenant, and putting them in a tenant-scoped
schema with a nullable `organisation_id` would mean the RLS predicate
`tenant_visible(organisation_id)` evaluates permissively for them. Internal
commercial data would then be reachable from a tenant connection.

**Decision: a separate `veylith` schema, not in the tenant `search_path`, with
no RLS policy granting tenant access.** The tenant application role gets no
privileges on it at all. This is a hard boundary that can be tested — and will
be, adversarially.

## Finding 2 — the existing policy engine cannot express a company decision

`PolicyQuestion` is:

```ts
{ actionType, riskClass, findingSeverity, organisationAutonomyLevel,
  recentExecutions, utcHour, proposerUserId }
```

It is shaped entirely around remediating a finding on a customer estate. It
cannot express "may the system send this outbound email to this prospect", which
needs consent state, contract state, a communication cap and a reputational risk
class that has nothing to do with `ActionRiskClass`.

More importantly:

```ts
POLICY_OUTCOMES = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY']
```

§18 of the brief requires **PERMIT / DENY / REQUIRE_APPROVAL / ESCALATE /
UNKNOWN**, and states: *UNKNOWN must never silently become PERMIT.* The current
engine has no way to say "I could not determine this" — an unanswerable question
falls through to a default rule and becomes a decision.

**Decision: a new, domain-neutral autonomy policy engine in `packages/autonomy`.**
Adericel's action policy is left exactly as it is (§2.5: do not corrupt the
existing architecture). The new engine carries the five-valued outcome and treats
an undetermined input as `UNKNOWN`, which never resolves to permission.

## Finding 3 — the company has no event vocabulary

`EVENT_TYPES` is assurance vocabulary (`ClaimChanged`, `AssuranceStateChanged`).
Business events (`LEAD_QUALIFIED`, `PAYMENT_FAILED`, `APPROVAL_REQUIRED`) are a
different model with a different audience and different retention. Mixing them
would put commercial pipeline data into a tenant's event stream.

**Decision: `veylith.business_events`, same discipline — actor, authority,
policy, reason, correlation id, idempotency key, result — different vocabulary
and a different home.**

## Finding 4 — there is no exception queue, and it is the most important system

§19: *humans deal with exceptions, not workflows.* Nothing in the repository
implements this. Without it, autonomy has no safe failure mode: an automation
that cannot proceed currently either throws, retries forever, or silently does
nothing.

**Decision: `veylith.operational_exceptions` is built first**, before any
automation that could raise one. Building automation before its escalation path
would be building the exact thing the brief warns against.

## Finding 5 — autonomy is unmeasured

§20 requires automation ratio, human intervention rate, human minutes per
customer, exception rate, autonomous resolution rate, verification rate. None of
these can be computed today because no record distinguishes "a human did this"
from "the system did this".

**Decision: every business event records whether a human was in the loop**, so
the metrics are derived from the ledger rather than estimated.

## Build order

Deliberately bottom-up. Each layer is useless without the one below it, and
building a workflow before its authority boundary and its escalation path is how
an autonomous system ends up doing something nobody authorised.

1. Schema: `veylith` boundary, business events, exceptions, policy, processes.
2. `packages/autonomy`: the five-valued policy engine, pure and adversarially tested.
3. Exception engine: raise, classify, route, escalate, resolve, verify.
4. Business event ledger + autonomy metrics.
5. The company process registry and its maturity model.
6. Commercial pipeline (lead → opportunity → contract → customer) on top.
7. Control room.

## What will NOT be built, and why

- **No autonomous banking authority.** §11 is explicit and it is correct.
- **No autonomous acceptance of non-standard contractual liability.** §12.
- **No LLM in the authority path.** §26. AI may propose; it may not decide.
- **No replacement of Adericel's Truth Engine.** §2.5.
- **No commodity SaaS rebuilt to claim autonomy.** §24. Integration contracts
  with explicit external-dependency marking instead.
