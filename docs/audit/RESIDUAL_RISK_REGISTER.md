# Adericel Residual Risk Register

**Required by:** Contract v3.1 §38 (originally v3.0 §57)
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

### RR-001 — The product exists only on an unmerged branch — **CLOSED 15 Sept 2026**

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

### RR-002 — Duplicate implementation of Passport interchange in PR #3 — **CLOSED 15 Sept 2026**

| Field           | Value                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | PR #3 implements the same capability with different files and an ADR numbered 0039, which collides with a different ADR-0039 on the working branch. |
| **Impact**      | High if merged — duplicate truth and corrupted ADR numbering. Zero while it stays unmerged.                                                         |
| **Mitigation**  | Close PR #3 as superseded.                                                                                                                          |
| **Owner**       | Founder.                                                                                                                                            |
| **Target**      | Before merging PR #1.                                                                                                                               |
| **State**       | `OPEN`                                                                                                                                              |

### RR-003 — PR #2 proposes an out-of-contract product — **CLOSED 15 Sept 2026**

| Field           | Value                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | PR #2 ("Money Engine") is a direct-to-consumer personal finance capability. Not in the working tree; branches independently from `main`. |
| **Impact**      | Low technically (no code risk). Governance risk: an open proposal outside the §2 commercial definition.                                  |
| **Mitigation**  | Close, or move to a separate repository if it is a genuine separate venture.                                                             |
| **Owner**       | Founder.                                                                                                                                 |
| **State**       | `OPEN`                                                                                                                                   |

---

## Security

### RR-010 — No containment capability (C0–C5) — **CLOSED 16 Sept 2026**

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

### RR-011 — No break-glass access — **WITHDRAWN, superseded by RR-061**

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

## New under contract v3.1

> v3.1 added requirement families v3.0 did not contain. These entries derive
> from `ADERICEL_V3.1_CONTRACT_GAP_REPORT.md`.

### RR-050 — No truth-state vocabulary — **CLOSED 15 Sept 2026**

| Field           | Value                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | v3.1 §6 requires OBSERVED / VERIFIED / DERIVED / INTERPRETED / ASSUMED / TARGET as first-class states. Fragments exist (claim origins, collection methods); no unified vocabulary does. |
| **Impact**      | Medium. Adericel cannot currently say what _kind_ of truth an assertion is — which is the question the Assurance Passport exists to answer.                                             |
| **Mitigation**  | One domain module; INTERPRETED must never reach the Truth Engine.                                                                                                                       |
| **Target**      | Sequence 1.                                                                                                                                                                             |
| **State**       | `OPEN`                                                                                                                                                                                  |

### RR-051 — Assurance states lack DEGRADED and BLOCKED — **CLOSED 15 Sept 2026**

| Field                | Value                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | v3.1 §6 requires both as peers of PASS/FAIL/UNKNOWN. The repository carries 6 states and expresses degradation as UNKNOWN with reason `COLLECTION_FAILED`.                                                                                                       |
| **Impact**           | **High.** §6 states semantic distinctions must not be collapsed. Today a degraded connector is indistinguishable from an unassessed control, so an MSP cannot tell "we cannot see this" from "this is broken" — a connector ticket from a customer conversation. |
| **Affected surface** | Truth Engine, domain model, Passport, triage.                                                                                                                                                                                                                    |
| **Mitigation**       | Extend the enum; teach the engine to emit both. Cheapest now, before more code depends on the narrower set.                                                                                                                                                      |
| **Target**           | Sequence 1.                                                                                                                                                                                                                                                      |
| **State**            | `OPEN`                                                                                                                                                                                                                                                           |

### RR-052 — No capability status lifecycle

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | v3.1 §6 requires DESIGNED → IMPLEMENTED → TESTED → VERIFIED → OPERATIONAL → PROVEN → PRODUCTION_READY → COMMERCIAL_VALIDATED → RETIRED, with no status inferable from another. Tracked by hand in audit documents.                                                                                                                                                                                                                                                                                                                                                                          |
| **Impact**      | Medium. §37 documentation integrity depends on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Target**      | With the §36 release record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **State**       | `CLOSED` — `packages/domain/src/capability.ts` models the nine statuses with an independent attestation per status; `scripts/capability-register.ts` holds the register; `docs/product/CAPABILITY_STATUS.md` is generated from it with a drift test. No status is inferred: a skipped status is reported as a skip. `PROVEN`, `PRODUCTION_READY` and `COMMERCIAL_VALIDATED` are refused to any automated attestation, and `tests/unit/capability-status.test.ts` checks every cited evidence path against the repository. **The release evidence record itself remains open** — see RR-073. |

