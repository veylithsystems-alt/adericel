# Adericel Residual Risk Register

**Required by:** Contract v3.0 §57
**Opened:** 15 September 2026
**Owner of the register:** Veylith Systems (founder)

> §57: "Known limitations must never be hidden merely because they make the
> product look less mature."
>
> Every entry derives from the v3.0 Contract Gap Report and names what is
> actually true today. An entry leaves this register when the mitigation is
> implemented **and** evidenced, not when it is planned.

**Acceptance states:** `OPEN` (no mitigation yet) · `MITIGATING` (work in
progress) · `ACCEPTED` (understood, deliberately not fixed now, with a reason) ·
`CLOSED` (fixed and evidenced).

---

## Release and continuity

### RR-001 — The product exists only on an unmerged branch

| Field                | Value                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | `main` holds 2 files. 62 commits (~82k lines) exist only on `claude/adericel-platform-build-k8noew` via PR #1, open since 9 Sept 2026.               |
| **Impact**           | **Critical.** Loss of the branch or the fork loses the product. No release baseline exists, so every §48 gate runs against code nobody has accepted. |
| **Likelihood**       | Low per day, compounding.                                                                                                                            |
| **Affected surface** | Everything.                                                                                                                                          |
| **Mitigation**       | Merge PR #1 to `main`, tag a baseline, work in smaller PRs thereafter.                                                                               |
| **Owner**            | Founder (requires authority to merge).                                                                                                               |
| **Target**           | Immediate.                                                                                                                                           |
| **State**            | `OPEN`                                                                                                                                               |

### RR-002 — Duplicate implementation of Passport interchange in PR #3

| Field           | Value                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | PR #3 implements the same capability with different files and an ADR numbered 0039, which collides with a different ADR-0039 on the working branch. |
| **Impact**      | High if merged — duplicate truth and corrupted ADR numbering. Zero while it stays unmerged.                                                         |
| **Mitigation**  | Close PR #3 as superseded.                                                                                                                          |
| **Owner**       | Founder.                                                                                                                                            |
| **Target**      | Before merging PR #1.                                                                                                                               |
| **State**       | `OPEN`                                                                                                                                              |

### RR-003 — PR #2 proposes an out-of-contract product

| Field           | Value                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | PR #2 ("Money Engine") is a direct-to-consumer personal finance capability. Not in the working tree; branches independently from `main`. |
| **Impact**      | Low technically (no code risk). Governance risk: an open proposal outside the §2 commercial definition.                                  |
| **Mitigation**  | Close, or move to a separate repository if it is a genuine separate venture.                                                             |
| **Owner**       | Founder.                                                                                                                                 |
| **State**       | `OPEN`                                                                                                                                   |

---

## Security

### RR-010 — No containment capability (C0–C5)

| Field                | Value                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description**      | There is no mechanism to isolate a compromised integration, restrict a tenant, or perform emergency containment while preserving evidence. |
| **Impact**           | **High.** If an MSP's Microsoft credentials are compromised, the remedy today is manual database work under time pressure, unattributed.   |
| **Likelihood**       | Low now (no live customers); rises to Medium at first production MSP.                                                                      |
| **Affected surface** | Integrations, credentials, tenant data.                                                                                                    |
| **Mitigation**       | Build C0–C5 with explicit triggers, authority, evidence preservation and restoration verification.                                         |
| **Owner**            | Engineering.                                                                                                                               |
| **Target**           | Before first production MSP.                                                                                                               |
| **State**            | `OPEN`                                                                                                                                     |

### RR-011 — No break-glass access

| Field           | Value                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | No controlled emergency access path exists (§30).                                                                                                                                                                                          |
| **Impact**      | **High.** Incidents are therefore handled with direct database credentials — unattributed, unscoped and untimed. This is precisely the "permanent hidden administrator path" §30 warns against, arrived at by omission rather than design. |
| **Mitigation**  | Time-limited, scoped, audited, revocable emergency grant.                                                                                                                                                                                  |
| **Target**      | With RR-010.                                                                                                                                                                                                                               |
| **State**       | `OPEN`                                                                                                                                                                                                                                     |

