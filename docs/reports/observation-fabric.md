# The universal integration and observation fabric

**Report against the brief · 2026-09-10 · branch `claude/adericel-platform-build-k8noew`**

Written to the standard the brief sets: optimise for discovering whether
Adericel is actually trustworthy, not for making the report look good. Section
H lists everything that is wrong or missing, including things nobody would find
without reading the code.

---

## A. What was asked for

> A universal integration and observation architecture capable of converting
> heterogeneous external system outputs into canonical assurance observations
> without coupling the assurance model to individual vendors.

Explicitly **not** "more integrations", and explicitly not a collection of
vendor-specific adapters bolted onto the existing codebase.

The test applied throughout: **could a competitor replace Microsoft Entra with
an RMM, or add a vendor Adericel has never seen, by writing one adapter and
changing nothing else?** Before this work the answer was no, and the reason was
not missing connectors — it was that nothing in the system could reason about
what a connector was able to supply.

## B. What existed before

Inspection first, per §46. The foundations were genuinely sound and are
unchanged:

- A connector contract with config/credential schema separation, sealed
  credentials, SSRF-hardened egress and cursor-based incremental collection.
- Canonical observation kinds and deterministic normalisers producing canonical
  predicates, recorded as `DETERMINISTIC_NORMALISATION` so a human can check the
  claim by reading the code.
- Real Entra, Intune and Google Workspace connectors, plus a declaratively
  configured generic HTTP connector.
- Row-level security, evidence provenance, verification requiring re-observation.

The gaps were about **reasoning**, not plumbing:

| Missing | Consequence |
| --- | --- |
| Machine-readable manifest | Connector metadata readable by TypeScript and nothing else |
| Collect-capability model | `capabilities` meant executable actions only; collection was unrepresented |
| Predicate → source resolution | Could not answer "what can this customer's integrations tell us?" |
| Source conflict representation | **A second source silently superseded the first** |
| Per-capability outcomes | "Degraded" — accurate, useless |
| Schema drift detection | A vendor moving a field looks identical to a customer having no data |
| Collection planning | Every integration ran everything, every time |
| LIVE/DEMONSTRATION distinction | Not surfaced anywhere |
| Conformance suite | Adapter uniformity was an aspiration, not a fact |

## C. What was built

**The manifest.** Every connector declares, machine-readably, which canonical
predicates each collection capability supplies, what permission it needs, what
it produces and whether it talks to a real system. `predicates` is the
load-bearing field: it is how a required predicate resolves to a connector, how
a plan is built, and how *cannot be assessed* is told apart from *failed*.

**Canonical predicates as the only vocabulary.** `identity.mfa.enforced`, never
`entra_strongAuthenticationRequirements`. Vendor language stops at the adapter.
The payload-key → predicate mapping is now a declarative table (`PREDICATE_MAP`)
read by both the normaliser and by manifest derivation for connectors whose
capability is a property of their configuration.

**Collection planning.** Deduplicated by (integration, capability): three
controls needing one predicate collect once. Every source that can supply a
predicate is collected, not a preferred one — choosing at collection time would
hide a disagreement. Deterministic, so a plan can be shown before it runs.

**Source conflict.** Claims carry their source integration. A contradicting
second source is adjudicated by per-predicate authority, then by a configured
freshness margin, then — if nothing settles it — both claims become `DISPUTED`,
no rule reads them, and the dependent controls report UNKNOWN with the
disagreement as the reason. Detection lives inside `claims.assert`, the single
funnel every claim passes through.

**Per-capability outcomes.** Nine states, persisted per run, with the predicates
each failure cost denormalised onto the row. `EMPTY` is informative — no cloud
resources is a fact, not a failure. `PERMISSION_DENIED` names the exact scope to
grant.

**Schema drift.** A connector declares the fields it depends on; their absence
across a sampled population is reported as drift rather than as absence. An
empty response is explicitly not drift.