### RR-053 — Support domain absent (now mandatory)

| Field           | Value                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description** | v3.1 §20–26 specify 18 entities, 14 categories, 12 queues, 20 case states, prohibited transitions, entitlement validation, tenant-scoped diagnostics, knowledge lifecycle and AI drafting boundaries. None exists. |
| **Impact**      | **High.** v3.1 §40 places support at Phase 5 and §20 calls it mandatory infrastructure. This reverses RR-025's earlier ACCEPTED state.                                                                             |
| **Mitigation**  | SupportCase, states, entitlement gate and diagnostics first.                                                                                                                                                       |
| **Target**      | Sequence 3.                                                                                                                                                                                                        |
| **State**       | `OPEN` — **supersedes RR-025**, which is withdrawn                                                                                                                                                                 |

### RR-054 — Commercial entitlement not separated from security containment — **CLOSED 16 Sept 2026**

| Field           | Value                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | v3.1 §16 requires ten commercial states and forbids commercial restriction becoming security containment or vice versa. The repository has five subscription states and no containment model. |
| **Impact**      | Medium now, High once containment exists. ADR-0027 gets the principle right by convention; v3.1 requires it by type.                                                                          |
| **Mitigation**  | Model both as distinct concerns when containment is built, not after.                                                                                                                         |
| **Target**      | Sequence 2.                                                                                                                                                                                   |
| **State**       | `OPEN`                                                                                                                                                                                        |

### RR-055 — Backup claims not separated

| Field           | Value                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | v3.1 §30 requires BACKUP_SUCCESS, RESTORE_SUCCESS, SERVICE_RECOVERY and BUSINESS_RECOVERY as distinct claims. CI proves backup and restore; the four are not modelled, and corruption detection is still unproven (RR-014). |
| **Impact**      | Medium. A proven restore is not proven service recovery, and conflating them is the failure §30 names.                                                                                                                      |
| **State**       | `OPEN`                                                                                                                                                                                                                      |

### RR-056 — Test taxonomy incomplete

| Field           | Value                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Of v3.1 §35's suites: five exist and are named; four exist unnamed (connector-contract, property, restore, questionnaire-partial); mutation testing is manual; load, soak, chaos, containment and support do not exist. |
| **Impact**      | Medium. Naming the four is cosmetic; the absence of load, soak and chaos evidence means capacity claims cannot be made (§30).                                                                                           |
| **Mitigation**  | Name what exists; automate mutation; then build the rest.                                                                                                                                                               |
| **State**       | `OPEN`                                                                                                                                                                                                                  |

### RR-057 — No SUPPORT user surface

| Field           | Value                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| **Description** | v3.1 §32 names six surfaces. Five exist as pages (Assurance, Fix, Proof, Change, Ask). SUPPORT does not. |
| **Impact**      | Low independently; gated behind RR-053.                                                                  |
| **State**       | `OPEN`                                                                                                   |

---

### RR-060 — Containment has no automatic triggers

| Field                | Value                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | C0–C5, the 16 triggers and the authority model are implemented and tested. Nothing detects a compromised credential, a scope anomaly or an evidence-integrity failure and raises containment automatically.    |
| **Impact**           | Medium. Containment is an operator capability: it works when somebody notices. The automatic path exists in the authority model (AUTOMATIC may reach C2) and has no caller.                                    |
| **Likelihood**       | Certain — this is a stated absence, not a risk of one.                                                                                                                                                         |
| **Affected surface** | Incident response latency.                                                                                                                                                                                     |
| **Mitigation**       | Wire detectors: credential failure from connector health, scope anomaly from the manifest boundary, evidence-integrity failure from the hash check. Each already produces the signal; none raises containment. |
| **Owner**            | Engineering.                                                                                                                                                                                                   |
| **Target**           | With the support domain (Phase 5), which is where connector health becomes a case.                                                                                                                             |
| **State**            | `OPEN` — and must not be described as autonomous containment until closed.                                                                                                                                     |

