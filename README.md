# Adericel

**Autonomous Organisational Security Assurance Infrastructure.**

Adericel is a system of record for what is actually true about an
organisation's security posture — and, just as importantly, for what is not
known. It is built for managed service providers who are accountable for the
security of many organisations at once and cannot afford a tool that guesses.

---

## The three ideas everything else follows from

**1. `UNKNOWN` is a state, not a gap.**

Most security tooling has two answers: pass and fail. Anything it cannot see
becomes one of them, usually pass. Adericel has three. `UNKNOWN` means Adericel
does not know, and it never quietly resolves to secure, insecure, compliant or
non-compliant. It propagates through evaluation ([Kleene
logic](./docs/adr/ADR-0003-unknown-as-first-class-state.md)), through
aggregation, through the API, and onto the screen — where it is drawn as a
diagonal hatch rather than a colour, because a colour is an opinion.

An organisation with twenty-one unknown controls and zero findings does not have
a clean bill of health. Adericel says so, in those words, on the screen.

Outwardly there are four states — `PROVEN`, `FAILING`, `EXCEPTION`, `UNKNOWN` —
and internally eight, because an MSP working a queue needs `DEGRADED` (the
source broke) separated from `BLOCKED` (a person owes a decision). The join
between them is
[one total mapping](./packages/domain/src/assurance.ts), and it is a security
boundary: it is the last place an internal state becomes an outward claim, so it
is the last place `UNKNOWN` could become a pass. Nothing maps to `PROVEN` but
`SATISFIED` — not a partially satisfied control, and deliberately not a control
somebody scoped out, which is the cheapest way there is to inflate a headline
figure.

**2. AI output is not organisational truth.**

Language models are useful for reading a policy document and proposing what it
might mean. They are not useful as a source of assertions about an
organisation's security. In Adericel an AI-derived claim is created with
provenance `AI_SUGGESTED`, and
[`isRuleEligible()`](./packages/domain/src/claim.ts) refuses to hand it to the
Truth Engine until a named human has confirmed it. There is no configuration
flag that changes this. Turning AI off entirely changes suggestion quality and
nothing else.

Confidence is also not truth. Adericel will never say "the model is 97%
confident, therefore the organisation is 97% secure" — those are different
quantities and the product does not have a place to write that sentence.

**3. The Truth Engine is a pure function.**

[`assessControl()`](./packages/truth-engine/src/engine.ts) takes a versioned
ruleset and an input document and returns a state with a reason. It has no
clock, no database, no network, and no access to a model. Given the same
ruleset hash and the same input digest it returns the same answer today, next
year, and in a dispute. That is what makes an assessment defensible: you can
replay it.

Rules are [data, not code](./docs/adr/ADR-0005-rules-as-data.md) — a total,
side-effect-free expression language — so the ruleset hash genuinely covers the
behaviour rather than just the parameters.

---

## What to do about an `UNKNOWN`

Being honest about what is not known is the first idea, and on its own it is
only half a product. An MSP told that forty controls are undecided has been
handed the cost of finding out, not relieved of it. So every undecided control
carries eight things, and none of them is optional:

|                                          | Where it comes from                                |
| ---------------------------------------- | -------------------------------------------------- |
| Why it is unknown                        | `kind` and `becauseUnknown`                        |
| What evidence would resolve it           | `resolvedBy`                                       |
| Who can actually provide that            | `owner` and `ownerDetail`                          |
| How material it is                       | `materiality`, with every reason that put it there |
| What happens if nobody resolves it       | `ifUnresolved`                                     |
| Which sort of gap it is                  | one of six `kind`s                                 |
| The next recommended action              | `nextAction`, imperative, addressed to its owner   |
| How much uncertainty resolving it clears | `uncertaintyReduction`, as counts                  |

`GET /v1/organisations/:id/unknowns` returns that queue, ranked, with the items
nobody can action separated out rather than mixed in. Six things about it are
deliberate:

**The six kinds answer "what does a person do next", not "what went wrong".**
`MISSING` means nothing has been observed. `STALE` means it was, and the
observation is too old. `CONTRADICTORY` means two sources disagree and
collecting harder will produce more disagreement, not less. `UNCOLLECTABLE`
means the path exists and is broken — a repair, and usually the best-value item
in the queue. `OUT_OF_SCOPE` means no connector would ever change it.
`AWAITING_DECISION` means a named person owes a consent, an approval or an
authority, and collecting harder is precisely the wrong instinct. Every reason
the engine can produce maps to exactly one kind, and
[the map is total by construction](./packages/resolution/src/kind.ts) — adding a
reason without deciding what a person does about it does not compile.

**Fan-out is computed, because it is the thing an operator cannot see.**
Severity is on the screen already. "This one device-management gap is why five
controls are dark" is not. The queue builds a predicate-to-controls map across
the whole organisation, routes each item on its widest gap, and a MEDIUM control
blocking five outranks a lone CRITICAL — which is the correct order and the
opposite of what working by severity produces.

**A never-assessed control appears.** It has no row in the current-state
projection at all, so a queue read from that projection would report a freshly
onboarded organisation as having nothing undecided. That is the single most
dangerous sentence this product could produce, and
[`resolution-queue.test.ts`](./tests/e2e/resolution-queue.test.ts) exists to
stop it.

**The numbers are counts, never confidence.** Every figure carries the sentence
saying so. "Resolving this makes six assessments decidable" is a fact about the
graph. "73% confident" is a fabrication dressed as precision, and there is
nowhere in this product to write it.

**Nothing is ranked `BLOCKING` without a date somebody typed.** Urgency comes
from `organisation_commitments` — a certification assessment, an insurer's
renewal, a questionnaire deadline — recorded by a named person and never
inferred. A queue that assumed a deadline would mark everything blocking, and an
operator would learn to ignore the ranking, which is worse than no ranking
because it looks like one. Where no commitment is recorded, the queue says so in
its own `limitations`.

**An item nobody can action is capped, not hidden.** It stays out of the work
queue, because an unactionable item in a backlog teaches an operator to distrust
the backlog. It is still returned, because a CRITICAL control nobody can observe
is a real hole in the assurance position and belongs in a report.

---

## One observation, several frameworks, and no false equivalence

An MSP whose customer holds Cyber Essentials and ISO 27001 is answering two
schemes from one estate. The obviously valuable feature is to answer the second
from the first's evidence. It is also the feature that would make this product
worthless, so it is worth being precise about what is offered.

A **crosswalk** here is a directed statement: this requirement in this framework
at this version, related to that one, with a rationale, a confidence band, the
conditions under which it holds, and who asserted it. Directed, because a
symmetric pair is itself an equivalence claim — pair Cyber Essentials
`access.mfa_on_cloud_services` with ISO 27001 `A.5.17` and a symmetric table says
each satisfies the other. It does not: the first goes part of the way towards the
second, and the second says nothing about whether the first's specific condition
was met. `reverseOf()` returns null for every directed relation, so a screen
showing "what maps to this requirement" has to query for crosswalks whose
destination it is rather than flipping the ones whose source it is.

**A crosswalk never establishes an assurance state.** `stateFromCrosswalks()`
returns `UNKNOWN` whatever the crosswalks say, `EQUIVALENT` included, and it
exists so that the refusal is something a future contributor finds rather than an
absence they have to notice. What a crosswalk produces is a place to look for
evidence that already exists, with an honest statement of how far that gets you —
and every lead carries the sentence saying it does not determine anything, on
every lead, because a caveat shown once at the top of a list is a caveat that gets
truncated in a table cell.

`UNRELATED` is a recordable relation, which sounds like pedantry and is not:
without it, "no crosswalk exists" and "somebody read both requirements and found
no relationship" are the same empty result, and they lead to completely different
work.

**The layer holds no data yet.** A mapping between two published schemes has to be
read from the schemes; writing one from recollection would produce a confident
rationale with no basis, which is precisely what the confidence band and the
provenance field exist to prevent. That is recorded as an open risk rather than
quietly left blank.

## What is in this repository

Twenty workspace packages. The dependency direction is acyclic and enforced by a
test rather than by intent: `shared` → `domain` → {`graph`, `evidence`, `policy`,
`truth-engine`} → everything else → `apps`. Nothing `truth-engine` depends on can
perform I/O.

