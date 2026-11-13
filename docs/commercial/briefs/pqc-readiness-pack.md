# Adericel PQC Readiness Pack — commercial brief

_Post-quantum cryptography readiness, as an add-on to Adericel. A product of
Veylith Systems Ltd._
_Status: **contract approved, Phase 0.** No code written. No customer has used
it. Last reviewed 13 October 2026._

## Target buyer

**The same MSP that buys Adericel**, selling into customers who are starting to
be asked about post-quantum readiness: regulated financial services,
professional services holding long-lived client data, defence and public-sector
supply chains, and anybody filling in a questionnaire that has grown a
quantum section.

The economic buyer is the MSP. The _pressure_ comes from the MSP's customer's
customer — an insurer, a procurement team, a prime contractor — which is why
this is an add-on and not a separate product: it is bought because an existing
assurance relationship has a new question in it.

**ASSUMPTION, load-bearing and unvalidated:** that UK MSPs are already being
asked this. If the questions are still two years away, the product is early and
the right move is to build Phases 0–1 and stop, which is exactly what the
contract instructs.

## The problem

An organisation asked "are you post-quantum ready?" today has no honest way to
answer, and three dishonest ways available:

1. **Say yes**, on the strength of a vendor's "quantum-ready" marketing page.
2. **Say no**, and buy a migration programme for an estate nobody has inventoried.
3. **Buy a scanner**, get a percentage, and present it as a position.

All three fail the same way: **nobody knows what cryptography the estate
actually uses.** The public-key dependencies are spread across TLS endpoints,
certificates, VPNs, SSH, code signing, HSMs, backups, appliances, SaaS
suppliers and embedded libraries — and the honest answer for most of them is
`UNKNOWN`, which no product on the market is willing to say.

Underneath sits the one genuinely urgent concern: **harvest-now-decrypt-later.**
Data with a ten-year confidentiality requirement, encrypted today with RSA, is
already exposed if it can be captured now and decrypted later. That is a
planning problem with a deadline, and it is invisible without an inventory.

## The offer

An evidence-backed PQC readiness position per managed customer, extending
Adericel rather than duplicating it — one Truth Engine, one evidence graph, one
authority model, one Passport (contract §1.4).

- **A declared, versioned scope**, approved by a named person. No declared
  scope means no readiness conclusion — the product renders `UNKNOWN` and
  routes the scope decision, rather than reporting on an estate nobody bounded.
- **Observation state separated from assurance.** `OBSERVED`, `STALE_OBSERVED`,
  `DECLARED_UNOBSERVED`, `UNCOLLECTABLE`, `OUT_OF_SCOPE`, `UNDECLARED`,
  `CONTRADICTORY` — each visible, none collapsed into a clean number.
- **Supplier claims recorded as claims.** A vendor's "quantum-ready" statement
  establishes that the vendor said it, dated, attributed, and unverified. It
  never becomes a technical observation.
- **Harvest-now-decrypt-later as an evidence-backed planning concern**, driven
  by recorded data longevity rather than by fear.
- **Authorised migration actions with verification by re-observation.** A
  completed ticket is not verification. There is no path from "marked complete"
  to "verified" that does not pass through fresh evidence.
- **A signed PQC Readiness Passport** — which is explicitly _not_ a quantum-
  safety certificate, and says so on its face.

**No score.** No readiness percentage, no migration score, no traffic light
that hides an `UNKNOWN` (§3.4). This is the central product decision and the
central commercial risk: a buyer who wants a number to put in a board pack will
prefer a competitor who invents one.

## Price hypothesis

**ASSUMPTION throughout. No price exists in code, and none has been quoted.**

The contract's revenue shape is `MSP platform entitlement + (managed customers
× customer entitlement) + approved add-ons` (§1.3). PQC is the add-on term.

| Shape under consideration                         | Rationale                                                   | Status                   |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| Per-customer monthly uplift on the Adericel price | Matches the platform's unit and bills with the relationship | **Preferred ASSUMPTION** |
| One-off scoping and inventory fee, then monthly   | Reflects that discovery is front-loaded effort              | Plausible, untested      |
| Separate per-customer price                       | Rejected — it implies a second platform, which §1.4 forbids | Discarded                |

**An uplift in the region of 30–50% of the base per-customer price** is the
working hypothesis — a **TARGET**, derived from nothing but the judgement that
a readiness position is worth meaningfully less than the whole assurance
relationship and meaningfully more than a report.

The assumptions underneath, each falsifiable by one conversation:

- MSPs will pay an uplift rather than expecting PQC bundled. **UNKNOWN.**
- A readiness _position_ is worth paying for when competitors sell a _score_
  more cheaply. **UNKNOWN**, and the most likely reason the product fails.
- Discovery effort is low enough to leave margin at a monthly price.
  **UNKNOWN** — it depends on connector coverage nobody has measured.

## Evidence obtained so far

**MEASURED:** nothing. No PQC code exists. Writing a measured figure here would
be the first dishonest line in a product whose contract opens by forbidding
exactly that (§0.8).

**ESTABLISHED, and it is not small:** the platform this extends. The Truth
Engine, the evidence graph with provenance and freshness, the resolution engine
for `UNKNOWN`, the action and verification lifecycle, the authority model,
forced row-level tenancy, the Passport and its issuer-key lifecycle, and the
AI boundary — all `OPERATIONAL` or `VERIFIED`, all reusable, and §1.4 requires
reuse rather than duplication. The PQC pack is a domain layer on working
infrastructure, not a product from zero.

**And one measured fact that bears directly on this product's risk.**
Failure-injection testing of that same infrastructure found four critical
defects in October 2026, including an estate that went `UNKNOWN` on day seven
while every light stayed green. The platform PQC extends is sound in design and
has been wrong in operation. **The implication for this brief: "built on proven
infrastructure" is not available as a claim. "Built on infrastructure that is
tested, and whose last untested dimension contained four critical defects" is
the true version.**

**UNKNOWN and commercially decisive:**

- Whether UK MSPs are being asked about PQC yet. **The single most important
  unknown on this page.**
- Whether a buyer will accept an estate that is mostly `UNKNOWN` as a useful
  deliverable, or read it as a failure to deliver.
- How much of a typical estate the existing connectors can actually observe
  cryptographically. Unmeasured.
- Whether "no score" survives contact with a procurement form that wants one.

## Next milestone

**Phase 0 and Phase 1 only, and then stop** — as §18 instructs, and as the
commercial position independently warrants.

Phase 0: the capability map (existing primitive → requirement → reuse path →
gap → invariant risk), the ADRs, the external reference register, the claims
linter, product-status entries, and the synthetic corpus specification.

Phase 1: product-only PQC domain and migrations, the versioned control pack,
graph-based evidence applicability, declared scope, assets and dependencies,
freshness policy registry, Truth Engine rules, `UNKNOWN` mapping and fan-out,
the six synthetic estates of §19, and the tests and mutation entries.

**Explicitly not built now**, per §18: a score, a dashboard-first feature,
external AI, a public scanner, live customer collection, a migration executor,
or any production claim.

**The milestone that matters more than either phase:** _one conversation with
one MSP about whether their customers are asking._ It costs nothing, needs no
code, and could save the Phase 2–4 investment entirely. **It should happen
before Phase 1 is finished, not after.** Every price, volume and
willingness-to-pay figure on this page is an assumption that one conversation
would begin to test, and continuing to build while that conversation has not
happened is the most expensive mistake available here.