### RR-012 — Eight control-plane tables run without RLS, and the reason is undocumented

| Field           | Value                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | `msps`, `users`, `grants`, `plans`, `msp_baselines`, `msp_baseline_controls`, `user_mfa_factors`, `health_checks` have RLS disabled. Verified against the live database, not inferred.              |
| **Impact**      | Low. The exemptions are very likely correct — `grants` is the table that _resolves_ tenancy and cannot be gated by it — but a future table added to that set without scrutiny would not be noticed. |
| **Mitigation**  | Document the rationale per table; add a test asserting the exempt set is exactly these eight, so adding a ninth fails CI.                                                                           |
| **Target**      | Next security pass.                                                                                                                                                                                 |
| **State**       | `OPEN`                                                                                                                                                                                              |

### RR-013 — Portfolio aggregation is not adversarially tested for cross-tenant leakage

| Field           | Value                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Description** | Cross-customer pattern detection (§18) exists. No test attempts to extract one customer's data through the aggregate. |
| **Impact**      | Medium. A leak here would be a critical tenant-isolation failure.                                                     |
| **Mitigation**  | Adversarial test: a portfolio query must not disclose per-customer detail the caller lacks authority for.             |
| **State**       | `OPEN`                                                                                                                |

### RR-014 — Backup corruption detection is unproven

| Field           | Value                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------- |
| **Description** | CI proves backup **and restore** (`ci.yml`). It does not prove that a _corrupted_ dump is detected. |
| **Impact**      | Medium. A silently corrupt backup is worse than none: it is relied upon.                            |
| **Mitigation**  | Corrupt a dump in CI and assert verification fails.                                                 |
| **State**       | `OPEN`                                                                                              |

---

## Capability gaps

### RR-020 — Questionnaire Autopilot has no intake and no persistence

| Field           | Value                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | `packages/questionnaire` is a correct, tested library. There is no XLSX/DOCX/PDF intake, no database tables and no API routes. Nothing can enter it or leave it. |
| **Impact**      | **High commercially.** This is the largest gap between documented and delivered capability, and it is billable MSP work.                                         |
| **Mitigation**  | XLSX intake, persistence, classification, mapping, review, write-back.                                                                                           |
| **Target**      | Phase 5.                                                                                                                                                         |
| **State**       | `OPEN`                                                                                                                                                           |

### RR-021 — Microsoft coverage is too shallow for Cyber Essentials v3.3

| Field           | Value                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Entra emits 2 observation kinds, Intune 2. No Defender, Exchange Online, Purview or Secure Score. Conditional Access policies, privileged roles and patch state are not collected.                               |
| **Impact**      | **High.** The initial commercial wedge (§4) depends on covering CE v3.3, and several controls are currently uncoverable — they will honestly read UNKNOWN, which is correct behaviour and an unsellable product. |
| **Mitigation**  | Map CE v3.3 controls to required observations; close gaps in priority order.                                                                                                                                     |
| **Target**      | Phase 2.                                                                                                                                                                                                         |
| **State**       | `OPEN`                                                                                                                                                                                                           |

### RR-022 — No white-label or MSP co-branding

| Field           | Value                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| **Description** | §38 permits MSP branding. Nothing implements it.                                      |
| **Impact**      | Medium commercially. An MSP cannot put its own identity in front of its own customer. |
| **Mitigation**  | Branding on reports, Passport presentation and notifications. Custom domains later.   |
| **State**       | `OPEN`                                                                                |

### RR-023 — No SBOM, no signed releases

| Field           | Value                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Description** | §48 requires supply-chain controls. Dependency audit and secret scanning exist; SBOM generation and release signing do not. |
| **Impact**      | Medium. Blocks enterprise MSP procurement; unlikely to block a first sale.                                                  |
| **State**       | `OPEN`                                                                                                                      |

