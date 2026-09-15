# Adericel v3.0 Contract Gap Report

**Audit date:** 15 September 2026
**Controlling authority:** Master Product, Engineering, Operating & Build Contract v3.0
**Audited baseline:** `main` @ `7a292dd`, working branch `claude/adericel-platform-build-k8noew` @ `7cc87cc`
**Auditor:** Claude Code, under §50–§51 (Required Pre-Build Audit)

> This report classifies what the repository **is**, not what it was intended to
> be. Nothing here is classified from a README claim, a filename, a passing test
> or a prior brief. Every classification names the evidence that supports it.
>
> No material implementation was performed during this audit.

---

## 1. Executive summary

### Current repository maturity

Adericel is a **substantially built assurance system with an unusually strong
core and a dangerously thin delivery boundary.**

The engineering quality of the assurance core is high and, in several places,
genuinely defensible: the Truth Engine's purity is enforced by a structural test
that reads its own source, tenant isolation is enforced twice with 70 of 78
tables under `FORCE ROW LEVEL SECURITY`, and several critical invariants have
been proved by deliberately breaking them rather than by assertion.

Measured baseline: **1,149 tests passing**, 6 skipped, across 67 files;
typecheck, lint, format, web build, dependency audit and n8n validation all
clean; container build, smoke deployment, migration idempotency and a **proven
restore** all exercised in CI.

That is the good news, and it is real.

The bad news is structural rather than technical.

### Major production blockers

