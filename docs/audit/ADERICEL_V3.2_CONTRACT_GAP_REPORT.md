# Adericel against contract v3.2

**Audited:** 29 September 2026
**Against:** MASTER PRODUCT, ENGINEERING, OPERATING, SUPPORT & BUILD CONTRACT
v3.2
**Method:** each requirement checked against code, migrations and tests in this
repository. Where a requirement was confirmed, the file that confirms it is
named. Where it was not, it is RED or AMBER and says why.

## How to read this

v3.2 is a principle-and-lifecycle contract rather than a numbered-section one,
so this report is organised by the contract's own headings instead of by section
number.

**This audit is bounded by a lossy source.** The contract was supplied as a PDF;
its diagrams did not extract, and it uses diagrams for several load-bearing
lists. Those are listed in [`docs/contract/README.md`](../contract/README.md) and
appear below as `UNAUDITABLE` — not as passes. Nothing in this repository has
been built from a guess at them.

---

## 1. What v3.2 added over v3.1, and what was done about it

| Requirement                                                                                                  | Class     | Evidence                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ten completion conditions ("A feature is not complete because code exists")                                  | **GREEN** | `packages/domain/src/release-gate.ts`; 15 tests; three guards proved by mutation. v3.1's audit counted these without naming them, which is why the gate waited (RR-073).        |
| Eight non-regression invariants ("No change may weaken…")                                                    | **GREEN** | `NON_REGRESSION_INVARIANTS`; an unaffirmed invariant blocks a release, because silence is not an affirmation.                                                                   |
| Four headline truth states `PROVEN` / `FAILING` / `EXCEPTION` / `UNKNOWN`                                    | **GREEN** | `HEADLINE_OF_STATE` in `packages/domain/src/assurance.ts`. A mapping, not a rename: renaming would destroy the internal distinctions and falsify assessments already on record. |
| Ten provenance states, including `DEGRADED`, `BLOCKED`, `FAILED`                                             | **GREEN** | `TRUTH_STATES`. Three were missing. `NON_CLAIM_TRUTH_STATES` records that no claim can carry them, since they describe collection and authority rather than assertion.          |
| Six documentation states (implemented / tested / planned / assumed / externally dependent / legally pending) | **AMBER** | `DOCUMENTATION_STATES` exists and `NOT_YET_CAPABILITY_STATES` names the four that are not yet a capability. Nothing yet enforces that prose in `docs/` carries one. See RR-074. |

## 2. The nine lifecycle stages

| Stage    | Class           | Evidence                                                                                                                                                                                                                                                                       |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ONBOARD  | **GREEN**       | `apps/api/src/services/onboarding.ts`; `tests/e2e/self-serve-onboarding.test.ts`. Missing information becomes UNKNOWN rather than assumed.                                                                                                                                     |
| CONNECT  | **GREEN**       | `packages/integrations`; a missing permission yields a capability limitation rather than fabricated coverage.                                                                                                                                                                  |
| ASSURE   | **GREEN**       | `packages/truth-engine`; deterministic, reproducible, no clock, no network, no model.                                                                                                                                                                                          |
| MONITOR  | **GREEN**       | `assurance_states`, `assessments`, point-in-time reconstruction; `tests/integration/assessment-replay.test.ts`.                                                                                                                                                                |
| MANAGE   | **GREEN**       | Findings, risks, exceptions, actions, approvals, verification across `packages/actions` and `apps/api`.                                                                                                                                                                        |
| VERIFY   | **UNAUDITABLE** | The contract states the authoritative execution lifecycle as a diagram; only `OBSERVE` survived extraction. The repository has an execution and reconciliation path, and whether it matches the contract's sequence cannot be established from the text available. See RR-075. |
| PROVE    | **GREEN**       | Assurance Passport plus `adericel.passport-interchange/v1`, verifiable independently.                                                                                                                                                                                          |
| IMPROVE  | **AMBER**       | Historical evidence informs future assessment and cannot silently establish current truth. Institutional memory beyond that is not built.                                                                                                                                      |
| OFFBOARD | **GREEN**       | `tests/e2e/offboarding.test.ts`; a governed state, not deletion. Adericel never terminates a relationship autonomously.                                                                                                                                                        |

## 3. Requirements this audit found unmet

### R1 — Framework crosswalks are absent — **RED**

v3.2 requires a framework-independent control and requirement layer with
crosswalks preserving **source framework, destination framework, mapping
rationale, confidence, applicability, version and provenance**, and is explicit
that the system "must never imply equivalence where the underlying requirements
differ".

