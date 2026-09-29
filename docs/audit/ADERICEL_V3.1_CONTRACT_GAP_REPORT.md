# Adericel v3.1 Contract Gap Report

**Audit date:** 15 September 2026
**Controlling authority:** Master Product, Engineering, Operating, Support & Build Contract **v3.1**
**Supersedes:** the v3.0 gap report, which remains on file as the prior baseline
**Audited:** `main` @ `6a71426` · working branch @ `83c52f7`
**Auditor:** Claude Code, under v3.1 §39 (Required Pre-Build Audit)

> Classified from repository evidence only — not from filenames, README claims,
> passing tests, prior briefs or the previous audit. Where v3.0 findings have
> since been closed by work in this repository, the closure is stated with its
> commit.
>
> **No material implementation was performed during this audit.**

---

## 1. Executive summary

### What changed between v3.0 and v3.1

v3.1 is not a restatement. It adds six substantial requirement families the
v3.0 audit did not assess, and they change the shape of the gap:

1. **Truth states** (§6) — `OBSERVED / VERIFIED / DERIVED / INTERPRETED /
ASSUMED / TARGET / UNKNOWN / DEGRADED / BLOCKED / FAILED` as a first-class
   vocabulary distinct from assurance state.
2. **Assurance states gain `DEGRADED` and `BLOCKED`** (§6) as peers of
   PASS/FAIL/UNKNOWN, not as reasons underneath UNKNOWN.
3. **Capability status lifecycle** (§6) — `DESIGNED → IMPLEMENTED → TESTED →
VERIFIED → OPERATIONAL → PROVEN → PRODUCTION_READY → COMMERCIAL_VALIDATED →
RETIRED`, with the explicit rule that no status may be inferred from another.
4. **Containment C0–C5 fully specified** (§15), including the separation of
   commercial entitlement control from security containment.
5. **Commercial entitlement states** (§16) — a ten-state model distinct from the
   five the repository implements.
6. **An entire support and service-operations domain** (§20–26) — 18 entities,
   14 categories, 12 queues, 4 severities, 20 case states, prohibited
   transitions, identity and entitlement validation, tenant-scoped diagnostics,
   connector-health-driven proactive support, versioned knowledge, AI drafting
   boundaries and security/privacy/commercial routing.

Support also moves **into the build order at Phase 5**, ahead of the
questionnaire autopilot, which v3.0 had at Phase 5 and v3.1 places at Phase 6.

### Current repository maturity

**Stronger than at the v3.0 audit, in ways that matter structurally.**

Since that report: `main` now holds the product (473 files, merged as
`6a71426`); the duplicate and out-of-contract PRs are closed; the direct-to-SME
path is removed and MSP-only is enforced at four layers with a database
constraint; and the residual-risk register required by §38 exists.

Measured baseline: **1,155 tests passing**, 6 skipped, 68 files. Typecheck,
lint, format, web build, dependency audit and n8n validation clean. Container
build, compose smoke deployment, migration idempotency and a **proven restore**
all exercised in CI.

### Major proven strengths

Unchanged from v3.0 and re-verified:

- **Truth Engine purity enforced structurally** — a test reads the engine's own
  source and fails on any I/O import, wall-clock read, randomness, environment
  access or mutable module state.
- **Tenant isolation** — two layers, 70 of 78 tables under `FORCE ROW LEVEL
SECURITY`, queried from the live database.
- **Three-surface boundary** — every route classified; CI fails on any
  unclassified route.
- **Six critical invariants proved by deliberate breakage**, most recently
  MSP-only (reintroducing `accountKind` fails exactly one test).

### Major production blockers

**B1 — The support domain does not exist** (§20–26). This is now the largest
single gap in the contract, and v3.1 makes it Phase 5 rather than optional. Zero
matches for `SupportCase` or `support_case` anywhere in the repository.

**B2 — Containment C0–C5 does not exist** (§15). No mechanism to isolate a
compromised integration or credential, restrict tenant operations, or perform
emergency containment while preserving evidence.

**B3 — Break-glass access does not exist** (§28). Emergency access therefore
happens outside the application with raw database credentials — unattributed,
unscoped, untimed. Precisely the "hidden permanent administrator path" the
contract forbids, arrived at by omission.

**B4 — Commercial entitlement and security containment are not separated**
(§16). The repository has one five-state subscription model doing both jobs.
v3.1 requires them to be distinct concerns that must not cascade into each
other.

### Major MSP-commercial blockers

**C1 — Questionnaire Autopilot has no intake and no persistence** (§19).
Unchanged from v3.0 and still the largest capability gap: the package is a
correct, tested library that nothing can enter or leave.

**C2 — Microsoft coverage is too shallow for Cyber Essentials v3.3** (§4, §12).
Entra emits 2 observation kinds, Intune 2. No Defender, Exchange Online, Purview
or Secure Score. Several CE v3.3 controls are currently uncoverable — they will
honestly read UNKNOWN, which is correct behaviour and an unsellable product.

**C3 — No white-label or co-branding** (§34 of v3.0 / MSP identity in v3.1).