**B1 — The product does not exist on `main`.**
_(Closed 15 Sept 2026 — PR #1 merged as `6a71426`; `main` now holds 473 files.)_

`main` contains **two files**: `README.md` and one ADR. The entire product —
62 commits, ~82,000 lines — exists only on a single unmerged working branch,
via PR #1, open since 9 September. There is no release baseline, no tag, no
merge history and no reviewed trunk. Every release gate in §48 is currently
being run against a branch that no one has accepted.

This is the single highest-severity finding in this report. It is not a code
defect; it is the absence of the thing every other gate is supposed to protect.

**B2 — There are two divergent implementations of the same feature.**
_(Closed 15 Sept 2026 — PR #3 closed as superseded.)_

PR #3 (`increment-1-passport-interchange` @ `cca47c5`) implements Passport
interchange signing with `passport-signing.ts`, `issuer-keys.ts`, `signing.ts`
and an ADR numbered **0039**. The working branch implements the same capability
with `passport-interchange.ts`, `issuer-key.ts`, `issuer-keyring.ts` and an ADR
numbered **0040** — while `ADR-0039` on the working branch is an entirely
different decision ("The loop is a recorded object"). Two implementations, one
ADR number, one capability. This is duplicate truth in the §53 sense and must be
resolved before either is merged.

**B3 — No residual-risk register exists** (§57), so known limitations are
recorded only in prose scattered across 63 documents.
_(Closed 15 Sept 2026 — see `RESIDUAL_RISK_REGISTER.md`.)_

### Major MSP-commercial blockers

**C1 — A live direct-to-SME acquisition path exists in code.**
_(Closed 15 Sept 2026 — removed at four layers; see ADR-0042 and RR-040.)_

`apps/api/src/services/signup.ts:44` defines `accountKind: z.enum(['MSP',
'DIRECT'])`. `POST /v1/signup` is public and unauthenticated, and a `DIRECT`
signup creates an organisation with a null `msp_id` — an Adericel customer with
no MSP in the chain.

Under v3.0 this is a direct conflict with §2 ("Adericel is not a direct-to-SME
product"), §37 ("must not build a competing direct customer acquisition motion")
and the explicit prohibition in the execution instruction ("Do not add
direct-to-SME sales/onboarding functionality"). It predates v3.0 and was correct
under the prior brief; §0 states plainly that this does not make it correct now.

Blast radius is small and contained: 6 source files, one migration column, two
test files. This is a cheap fix made expensive by delay.

**C2 — PR #2 ("Money Engine: personal automated leak-detection and claims
system") is an open PR for a direct-to-consumer personal finance product.** It
is **not** in the working tree — it branches from `main` independently — so it
poses no code risk today. It poses a governance risk: an open PR proposing a
product outside the contract's commercial definition.

**C3 — No white-label or MSP co-branding capability exists** (§38). Zero
matches for branding, custom domain or co-branding anywhere in the tree. An MSP
cannot currently put its own identity in front of its own customer.

**C4 — Questionnaire Autopilot is a library, not a pipeline** (§19). The
`packages/questionnaire` package implements answer states, rendering,
consistency and interpretation — and the no-silent-yes property is genuinely
proved. But there is **no intake, no XLSX/DOCX/PDF parsing, no persistence, no
database tables and no API routes.** Nothing can enter it and nothing can leave
it. This is the largest gap between documented capability and delivered
capability in the repository.

### Major security / tenant-isolation blockers

No _blockers_. Tenant isolation is the strongest area of the codebase: two
enforcement layers, 70/78 tables with FORCE RLS, and a dedicated adversarial
suite. Three items need attention but none is release-blocking:

- **S1 — Containment (C0–C5) does not exist** (§14 chain, audit scope item 6).
  There is no mechanism to isolate a compromised integration, restrict a tenant,
  or perform emergency containment while preserving evidence.
- **S2 — Break-glass access does not exist** (§30). There is no controlled
  emergency access path, which in practice means an incident is handled with
  database credentials and no attribution.
- **S3 — Eight tables run without RLS.** All eight are control-plane
  (`msps`, `users`, `grants`, `plans`, `msp_baselines`, `msp_baseline_controls`,
  `user_mfa_factors`, `health_checks`). This is very likely correct by design —
  `grants` is the table that _resolves_ tenancy and cannot be gated by it — but
  the justification is not written down and not tested. Classified GREY, not RED.

### Major architecture risks

**A1 — `packages/vaol` and `packages/autonomy` are Veylith's own operating
layer inside the product repository.** Not wrong, and clearly deliberate, but it
means the repository holds two products with one dependency graph.

**A2 — Assurance Exchange (§21) has an unusually strong foundation and no
roadmap.** The signed interchange envelope, published JSON Schemas and offline
verifier are exactly the primitives §21 needs. Selective disclosure — the actual
hard part — is absent.

### Immediate recommended sequence

1. **Merge to `main`.** Resolve PR #3, close PR #2, land PR #1. (B1, B2, C2)
2. **Remove the `DIRECT` signup path.** (C1)
3. **Write the residual-risk register.** (B3)
4. **Build the questionnaire pipeline.** (C4)
5. **Build containment and break-glass.** (S1, S2)
6. **Build white-label.** (C3)

Rationale for the order is in §9.

---

## 2. Status summary

| Classification                  | Count  |
| ------------------------------- | ------ |
| GREEN — Proven                  | 18     |
| AMBER — Partial                 | 11     |
| RED — Missing                   | 9      |
| RED — Risk                      | 3      |
| GREY — Unproven                 | 6      |
| DEFER                           | 5      |
| **Total requirements assessed** | **52** |

### By domain

| Domain                         | GREEN | AMBER | RED-M | RED-R | GREY | DEFER |
| ------------------------------ | ----- | ----- | ----- | ----- | ---- | ----- |
| Repository & release baseline  | 1     | 1     | 1     | 1     | 1    | 0     |
| Assurance core & graph         | 5     | 1     | 0     | 0     | 1    | 0     |
| Truth & policy                 | 5     | 0     | 0     | 0     | 0    | 0     |
| Integrations & Microsoft wedge | 2     | 3     | 1     | 0     | 1    | 0     |
| Action & autonomy              | 3     | 1     | 0     | 0     | 1    | 0     |
| Containment & recovery         | 0     | 1     | 3     | 0     | 0    | 0     |
| MSP operating system           | 1     | 2     | 2     | 2     | 1    | 0     |
| Passport & exchange            | 1     | 1     | 0     | 0     | 0    | 2     |
| Questionnaire autopilot        | 0     | 1     | 2     | 0     | 0    | 1     |
| Support & service operations   | 0     | 0     | 0     | 0     | 0    | 2     |
| Security & privacy             | 4     | 0     | 0     | 0     | 1    | 0     |
| Reliability & operations       | 3     | 1     | 0     | 0     | 0    | 0     |
| Quality & release evidence     | 3     | 1     | 0     | 0     | 0    | 0     |

---

## 3. Contract requirements matrix

Legend for branch status: **M** = `main`, **W** = working branch.
`main` holds only a README and one ADR, so **M is ABSENT for every
implementation requirement.** It is stated once here rather than repeated 52
times.

### 3.1 Repository and release baseline

| ID  | Contract requirement                           | M      | W              | Class          | Evidence                                                                                                                                             | Gap                                   | Security impact                      | MSP/commercial impact              | Priority | Acceptance test                                          | Recommendation         |
| --- | ---------------------------------------------- | ------ | -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------ | ---------------------------------- | -------- | -------------------------------------------------------- | ---------------------- |
| R1  | §48 Release gates run against a reviewed trunk | ABSENT | Branch only    | **RED — RISK** | `git ls-tree origin/main` = 2 files; 62 commits ahead; PR #1 open since 2026-09-09                                                                   | No release baseline exists            | Loss of the branch loses the product | Cannot ship, cannot onboard an MSP | **P0**   | `main` contains the product; CI green on `main`          | Land PR #1             |
| R2  | §53 No duplicate sources of truth              | ABSENT | Duplicated     | **RED — RISK** | PR #3 `cca47c5` has `passport-signing.ts`, `issuer-keys.ts`, ADR-0039; W has `passport-interchange.ts`, `issuer-key.ts`, ADR-0040; ADR-0039 collides | Two implementations of one capability | Merge would corrupt ADR numbering    | Confusion, wasted review           | **P0**   | One implementation; ADR numbers unique                   | Close PR #3            |
| R3  | §2 MSP-only commercial definition              | ABSENT | Conflicting PR | **AMBER**      | PR #2 "Money Engine" open against `main`; absent from working tree                                                                                   | Open PR outside contract scope        | None (not in tree)                   | Governance                         | P1       | PR #2 closed or re-scoped                                | Close PR #2            |
| R4  | §22 TypeScript monorepo, project references    | ABSENT | Present        | **GREEN**      | 16 workspace packages; `tsc -b`; `pnpm typecheck` clean                                                                                              | —                                     | —                                    | —                                  | —        | Typecheck passes                                         | Preserve               |
| R5  | §49 Documentation integrity                    | ABSENT | Partial        | **GREY**       | 63 docs; placeholder scan clean; README claims spot-checked and accurate                                                                             | Not systematically enforced           | Low                                  | Low                                | P2       | A test asserts each README capability claim maps to code | Add doc-integrity test |

### 3.2 Assurance core and graph

| ID  | Contract requirement                                       | W       | Class     | Evidence                                                                      | Gap                                                     | Priority | Acceptance test                                    | Recommendation              |
| --- | ---------------------------------------------------------- | ------- | --------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | -------- | -------------------------------------------------- | --------------------------- |
| G1  | §8 Organisational Assurance Graph as canonical model       | Present | **GREEN** | `graph_nodes`/`graph_edges`; `packages/graph`; ADR-0001                       | —                                                       | —        | Traversal + neighbourhood tests pass               | Preserve                    |
| G2  | §10 Evidence fabric: provenance, integrity, hash, validity | Present | **GREEN** | `packages/evidence`; `evidence`, `evidence_subjects`, `evidence_observations` | —                                                       | —        | Integrity + freshness tests                        | Preserve                    |
| G3  | §10 Evidence never silently overwritten; supersession      | Present | **GREEN** | `supersedes_claim_id` in `packages/evidence/src/claims.ts:35`                 | —                                                       | —        | Supersession test                                  | Preserve                    |
| G4  | §8 Model people, devices, apps, suppliers, data assets     | Partial | **AMBER** | Identity + device kinds present; supplier/data-asset node kinds not modelled  | Supplier assurance (§22) unmodelled                     | P2       | Supplier node + edge round-trip                    | Extend when Phase 6 starts  |
| G5  | §10 Historical reconstruction                              | Present | **GREEN** | ADR-0010 temporal model; `assessments` append-only; replay test               | —                                                       | —        | `tests/integration/assessment-replay.test.ts`      | Preserve                    |
| G6  | §9 Digital twin: reason about consequences of change       | Partial | **GREY**  | Change detection exists; impact analysis across graph not demonstrated        | §23 "impact analysis rather than notification" unproven | P2       | One identity change → affected controls enumerated | Demonstrate before claiming |

### 3.3 Truth and policy

| ID  | Contract requirement                             | W       | Class     | Evidence                                                                                                                                                      | Recommendation                          |
| --- | ------------------------------------------------ | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| T1  | §11 Truth Engine deterministic, side-effect-free | Present | **GREEN** | `tests/unit/engine-purity.test.ts` reads the engine's own source and fails on any I/O import, wall-clock read, randomness, env access or mutable module state | Preserve — exemplary                    |
| T2  | §11 Versioned, hashable, replayable              | Present | **GREEN** | `rulesetHash`, `inputDigest` (`engine.ts:112,114,306`); ADR-0023                                                                                              | Preserve                                |
| T3  | §11 Rules as data                                | Present | **GREEN** | ADR-0005; ruleset registry                                                                                                                                    | Preserve                                |
| T4  | §6.2 UNKNOWN never becomes PASS                  | Present | **GREEN** | 10 `UNKNOWN_REASONS`; property test over 210 combinations; proved by deliberate breakage                                                                      | Preserve — exemplary                    |
| T5  | §6.3 AI never becomes truth                      | Present | **GREEN** | `origin: AI_SUGGESTED` + `status: CANDIDATE`; `isRuleEligible` refuses; ADR-0004; ADR-0041                                                                    | Preserve                                |
| T6  | §12 State vocabulary preserves distinctions      | Present | **GREEN** | 6 states + 10 UNKNOWN reasons carrying stale/contradictory/unavailable/unverified as _reasons_, not collapsed                                                 | Preserve; document the modelling choice |

### 3.4 Integrations and the Microsoft-first wedge

| ID  | Contract requirement                               | W       | Class             | Evidence                                                                                            | Gap                                                                                                                 | Priority | Recommendation                         |
| --- | -------------------------------------------------- | ------- | ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------- |
| I1  | §25 Common connector contract                      | Present | **GREEN**         | `packages/integrations/src/connector.ts`; conformance + manifest-honesty tests                      | —                                                                                                                   | —        | Preserve                               |
| I2  | §26 Microsoft Entra                                | Present | **AMBER**         | 543 lines, real Graph v1.0 client-credentials flow; emits `IDENTITY_STATE`, `CONFIGURATION_SETTING` | Only 2 observation kinds; CA policies, privileged roles, sign-in risk absent                                        | **P1**   | Deepen for CE v3.3                     |
| I3  | §26 Microsoft Intune                               | Present | **AMBER**         | 469 lines, real Graph; emits `DEVICE_STATE` ×2                                                      | Compliance policies, configuration profiles, encryption state thin                                                  | **P1**   | Deepen for CE v3.3                     |
| I4  | §26 Microsoft 365 security/configuration surfaces  | Absent  | **RED — MISSING** | No Defender, Exchange Online, Purview or Secure Score source                                        | CE v3.3 malware/patch controls uncoverable                                                                          | **P1**   | Build after I2/I3                      |
| I5  | §25 SSRF, egress control                           | Present | **GREEN**         | `packages/integrations/src/http.ts`; DNS-rebinding hardening; `tests/security`                      | —                                                                                                                   | —        | Preserve                               |
| I6  | §25 Connector health, degradation, coverage ladder | Present | **AMBER**         | `packages/triage/src/coverage.ts`; statuses `CONFIGURED/CONNECTED/DEGRADED/FAILED/DISABLED`         | Ladder drives off Truth Engine conclusions (correct), but rate-limit and retry semantics per connector undocumented | P2       | Document per-connector error semantics |
| I7  | §25 Evidence freshness and change detection        | Present | **GREY**          | Freshness in evidence model; change detection in operating loop                                     | Not demonstrated end to end against a live Microsoft tenant                                                         | P1       | Requires a real tenant to prove        |

### 3.5 Action and autonomy

| ID  | Contract requirement                                                                       | W       | Class     | Evidence                                                                                                                              | Recommendation              |
| --- | ------------------------------------------------------------------------------------------ | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A1  | §15 Autonomy levels 0–5, explicit and policy-controlled                                    | Present | **GREEN** | `packages/domain/src/autonomy.ts` defines L0 Observe → L5, per-organisation and per-action-type; matches the contract's model exactly | Preserve                    |
| A2  | §14 Intent → Policy → Authority → Risk → Action → Re-observation → Verification → Evidence | Present | **GREEN** | `packages/actions/src/action-service.ts`; ADR-0014                                                                                    | Preserve                    |
| A3  | §14 Four-eyes; no self-approval; no agent approval                                         | Present | **GREEN** | ADR-0015; enforced structurally; adversarial tests                                                                                    | Preserve                    |
| A4  | §6.5 Verification by re-observation; UNKNOWN OUTCOME                                       | Present | **GREEN** | Verification re-observes; at-most-once semantics corrected this cycle                                                                 | Preserve                    |
| A5  | §14 Recovery / rollback                                                                    | Partial | **AMBER** | Reconciliation and dead-letter exist; explicit rollback of an applied change does not                                                 | P2 — define per action type |
| A6  | §15 Autonomy level tenant-specific and operation-specific in practice                      | Present | **GREY**  | Schema and policy support it; no evidence an MSP has configured differentiated levels                                                 | P2 — demonstrate            |

### 3.6 Containment and recovery

| ID  | Contract requirement                        | W          | Class             | Evidence                                                                                                    | Security impact                                         | Priority | Recommendation          |
| --- | ------------------------------------------- | ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------- | ----------------------- |
| K1  | C0–C5 containment hierarchy                 | **Absent** | **RED — MISSING** | Zero matches outside unrelated prose                                                                        | Cannot isolate a compromised integration                | **P1**   | Build                   |
| K2  | Containment triggers and authority          | **Absent** | **RED — MISSING** | —                                                                                                           | No defined emergency authority                          | **P1**   | Build with K1           |
| K3  | §30 Break-glass access                      | **Absent** | **RED — MISSING** | Zero matches                                                                                                | Incidents handled with raw DB credentials, unattributed | **P1**   | Build                   |
| K4  | §33 Backup, restore, integrity verification | Present    | **AMBER**         | CI proves backup **and restore** (`ci.yml:274-279`) plus migration idempotency; `scripts/verify-restore.ts` | Corruption-detection test not evidenced                 | P2       | Add corrupted-dump test |

### 3.7 MSP operating system

| ID  | Contract requirement                                 | W                           | Class             | Evidence                                                                                                                        | Gap                                                        | Priority | Recommendation                |
| --- | ---------------------------------------------------- | --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------- | ----------------------------- |
| M1  | §16 Exception operating system, not dashboards       | Present                     | **GREEN**         | `packages/triage`; ranked queue; each item explained                                                                            | —                                                          | —        | Preserve                      |
| M2  | §17 Portfolio intelligence at scale                  | Present                     | **AMBER**         | Portfolio routes; `proof/` 100-customer synthetic portfolio                                                                     | Proven against synthetic data only                         | P1       | Prove with one real MSP       |
| M3  | §2/§37 No direct-to-SME path                         | **Present and conflicting** | **RED — RISK**    | `signup.ts:44` `accountKind: 'MSP'\|'DIRECT'`; public `POST /v1/signup`; `msp_id` nullable; `0014_self_serve_onboarding.sql:35` | Direct acquisition motion in code                          | **P0**   | Remove DIRECT                 |
| M4  | §38 White-label / co-branding                        | **Absent**                  | **RED — MISSING** | Zero matches                                                                                                                    | MSP cannot front its own identity                          | **P1**   | Build                         |
| M5  | §35 MSP economics measurable                         | Present                     | **AMBER**         | `packages/value`; capacity model refuses unsupported figures                                                                    | Measured against synthetic portfolio only                  | P1       | Measure with a real MSP       |
| M6  | §34 Billing behind provider-neutral boundary         | Present                     | **GREEN**         | `packages/billing`; manual + Stripe; ADR-0027                                                                                   | —                                                          | —        | Preserve                      |
| M7  | §18 Portfolio learning without cross-tenant exposure | Partial                     | **GREY**          | Recurring-failure aggregation exists                                                                                            | Isolation of the aggregation path not adversarially tested | P2       | Add cross-tenant leakage test |
| M8  | §37 No feature whose purpose is disintermediation    | Mixed                       | **RED — RISK**    | M3 is such a feature                                                                                                            | —                                                          | **P0**   | Resolve with M3               |

### 3.8 Assurance Passport and exchange

| ID  | Contract requirement                                                               | W       | Class     | Evidence                                                                                             | Recommendation                            |
| --- | ---------------------------------------------------------------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P1  | §20 Evidence-backed Passport distinguishing unknowns, exceptions, age, limitations | Present | **GREEN** | `apps/api/src/services/passport.ts`; carries UNKNOWN as headline; maintenance status                 | Preserve                                  |
| P2  | §20 Independent third-party verification                                           | Present | **GREEN** | Ed25519 detached signature; offline verifier; published JSON Schemas; `/v1/assurance/keys`; ADR-0040 | Preserve                                  |
| P3  | §21 Selective disclosure                                                           | Partial | **AMBER** | FULL/REDACTED share disclosure exists; redacted views deliberately unsigned                          | Cryptographic selective disclosure absent | DEFER to Phase 7 |
| P4  | §21 Assurance exchange ecosystem                                                   | Absent  | **DEFER** | Foundations present, ecosystem absent                                                                | Correct to defer per §61                  |
| P5  | §22 Supplier assurance passports                                                   | Absent  | **DEFER** | —                                                                                                    | Phase 6                                   |

### 3.9 Questionnaire autopilot

| ID  | Contract requirement                                                          | W          | Class             | Evidence                                                                 | Gap                               | Priority | Recommendation    |
| --- | ----------------------------------------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------------------ | --------------------------------- | -------- | ----------------- |
| Q1  | §19 No silent yes                                                             | Present    | **GREEN**         | `packages/questionnaire`; property-tested; proved by deliberate breakage | —                                 | —        | Preserve          |
| Q2  | §19 Intake: XLSX, DOCX, PDF                                                   | **Absent** | **RED — MISSING** | Zero matches for xlsx/docx/pdf in `packages/questionnaire` or `apps/api` | Nothing can enter the engine      | **P1**   | Build             |
| Q3  | §19 Persistence, question classification, control mapping, review, write-back | **Absent** | **RED — MISSING** | No questionnaire tables in 25 migrations; no questionnaire API routes    | Nothing can leave the engine      | **P1**   | Build             |
| Q4  | §19 Post-submission monitoring / staleness detection                          | Absent     | **AMBER**         | ADR-0038 specifies it; no implementation                                 | Designed, not built               | P2       | Build after Q2/Q3 |
| Q5  | §19 Deterministic answer determination from assurance state                   | Partial    | **DEFER→P1**      | Composer exists and is pure                                              | Not wired to real assurance state | P1       | Wire with Q3      |

### 3.10 Support and service operations

| ID  | Contract requirement                               | W          | Class     | Evidence                                      | Recommendation                                      |
| --- | -------------------------------------------------- | ---------- | --------- | --------------------------------------------- | --------------------------------------------------- |
| U1  | SupportCase / incident model                       | **Absent** | **DEFER** | Zero matches for `SupportCase`/`support_case` | Valid future capability; not required for the wedge |
| U2  | Support metrics, knowledge base, AI draft boundary | **Absent** | **DEFER** | —                                             | Defer until an MSP is live                          |

> Justification for DEFER rather than RED: §61 Test 1 — an MSP with zero live
> customers does not yet have a support burden. Building a support system before
> the first MSP is theatre under §44. Revisit at first paying MSP.

### 3.11 Security and privacy

| ID  | Contract requirement                                      | W       | Class     | Evidence                                                                                                           | Recommendation                                                                                                                                                                           |
| --- | --------------------------------------------------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | §28 Tenant isolation, RLS, FORCE RLS                      | Present | **GREEN** | Live DB: 70/78 tables `relforcerowsecurity`; two enforcement layers; ADR-0007; dedicated adversarial suite         | Preserve                                                                                                                                                                                 |
| X2  | §28 Authentication, MFA, sessions, rate limiting          | Present | **GREEN** | TOTP + recovery codes; step-up on approval; per-route limits                                                       | Preserve                                                                                                                                                                                 |
| X3  | §29 Three-surface model                                   | Present | **GREEN** | `apps/api/src/surfaces.ts`; every route classified; `information-boundary.test.ts` fails on any unclassified route | Preserve — exemplary                                                                                                                                                                     |
| X4  | §28 Secrets, credential storage, redaction                | Present | **GREEN** | Envelope encryption per organisation; ADR-0019; log redactor; CI secret scan                                       | Preserve                                                                                                                                                                                 |
| X5  | §28 Eight control-plane tables without RLS                | Present | **GREY**  | `grants`, `users`, `msps`, `plans`, `msp_baselines`, `msp_baseline_controls`, `user_mfa_factors`, `health_checks`  | Very likely correct — `grants` resolves tenancy and cannot be gated by it — but undocumented and untested. Write the justification; add a test asserting the list is exactly these eight |
| X6  | §31/§32 Data protection, minimisation, erasure, retention | Present | **GREEN** | `packages/domain/src/personal-data.ts`; erasure + retention services; 9 data-protection documents; ADR-0032        | Preserve. **Note:** documentation existing is explicitly _not_ compliance (§31)                                                                                                          |

### 3.12 Reliability and operations

| ID  | Contract requirement                               | W          | Class             | Evidence                                                                               | Recommendation                                             |
| --- | -------------------------------------------------- | ---------- | ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| O1  | §39 Outbox, scheduler, reconciliation, dead-letter | Present    | **GREEN**         | `apps/worker`; dead-letter visibility route; ADR-0011                                  | Preserve                                                   |
| O2  | §27 n8n orchestrates, never decides                | Present    | **GREEN**         | 25 workflows / 236 nodes; `n8n:validate` checks reachability, secrets, drift; ADR-0012 | Preserve                                                   |
| O3  | §48 Container build, startup, readiness            | Present    | **GREEN**         | CI builds images, runs compose smoke test, checks proxy config and readiness           | Preserve                                                   |
| O4  | §39 Monitoring and alerting                        | Present    | **AMBER**         | Health checks, structured logging, outbox stats                                        | No alerting destination configured; no soak/load evidence  | P2  |
| O5  | §48 Supply chain: SBOM, signed releases            | **Absent** | **RED — MISSING** | No SBOM generation; no release signing                                                 | **P2** (blocks enterprise MSP procurement, not first sale) |

### 3.13 Quality and release evidence

| ID  | Contract requirement                | W       | Class     | Evidence                                                                                                                                                                         | Recommendation                                              |
| --- | ----------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| V1  | §46 Test coverage across categories | Present | **GREEN** | 1,149 passing / 6 skipped, 67 files: unit 9, integration 6, tenancy 1, security 10, e2e 12, package 29                                                                           | Preserve                                                    |
| V2  | §47 Adversarial / mutation testing  | Present | **GREEN** | Invariants proved by deliberate breakage: no-silent-yes (9 violations named), keyId binding (exactly 1 test), inference containment (exactly 1), sovereignty gate (exactly 5)    | Preserve — this is the strongest quality signal in the repo |
| V3  | §48 Release gates in CI             | Present | **GREEN** | format, lint, typecheck, unit, tenancy, security, integration, e2e, n8n, web build, images, compose smoke, migration idempotency, restore, CodeQL, dependency audit, secret scan | Preserve                                                    |
| V4  | §47 Mutation testing systematised   | Present | **AMBER** | Performed manually and documented in commit messages; not automated or repeatable in CI                                                                                          | P2 — consider a mutation harness                            |

---

## 4. Architecture assessment

### Current package boundaries

Sixteen workspace packages. Dependency direction is clean and acyclic:
`shared` → `domain` → {`graph`, `evidence`, `policy`, `truth-engine`} →
{`actions`, `integrations`, `triage`, `value`, `questionnaire`, `inference`} →
`apps`.

`truth-engine` depends on nothing that can perform I/O, and this is enforced
structurally rather than by convention.

### Canonical source-of-truth boundaries

Correct and well defended:

- **Assurance truth** — Truth Engine only. n8n, AI and the UI cannot write it.
- **Authority** — `packages/policy` + `packages/autonomy`. Not the caller.
- **Tenancy** — `grants`, resolved from the authenticated principal, enforced
  again by RLS. Never a caller-supplied identifier.
- **Evidence** — append-only with supersession, never overwritten.

### Duplicate / competing truth sources

**One serious instance:** PR #3 vs the working branch (R2). Must be resolved
before merge.

**One to watch:** `packages/vaol` (Veylith's own operating layer) and
`packages/value` (MSP proof-of-value) both compute operational metrics, for
different audiences. Currently distinct; worth a boundary note before either
grows.

### Areas that would prevent the Digital Assurance Twin

Nothing structural. The graph is canonical, evidence is temporal and
append-only, assessments are replayable. §9's twin is reachable from here.

The one genuine limitation is **G6**: consequence reasoning across the graph is
not demonstrated. The data model supports it; no code walks it.

### Safe to preserve

Truth Engine, evidence fabric, graph, tenancy, three-surface model, action
lifecycle, autonomy levels, Passport + interchange, inference layer, connector
contract, n8n boundary, CI gates.

### Requiring modification

- Remove `DIRECT` account kind (M3).
- Deepen Entra/Intune observation coverage (I2, I3).
- Document the RLS exemption list (X5).

### Requiring replacement

**None.** No existing code materially conflicts with v3.0 except the `DIRECT`
signup path, and that is a removal rather than a replacement.

---

## 5. Security assessment

| Area               | State               | Note                                                                                                                                   |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation   | **Strong**          | Two layers; 70/78 FORCE RLS; adversarial suite; a cross-tenant read is treated as critical                                             |
| RLS                | **Strong, one gap** | Eight control-plane tables exempt; justification undocumented (X5)                                                                     |
| AuthN / AuthZ      | **Strong**          | MFA, step-up on approval, grant-resolved authority, no caller-supplied tenancy                                                         |
| Secrets            | **Strong**          | Per-organisation envelope encryption; issuer signing key separately established and never derived from the root secret; CI secret scan |
| API security       | **Strong**          | Zod validation everywhere; per-route rate limits; every route surface-classified                                                       |
| Integration egress | **Strong**          | Allowlist, private-range blocking, DNS-rebinding hardening                                                                             |
| Auditability       | **Strong**          | Append-only audit; correlation IDs across API, worker and n8n                                                                          |
| **Containment**    | **Absent**          | K1–K3. No isolation, no break-glass, no emergency authority                                                                            |
| Backup / recovery  | **Good**            | Backup _and restore_ proven in CI; corruption detection not evidenced                                                                  |

**Material security risks:**

1. **No containment capability (K1–K3).** If an MSP's Microsoft credentials are
   compromised, there is no mechanism to isolate that integration while
   preserving evidence. The remedy today is manual database work.
2. **No break-glass (K3).** Emergency access therefore happens outside the
   application, unattributed and unaudited — the exact "permanent hidden
   administrator path" §30 warns against, arrived at by omission rather than
   design.
3. **RLS exemptions undocumented (X5).** Low likelihood of being wrong; high
   cost if a future table is added to that list without scrutiny.

---

## 6. MSP readiness assessment

**Is the product genuinely MSP-first?** _Mostly, with one contradiction._

The operational model is emphatically MSP-first: portfolio exception queue,
coverage ladder, cross-customer aggregation, engineer-capacity measurement,
MSP-scoped surface. The architecture assumes an MSP operator.

The **signup path contradicts it** (M3). `accountKind: 'DIRECT'` is a
direct-to-SME acquisition motion, publicly reachable, with no MSP in the chain.

| Capability             | State                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| Portfolio operation    | **Ready** — but proven only against a synthetic 100-customer portfolio   |
| Microsoft wedge        | **Partial** — Entra + Intune real but shallow; no M365 security surfaces |
| Onboarding             | **Ready for MSP-led**; contains a non-conforming direct path             |
| Offboarding            | **Ready** — implemented and e2e tested                                   |
| Reporting / Passport   | **Strong** — including independent verification                          |
| Partner support        | **Absent** — deferred deliberately                                       |
| Billing / entitlements | **Ready** — provider-neutral, manual + Stripe                            |
| Value measurement      | **Ready, honest** — refuses to produce figures it cannot substantiate    |
| **White-label**        | **Absent** (M4)                                                          |

**Channel-conflict risk: PRESENT.** M3 in code; PR #2 as an open proposal.

---

## 7. Production readiness assessment

Using §45's required distinctions:

| State                    | What qualifies                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IMPLEMENTED**          | Assurance core, Truth Engine, graph, evidence, actions, autonomy, tenancy, three surfaces, Passport + signed interchange, inference, billing, onboarding, offboarding, triage, value, n8n export |
| **TESTED**               | All of the above — 1,149 tests across unit, integration, tenancy, security and e2e                                                                                                               |
| **VERIFIED**             | Tenant isolation, no-silent-yes, Truth Engine purity, keyId binding, injection containment, sovereignty gate — each proved by deliberate breakage                                                |
| **OPERATIONAL**          | Container build, compose smoke deployment, migration idempotency, backup **and restore**, readiness probes — all in CI                                                                           |
| **PROVEN**               | _Nothing with a real customer._ Every operational claim rests on synthetic data                                                                                                                  |
| **NOT PRODUCTION-READY** | Release baseline (R1), containment (K1–K3), questionnaire pipeline (Q2–Q3), white-label (M4), supply chain (O5), residual-risk register (B3)                                                     |

**Required production gates not yet met:**

1. Product exists on `main` with CI green (R1)
2. Residual-risk register exists (§57)
3. Containment and break-glass exist (§30, K1–K3)
4. One real MSP has operated one real portfolio (§58)

> Per §45 and §55, **Adericel is not production-ready**, and no statement in
> this repository should say otherwise. It is, on the evidence, a
> well-engineered pre-production system with an unmerged trunk.

---

## 8. False-capability and placeholder review

**Placeholder scan: clean.** No `TODO`, `FIXME`, `HACK`, `NotImplemented` or
stub markers in production source. The four matches are prose explicitly stating
something is _not_ a stub.

**Mocks resembling real capability:** one, and it is honest —
`demo-fixture` connector is gated to non-production (`allowDemoConnectors:
config.nodeEnv !== 'production'`).

**Documentation claims not backed by implementation:** none found in this audit.
README claims were spot-checked against code and hold. Three stale _counts_ were
corrected during the preceding work cycle (ADR count, n8n workflow/node counts).

**Tests that fail to establish the claimed property:** none identified. The
mutation exercises in §3.13 V2 actively demonstrate the opposite — that the
critical tests do fail when the property is removed.

**Missing negative / adversarial tests:**

- Cross-tenant leakage through portfolio _aggregation_ (M7)
- Backup **corruption** detection (K4)
- RLS exemption list stability (X5)

**Required documentation corrections:**

- ADR-0039 numbering collision between branches must be resolved (R2)
- RLS exemption rationale must be written (X5)
- Residual-risk register must be created (§57)

---

## 9. Recommended implementation sequence

Dependency-ordered. Each item states the smallest safe change.

### Sequence 1 — Establish a release baseline (P0)

**Problem:** The product exists on one unmerged branch; `main` has two files.
**Contract:** §48, §50, §53.
**Existing state:** PR #1 open since 9 Sept, 62 commits. PR #3 duplicates one
feature. PR #2 proposes an out-of-contract product.
**Smallest safe change:** Close PR #3 (superseded — its capability exists in a
later, more complete form). Close PR #2 (outside §2). Merge PR #1 to `main`.
**Security implications:** None directly; removes the risk of losing everything
with one branch.
**MSP value:** Prerequisite to every other item.
**Tests:** Full gate green on `main`.
**Evidence:** `main` contains the product; CI green; tag cut.
**Complexity:** Low.
**Product-owner decision required:** **Yes** — D1, D2 below.

### Sequence 2 — Remove the direct-to-SME path (P0)

**Problem:** `accountKind: 'DIRECT'` is a direct acquisition motion.
**Contract:** §2, §37.
**Existing state:** 6 source files, one migration column, two test files.
**Smallest safe change:** Narrow the enum to `'MSP'`; require `msp_id` on
organisation creation; migrate the column with a check constraint; delete the
DIRECT onboarding task variants; update tests to assert a DIRECT signup is
_rejected_.
**Security implications:** Removes an unauthenticated path that creates tenants.
**MSP value:** Removes channel conflict — a material objection in MSP sales.
**Tests:** A DIRECT signup returns a refusal; no organisation may exist with a
null `msp_id`.
**Evidence:** Migration + adversarial test.
**Complexity:** Low–medium (migration on an existing column).
**Product-owner decision required:** **Yes** — D3.

### Sequence 3 — Residual-risk register (P0, cheap)

**Problem:** §57 requires it; it does not exist.
**Smallest safe change:** `docs/audit/RESIDUAL_RISK_REGISTER.md` seeded from
every AMBER, RED and GREY in this report, with the §57 fields.
**Complexity:** Low. **Decision required:** No.

### Sequence 4 — Containment and break-glass (P1)

**Problem:** No way to isolate a compromised integration or grant audited
emergency access.
**Contract:** §14, §30.
**Existing state:** Absent. Integration statuses and the audit log provide
foundations.
**Smallest safe change:** C0–C5 as a first-class state on integration and
organisation, with explicit triggers, authority, evidence preservation and
restoration verification. Break-glass as a time-limited, scoped, audited grant.
**Security implications:** Large and positive; this is the biggest security gap.
**Tests:** Containment isolates without destroying evidence; break-glass expires
and cannot be extended silently; adversarial test that containment cannot be
lifted without authority.
**Complexity:** Medium–high.
**Decision required:** **Yes** — D4 (who holds containment authority).

### Sequence 5 — Questionnaire pipeline (P1)

**Problem:** The engine has no intake and no persistence.
**Contract:** §19.
**Existing state:** Pure library, correct and tested; ADRs 0034–0038 already
specify the design.
**Smallest safe change:** XLSX intake first (highest real-world frequency),
persistence tables, question classification, control mapping, review and
write-back. DOCX second. PDF deferred.
**Security implications:** The questionnaire is hostile input (ADR-0037); the
inference containment built this cycle applies directly.
**MSP value:** High — this is billable work an MSP does manually today.
**Tests:** No silent yes end to end; hostile questionnaire cannot alter state.
**Complexity:** High.
**Decision required:** **Yes** — D5 (XLSX-first scope).

### Sequence 6 — Microsoft depth for CE v3.3 (P1)

**Problem:** Entra and Intune emit 2 observation kinds each; no M365 security
surfaces. CE v3.3 malware and patch controls are uncoverable.
**Contract:** §4, §26.
**Smallest safe change:** Map CE v3.3 controls to required observations, then
close the gaps in priority order.
**MSP value:** Directly determines whether the wedge works.
**Tests:** Coverage ladder reports genuine CE v3.3 coverage.
**Complexity:** Medium. **Decision required:** No.

### Sequence 7 — White-label (P1)

**Problem:** MSP cannot put its identity in front of its customer.
**Contract:** §38.
**Smallest safe change:** MSP branding on customer-facing reports, Passport
presentation and notifications. Custom domains deferred.
**Security implications:** Must not weaken auditability — the Passport's issuer
remains Veylith regardless of presentation.
**Complexity:** Medium. **Decision required:** **Yes** — D6.

### Sequence 8 — Supply chain (P2)

SBOM generation, signed releases. Blocks enterprise MSP procurement, not the
first sale. **Complexity:** Low–medium.

### Sequence 9 — Consequence reasoning (P2)

Demonstrate §9/§23 impact analysis: one identity change enumerating affected
controls, requirements and portfolio exceptions. Until this exists, the Digital
Assurance Twin claim should not be made.

---

## 10. Product-owner decisions

Only decisions requiring Veylith founder authority.

### D1 — Close PR #3?

**Why it matters:** Two divergent implementations of Passport interchange, with
colliding ADR numbers. Cannot merge both.
**Options:** (a) Close PR #3, keep the working-branch implementation.
(b) Close the working-branch version, adopt PR #3. (c) Reconcile manually.
**Recommendation:** **(a).** The working-branch implementation is strictly more
complete — keyring lifecycle, rotation, revocation, public verification
endpoints, published JSON Schemas, 50 tests, and guards proved by deliberate
breakage. PR #3 has none of the keyring work.
**Consequences:** (a) loses nothing; (b) loses substantial capability;
(c) costs review time for no gain.
**Unknown:** Whether PR #3 contains any deliberate decision not carried forward.
I have compared file sets, not line-by-line intent.
**Authority required:** Founder.

### D2 — Merge PR #1 to `main` now, or continue on the branch?

**Why it matters:** Today the entire product is one branch away from
non-existence, and no release gate has ever run against a trunk.
**Options:** (a) Merge now, tag, continue in smaller PRs. (b) Continue on the
branch until a chosen milestone.
**Recommendation:** **(a), immediately.** §48's gates are meaningless against an
unaccepted branch, and the risk is asymmetric: merging costs an afternoon,
losing the branch costs the product.
**Consequences:** (a) forces smaller future PRs — a benefit. (b) compounds
risk daily.
**Unknown:** Whether you want a review pass before it lands.
**Authority required:** Founder.

### D3 — Remove `DIRECT` signup, or keep a direct channel?

**Why it matters:** v3.0 §2 and §37 forbid a direct-to-SME motion. The code has
one. Either the code changes or the contract does.
**Options:** (a) Remove it — MSP-only, enforced. (b) Keep it as a deliberate
exception, documented and contract-amended. (c) Keep the code, disable by
configuration.
**Recommendation:** **(a).** Channel conflict is a real objection in MSP sales,
and "we _can_ sell direct but promise not to" is a weaker answer than "we
cannot". (c) is the worst option: the capability still exists and an MSP's
technical reviewer will find it.
**Consequences:** (a) forecloses direct revenue — deliberately. (b) requires
amending a contract issued today. (c) leaves a latent contradiction.
**Unknown:** Whether any direct pilot is already promised to anyone.
**Authority required:** Founder — this is a commercial strategy decision, not
an engineering one.

### D4 — Who holds containment authority?

**Why it matters:** Containment isolates a customer's integrations, possibly
during an incident, possibly out of hours. The authority model must be decided
before it is built.
**Options:** (a) Veylith only. (b) MSP may contain its own customers; Veylith
may contain any. (c) Automatic containment on defined triggers, with
notification.
**Recommendation:** **(b), with (c) for a narrow, explicitly enumerated trigger
set** (e.g. credential compromise detected). Pure (a) is too slow when the MSP
is the one watching; pure (c) risks Adericel disabling a customer's integration
on a false positive.
**Consequences:** (b) needs careful authority modelling. (c) needs a very high
trigger bar — a false containment is an outage you caused.
**Unknown:** MSP appetite for holding this authority.
**Authority required:** Founder.

### D5 — Questionnaire: XLSX only first?

**Why it matters:** Determines scope of the largest remaining build.
**Options:** (a) XLSX first, DOCX second, PDF deferred. (b) All three together.
(c) DOCX first.
**Recommendation:** **(a).** Insurer and procurement questionnaires are
overwhelmingly XLSX; PDF intake needs OCR and is the worst effort-to-value
ratio in the set.
**Consequences:** (a) ships usable capability soonest. (b) triples the surface
before any of it is validated. (c) optimises for the rarer format.
**Unknown:** The actual format mix your first MSP receives — **this is worth
asking them before building.**
**Authority required:** Founder, informed by one MSP conversation.

### D6 — How far does white-label go?

**Why it matters:** §38 permits MSP branding; auditability must not be
compromised. The boundary is a product decision.
**Options:** (a) Logo and name on reports and notifications only.
(b) (a) plus customer-facing custom domains. (c) Full white-label where Adericel
is invisible.
**Recommendation:** **(a) now, (b) when an MSP pays for it.** (c) conflicts with
§20 — a Passport whose issuer is obscured cannot be independently verified,
which destroys the property that makes it valuable.
**Consequences:** (c) would require re-examining the entire interchange design.
**Unknown:** Whether MSPs will ask for (c). If they do, the answer must be no,
and the reason is worth having ready.
**Authority required:** Founder.

---

## Appendix A — Audit method

Evidence was collected by direct inspection, not inference:

- Branch and PR state via `git` and the GitHub API
- **RLS coverage queried from the live database** (`pg_class.relforcerowsecurity`)
  rather than grepped from migrations — an early grep-based count was wrong and
  was discarded
- Test counts from a full `pnpm test` run (1,149 passing / 6 skipped)
- Connector depth by reading emitted observation kinds and HTTP endpoints
- Absence claims verified by exhaustive search across `--include=*.ts`,
  `*.tsx`, `*.sql` excluding `node_modules` and `dist`

## Appendix B — What this report does not establish

- **No claim of legal compliance.** §31: documentation existing is not
  compliance.
- **No claim of production readiness.** §7 above states the opposite.
- **No claim of measured customer value.** All operational figures derive from a
  synthetic portfolio, and `packages/value` refuses to produce figures it cannot
  substantiate.
- **No line-by-line review of PR #3's intent.** File sets were compared; D1
  notes this limit.
- **No live Microsoft tenant validation.** I7 is GREY for this reason.
