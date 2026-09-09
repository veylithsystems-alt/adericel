# Adericel threat model

Adericel holds, for many organisations at once, a description of where their
security is weak — and credentials that reach into the systems that weakness
lives in. That combination makes it a more attractive target than most of what
it monitors.

This document states what Adericel is defending, from whom, what is done about
it, and — the part that is usually missing — what is **not** covered.

Reviewed against the current implementation on 2026-09-09.

---

## What is worth stealing

In descending order of harm:

1. **Integration credentials.** A credential for a customer's identity provider
   with permission to disable accounts and change authentication policy. A
   disclosure here compromises the customer, not merely Adericel.
2. **Cross-tenant assurance data.** A ranked list of every unfixed weakness
   across eighty organisations is a target package for whoever obtains it.
3. **The ability to execute actions.** Adericel can disable accounts and change
   authentication policy by design. An attacker who can propose _and_ approve
   has a remote administration channel into every connected tenant.
4. **The integrity of assurance history.** Silently changing what Adericel
   recorded — turning a finding into a pass — corrupts the evidence a customer
   would rely on after an incident. Quieter than theft and, in a dispute, worse.
5. **Identity and audit data.** Who did what, and when.

## Who is attacking

| Actor                           | Capability                                | Primary goal                          |
| ------------------------------- | ----------------------------------------- | ------------------------------------- |
| Opportunistic internet attacker | Scanning, known CVEs, credential stuffing | Any foothold                          |
| Authenticated tenant user       | A valid account in one organisation       | Reach another organisation            |
| Malicious MSP operator          | Legitimate access to their own portfolio  | Reach another MSP's customers         |
| Compromised integration vendor  | Controls responses Adericel ingests       | Poison assurance conclusions; SSRF    |
| Insider at the operator         | Database or host access                   | Data theft; silent history alteration |
| Supply-chain attacker           | A dependency or base image                | Code execution in the API             |

Explicitly out of scope: a nation-state adversary with physical access to the
host, and the operator colluding with an attacker against their own customers.
Neither is defended by architecture, and pretending otherwise would misdescribe
the product.

---

## Threats and what is done about them

### T1 — Cross-tenant read or write

_The defining risk of the product._ A user of organisation A reaches
organisation B's data.

**Controls.** Three independent layers (ADR-0007): authority is resolved from
the principal's grants against ownership loaded from the database, never from a
caller-supplied tenant id; PostgreSQL row-level security with
`FORCE ROW LEVEL SECURITY` on every tenant table, applied to a role that is not
the table owner; and fail-closed defaults, so a query issued without tenant
context returns zero rows rather than everything.

**Verification.** `tests/tenancy` attacks the boundary through the API, directly
through the database layer with the wrong context, and with no context at all.
One test is structural rather than enumerated: any table carrying an
`organisation_id` column must have a forced policy, so a new table added without
one fails CI. That test found a real gap — `subscriptions` — which migration
`0008` closes.

**Residual risk.** The MSP dimension is the subtle part: an MSP operator
legitimately reads across organisations, and the correctness of that widening
depends on the ownership set loaded per request. It is tested directly and it is
the area most worth re-reviewing on every change.

### T2 — Credential disclosure from the database

**Controls.** AES-256-GCM sealing with the integration id as additional
authenticated data, so a sealed value cannot be relocated to another integration
record and decrypted (ADR-0019). The key lives in the environment, never in the
database. No API endpoint returns a credential; replacement is the only
operation. Passwords are salted, hashed and peppered with material held outside
the database. Refresh tokens are stored hashed.

**Residual risk.** Explicitly **not covered**: an attacker with code execution
on the API container. The key is in that process's memory by necessity.
Mitigation there is host hardening, egress restriction and detection — not
cryptography. Key rotation is currently a re-seal of every credential; envelope
encryption with per-organisation data keys is the recorded next step.

### T3 — Unauthorised action execution

An attacker who can make Adericel change a customer's production systems.

**Controls.** The proposer cannot approve. `org:action:approve` is held by roles
that do not hold `org:action:propose`. And — the strongest form — the permission
is refused to any principal that is not a `USER`, checked before any grant is
examined, so no scope or role combination reaches it (ADR-0015). n8n, API keys
and any AI agent authenticate as non-human principals. **There is no
configuration in which Adericel approves its own actions.**

Execution runs under credentials scoped to one integration, and only against
capabilities the connector declares. High-risk classes require explicit approval
regardless of the organisation's autonomy level.

**Verification.** `packages/domain/src/authz.test.ts` asserts the refusal for
every non-human principal type, including one holding a platform grant.
`tests/e2e` asserts that a proposer's own approval and an execute-before-approve
are both refused over real HTTP.

**Residual risk.** A compromised _human_ approver account. Mitigated by session
handling and audit, not prevented. This is the reason approval is a distinct
role rather than an attribute of seniority.

### T4 — Server-side request forgery through integrations

A customer configures an endpoint; Adericel's server makes a request to it. The
canonical path to a cloud metadata service.

**Controls.** All connector HTTP goes through one client
(`packages/integrations/src/http.ts`) which resolves DNS **first** and rejects
private, loopback, link-local and carrier-grade NAT destinations before
connecting — checking a hostname before resolution permits a DNS record that
resolves inward. Redirects are re-checked. An allow-list is supported and the
block is on by default.