**C4 — Channel conflict: resolved.** Closed 15 Sept 2026.

### Major security / tenant-isolation blockers

None. Isolation remains the strongest area. The security gaps are **absences**
(B2, B3) rather than weaknesses in what exists.

### Major architecture risks

**A1 — The assurance state vocabulary is narrower than v3.1 requires.** The
repository has 6 assurance states plus 10 UNKNOWN reasons. v3.1 §6 requires
`DEGRADED` and `BLOCKED` as peer states. Today a degraded connector produces
UNKNOWN with reason `COLLECTION_FAILED` — semantically honest, but it collapses
a distinction v3.1 says must not be collapsed. **This is a domain-model change
that touches the Truth Engine, and it is cheapest now.**

**A2 — No truth-state vocabulary** (§6). `OBSERVED / VERIFIED / DERIVED /
INTERPRETED / ASSUMED / TARGET` do not exist as a first-class concept. Fragments
exist — claim origins include `VERIFICATION_DERIVED` and `AI_SUGGESTED`,
collection methods include `DERIVED` — but there is no single vocabulary saying
what kind of truth a given assertion is.

**A3 — No capability status lifecycle** (§6). Nothing in the repository records
whether a capability is TESTED, VERIFIED, OPERATIONAL or PROVEN. This audit and
the risk register do that work by hand; v3.1 requires it as data.

### Immediate recommended sequence

1. **Domain vocabulary first** — truth states, DEGRADED/BLOCKED, capability
   lifecycle (A1–A3). Cheapest now; touches the Truth Engine.
2. **Containment C0–C5 + break-glass + entitlement separation** (B2, B3, B4).
3. **Support domain** (B1) — Phase 5 under v3.1.
4. **Microsoft depth for CE v3.3** (C2) — the wedge depends on it.
5. **Questionnaire pipeline** (C1).
6. **White-label** (C3), then supply chain.

Rationale in §9.

---

## 2. Status summary

| Classification     | Count  |
| ------------------ | ------ |
| GREEN — Proven     | 21     |
| AMBER — Partial    | 12     |
| RED — Missing      | 17     |
| RED — Risk         | 0      |
| GREY — Unproven    | 7      |
| DEFER              | 5      |
| **Total assessed** | **62** |

RED-RISK is zero for the first time: the three v3.0 risk items (direct-to-SME
path, duplicate implementation, out-of-contract PR) are closed. RED-MISSING has
risen from 9 to 17 because v3.1 specifies capability that v3.0 only gestured at.

### By domain

| Domain                               | GREEN | AMBER | RED-M | GREY | DEFER |
| ------------------------------------ | ----- | ----- | ----- | ---- | ----- |
| Repository & release baseline        | 3     | 1     | 1     | 1    | 0     |
| Truth, assurance & capability states | 3     | 1     | 3     | 0    | 0     |
| Assurance core & graph               | 5     | 1     | 0     | 1    | 0     |
| Truth Engine & policy                | 5     | 0     | 0     | 0    | 0     |
| Integrations & Microsoft wedge       | 2     | 3     | 1     | 1    | 0     |
| Action & autonomy                    | 4     | 1     | 0     | 1    | 0     |
| Containment & recovery               | 0     | 1     | 4     | 0    | 0     |
| Commercial entitlement & billing     | 1     | 2     | 1     | 0    | 0     |
| MSP operating system                 | 2     | 2     | 1     | 1    | 0     |
| Passport & exchange                  | 2     | 1     | 0     | 0    | 2     |
| Questionnaire autopilot              | 1     | 1     | 2     | 0    | 1     |
| Support & service operations         | 0     | 0     | 6     | 0    | 2     |
| Security & privacy                   | 5     | 0     | 0     | 1    | 0     |
| Reliability & operations             | 3     | 1     | 1     | 0    | 0     |
| Quality & release evidence           | 3     | 1     | 1     | 1    | 0     |

---

## 3. Contract requirements matrix

`main` and the working branch are now equivalent for implementation purposes
(`main` @ `6a71426` contains the merge; the branch carries three later commits
of audit and MSP-only work). Where they differ it is stated.

### 3.1 Truth, assurance and capability states — **new in v3.1**