### RR-062 — Break-glass has no automatic review enforcement

| Field                | Value                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | Every break-glass grant carries `review_required`, and `outstandingBreakGlass()` reports how many are unreviewed and how old the oldest is. Nothing acts on that number: no reminder, no escalation, no bar on opening another. |
| **Impact**           | Medium. A mandatory review nobody chases becomes a formality, and a formality is indistinguishable from no review at the point somebody asks how the access was governed.                                                       |
| **Likelihood**       | Certain — this is a stated absence, not a risk of one.                                                                                                                                                                          |
| **Affected surface** | Assurance over Veylith's own support access.                                                                                                                                                                                    |
| **Mitigation**       | Surface the count on the Veylith control room, escalate on age, and require the backlog to be cleared before non-emergency grants. The signal exists; it has no consumer.                                                       |
| **Owner**            | Engineering.                                                                                                                                                                                                                    |
| **Target**           | With the support domain (Phase 5), where a review becomes a case with an owner.                                                                                                                                                 |
| **State**            | `OPEN` — break-glass must not be described as "reviewed" until closed. It is _recorded_ and _review-required_.                                                                                                                  |

### RR-071 — Company-layer migrations 0018–0020 already applied on existing installs

| Field                | Value                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | Layered migrations stop the `veylith.*` schema being created on new product installs. A database that was migrated before ADR-0049 already has it, and nothing removes it.                                                                                      |
| **Impact**           | Low today — there are no customer installs yet, so no customer database holds it. It becomes Medium the day one exists and was provisioned from an older image.                                                                                                 |
| **Likelihood**       | Certain for any pre-ADR-0049 database.                                                                                                                                                                                                                          |
| **Affected surface** | A customer's database would hold empty Veylith tables. Empty, because the routes that write them were never reachable without the company layer's own principals — but present, and present is what a data-protection question asks about.                      |
| **Mitigation**       | A product-layer migration that drops the `veylith` schema when it is empty and refuses when it is not, so it can never destroy a company deployment. Deliberately not written blind: it is a destructive migration and deserves a real install to test against. |
| **Owner**            | Engineering.                                                                                                                                                                                                                                                    |
| **Target**           | Before the first customer self-hosts.                                                                                                                                                                                                                           |
| **State**            | `OPEN`                                                                                                                                                                                                                                                          |

### RR-073 — No release evidence record has been produced

| Field             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**   | The contract requires a standard release and capability gate with ten named conditions, plus a release evidence record. The capability half was built first (RR-052).                                                                                                                                                                                                                                                                                      |
| **Impact**        | Medium. Without a record there is no single artefact stating what was true at a release, which is what a customer or an assessor asks for after an incident.                                                                                                                                                                                                                                                                                               |
| **Likelihood**    | Certain until a release is cut.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Why it waited** | The ten conditions were not enumerated anywhere in this repository — the v3.1 audit named their count, not their content. Inventing ten and labelling them as the contract's would have been a documentation overclaim of exactly the kind the contract forbids, and it would have read as conformant while being fabricated. Contract v3.2 supplied them verbatim under "A feature is not complete because code exists", which removed the need to guess. |
| **Mitigation**    | `packages/domain/src/release-gate.ts` models the ten conditions and the eight non-regression invariants. An unassessed condition blocks rather than passes, a `NOT_APPLICABLE` without a reason blocks, and the four conditions no pipeline can establish are refused to any automated claim. `pnpm release:position` reports where the working tree stands and deliberately produces no record.                                                           |
| **Owner**         | Engineering for the gate (done); Veylith founder to sign a release.                                                                                                                                                                                                                                                                                                                                                                                        |
| **Target**        | The first cut release.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **State**         | `OPEN` — the gate is built; no release has been cut, so no record exists. Closing this is a release event rather than an engineering task: four conditions and all eight invariants need a named person to have looked, and nothing in the repository signs on their behalf.                                                                                                                                                                               |

### RR-065 — Support knowledge, AI drafting and most diagnostic collectors — **OPEN**