**Residual risk.** DNS rebinding between the check and the connection. Narrowed
by connecting to the resolved address, and not eliminated in every runtime path.

### T5 — Poisoned data from a compromised vendor

An integration returns crafted data intended to produce a false conclusion.

**Controls.** Connectors normalise to canonical observations and cannot express
a conclusion (ADR-0013). Vendor-supplied timestamps become `observed_at` and
never affect ordering (ADR-0010). Partial collections are explicit, so
truncated data resolves to UNKNOWN rather than to a conclusion drawn from half
the estate. Evidence provenance records which integration and credential
produced each fact.

**Residual risk.** A vendor that lies consistently and plausibly will be
believed. This is irreducible for any system that reads external state; the
mitigation is that provenance is recorded, so the blast radius is identifiable
afterwards.

### T6 — AI output treated as truth

**Controls.** AI-derived claims carry provenance `AI_SUGGESTED` and
`isRuleEligible()` refuses them to the Truth Engine until a named human
confirms (ADR-0004). There is no flag that changes this. Confidence is never
rendered as an assurance quantity. The `ai` profile can be stopped entirely with
no effect on the assurance chain.

**Residual risk.** Prompt injection through evidence documents can produce a
misleading _suggestion_. It cannot produce an assurance state, and the human
confirmation step is where it is caught — which means the quality of that step
is a real control and is presented as such in the interface, not as a rubber
stamp.

### T7 — Silent alteration of assurance history

**Controls.** Assessments, evidence records, events and the audit log are
append-only with `bigserial` ordering that survives clock skew (ADR-0010).
Evidence is superseded, never overwritten, and revocation is a recorded fact.
Assessments store their ruleset hash and input digest, so a replay that
disagrees is detectable.

**Residual risk.** An operator with direct database access can alter rows.
Detectable through the disagreement between a stored assessment and its replay,
and through backup comparison; not prevented. Stated plainly rather than
implied — the product does not claim tamper-proofing it does not have.

### T8 — Authentication attacks

**Controls.** Identity carries no authority (ADR-0008): a stolen token grants
nothing by itself, and revoking a grant takes effect on the next request rather
than at token expiry. HS256 with the algorithm asserted rather than read from the
token, and constant-time signature comparison. Uniform responses and uniform
timing across unknown email, wrong password and locked account. Lockout with an
explicit `locked_until` that a subsequent failure cannot accidentally clear or
extend. Refresh tokens rotate on use, so replay invalidates the legitimate
session visibly. Rate limiting at the edge and in the API.

**Residual risk.** No second factor on Adericel accounts yet. For a product that
assesses other people's multi-factor coverage this is the most conspicuous gap
in this document, and it is the highest-priority security item outstanding.

### T9 — Supply-chain compromise

**Controls.** Pinned dependencies with a committed lockfile; pinned base image
digests; `pnpm audit` at high severity and above in CI; CodeQL with the extended
security query set; Dependabot grouped so updates are actually read; production
images built without the development toolchain and without the interface's
dependency tree; tracked files scanned for credential-shaped material.

**Residual risk.** A compromised popular package that passes audit. Reduced by a
deliberately small dependency surface — JWT, S3 SigV4 and canonical JSON are
implemented directly rather than pulled in — and not eliminated.

### T10 — Denial of service

**Controls.** Rate limiting, body size caps, statement timeouts, bounded
connection pools, per-service memory limits with Node heaps capped below them,
and a CPU cap on inference so a local model cannot starve the database.

**Residual risk.** A single VPS has no capacity headroom. Accepted and stated in
`docs/operations/vps-sizing.md`; availability is not what this deployment tier
is selling.

### T11 — The n8n instance

n8n holds an Adericel API key and runs with `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
so workflows can read configuration.

**Controls.** The key belongs to a service principal, which by T3 cannot approve
anything. n8n never touches the database — there is no PostgreSQL node in the
export. It is served on its own hostname, outside Adericel's origin, cookie
scope and CSP. Inbound webhooks are HMAC-signed with a timestamp window.

**Residual risk.** Anyone who can edit workflows on that instance can read its
environment and use its API key within that principal's permissions. The
instance is an operator tool and should be treated as one: it is not a customer
surface, and it should not be given credentials beyond Adericel's own.

---

## What this model does not cover

Stated so that nobody has to infer it:

- **Host compromise.** Code execution on the API container defeats T2. There is
  no in-application defence against it.
- **A malicious operator.** Adericel's operator can read every tenant's data. The
  control is contractual and organisational, not technical, and self-hosting
  exists for MSPs who will not accept that.
- **Tamper-evidence against the database owner.** T7's controls make alteration
  detectable in practice, not cryptographically impossible.
- **Availability guarantees on the single-VPS tier.**
- **Second-factor authentication on Adericel itself.** Outstanding, and the top
  of the list.

## Outstanding security work

In priority order:

1. Multi-factor authentication for Adericel accounts (T8).
2. Envelope encryption with per-organisation data keys and a KMS-backed key
   provider (T2, ADR-0019).
3. Signed release artefacts and a published SBOM (T9).
4. DNS-rebinding hardening on every connector path (T4).
5. An automated restore test in CI against a synthetic dataset (ADR-0020).