| ID  | Requirement                                                          | Main    | Branch  | Class             | Evidence                                                                                                                              | Gap                                                             | Security impact                                                              | MSP impact                                                     | Pri    | Acceptance test                                                                    | Recommendation                           |
| --- | -------------------------------------------------------------------- | ------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| S1  | §6 Truth states OBSERVED/VERIFIED/DERIVED/INTERPRETED/ASSUMED/TARGET | Absent  | Absent  | **RED — MISSING** | Fragments only: `CLAIM_ORIGINS` has `VERIFICATION_DERIVED`, `AI_SUGGESTED`; `COLLECTION_METHODS` has `DERIVED`. No unified vocabulary | Cannot say what _kind_ of truth an assertion is                 | Low                                                                          | Medium — "why should I believe it" is the Passport's whole job | **P1** | Every assertion carries a truth state; INTERPRETED never reaches the Truth Engine  | Build as one domain module               |
| S2  | §6 Assurance states include DEGRADED and BLOCKED                     | Absent  | Absent  | **RED — MISSING** | `ASSURANCE_STATES` = SATISFIED, PARTIALLY_SATISFIED, NOT_SATISFIED, EXCEPTED, NOT_APPLICABLE, UNKNOWN. Neither DEGRADED nor BLOCKED   | Degradation collapses into UNKNOWN + reason `COLLECTION_FAILED` | Medium — a degraded evidence path reads identically to an unassessed control | **High** — §6 forbids collapsing these                         | **P1** | A failed connector yields DEGRADED, not UNKNOWN; a missing approval yields BLOCKED | Extend the enum; Truth Engine change     |
| S3  | §6 UNKNOWN reasons preserved                                         | Present | Present | **GREEN**         | 10 reasons incl. STALE_EVIDENCE, CONTRADICTORY_EVIDENCE, EVIDENCE_INTEGRITY_UNVERIFIED                                                | —                                                               | —                                                                            | —                                                              | —      | Preserve; they become reasons _under_ the widened state set                        |
| S4  | §6 Capability lifecycle DESIGNED→…→COMMERCIAL_VALIDATED              | Absent  | Absent  | **RED — MISSING** | No matches for PRODUCTION_READY, COMMERCIAL_VALIDATED as capability status                                                            | Status tracked by hand in audit documents                       | Low                                                                          | Medium — §37 documentation integrity depends on it             | **P2** | Each capability carries a status; no status inferable from another                 | Build with the release-gate record (§36) |
| S5  | §6 Coverage distinct from satisfaction                               | Present | Present | **GREEN**         | ADR-0017; no function combines them                                                                                                   | —                                                               | —                                                                            | —                                                              | —      | Preserve                                                                           |
| S6  | §5.3 AI_SUGGESTED cannot reach the Truth Engine                      | Present | Present | **GREEN**         | `isRuleEligible` refuses; engine calls it for every claim; ADR-0004                                                                   | —                                                               | —                                                                            | —                                                              | —      | Preserve                                                                           |
| S7  | §5.2 UNKNOWN never becomes PASS                                      | Present | Present | **GREEN**         | Property test over 210 combinations; proved by deliberate breakage (9 violations named)                                               | —                                                               | —                                                                            | —                                                              | —      | Preserve — exemplary                                                               |

### 3.2 Containment and recovery — §15, substantially expanded in v3.1

| ID  | Requirement                                                                                 | Class             | Evidence                                                                          | Gap                                                                                                                                  | Security impact                                        | Pri    | Recommendation                                 |
| --- | ------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------ | ---------------------------------------------- |
| K1  | C0–C5 containment hierarchy                                                                 | **RED — MISSING** | No matches outside unrelated prose                                                | Entire capability                                                                                                                    | **High** — no way to isolate a compromised integration | **P1** | Build                                          |
| K2  | Containment triggers (16 enumerated in §15)                                                 | **RED — MISSING** | —                                                                                 | No trigger model                                                                                                                     | High                                                   | **P1** | Build with K1                                  |
| K3  | Containment authority and least-disruptive response                                         | **RED — MISSING** | —                                                                                 | No authority model for containment                                                                                                   | High                                                   | **P1** | Build with K1; needs D-1                       |
| K4  | Recovery requires authority + re-observation + verification; no auto-recovery from C3/C4/C5 | **RED — MISSING** | —                                                                                 | —                                                                                                                                    | High                                                   | **P1** | Build with K1                                  |
| K5  | §28 Break-glass: scoped, time-limited, logged, revocable                                    | **RED — MISSING** | Zero matches                                                                      | Emergency access happens outside the app                                                                                             | **High**                                               | **P1** | Build                                          |
| K6  | §30 Backup/restore                                                                          | **AMBER**         | CI proves backup **and** restore (`ci.yml`), migration idempotency, compose smoke | Corruption detection unproven; BACKUP_SUCCESS / RESTORE_SUCCESS / SERVICE_RECOVERY / BUSINESS_RECOVERY not separated as claims (§30) | Medium                                                 | P2     | Add corrupted-dump test; model the four claims |

### 3.3 Support and service operations — §20–26, **entirely new in v3.1**

| ID  | Requirement                                                   | Class             | Evidence                                                                     | Pri    | Recommendation                                                     |
| --- | ------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| U1  | §21 Support domain entities (SupportCase + 17 others)         | **RED — MISSING** | Zero matches for `SupportCase`/`support_case`                                | **P1** | Build — Phase 5                                                    |
| U2  | §21 Case states and prohibited transitions                    | **RED — MISSING** | —                                                                            | **P1** | Build with U1; the prohibited transitions are the interesting part |
| U3  | §22 Identity and entitlement validation before disclosure     | **RED — MISSING** | —                                                                            | **P1** | Build on existing grant model                                      |
| U4  | §23 Tenant-scoped diagnostic bundles, integrity-protected     | **RED — MISSING** | —                                                                            | **P1** | Build; content hash primitives already exist                       |
| U5  | §24 Connector-health-driven proactive support                 | **RED — MISSING** | Connector health exists (`triage/coverage.ts`); nothing turns it into a case | **P1** | Build on existing health                                           |
| U6  | §25 Versioned knowledge + known issues + AI drafting boundary | **RED — MISSING** | —                                                                            | **P2** | Build after U1–U5                                                  |
| U7  | §26 Security / privacy / commercial routing                   | **DEFER → P2**    | Underlying privacy processes exist (erasure, retention, ADR-0032)            | P2     | Route into U1 once it exists                                       |
| U8  | §20 Default end-customer routing to MSP                       | **DEFER → P1**    | No support system to route                                                   | P1     | Build with U1 — this is the §2 boundary in support form            |