| Field                | Value                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | §25 versioned knowledge, known issues and the AI drafting boundary are not built. Of the seven diagnostic sections, three collect (`INTEGRATION_HEALTH`, `IMPAIRMENT_STATE`, `PLATFORM_VERSIONS`); the other four return empty.                          |
| **Impact**           | Medium. A bundle is less useful than it will be. It is not misleading: a declared section with no collector returns empty rather than being omitted, so the bundle says it asked and found nothing instead of letting a reader assume there was nothing. |
| **Likelihood**       | Certain — this is a stated absence.                                                                                                                                                                                                                      |
| **Affected surface** | Time to diagnose. Not disclosure: the unwritten collectors cannot leak what they do not gather.                                                                                                                                                          |
| **Mitigation**       | Write the four remaining collectors against the same shaping discipline (named columns, no error text, no configuration). Knowledge and AI drafting after, behind the §5.3 boundary — a drafted reply is `AI_SUGGESTED` and never sent unreviewed.       |
| **Owner**            | Engineering.                                                                                                                                                                                                                                             |
| **Target**           | With the second support increment.                                                                                                                                                                                                                       |
| **State**            | `OPEN` — support must not be described as AI-assisted until the drafting boundary exists.                                                                                                                                                                |

### RR-066 — Proactive support has no producer

| Field                | Value                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**      | §24. The `SYSTEM` requester kind exists and routes correctly — a case Adericel raises about what it observed goes to the MSP that owns the customer. Nothing calls it. Connector health, failed actions and integrity failures raise no case. |
| **Impact**           | Medium, and it pairs with RR-060 (containment has no automatic triggers): both are the same missing wire from an existing signal to an existing consumer.                                                                                     |
| **Likelihood**       | Certain — this is a stated absence.                                                                                                                                                                                                           |
| **Affected surface** | Support is reactive. A customer notices before Adericel tells them, which is the opposite of the claim.                                                                                                                                       |
| **Mitigation**       | Wire connector health, dead-lettered actions and evidence-integrity failures to `openCase` with `requesterKind: 'SYSTEM'`. The routing, the severity model and the record all exist; the producer does not.                                   |
| **Owner**            | Engineering.                                                                                                                                                                                                                                  |
| **Target**           | With the second support increment, alongside RR-060.                                                                                                                                                                                          |
| **State**            | `OPEN` — support must not be described as proactive until closed.                                                                                                                                                                             |

### RR-063 — Commercial states are modelled but barely driven — **OPEN**

| Field                | Value                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Description**      | The ten §16 states exist, are enforced and are reachable through the MSP routes. Only `ACTIVE`, `PAST_DUE`, `TERMINATED` and `UNKNOWN` are ever set automatically (by a provider webhook). `DRAFT`, `PAYMENT_PLAN`, `COMMERCIAL_RESTRICTION`, `COMMERCIAL_SUSPENSION` and `ARCHIVED` only move when a person moves them. |
| **Impact**           | Low, and partly deliberate: restriction and suspension are decisions somebody must make, and a dunning timer that suspends customers unattended is worse than none. `ARCHIVED` is the real gap — nothing advances a terminated account when its retention window elapses.                                                |
| **Likelihood**       | Certain — this is a stated absence.                                                                                                                                                                                                                                                                                      |
| **Affected surface** | Retention hygiene; terminated accounts sit in `TERMINATED` indefinitely.                                                                                                                                                                                                                                                 |
| **Mitigation**       | A scheduled job advancing `TERMINATED` → `ARCHIVED` once retention elapses, using the existing retention policy rather than a new clock. Dunning stays advisory: it proposes, a person decides.                                                                                                                          |
| **Owner**            | Engineering.                                                                                                                                                                                                                                                                                                             |
| **Target**           | With the support domain (Phase 5).                                                                                                                                                                                                                                                                                       |
| **State**            | `OPEN` — the model must not be described as a lifecycle until the terminal step runs on its own.                                                                                                                                                                                                                         |

### RR-074 — Documentation states are not enforced in prose