**The assurance core.** What decides, records and proves.

| Package                                            | What it is, and what it refuses to do                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/truth-engine`](./packages/truth-engine) | Deterministic assurance evaluation. No clock, no database, no network, no model — so the same ruleset hash and input digest give the same answer in a dispute years later.                               |
| [`packages/domain`](./packages/domain)             | The Organisational Assurance Graph, claims, authorisation, the assurance and truth-state vocabularies, and the release gate. Pure.                                                                       |
| [`packages/graph`](./packages/graph)               | Graph persistence and traversal, and the row-level-security boundary every tenant read passes through.                                                                                                   |
| [`packages/evidence`](./packages/evidence)         | Provenance, integrity, freshness, supersession, storage. Evidence is never manufactured and a revoked piece stops supporting what it supported.                                                          |
| [`packages/policy`](./packages/policy)             | Frameworks, controls, rulesets, versioning. A published ruleset version is immutable; changing a rule creates a new version.                                                                             |
| [`packages/crosswalk`](./packages/crosswalk)       | Directed statements relating a requirement in one framework to one in another, each with its rationale, confidence band, applicability, versions and provenance. Never establishes an assurance state.   |
| [`packages/resolution`](./packages/resolution)     | What to do about an `UNKNOWN`: which of six kinds it is, how material, who can actually close it, and how many assessments resolving it would make decidable — as counts, never a confidence percentage. |

**Acting, and the controls on acting.**

| Package                                            | What it is, and what it refuses to do                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/actions`](./packages/actions)           | The action lifecycle: propose → approve → execute → verify. Dispatch is never success; an outcome that cannot be established goes to reconciliation.                                            |
| [`packages/autonomy`](./packages/autonomy)         | A five-valued authority engine. Pure, and `UNKNOWN` never permits.                                                                                                                              |
| [`packages/containment`](./packages/containment)   | Governed containment C0–C5, its authority model and recovery preconditions. No level withholds an organisation's own assurance record, and automation can enter containment but never leave it. |
| [`packages/integrations`](./packages/integrations) | One connector contract, SSRF-guarded egress, and a connector that declares what it can observe. A connector never decides assurance truth.                                                      |
| [`packages/inference`](./packages/inference)       | Local-first inference. Sovereignty is a classification the code enforces: an external provider does not start without a written acknowledgement, and extraction must quote the document.        |

**Running a portfolio.** What an MSP works with day to day.

| Package                                              | What it is, and what it refuses to do                                                                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/triage`](./packages/triage)               | The MSP exception queue and the connector coverage ladder: what needs a person, ranked, and how far each customer actually got.                                                                                |
| [`packages/support`](./packages/support)             | Case states and the transitions that are prohibited, MSP-first routing, the disclosure gate, integrity-protected diagnostic bundles. Nothing about an organisation is disclosed before somebody is identified. |
| [`packages/questionnaire`](./packages/questionnaire) | Answer states, renderers and the consistency checker, plus a hardened workbook reader. No silent yes, enforced as a property.                                                                                  |
| [`packages/value`](./packages/value)                 | Proof of value and engineer capacity. Counts what Adericel did, prices it only with durations the MSP supplied, and returns `null` with a reason rather than a figure it cannot substantiate.                  |
| [`packages/billing`](./packages/billing)             | Subscriptions, provider events, lapse. Provider-neutral, and a commercial lapse never becomes security containment.                                                                                            |
| [`packages/notifications`](./packages/notifications) | Everything Adericel needs a person to see, and nothing it needs them to see twice.                                                                                                                             |
| [`packages/shared`](./packages/shared)               | Config, canonical JSON, content hashing, the Passport interchange and its standalone verifier, clock, logging, errors.                                                                                         |

**The company layer**, which a customer never receives.

| Package                            | What it is                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/vaol`](./packages/vaol) | Veylith's own operating layer: the autonomy gate, the exception queue, the business ledger, the commercial pipeline. Off by default and absent from a product build — see below. |

**Everything else.**