> **Why RED rather than DEFER**, reversing the v3.0 classification: v3.1 §40
> places support at Phase 5 and §20 states plainly that "support is a mandatory
> part of Adericel assurance infrastructure". It is no longer optional pending a
> first customer.

### 3.4 Commercial entitlement and billing — §16

| ID  | Requirement                                                     | Class             | Evidence                                                                          | Gap                                                                                                                                                | Pri              | Recommendation                                                |
| --- | --------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| E1  | §16 Ten-state commercial model                                  | **RED — MISSING** | `SUBSCRIPTION_STATUSES` = TRIAL, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED (5)       | No DRAFT, PAYMENT_PLAN, COMMERCIAL_RESTRICTION, COMMERCIAL_SUSPENSION, TERMINATED, ARCHIVED, UNKNOWN                                               | **P2**           | Extend                                                        |
| E2  | §16 Commercial restriction must not become security containment | **AMBER**         | ADR-0027 gets the _principle_ right: a lapse stops assertion but keeps the record | The separation is by convention, not by type. With no containment model there is nothing to conflate it _with_ — the risk arrives when K1 is built | **P1** (with K1) | Model them as distinct concerns from the start                |
| E3  | §16 Provider-neutral, replaceable                               | **GREEN**         | `packages/billing`; manual + Stripe; provider interface                           | —                                                                                                                                                  | —                | Preserve                                                      |
| E4  | §16 Billing never assurance truth                               | **AMBER**         | No path from payment to assurance state                                           | Not adversarially tested                                                                                                                           | P2               | Add a test asserting no billing field can reach an assessment |

### 3.5 Repository, release and evidence

| ID  | Requirement                                                                       | Class             | Evidence                                                                                                                  | Recommendation                           |
| --- | --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| R1  | §39 Product on a reviewed trunk                                                   | **GREEN**         | PR #1 merged `6a71426`; `main` = 473 files                                                                                | Preserve; work in smaller PRs now        |
| R2  | §0 No duplicate truth sources                                                     | **GREEN**         | PR #3 closed as superseded                                                                                                | Preserve                                 |
| R3  | §2 No out-of-contract product in the repo                                         | **GREEN**         | PR #2 closed                                                                                                              | Preserve                                 |
| R4  | §38 Residual-risk register                                                        | **GREEN**         | `docs/audit/RESIDUAL_RISK_REGISTER.md`, 16 entries with the §38 fields                                                    | Extend with v3.1 findings                |
| R5  | §36 Standard release and capability gate (10 conditions, release evidence record) | **RED — MISSING** | No release record exists; no tag cut                                                                                      | Build with S4                            |
| R6  | §37 Documentation integrity enforced                                              | **GREY**          | Placeholder scan clean; README claims spot-checked; three stale counts corrected; ADR-0016's overclaiming title corrected | Not systematically enforced — add a test |
| R7  | §37 FACT / ASSUMPTION / TARGET / PROVEN_RESULT distinction                        | **AMBER**         | Observed in practice (e.g. `packages/value` refuses unsubstantiated figures)                                              | Not a documented convention; formalise   |

### 3.6 Testing taxonomy — §35

Distinguishing **missing script** from **missing capability**, because they are
not the same finding:

| Suite                     | Script | Capability                                                                      | Class               |
| ------------------------- | ------ | ------------------------------------------------------------------------------- | ------------------- |
| `test:unit`               | ✓      | ✓                                                                               | **GREEN**           |
| `test:integration`        | ✓      | ✓                                                                               | **GREEN**           |
| `test:tenancy`            | ✓      | ✓                                                                               | **GREEN**           |
| `test:security`           | ✓      | ✓                                                                               | **GREEN**           |
| `test:e2e`                | ✓      | ✓                                                                               | **GREEN**           |
| `test:connector-contract` | ✗      | ✓ — `packages/integrations/src/conformance.test.ts`, `manifest-honesty.test.ts` | **AMBER** — name it |
| `test:property`           | ✗      | ✓ — no-silent-yes over 210 combinations; engine purity                          | **AMBER** — name it |
| `test:restore`            | ✗      | ✓ — CI `images` job runs `restore.sh` against a real dump                       | **AMBER** — name it |
| `test:questionnaire`      | ✗      | Partial — `render.test.ts` only; no pipeline to test                            | **AMBER**           |
| `test:mutation`           | ✗      | Manual — six invariants proved by hand, recorded in commits                     | **GREY** — automate |
| `test:load`               | ✗      | ✗                                                                               | **RED — MISSING**   |
| `test:soak`               | ✗      | ✗                                                                               | **RED — MISSING**   |
| `test:chaos`              | ✗      | ✗                                                                               | **RED — MISSING**   |
| `test:containment`        | ✗      | ✗ (nothing to test yet)                                                         | **RED — MISSING**   |
| `test:support`            | ✗      | ✗ (nothing to test yet)                                                         | **RED — MISSING**   |