| Field           | Value                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | v3.2 requires documentation to distinguish implemented / tested / planned / assumed / externally dependent / legally pending. `DOCUMENTATION_STATES` exists; nothing checks that a capability described in `docs/` carries a label. |
| **Impact**      | Medium. "Never present a target as an implemented capability" is the rule most easily broken by a sentence written in good faith.                                                                                                   |
| **Mitigation**  | The capability register and its generated document already carry a status per capability, and the documentation tests refuse compliance claims. Neither covers ordinary prose.                                                      |
| **Owner**       | Engineering.                                                                                                                                                                                                                        |
| **Target**      | With the next documentation pass.                                                                                                                                                                                                   |
| **State**       | `OPEN`                                                                                                                                                                                                                              |

### RR-075 — Eight passages are incomplete in the contract document

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | Eight passages in contract v3.2 introduce a list or a sequence and are followed by nothing. The most consequential is §3.6 VERIFY's authoritative execution lifecycle, which has only its first bullet, `-OBSERVE`. The others are listed in `docs/contract/README.md`.                                                                                                                                                                      |
| **Correction**  | This was first recorded as a PDF extraction failure. That was wrong and is corrected here. The document was re-read with a positional extractor that decodes composite fonts and groups by coordinate, then examined directly: it holds no images, no form XObjects, no vector drawing on any of its 22 pages, and no text fragments at the coordinates concerned. The gap under "The fundamental Adericel loop is:" is one empty paragraph. |
| **Impact**      | Medium. The execution lifecycle governs when an action outcome may be called successful, which is a correctness boundary rather than a presentational one.                                                                                                                                                                                                                                                                                   |
| **Mitigation**  | The existing path already refuses to treat dispatch as success and sends unestablished outcomes to reconciliation, which is the principle v3.2 states in the prose around the missing list.                                                                                                                                                                                                                                                  |
| **Owner**       | Veylith founder — the lists are needed. If the Word original holds them, re-exporting would supply them.                                                                                                                                                                                                                                                                                                                                     |
| **Target**      | On receipt of the missing passages.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **State**       | `OPEN` — blocked on input. Deliberately not guessed: inventing a lifecycle and calling it the contract's would be worse than recording that it is unstated.                                                                                                                                                                                                                                                                                  |

### RR-076 — No framework crosswalks — **CLOSED 29 Sept 2026**

| Field                     | Value                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**           | v3.2 requires crosswalks preserving source framework, destination framework, mapping rationale, confidence, applicability, version and provenance, and forbids implying equivalence where requirements differ. The repository mapped controls to requirements within a framework and had no crosswalk at all.                                                                                                                                 |
| **Mitigation applied**    | `packages/crosswalk` and migration `0033`. Every crosswalk is a **directed** statement: a symmetric pair is itself an equivalence claim, and `reverseOf()` returns null for every directed relation so a caller cannot flip one. All seven required fields are mandatory with no defaults. Confidence is banded rather than numeric, each band requiring a stated reason.                                                                     |
| **The load-bearing part** | A crosswalk never establishes an assurance state. `stateFromCrosswalks()` returns UNKNOWN whatever the crosswalks say, including EQUIVALENT, and exists so the refusal is a thing in the codebase rather than an absence somebody has to notice. The attractive feature — answering ISO 27001 automatically from Cyber Essentials evidence — is the one that would make every determination rest on an opinion about two paragraphs of prose. |
| **Evidence**              | 28 tests. Three invariants proved by deliberate breakage: EQUIVALENT determining SATISFIED (1 test), every relation made readable in reverse (2), an unconfirmed AI-suggested crosswalk made usable (1). Three database constraints proved to refuse against the live database: a tentative EQUIVALENT, an unconfirmed AI suggestion, and an evidence-bearing relation at UNKNOWN confidence.                                                 |
| **Findings en route**     | `UNRELATED` was added as a relation once it became clear that without it, "no crosswalk exists" and "somebody assessed the pair and found no relationship" are the same empty result and lead to different work.                                                                                                                                                                                                                              |
| **Residual**              | No crosswalk data is seeded. The layer is built and empty, which is honest: a published Cyber Essentials to ISO 27001 mapping has to be read from the schemes rather than invented. See RR-078.                                                                                                                                                                                                                                               |
| **State**                 | `CLOSED`                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### RR-077 — A conflict does not state what it costs — **CLOSED 29 Sept 2026**

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | v3.2 requires a conflict to expose affected controls and the resulting assurance limitation. `ConflictOutcome` carried sources, timestamps, resolution state and prose detail, and neither of those two — so it reported that two systems disagreed and left an operator to work out what that darkened.                                                                                                      |
| **Mitigation applied** | `conflictConsequence()` in `packages/domain/src/conflict.ts`, plus `ASSURANCE_LIMITATIONS`. Kept separate from `resolveConflict` because deciding what to believe needs only the sources, while deciding what the disagreement costs needs the assurance graph. The caller supplies the fan-out, which the resolution service already computes.                                                               |
| **The distinction**    | `DETERMINATION_WITHHELD` and `DETERMINATION_RESTS_ON_ONE_SOURCE` are separated deliberately. A conflict resolved by a configured authority produced a determination on a contested reading: that is decided, not undecided, and a Passport recipient is entitled to know it was contested, because "Intune says encrypted" and "Intune says encrypted while the RMM says otherwise" are different statements. |
| **Evidence**           | 9 tests. Three guards proved by deliberate breakage: a contested-but-decided reading reporting no limitation, affected controls double-counted, and the consequence rewritten as a restatement of the state ("controls stay UNKNOWN", which is a tautology).                                                                                                                                                  |
| **State**              | `CLOSED`                                                                                                                                                                                                                                                                                                                                                                                                      |