**Capability discovery, in the API and the product.** Three routes and a Proof
page section answering what Adericel can currently see, per evidence area,
including the areas nothing reaches. Control explanations now say which of three
things is true when a control is UNKNOWN — nothing supplies this, something
supplies it and is failing, or two systems disagree — and what would fix it.

**Conformance.** 105 assertions every connector must pass, including one that
drives each connector against a realistic upstream response and fails if it
declares a predicate it does not actually produce.

## D. Evidence it works

Not asserted — run.

| | |
| --- | --- |
| Tests | **691 passing, 6 skipped** (was 516 at the start of this work) |
| New suites | conformance (105), manifest honesty (5), fabric units (30), verification (10), source conflict (13), observation coverage (13) |
| Build | `tsc -b` clean across 12 packages |
| Migration | 0017 applied to a database at 0016 and to a virgin one |
| Live | Signed up, connected two contradicting sources, collected, assessed, and read the coverage report and control explanation through a running API and browser |

Three defect classes were **proved caught** by reverting the fix and confirming
the tests fail: source conflict detection (11 tests), the permanently
unassessable predicate check, and the manifest-honesty check.

## E. Defects found and fixed

Thirteen, all pre-existing, none reported by a user.

**Correctness of assurance**

1. **A second source silently superseded the first.** Two systems disagreeing
   about whether a laptop was encrypted resolved by whichever collection ran
   last, with no record that the question was contested. The most serious
   finding in this work.
2. **Three ISO 27001 controls were permanently unassessable.**
   `organisation.incident.plan_published`,
   `organisation.incident.last_exercise_at`,
   `organisation.change.process_published` were required by rules and producible
   by nothing — not a connector, not a pushed observation, not a person. The
   control read UNKNOWN forever, the explanation said "record this manually", a
   customer would have done so, and nothing would have changed.
3. **Five overclaimed predicates.** Two connectors declared predicates they
   never produce. Planning would have believed the control covered, so it read
   as a genuine gap in the customer's estate rather than as evidence Adericel
   never asked for.
4. **Intune's `device.management.sync` could never be verified.** It re-observed
   `device.sync.recent`, a predicate no normaliser produces. Safe-fail — it sat
   at UNVERIFIED — but the capability was inert.
5. **Evidence gaps were computed from the wrong set.** The explanation read the
   assessment's recorded inputs, which cover only what a rule actually read, so
   it told a customer to connect Intune for evidence a connected source had
   already supplied.

**Honesty of presentation**

6. **Coverage omitted domains no connector reaches**, letting a customer read
   the covered areas as the whole picture and conclude their backups were fine
   because nothing said otherwise.
7. **Demonstration capabilities appeared as coverage a customer could connect** —
   inviting someone to satisfy a control with fixture data.
8. **A connected, working fixture reported as covering nothing**, because
   discovery only knew capabilities from static manifests.
9. **Integrations that had never run reported HEALTHY.**

**Structural**

10. `planCollection` was order-dependent, so the plan varied with the order
    integrations happened to arrive in — unreproducible and unreviewable.
11. `DISPUTED` was unreachable in the claims filter — the one status an operator
    goes looking for.
12. Intune declared it produced `PATCH_STATE`; it emits `DEVICE_STATE`, and
    `PATCH_STATE` has no normaliser, so anything under that kind would have
    yielded zero claims silently. Entra declared `ACCESS_GRANT` (never emitted)
    and omitted `CONFIGURATION_SETTING` (which it does emit).
13. **`pnpm dev:api` and `dev:worker` had never worked.** `tsx` takes `watch` as
    a subcommand before flags.

## F. Capability added, not only structure

Intune now reads Graph's per-device `windowsProtectionState` for firewall and
anti-malware posture — real Cyber Essentials evidence Adericel simply was not
collecting. It is its own capability, read per device and capped, so hitting the
cap reports PARTIAL rather than silently covering part of an estate.

## G. Coverage, measured

Shipped live connectors (Entra, Intune, Google Workspace) supply:

| Ruleset | Predicates supplied |
| --- | --- |
| Cyber Essentials | **8 / 15** |
| Adericel baseline | 11 / 29 |
| ISO 27001:2022 | 12 / 36 |
| **Union** | **13 / 41** |

The remainder split two ways, and the distinction is the product's shape:

- **No connector exists yet**: cloud storage posture, backup state,
  vulnerability state, boundary firewall. Adericel today is a Microsoft-first
  identity and endpoint assurance product. That is the intended wedge — it is
  now *stated* rather than implied.
- **Legitimately human-asserted**: policy publication and review, supplier
  assurance, incident-plan publication, training completion. These have a route
  in and are not fabric gaps.

A test holds Cyber Essentials above 50% connector-supplied, because a wedge
where most controls need a person to type the answer is not autonomous
assurance.

## H. Known limitations — nothing hidden

1. **Coverage is thin, and that is the honest headline.** 13 of 41. Four
   evidence domains have no connector at all. The fabric makes adding them
   cheap; it does not add them.
2. **`identity.admin_account_separate` is unsupplied and I removed it rather
   than inferring it.** Graph does not state whether an administrator holds a
   separate day-to-day account. Inferring it from a naming convention would be a
   guess dressed as an observation. The Cyber Essentials control that needs it
   now reads UNKNOWN, which is worse-looking and true.
3. **Schema drift detection is written and no connector calls it.** The module
   is tested; no adapter declares field expectations yet, so drift is currently
   caught only where a connector already notices missing data.
4. **Conflict resolution compares exactly two sources.** The pure function
   handles N; the `claims.assert` path adjudicates the incoming claim against
   the one live claim. Three genuinely disagreeing sources resolve pairwise,
   which reaches the same UNRESOLVED outcome but records only the latest pair.
5. **`source_authority_policies` has a write route and no read route.** An
   operator can set authority and cannot list what they set, except through the
   conflict records.
6. **Collection planning is not yet wired into the scheduler.** `planCollection`
   is used for coverage and gap explanation; scheduled collection still runs
   each integration's full repertoire. The saving at MSP scale is available and
   unclaimed.
7. **The generic HTTP connector emits no capability reports.** Its manifest is
   derived correctly; its runs do not report per capability.
8. **No UI to resolve a conflict.** The Proof page shows disagreements; settling
   one requires the API.
9. **Google Workspace collects identity only.** No device, no Drive sharing
   posture, no admin audit.
10. **The three previously-unassessable predicates now have a route in and no
    source.** They are supplied by a pushed `CONFIGURATION_SETTING` observation.
    Nothing in the product yet *asks* a customer for them, so in practice those
    ISO 27001 controls stay UNKNOWN until someone uses the API.
11. **`healthFromReports` ignores capability count.** One failing capability out
    of six reports the same health as six out of six.
12. **Entra could supply organisation password policy and does not.** Graph
    exposes it; `organisation.password.min_length` and
    `organisation.password.breach_screening_enabled` are unsupplied gaps that a
    connector change would close.

## I. What I would do next, in order

1. Wire `planCollection` into the scheduler — the saving is already built.
2. Entra password policy, then a backup connector: the two cheapest coverage
   gains against the wedge.
3. Declare field expectations on Entra and Intune so drift detection is live.
4. A read route and a UI for source authority, so a conflict can be settled
   without curl.
5. N-way conflict recording.
6. Prompt for the human-asserted predicates during onboarding, so the ISO 27001
   controls that need them have a path a customer will actually walk.

---

### The standard, restated

> Can Adericel be trusted to determine, record, explain and verify
> organisational security assurance without silently inventing certainty or
> allowing unauthorised action?

On the fabric specifically: it now refuses to choose between contradicting
sources, refuses to declare a capability it cannot demonstrate, refuses to
present demonstration data as observation, and refuses to report a control as
assessable when nothing can supply its evidence. Each of those refusals makes
the product look worse and makes it true.