### 3.7 Carried forward from v3.0, re-verified

| ID    | Requirement                                                                  | Class             | Note                                                                                                                      |
| ----- | ---------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| G1–G5 | §7 Assurance Graph, evidence fabric, supersession, historical reconstruction | **GREEN**         | Unchanged                                                                                                                 |
| G6    | §8 Consequence reasoning across the graph                                    | **GREY**          | Data model supports it; no code walks it. **Until this exists the "Digital Assurance Twin" claim must not be made** (§42) |
| T1–T6 | §11 Truth Engine                                                             | **GREEN**         | Purity enforced structurally                                                                                              |
| I2/I3 | §12 Entra / Intune                                                           | **AMBER**         | Real Graph v1.0 client-credentials; 2 observation kinds each                                                              |
| I4    | §12 M365 security surfaces                                                   | **RED — MISSING** | Blocks CE v3.3                                                                                                            |
| I7    | §12 Live-tenant validation                                                   | **GREY**          | Never run against a real Microsoft tenant                                                                                 |
| A1–A4 | §14 Autonomy L0–L5, action chain, four-eyes, verification                    | **GREEN**         | L0–L5 match v3.1 exactly                                                                                                  |
| A5    | §14 Rollback/recovery per action                                             | **AMBER**         | Reconciliation and dead-letter exist; explicit rollback does not                                                          |
| M1    | §3 Exception Operating System                                                | **GREEN**         | `packages/triage`; ranked, explained                                                                                      |
| M3    | §2 No direct-to-SME                                                          | **GREEN**         | **Closed 15 Sept** — four layers + DB constraint; ADR-0042                                                                |
| M4    | MSP white-label                                                              | **RED — MISSING** | Zero matches                                                                                                              |
| P1/P2 | §18 Passport + independent verification                                      | **GREEN**         | Ed25519, offline verifier, published schemas                                                                              |
| Q1    | §19 No silent yes                                                            | **GREEN**         | Property-tested, proved by breakage                                                                                       |
| Q2/Q3 | §19 Intake and persistence                                                   | **RED — MISSING** | Nothing enters or leaves                                                                                                  |
| X1–X6 | §28 Security architecture                                                    | **GREEN**         | 70/78 FORCE RLS, three surfaces, envelope encryption                                                                      |
| X5    | RLS exemptions documented                                                    | **GREY**          | Eight control-plane tables; rationale unwritten                                                                           |
| O1–O3 | §30 Outbox, n8n boundary, container build                                    | **GREEN**         | 25 workflows, 236 nodes, validated                                                                                        |
| O5    | §28 SBOM, signed releases                                                    | **RED — MISSING** | Blocks enterprise procurement                                                                                             |

### 3.8 User experience — §32

| Surface     | State             | Evidence                           |
| ----------- | ----------------- | ---------------------------------- |
| ASSURANCE   | **GREEN**         | `apps/web/src/pages/Assurance.tsx` |
| FIX         | **GREEN**         | `Fix.tsx`                          |
| PROOF       | **GREEN**         | `Proof.tsx`                        |
| CHANGE      | **GREEN**         | `Change.tsx`                       |
| ASK         | **GREEN**         | `Ask.tsx`                          |
| **SUPPORT** | **RED — MISSING** | No page; no domain behind it       |

> The five operational surfaces v3.1 §32 names already exist and are already
> the product's conceptual centre rather than a dashboard. This is the clearest
> single piece of evidence that the repository was built toward this contract's
> intent before the contract named it.

---

## 4. Architecture assessment

### Package boundaries

Sixteen packages; dependency direction acyclic:
`shared` → `domain` → {`graph`, `evidence`, `policy`, `truth-engine`} →
{`actions`, `integrations`, `triage`, `value`, `questionnaire`, `inference`} →
`apps`.

### Canonical source-of-truth boundaries — correct and defended

- **Assurance truth** — Truth Engine only.
- **Authority** — `policy` + `autonomy`, never the caller.
- **Tenancy** — resolved from the authenticated principal, enforced again by RLS.
- **Evidence** — append-only with supersession.
- **Commercial** — `billing`, structurally unable to reach an assessment.

### Duplicate / competing truth sources