### RR-078 — The crosswalk layer is built and empty

| Field           | Value                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description** | `packages/crosswalk` and `framework_crosswalks` exist and hold no rows. Adericel therefore carries the machinery for cross-framework evidence reuse and offers none in practice.                                                                                                                      |
| **Impact**      | Low technically, Medium commercially. An MSP holding Cyber Essentials and ISO 27001 sees no leads, so the value of the layer is not yet realised.                                                                                                                                                     |
| **Why empty**   | A crosswalk between two published schemes has to be read from the schemes. Writing one from recollection would produce a mapping with a confident rationale and no basis — the precise failure the `confidence` band and `provenance` field exist to prevent, committed by the person who built them. |
| **Mitigation**  | The absence is visible rather than silent: `crosswalkCoverage` returns a statement saying the requirement must be established on its own evidence, and `UNRELATED` distinguishes an assessed pair from an unexamined one.                                                                             |
| **Owner**       | Veylith founder — the published requirement texts are needed, or a decision to commission the mapping.                                                                                                                                                                                                |
| **Target**      | Before a customer holds two frameworks.                                                                                                                                                                                                                                                               |
| **State**       | `OPEN` — blocked on source material, not on engineering.                                                                                                                                                                                                                                              |

---

## Closed

### RR-072 — The product/company separation was claimed but not enforced — **CLOSED 17 Sept 2026**

| Field                  | Value                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | The README stated that a customer self-hosting Adericel "gets the assurance platform and none of Veylith's commercial machinery, and a test asserts that separation holds". The test asserted it over `packages/` only; the dependency was in `apps/`.                                    |
| **Impact**             | **High.** `apps/api` imported the company layer at startup, registered `/v1/veylith/*` unconditionally, and migrations created the `veylith.*` schema on every install. A customer would have held Veylith's commercial pipeline, backed it up, and exposed it with their DB credentials. |
| **Mitigation applied** | `ADERICEL_COMPANY_LAYER`, default off, enforced at four layers: routes not registered, no static import path, `MIGRATION_LAYER=product` skips the company schema, and a `product` Docker target that removes the company layer's compiled output. ADR-0049.                               |
| **Evidence**           | `tests/unit/architecture.test.ts` (no static path; every dynamic import guarded; default off across seven spellings), `tests/unit/migration-layers.test.ts` (manifest cannot drift either way), `tests/e2e/product-separation.test.ts` (8 tests, both sides of the switch).               |
| **Findings en route**  | The README also described `packages/value` as company machinery. It is product — the MSP's own proof-of-value argument to their client — and gating it would have withheld the argument for the deployment. Corrected rather than enforced.                                               |
| **Verified**           | A clean database migrated with `MIGRATION_LAYER=product`: 77 Adericel tables, no `veylith` schema, no company migration in the ledger.                                                                                                                                                    |
| **Residual**           | Pre-existing databases still carry the schema — see RR-071.                                                                                                                                                                                                                               |
| **State**              | `CLOSED`                                                                                                                                                                                                                                                                                  |