```
apps/
  api/            Fastify HTTP API. Authentication, tenancy, every resource.
  worker/         Outbox dispatch, schedulers, reconciliation, dead letters.
  web/            React interface, on the Adericel brand.

database/migrations/   Versioned SQL, checksum-verified, RLS included.
workflows/n8n/         Deliverable B — the single importable export.
docs/adr/              Architecture decision records.
infrastructure/        Dockerfiles, edge proxy, deployment.
tests/                 unit · integration · tenancy · security · e2e · mutation
```

### Adericel is the product; Veylith is the company that operates it

`vaol/` is the company layer — Veylith's own autonomy gate, exception queue,
business ledger and commercial pipeline. It is **not** part of what a customer
receives, and that is enforced rather than intended:

- `ADERICEL_COMPANY_LAYER` defaults to **off**. An unset flag means a customer
  deployment, because the cost of being wrong that way is a Veylith operator
  seeing a 404, and the cost of being wrong the other way is a customer's
  database holding Veylith's commercial pipeline.
- With it off, the company routes are **not registered at all** — absent rather
  than refused. There is nothing to probe.
- The company layer is reached through `await import()` inside that branch, so
  there is no static import path from the product to it. A static import would
  put it in the module graph of every deployment, meaning a product build could
  not ship without it even though it never ran it.
- Migrations are layered. `pnpm db:migrate:product` applies the product schema
  and skips the `veylith.*` tables entirely. The classification lives in
  `database/migrations/layers.json` and cannot drift: a test derives it from the
  SQL and fails in both directions.
- `docker build --target product` builds an image with the company layer's
  compiled output removed, so setting the flag on a product image fails loudly
  rather than quietly working.

`value/` is **product**, not company, despite an earlier version of this
sentence saying otherwise. It counts what Adericel did and prices it only with
durations the MSP supplied — that is the MSP's own argument to their client at
renewal, and withholding it from a self-hosted deployment would be withholding
the argument for the deployment.

The separation was previously claimed here and asserted by a test that looked at
`packages/` only, which is exactly where the dependency was not: `apps/api`
imported the company layer at startup and registered its routes unconditionally.
See [ADR-0049](./docs/adr/ADR-0049-product-and-company-layers.md).

## Running it

**Locally, for development:**

```bash
pnpm install
cp .env.example .env          # defaults are fine for local work
createdb adericel             # or point DATABASE_URL at any PostgreSQL 16
pnpm db:migrate
pnpm db:seed                  # four organisations of demonstration data
pnpm dev                      # API on :4000, interface on :5173
```

**On a server:**

```bash
cp .env.example .env          # fill in the secrets it names
docker compose --profile core up -d
docker compose --profile core --profile workflow up -d   # adds n8n
```

Sized to run alongside PostgreSQL, Redis, n8n and local Ollama models on a
single 16 GB VPS. The working is in
[docs/operations/vps-sizing.md](./docs/operations/vps-sizing.md), including what
that machine will not do.

## Conformance to the contract's own lifecycles

The contract states two sequences that bear directly on code: the authoritative
execution lifecycle (`INTENT → POLICY → AUTHORISATION → RISK → ACTION →
RE-OBSERVE → VERIFY → EVIDENCE`) and the support lifecycle (`RECEIVED → TRIAGED
→ INVESTIGATING → ACTION_REQUIRED → VERIFICATION_PENDING → RESOLVED → CLOSED`).

Both are quoted in code, and every state this system actually has is mapped onto
them — [executions](./packages/domain/src/contract-lifecycle.ts),
[support cases](./packages/support/src/case.ts). The mappings are total by
construction, so a state added without deciding which stage of the contract it
belongs to does not compile.

**They are mappings, not renames.** Sixteen action states and twenty support case
states are finer than the contract's eight and seven, and deliberately: an MSP
cannot work a queue in which "waiting on the customer" and "waiting on the
vendor" are the same thing — one needs a chase and the other needs patience.
Renaming the operational states to match the contract would destroy the
distinctions the queues are built on.

**A stage realised as a property says so.** The contract names `RISK` as a stage;
this system carries `riskClass` on the action from proposal onwards instead,
because a `DESTRUCTIVE` action is still destructive at the moment of execution
and a stage would let the classification go stale between evaluation and act.
That is recorded as `PROPERTY` rather than dressed up as a state, and a test
refuses a stage that claims to be a state while naming none.