**None outstanding.** The v3.0 instance (PR #3) is closed. `vaol` and `value`
remain worth a boundary note before either grows.

### What prevents the Digital Assurance Twin (§8)

Two things, both additive rather than structural:

1. **No consequence reasoning** (G6) — the model supports it; no code walks it.
2. **No truth-state vocabulary** (S1) — the twin must distinguish what is
   observed from what is interpreted, and cannot currently say which is which.

Neither requires redesign. Both are cheapest now.

### Safe to preserve

Truth Engine, evidence fabric, graph, tenancy, three surfaces, action lifecycle,
autonomy levels, Passport and interchange, inference layer, connector contract,
n8n boundary, CI gates, the five UX surfaces.

### Requiring modification

- Widen assurance states with DEGRADED and BLOCKED (S2) — Truth Engine change.
- Add truth states (S1) and capability lifecycle (S4).
- Extend commercial states (E1) and separate them from containment (E2).
- Deepen Entra/Intune (I2/I3).
- Document RLS exemptions (X5).

### Requiring replacement

**None.** No existing code materially conflicts with v3.1.

---

## 5. Security assessment

| Area                | State               | Note                                                                                       |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Tenant isolation    | **Strong**          | Two layers; 70/78 FORCE RLS; adversarial suite                                             |
| RLS                 | **Strong, one gap** | Eight control-plane exemptions undocumented (X5)                                           |
| AuthN / AuthZ / MFA | **Strong**          | Step-up on approval; grant-resolved authority                                              |
| Secrets             | **Strong**          | Per-organisation envelope encryption; issuer key separately established; CI secret scan    |
| API security        | **Strong**          | Zod validation; per-route limits; every route surface-classified                           |
| Integration egress  | **Strong**          | Allowlist, private-range blocking, DNS-rebinding hardening                                 |
| Auditability        | **Strong**          | Append-only; correlation across API, worker, n8n                                           |
| **Containment**     | **Absent**          | K1–K4                                                                                      |
| **Break-glass**     | **Absent**          | K5                                                                                         |
| Backup / recovery   | **Good**            | Backup and restore proven in CI; corruption detection and the four-claim separation absent |

**Material risks:** the two absences above, plus the undocumented RLS exemption
list. Nothing that exists is weak; what is missing is missing.

---

## 6. MSP readiness assessment

**Genuinely MSP-first, and now consistently so.** The v3.0 contradiction is
closed: there is no direct-to-SME path, enforced at four layers including the
database.

| Capability                 | State                                                          |
| -------------------------- | -------------------------------------------------------------- |
| Portfolio operation        | Ready — proven against a synthetic 100-customer portfolio only |
| Exception Operating System | Ready                                                          |
| Microsoft wedge            | **Partial** — the binding constraint on first revenue          |
| Onboarding / offboarding   | Ready                                                          |
| Reporting / Passport       | Strong, including independent verification                     |
| **Partner support**        | **Absent** — now Phase 5, not optional                         |
| Billing / entitlements     | Partial — 5 states against v3.1's 10                           |
| Value measurement          | Ready and honest — refuses unsubstantiated figures             |
| **White-label**            | **Absent**                                                     |

**Channel-conflict risk: none.**

---

## 7. Production readiness assessment

Per §6's capability lifecycle and §44:

| Status                   | What qualifies                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IMPLEMENTED**          | Assurance core, Truth Engine, graph, evidence, actions, autonomy, tenancy, three surfaces, Passport + signed interchange, inference, billing, onboarding, offboarding, triage, value, n8n export, five UX surfaces |
| **TESTED**               | All of the above — 1,155 tests                                                                                                                                                                                     |
| **VERIFIED**             | Tenant isolation, no-silent-yes, Truth Engine purity, keyId binding, injection containment, sovereignty gate, MSP-only — each proved by deliberate breakage                                                        |
| **OPERATIONAL**          | Container build, compose smoke, migration idempotency, backup **and** restore, readiness probes — all in CI                                                                                                        |
| **PROVEN**               | **Nothing.** No capability has run with a real customer                                                                                                                                                            |
| **PRODUCTION_READY**     | **Nothing**, and §44 is explicit about why: no containment, no break-glass, no support workflow, no operational owner, no release record                                                                           |
| **COMMERCIAL_VALIDATED** | **Nothing**                                                                                                                                                                                                        |

**Required production gates not met:** containment and recovery (K1–K5); support
workflow (U1–U5); release evidence record (R5); alert ownership; one real MSP
portfolio.

> Adericel is **not production-ready**, and nothing in this repository says
> otherwise.

---

## 8. False-capability and placeholder review

**Placeholder scan: clean.** No TODO/FIXME/HACK/NotImplemented/stub markers in
production source. The four matches are prose stating something is _not_ a stub.

**Mocks resembling real capability:** one, honestly gated — `demo-fixture` is
refused when `nodeEnv === 'production'`.

**Documentation claims not backed by implementation:** none found. Four stale
claims were corrected during this work cycle: the ADR count, the n8n
workflow/node counts, ADR-0016's title ("Exactly-once external effects", whose
own body denied the claim), and ADR-0027's "Exactly once" bullet.

**Tests failing to establish the claimed property:** none identified. The
mutation exercises demonstrate the opposite.

**Missing negative / adversarial tests:** cross-tenant leakage through portfolio
aggregation; backup corruption detection; RLS exemption-list stability; no
billing field reachable from an assessment (E4).