### RR-067 — U1–U4, U8 — The support domain — **CLOSED 16 Sept 2026**

| Field                  | Value                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | §20–26 was the largest capability gap in the v3.1 report: zero matches for `SupportCase` anywhere. Support is not optional — §20 makes it part of assurance infrastructure and Phase 5 of the build order.                                                                                          |
| **Mitigation applied** | `packages/support` (case states + prohibited transitions, MSP-first routing, the disclosure gate, integrity-protected bundles), migration `0031` (five tables, three append-only triggers, RLS throughout), API service and routes. ADR-0048.                                                       |
| **Evidence**           | 52 package tests, 10 security tests over the whole state × kind × requester cross product, 20 e2e. Eleven guards proved by mutation, each failing named tests.                                                                                                                                      |
| **Findings en route**  | Two, both from running it: the version collector was refused by row-level security for reading the migration ledger (correctly — that table belongs to the runner, not the application); and a leak assertion was matching the bundle's own "carries no credentials" disclaimer rather than a leak. |
| **Decision applied**   | D2 as recommended: the direct-support entitlement gate is built and granted to nobody, with a test asserting no `INSERT` into it exists anywhere in the application.                                                                                                                                |
| **Residual**           | Knowledge and the remaining collectors (RR-065); the proactive producer (RR-066).                                                                                                                                                                                                                   |
| **State**              | `CLOSED`                                                                                                                                                                                                                                                                                            |

### RR-064 — E1/E2 — Commercial model and its separation from containment — **CLOSED 16 Sept 2026**

| Field                  | Value                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | Five subscription states did both jobs. `SUSPENDED` meant an unpaid invoice to one reader and a compromised tenant to another; 0028 had already flagged the same word carrying both meanings on `organisations.status`.                                                   |
| **Mitigation applied** | Ten states with names that say which kind they are (`COMMERCIAL_SUSPENSION`, `TERMINATED`), one enum shared with `SubscriptionStatus`, `commercial_transitions` append-only with mandatory reason and prior customer notification, migration `0030`. ADR-0047.            |
| **Evidence**           | `tests/security/commercial-separation.test.ts` (8), `packages/domain/src/commercial.test.ts` (15), `tests/e2e/commercial-states.test.ts` (11). A `containmentForCommercialState` helper fails exactly one; a billing field on `ControlAssessmentInput` fails exactly one. |
| **Findings en route**  | `definitionOf()` returned `undefined` for an unrecognised level rather than refusing, so a commercial state reaching containment crashed on a property read one line later — a category error presenting as a containment bug. It now refuses by name.                    |
| **Residual**           | Automation of the terminal states — see RR-063.                                                                                                                                                                                                                           |
| **State**              | `CLOSED`                                                                                                                                                                                                                                                                  |

### RR-061 — No break-glass access — **CLOSED 16 Sept 2026**

| Field                  | Value                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Description**        | §28 required emergency access that is scoped, time-limited, logged and revocable. Containment gave Veylith a governed way to _restrict_; there was no governed way to _reach in_, so it happened outside the application with database credentials.                                            |
| **Mitigation applied** | `break_glass_grants` + migration `0029`. An ordinary grant with a four-hour ceiling, ≥30-character justification, mandatory second factor, no authority-conferring permissions, MSP notified at the time, visible to the organisation through its own RLS scope, append-only. ADR-0046.        |
| **Evidence**           | `tests/e2e/break-glass.test.ts` (16 tests); `packages/domain/src/break-glass.ts`. Non-extendable, non-rewritable and non-deletable are asserted against the live database, not the service.                                                                                                    |
| **Findings en route**  | Three, each fixed rather than noted: the grant conveyed the whole `BREAK_GLASS` role instead of the permissions requested (→ `grants.attenuated_to`); a second window after natural expiry hit a unique violation and a 500; and the "before" baseline in the confers-access test was vacuous. |
| **Residual**           | Review enforcement — see RR-062.                                                                                                                                                                                                                                                               |
| **State**              | `CLOSED` — supersedes RR-011.                                                                                                                                                                                                                                                                  |

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