The sharpest thing the mapping protects: **`EXECUTED` and `CONFIRMED` are two
stages apart, with re-observation between them.** The contract is explicit that
no action becomes successful merely because it was dispatched, and a lifecycle
that put them in one stage would permit exactly that.

### A correction this section exists because of

These sequences were recorded in this repository as **missing from the contract**
for several days. Two hand-rolled PDF readers could not decode them; I treated
the second failure as corroboration of the first, examined the file for images
and vector drawing, found none, and concluded the passages were blank in the
document. A real PDF library read all eight immediately.

The first failure was an ordinary limitation. The error was escalating from "my
instrument found nothing" to "the thing is not there" — which is the precise
inference this product exists to refuse. `UNKNOWN` means the instrument did not
establish something; it never means the thing is absent. The account is kept in
[`docs/contract/README.md`](./docs/contract/README.md).

## Every guard, proved by breaking it on every build

A test that would still pass with its guard removed proves nothing. A suite
arrives at that state gradually — a condition widens, an assertion is replaced
by a weaker one that still passes — and because nothing fails, nobody looks.

So every invariant this repository claims is "proved by deliberately breaking
it" is recorded in [`tests/mutation/registry.ts`](./tests/mutation/registry.ts)
as the exact edit that breaks it and the exact tests that must then fail.
`pnpm test:mutation` applies each one, runs only the suite that should care, and
reports a mutation whose tests still pass as **SURVIVED** — meaning the guard has
rotted, not that the mutation is wrong. CI runs it on every push.

Twenty-nine are recorded. They include: a control scoped out of assessment
presenting outwardly as `PROVEN`; a build signing off a release condition that
needs a named person; a crosswalk marked `EQUIVALENT` being allowed to determine
an assurance state; and the resolution queue reading only the state projection,
which would report a freshly onboarded organisation as having nothing undecided. Five of
them break this README: renaming a command it tells you to run, dropping a
package from the prose, pointing a link at a path that does not exist, naming a
package that was never built, and letting a stated count drift.

Three things about the runner are deliberate. It refuses to start on a dirty
working tree, because a crash would otherwise leave a mutated file
indistinguishable from work in progress. It restores everything it touched,
including files a suite regenerated as a side effect — found the hard way, when a
mutated path ended up written into a committed generated document. And a `find`
that matches zero or several places is an error rather than a warning, because a
mutation applied somewhere unintended would report a survival that means nothing.

## Verifying it

```bash
pnpm verify           # lint, typecheck, and the full test suite
pnpm test:mutation    # break each guard and confirm its tests fail
pnpm n8n:validate     # structural and safety validation of the n8n export
pnpm release:position # where this tree stands against the ten completion conditions
```

The suites are separated by what a failure would mean:

| Suite              | A failure here means                                              |
| ------------------ | ----------------------------------------------------------------- |
| `test:unit`        | The Truth Engine or the domain model computed the wrong answer    |
| `test:tenancy`     | One organisation's data was reachable from another                |
| `test:security`    | Authentication or authorisation did not hold                      |
| `test:integration` | A component boundary is wrong                                     |
| `test:e2e`         | The product does not do what it claims end to end                 |
| `test:mutation`    | A guard has rotted: its test would pass with the invariant broken |

`test:tenancy` and `test:security` exist as their own jobs deliberately. A red
tick there is not "a test broke"; it is a claim about isolation that no longer
holds, and it should say so in the checks list without anyone having to open it.

`test:mutation` is deliberately **not** part of `pnpm verify`. It edits source
files and restores them, so it refuses to run on a dirty working tree — which is
the normal state while you are working. Run it before you push; CI runs it on
every push against a fresh checkout.

## Where your customers' documents go

Nowhere, by default. `INFERENCE_PROVIDER=none` is the default and it is a
complete deployment: assurance determinations come from the Truth Engine
reading observed evidence, and no model participates in any of them at any
setting.

When you do want document reading, the intended path is a model on your own
hardware:

```bash
docker compose --profile core --profile ai up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Sovereignty is a classification the code enforces rather than a preference in a
document. Every provider is classed by where the data goes, the classification
is exhaustive over the provider list and tested, and anything that would move a
customer's documents outside infrastructure you control **refuses to start**
without a written acknowledgement naming the operator and the jurisdiction. Not
a checkbox — a sentence, recorded verbatim and reported at
`/v1/system/data-processing`, which is the URL you give a customer whose
solicitor asks.

Extraction is grounded: every proposed value must quote the document, and
Adericel checks the quote is actually there. A value that cannot show where it
came from is dropped before anyone sees it — because a reviewer confirming a
hundred supplier certificates will not open a hundred PDFs, and the one they do
not open is the one that was invented.

A model may propose. It may never conclude
([ADR-0004](./docs/adr/ADR-0004-ai-truth-separation.md),
[ADR-0041](./docs/adr/ADR-0041-sovereign-inference.md);
[the operator's guide](./docs/operations/sovereign-inference.md)).

## Verifying a Passport without us

The Assurance Passport is exported as a detached-signed envelope that a
recipient checks on their own machine, with no Adericel account and no network
call:

```bash
pnpm passport:keygen adericel-prod-2026-01 "Your Company Ltd"
```

The envelope carries the Passport byte-identically as issued, plus an Ed25519
signature over the canonical encoding of everything else in it. The issuer
public keys are published at `/v1/assurance/keys`, and the envelope and
canonicalisation are documented in [`schemas/`](./schemas), so verification can
be reimplemented in about twenty lines against any standard Ed25519 library.
Verification that only works with the vendor's tool is not independent
verification.

What a valid signature establishes: Adericel issued this exact record, and
nobody has altered it. **It does not mean the assurance position is
satisfactory** — a signed Passport reporting nine UNKNOWN controls is a signed
record of nine UNKNOWN controls — and it does not mean the record is current.
Both sentences travel with the verification result.

Signing is off until an issuer key is configured, and a deployment without one
exports the Passport with its content hash and says plainly that it is
unsigned. A hash is not a signature and nothing here calls it one.
[ADR-0040](./docs/adr/ADR-0040-signed-passport-interchange.md) records why;
[the key lifecycle](./docs/operations/issuer-key-lifecycle.md) is the procedure.

## When something goes wrong

Three separate things can stop the product doing something, and conflating any
two of them is a bug with a customer on the end of it.

**Security: containment (C0-C5).** A compromised credential, an integration
behaving unexpectedly, an evidence-integrity failure. Containment stops
_Adericel_ doing things — it does not stop customers knowing things, and **no
level at any severity withholds an organisation's own assurance record**.
Authority is earned per level: automation reaches C2 (enough to stop using a
compromised credential), an MSP reaches C3 over its own customers, C4 and C5
stop every estate and are Veylith's alone. Recovery needs authority,
re-observation and verified findings; nothing above C2 recovers itself
([ADR-0045](./docs/adr/ADR-0045-governed-containment.md)).

**Commercial: ten entitlement states.** `DRAFT` · `TRIAL` · `ACTIVE` ·
`PAST_DUE` · `PAYMENT_PLAN` · `COMMERCIAL_RESTRICTION` ·
`COMMERCIAL_SUSPENSION` · `TERMINATED` · `ARCHIVED` · `UNKNOWN`. A commercial
state is **not** a security state, and the separation is enforced rather than
remembered: no shared vocabulary, no function between the two models, and a
test that fails if one is ever added. A late invoice restricts nothing on day
one; `UNKNOWN` keeps everything running, because an outage at a payment
processor is not evidence that a customer stopped paying. Nothing about money
can reach the Truth Engine
([ADR-0047](./docs/adr/ADR-0047-commercial-is-not-security.md)).

**Support: a case, and a door that is loud.** Adericel is delivered through
MSPs, so an end customer's request goes to their MSP — enforced in routing and
again in reassignment, because a backlog tidy-up is how that boundary actually
gets crossed. Support is a disclosure surface: identity and entitlement are
established before anything about an organisation is said, _including whether
it exists_, and every disclosure decision is recorded where the organisation
can read it — the refusals as well as the disclosures. Nobody can mark a
customer's S1 resolved without the customer
([ADR-0048](./docs/adr/ADR-0048-support-domain.md)).

Where a Veylith engineer genuinely needs into a customer's estate, the route is
break-glass: four hours maximum, a justification of substance, a second factor
required even in an emergency, the MSP told at the time rather than from an
audit log afterwards, visible in the customer's own audit trail, unextendable
at any layer, and reviewed whether or not it turned out to have been warranted.
It cannot confer authority over who can reach the estate afterwards, and it
grants only the permissions actually asked for — grants carry an attenuation
the database refuses to widen
([ADR-0046](./docs/adr/ADR-0046-break-glass-and-grant-attenuation.md)).

## The n8n export

`workflows/n8n/adericel.n8n.json` is one file: 25 workflows, 236 nodes, the
complete orchestration layer. Import it into a clean self-hosted n8n instance —
core nodes only, no community packages required.

```bash
n8n import:workflow --separate --input=workflows/n8n/adericel.n8n.json
```

It contains no credentials and no hostnames. Endpoints come from `$env`,
authentication from a named n8n credential you create after import. The export
is generated by [`workflows/n8n/build.ts`](./workflows/n8n/build.ts) and
[validated](./workflows/n8n/validate.ts) in CI for reachability, resolvable
sub-workflow references, error-workflow coverage, and the absence of embedded
secrets — plus a drift check, so the committed file is provably the file the
builder produces.

n8n orchestrates. It does not decide. No assurance state is computed in a
workflow, and every state change goes through the API where authorisation and
audit apply ([ADR-0012](./docs/adr/ADR-0012-n8n-role.md)).

## When a feature is finished

The contract's definition, not ours: a feature is not complete because code
exists. It is complete when ten conditions hold — architecture is coherent,
security boundaries are tested, privacy implications are addressed, failure
modes are explicit, auditability exists where required, documentation matches
implementation, tests pass, recovery implications are understood, operational
behaviour is observable, and no unsupported claims are introduced.

Those ten are [modelled](./packages/domain/src/release-gate.ts) rather than kept
in a checklist, because a checklist is satisfied by being read. Four things
about the model are deliberate:

**An unassessed condition blocks.** The tempting default is "no evidence either
way, so treat it as fine", and it is how a gate becomes a formality: the
conditions nobody can measure automatically quietly pass, and those are privacy
implications, failure modes and unsupported claims.

**Four conditions cannot be claimed by a pipeline.** If all ten were automatable
the gate would collapse into "the tests passed", which is condition seven
restated nine times. A build that asserted privacy implications had been
addressed would be signing on somebody's behalf.

**There is no score.** Nine of ten is not ninety per cent complete; it is
incomplete with one named reason, and the reason is the useful output.

**`pnpm release:position`** prints where the working tree stands and
deliberately produces no record. Run it and it will tell you, among other
things, that `tests pass` is not established — because that script does not run
the suite, and reporting a pass it did not observe is the exact failure the gate
exists to catch.

Every document in [`docs/product`](./docs/product) — the ones written for
somebody outside the build — declares which of six states it is in:
`IMPLEMENTED`, `TESTED`, `PLANNED`, `ASSUMED`, `EXTERNALLY_DEPENDENT` or
`LEGALLY_PENDING`. A document in a state that is not yet a capability has to say
so in its opening lines, because a reader skims the prose and not the header.
That is why the framework-packs document opens by telling you the pack model is
not built.

Alongside it, [capability status](./docs/product/CAPABILITY_STATUS.md) records
what state each capability is in, with an independent attestation per status.
`PROVEN`, `PRODUCTION_READY` and `COMMERCIAL_VALIDATED` are refused to any
automated attestation — each is a claim about the world outside this repository,
and a green pipeline is not evidence of any of them. No capability holds one
today.

## Things this product will not do

Recorded here because a list of deliberate absences is more informative than a
feature list:

- **No single security score.** A number that mixes coverage with satisfaction
  destroys both. Adericel reports them
  [separately](./packages/domain/src/assurance.ts) and provides no function that
  combines them ([ADR-0017](./docs/adr/ADR-0017-no-single-score.md)).
- **No automatic remediation from a model.** Every action is proposed,
  approved by a second named human, executed, and then **verified by
  re-observation**. If verification fails, the action does not report success —
  it reports what actually happened.
- **No approval by an agent.** Four-eyes control is enforced structurally: the
  proposer's identity cannot approve, and a service identity has no approval
  permission to grant ([ADR-0015](./docs/adr/ADR-0015-approval-four-eyes.md)).
- **No trust in a caller-supplied tenant identifier.** Organisation access is
  resolved from the authenticated principal's grants, checked in application
  code, and enforced again by PostgreSQL row-level security with `FORCE`
  ([ADR-0007](./docs/adr/ADR-0007-tenant-isolation.md)). Two layers, because one
  is a single point of failure.
- **No destruction of history.** Assessments, evidence records, events and the
  audit log are append-only — as are containment events, break-glass grants,
  commercial transitions and support case histories. You can ask what Adericel
  believed on a given date, and why
  ([ADR-0010](./docs/adr/ADR-0010-temporal-model.md)).
- **No standing vendor access to your data.** A Veylith platform grant is
  honoured on neither Adericel surface, so operating the platform confers no
  access to any customer's assurance data or personal data. What exists instead
  is break-glass: announced, time-limited, attenuated, and reviewed.
- **No withholding a customer's record as a commercial lever.** Every one of
  the ten commercial states permits reading and exporting the organisation's own
  assurance record, including `TERMINATED`. Holding a compliance record hostage
  over an invoice is not a lever.
- **No talking to an MSP's customer behind their back.** Support routes to the
  MSP by default and structurally cannot be reassigned past that boundary. The
  direct-support entitlement table exists — §22 needs the gate regardless — and
  ships empty, with no code path that fills it.

## For an MSP evaluating this

Four documents written for the conversation an MSP actually has, rather than for
an engineer reading the source:

- [**MSP operating model**](./docs/product/MSP_OPERATING_MODEL.md) — who decides
  what, who owns the evidence, where an escalation goes, what the client must
  approve, what each account state means, and how offboarding works.
  **Generated from the system**: rendered from
  [`operating-model.ts`](./packages/domain/src/operating-model.ts), checked
  against the authority and surface models, and CI fails if it drifts. A diagram
  drawn by hand is true on the day it is drawn.
- [**Trust and deployment pack**](./docs/product/TRUST_AND_DEPLOYMENT_PACK.md) —
  the thirteen questions a UK MSP and their client ask before putting an estate
  into this, each answered with the place in the code where it is enforced, and
  a closing section on what it does not claim.
- [**Framework packs**](./docs/product/FRAMEWORK_PACKS.md) — what a pack is, the
  eight things every pack must report, and the sentence that governs all of
  them: using a framework pack is not certification and is not legal compliance.
- [**Commercial boundary**](./docs/product/COMMERCIAL_BOUNDARY.md) — the six
  positions on Adericel versus Veylith Systems, each with the build target,
  migration flag or test that enforces it.

## Documentation

- [The controlling contract](./docs/contract/README.md) — what Adericel is built
  to, and exactly which parts of the supplied document could not be read
- [Contract v3.2 gap report](./docs/audit/ADERICEL_V3.2_CONTRACT_GAP_REPORT.md) —
  every requirement checked against the code, including the three that are unmet
  and the one that cannot be audited
- [Capability status](./docs/product/CAPABILITY_STATUS.md) — generated; what
  state each capability is in and what establishes it
- [Architecture decision records](./docs/adr/README.md) — every consequential
  decision, each with what it costs
- [Threat model](./docs/security/threat-model.md) — including what it does not cover
- [Operations runbook](./docs/operations/runbook.md)
- [Issuer key lifecycle](./docs/operations/issuer-key-lifecycle.md) — generating,
  rotating, retiring and revoking the key that signs Passports
- [Sovereign inference](./docs/operations/sovereign-inference.md) — running the
  model on your own hardware, and answering "where does our data go"
- [VPS sizing](./docs/operations/vps-sizing.md)
- [Brand](./docs/product/brand/README.md)

## Licence

See [LICENSE](./LICENSE).