**Required documentation corrections:** RLS exemption rationale (X5); the
FACT/ASSUMPTION/TARGET/PROVEN distinction as a stated convention (R7).

---

## 9. Recommended implementation sequence

### Sequence 1 — Domain vocabulary (P1)

**Problem:** v3.1 requires truth states, DEGRADED/BLOCKED assurance states and a
capability lifecycle. None exists.
**Contract:** §6.
**Existing state:** 6 assurance states + 10 UNKNOWN reasons; fragments of truth
kind across claim origins and collection methods.
**Smallest safe change:** one `truth-state.ts` in `packages/domain`; extend
`ASSURANCE_STATES` with DEGRADED and BLOCKED; teach the Truth Engine to emit
them where a dependency is impaired or an input is blocked.
**Security implications:** positive — a degraded evidence path stops being
indistinguishable from an unassessed control.
**MSP value:** an MSP can tell "we cannot see this" from "this is broken", which
is the difference between a connector ticket and a customer conversation.
**Tests:** a failed connector yields DEGRADED not UNKNOWN; a missing approval
yields BLOCKED; property test extended across the widened set; mutation test
that collapsing DEGRADED into UNKNOWN fails.
**Complexity:** Medium — touches the protected core, which is why it goes first.
**Decision required:** No.

### Sequence 2 — Containment, break-glass, entitlement separation (P1)

**Problem:** K1–K5 and E2.
**Contract:** §15, §16, §28.
**Smallest safe change:** containment as a first-class state on integration and
organisation with C0–C5, explicit triggers, authority, evidence preservation and
verified recovery; break-glass as a time-limited scoped audited grant;
commercial states modelled as a distinct concern that cannot cascade into
containment.
**Security implications:** the largest positive change available.
**Tests:** `test:containment` — containment isolates without destroying
evidence; no auto-recovery from C3/C4/C5; break-glass expires and cannot be
silently extended; commercial suspension does not contain; containment does not
terminate commercially.
**Complexity:** High. **Decision required:** **Yes — D1.**

### Sequence 3 — Support domain (P1, Phase 5)

**Problem:** U1–U8. Nothing exists.
**Contract:** §20–26.
**Smallest safe change:** SupportCase + states + prohibited transitions +
entitlement validation + tenant-scoped diagnostics first. Knowledge, AI drafting
and routing after.
**Security implications:** §22 is an authorisation problem — support is a new
disclosure surface and must obey the same grants and RLS.
**MSP value:** §20's default routing _is_ the §2 boundary expressed in support.
**Tests:** `test:support` — no disclosure without entitlement; prohibited
transitions rejected; closure requires verification; end-customer request routes
to MSP without disclosing tenant data.
**Complexity:** High. **Decision required:** **Yes — D2.**

### Sequence 4 — Microsoft depth for CE v3.3 (P1)

**Problem:** C2 — the wedge does not work without it.
**Smallest safe change:** map CE v3.3 controls to required observations, then
close gaps in priority order.
**Complexity:** Medium. **Decision required:** No.

### Sequence 5 — Questionnaire pipeline (P1, Phase 6)

XLSX intake, persistence, classification, mapping, review, write-back.
**Decision required:** **Yes — D3** (format priority).

### Sequence 6 — Release gate record and capability status (P2)

§36's ten conditions and release evidence, carrying S4's status per capability.

### Sequence 7 — Test taxonomy (P2)

Name the four suites that exist but are unnamed (`connector-contract`,
`property`, `restore`, `questionnaire`); automate mutation testing; then
`load`, `soak`, `chaos`.

### Sequence 8 — White-label, supply chain, consequence reasoning (P2)

---

## 10. Product-owner decisions

Only decisions genuinely requiring Veylith founder authority. The six decisions
in the v3.0 report are resolved; these are new or reshaped by v3.1.

### D1 — Who holds containment authority, and what may trigger automatically?

**1. Decision required.** Whether an MSP may contain its own customers'
integrations, and whether Adericel may ever contain automatically.

**2. Why it matters.** Containment isolates a customer's integrations, possibly
during an incident, possibly out of hours. §15 requires authority to be
determined before the least-disruptive response. Build it wrong and either
nobody can act in time, or Adericel takes a customer offline on a false positive.

**3. Options.**
(a) Veylith only.
(b) MSP may contain its own customers; Veylith may contain any.
(c) (b) plus automatic containment on a narrow enumerated trigger set.

**4. Recommendation.** **(c), with the automatic set limited to C1–C2 only** —
pause automation, isolate a credential. Anything at C3 or above stays human.
§15 already forbids automatic recovery from C3/C4/C5; this keeps automatic
_entry_ proportionate to that.

**5. Consequences.** (a) is too slow — the MSP is the one watching. (b) leaves
credential compromise waiting for a human at 3am. (c) requires a very high
trigger bar; a false containment is an outage you caused, and the MSP will
remember it.

**6. What remains unknown.** MSP appetite for holding this authority, and
whether they want to be asked or told. Worth one conversation with the first MSP.

**7. Required authority.** Founder.

### D2 — Does support default to MSP-only, with direct support as a paid exception?