### RR-024 — Consequence reasoning across the graph is not demonstrated

| Field           | Value                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | §9 and §23 require that a change triggers impact analysis. The data model supports it; no code walks the graph to enumerate affected controls. |
| **Impact**      | Medium. **Until this exists, the "Digital Assurance Twin" claim must not be made** (§45).                                                      |
| **State**       | `OPEN`                                                                                                                                         |

### RR-025 — No support case model

| Field                        | Value                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Description**              | No SupportCase, incident or knowledge model exists.                                                          |
| **Impact**                   | Low today.                                                                                                   |
| **Rationale for acceptance** | §61 Test 1: an MSP with zero live customers has no support burden. Building this now would be theatre (§44). |
| **Target**                   | Revisit at first paying MSP.                                                                                 |
| **State**                    | `ACCEPTED`                                                                                                   |

---

## Evidence and claims

### RR-030 — No operational figure has been measured with a real customer

| Field           | Value                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Every value, capacity and portfolio figure derives from the synthetic 100-customer portfolio in `proof/`.                                                                   |
| **Impact**      | **High commercially.** §6.6 and §45 forbid presenting these as measured customer results.                                                                                   |
| **Mitigation**  | One real MSP, one real portfolio. `packages/value` already refuses to produce figures it cannot substantiate, which is the correct behaviour and does not remove this risk. |
| **Target**      | First MSP pilot.                                                                                                                                                            |
| **State**       | `OPEN` — and must remain visible in every commercial conversation.                                                                                                          |

### RR-031 — Microsoft connectors are unvalidated against a live tenant

| Field           | Value                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Entra and Intune make real Graph calls with client-credentials auth, tested against fixtures. Neither has run against a live Microsoft tenant. |
| **Impact**      | Medium–High. Permissions, throttling and real-world data shapes are the usual source of first-contact failures.                                |
| **Mitigation**  | One live tenant, one full collection cycle.                                                                                                    |
| **State**       | `OPEN`                                                                                                                                         |

### RR-032 — Mutation testing is manual

| Field           | Value                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | Critical invariants have been proved by deliberate breakage (no-silent-yes, keyId binding, inference containment, sovereignty gate, MSP-only). Each was performed by hand and recorded in a commit message; none is automated. |
| **Impact**      | Low–Medium. The property holds today; nothing re-proves it on every change.                                                                                                                                                    |
| **Mitigation**  | A mutation harness in CI for the enumerated critical invariants.                                                                                                                                                               |
| **State**       | `OPEN`                                                                                                                                                                                                                         |

---

## Closed

### RR-040 — Direct-to-SME path in code — **CLOSED 15 Sept 2026**

| Field                  | Value                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | `accountKind: 'MSP' \| 'DIRECT'` on a public signup created MSP-less organisations; `POST /v1/organisations` did the same. Conflicted with §2 and §37.               |
| **Mitigation applied** | Removed at four layers — schema (strict), service, route and a `NOT NULL` database constraint. ADR-0042. Migration `0026` refuses to run rather than repairing data. |
| **Evidence**           | `tests/security/msp-only-distribution.test.ts` (6 tests); guard proved by reintroducing the field, which failed exactly one test.                                    |
| **State**              | `CLOSED`                                                                                                                                                             |

### RR-041 — "Exactly-once" overclaims — **CLOSED 15 Sept 2026**

| Field                  | Value                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | Action-path comments and ADR-0016's title claimed exactly-once semantics, which no network boundary provides.                                                                 |
| **Mitigation applied** | Corrected in `action-service.ts`, `domain/action.ts`, the n8n export, ADR-0016's title and ADR-0027's bullet. The ADR bodies had always denied the claim; the titles had not. |
| **State**              | `CLOSED`                                                                                                                                                                      |