The repository has the framework-independent layer: `controls` carry a
`ruleset_key`/`rule_key` and map to `requirements` through `control_requirements`
with a `coverage` fraction. That is a control-to-requirement mapping within one
framework. There is **no framework-to-framework crosswalk at all** — no table,
no type, no code — so today the same observation satisfying a Cyber Essentials
requirement and an ISO 27001 requirement is expressed only by writing two
controls.

The risk is the one the contract names: the cheap implementation is a mapping
table with no rationale and no confidence, which reads as equivalence. Recorded
as RR-076 and scheduled next.

### R2 — A conflict does not expose its consequence — **AMBER**

v3.2 requires a conflict to expose sources, timestamps, observations, affected
controls, resolution state and **the resulting assurance limitation**.

`ConflictOutcome` in `packages/domain/src/conflict.ts` carries the sources with
`observedAt` and `collectedAt`, the resolution state, the distinct values and a
prose `detail`. It does not carry **which controls the conflict affects**, nor a
typed **assurance limitation**. An operator is told that two sources disagree
and has to work out for themselves what that costs them. The fan-out machinery
built for the resolution queue is the same computation and can supply it.
Recorded as RR-077.

### R3 — Documentation states are not enforced in prose — **AMBER**

See §1. The vocabulary exists; nothing checks that a capability described in
`docs/` carries one of the six labels. RR-074.

## 4. Requirements confirmed, with what confirms them

| v3.2 requirement                                                                            | Confirmed by                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| UNKNOWN never silently becomes PASS                                                         | `engine.test.ts` over every shipped rule; `kleene.test.ts`; and now `headline-state.test.ts` at the presentation boundary.           |
| No generic percentage or opaque security score                                              | ADR-0017; no function combines coverage with satisfaction; the resolution queue reports counts and states the caveat with each one.  |
| AI never establishes authoritative truth                                                    | `isRuleEligible()` refuses `AI_SUGGESTED`; a confirmed AI claim becomes `ASSUMED`, not `OBSERVED`.                                   |
| Issuer keys separately configured, never derived from the root secret                       | `packages/shared/src/config.ts` requires distinct signing credentials and fails closed when absent.                                  |
| Verification distinguishes at least VALID/INVALID/MALFORMED/UNKNOWN_KEY/UNSUPPORTED_VERSION | `VERIFICATION_OUTCOMES` carries eight, splitting INVALID into signature and content-hash failure — a superset, and more informative. |
| Verification works with no account, tenant, database, AI or network                         | `packages/shared/src/passport-interchange.ts` is pure; the standalone verifier takes content, signature and public key only.         |
| Never claim universal exactly-once execution                                                | Corrected across the action path and ADR-0016 (RR-041).                                                                              |
| Tenant isolation, RLS, least privilege, MFA, append-only audit                              | `tests/security` (13 suites), `tests/tenancy`, and the application refuses to start if a tenant table lacks forced RLS.              |
| Do not invent time savings, ROI or customer outcomes                                        | `packages/value` refuses unsubstantiated figures and returns `null` with a reason rather than zero.                                  |
| Not direct-to-SME                                                                           | `tests/security/msp-only-distribution.test.ts`; a `NOT NULL` constraint at the database.                                             |
| Local/self-hosted first, then UK-hosted                                                     | `packages/inference` refuses an external provider without a written acknowledgement.                                                 |
| Engineering readiness is not legal certification                                            | `tests/unit/documentation.test.ts` refuses "certified" and "fully compliant" claims in the legal document set.                       |
| Restoration tested, not merely backed up                                                    | `tests/integration/backup-restore.test.ts`; CI restores a real dump.                                                                 |
| Never present a target as an implemented capability                                         | `docs/product/CAPABILITY_STATUS.md`, generated, with `PROVEN` and above refused to any automated attestation.                        |

## 5. Position

Adericel meets v3.2's truth, evidence, security, privacy and distribution
requirements as far as this repository can establish them, and is **not
production ready** — by the contract's own definition, since no capability is
attested `PROVEN` and no release record exists.

Three requirements are unmet and one is unauditable. None of the four is a
weakening of an established invariant; all four are additions v3.1 did not ask
for.

The recommended order is R1 (crosswalks, because it is structural and gets more
expensive with every framework added), then R2 (conflict consequence, because
the computation already exists), then R3.