**1. Decision required.** §20 says end-customer requests route to the MSP unless
a signed agreement grants Veylith direct support responsibility. Whether that
exception is ever offered is a commercial decision.

**2. Why it matters.** It determines the support architecture. If direct support
never exists, entitlement checking is simpler and the §2 boundary is absolute.
If it can be bought, every disclosure path needs an entitlement gate from day
one — retrofitting that is expensive and is exactly where tenant-isolation bugs
come from.

**3. Options.**
(a) MSP-only, always. No direct support, ever.
(b) MSP by default; direct support available as a paid, contracted exception.
(c) Direct support offered generally.

**4. Recommendation.** **(b), built as (a) first.** Build the entitlement gate
now — §22 requires it regardless — but ship with no direct-support entitlement
granted to anyone. You keep the option without building the product around it,
and the MSP sees a system that structurally cannot talk to their customer behind
their back.

**5. Consequences.** (a) forecloses a real revenue line some MSPs would welcome
— larger MSPs often _want_ escalation to the vendor. (c) is channel conflict in
support clothing and contradicts §2.

**6. What remains unknown.** Whether your first MSPs want to own all customer
contact or would pay to escalate. They will not all answer the same way.

**7. Required authority.** Founder — commercial.

### D3 — Questionnaire: XLSX first, or wait for the first MSP's real format mix?

**1. Decision required.** Scope of the largest remaining build.

**2. Why it matters.** PDF intake needs OCR and is the worst effort-to-value
ratio in the set. Building all three triples the surface before any is validated.

**3. Options.** (a) XLSX first, DOCX second, PDF deferred. (b) All three.
(c) Ask the first MSP, then choose.

**4. Recommendation.** **(c), defaulting to (a).** Insurer and procurement
questionnaires are overwhelmingly XLSX in my reading of the market, but that is
an assumption and this contract requires assumptions to be labelled as such. One
conversation converts it into a fact.

**5. Consequences.** Guessing wrong costs a rebuild of the intake layer. Asking
costs one email.

**6. What remains unknown.** The actual format mix — **this is genuinely
unknown and cheap to resolve.**

**7. Required authority.** Founder, informed by one MSP conversation.

### D4 — Is the £199/month hypothesis still the one to test?

**1. Decision required.** §36 of v3.0 named £199 + VAT per MSP per month as a
hypothesis. v3.1 §16 adds a richer entitlement model that would support
per-Protected-Organisation pricing.

**2. Why it matters.** The entitlement states being built in Sequence 2 should
match the commercial model they will meter. Building for a flat MSP fee and
later needing per-organisation metering is a migration.

**3. Options.** (a) Flat MSP fee. (b) Per-protected-organisation. (c) Flat fee
with an organisation cap, then per-organisation above it.

**4. Recommendation.** **(c).** It is the model the schema already leans toward
(`plans` carries `organisation_limit` and `price_per_organisation_minor`), it
gives an MSP a predictable floor, and it grows with their portfolio — which
aligns Veylith's revenue with the MSP's success rather than against it (§2).

**5. Consequences.** (a) is simplest and caps your upside at exactly the point
the product is working. (b) makes the first customer expensive to onboard.

**6. What remains unknown.** Everything about willingness to pay. §5.6 forbids
claiming otherwise, and no figure here is validated.

**7. Required authority.** Founder — commercial.

---

## Appendix A — Audit method

- Branch and PR state via `git` and the GitHub API.
- **RLS coverage queried from the live database** (`pg_class.relforcerowsecurity`),
  not grepped from migrations — a grep-based count was wrong in the v3.0 audit
  and was discarded.
- Test counts from a full `pnpm test` run: 1,155 passing, 6 skipped, 68 files.
- Test taxonomy audited as **script vs capability separately**, because "no npm
  script" and "no test" are different findings and four suites exist unnamed.
- Absence claims verified by exhaustive search across `*.ts`, `*.tsx`, `*.sql`,
  excluding `node_modules` and `dist`.

## Appendix B — What this report does not establish

- **No claim of legal compliance** (§29).
- **No claim of production readiness** — §7 states the opposite.
- **No claim of measured customer value** (§5.6). Every operational figure
  derives from a synthetic portfolio.
- **No live Microsoft tenant validation.** I7 is GREY for this reason.
- **No line-by-line review of the closed PR #3.** File sets were compared.

## Appendix C — v3.0 findings closed since that audit

| v3.0 ID | Finding                                       | Closure                                                                            |
| ------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| B1      | Product only on an unmerged branch            | PR #1 merged `6a71426`; `main` = 473 files                                         |
| B2      | Duplicate Passport interchange implementation | PR #3 closed as superseded                                                         |
| B3      | No residual-risk register                     | `RESIDUAL_RISK_REGISTER.md`, 16 entries                                            |
| C1      | Direct-to-SME path in code                    | Removed at four layers + DB constraint; ADR-0042; `0026_msp_only_distribution.sql` |
| C2      | Out-of-contract PR #2                         | Closed                                                                             |
| —       | "Exactly-once" overclaims                     | ADR-0016 title and ADR-0027 bullet corrected under §37                             |
