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

## What is in this repository

```
packages/
  truth-engine/   Deterministic assurance evaluation. Pure. No I/O.
  domain/         The Organisational Assurance Graph, claims, authorisation.
  graph/          Graph persistence and traversal.
  evidence/       Provenance, integrity, freshness, supersession, storage.
  policy/         Frameworks, controls, rulesets, versioning.
  actions/        The action lifecycle: propose → approve → execute → verify.
  integrations/   One connector contract; SSRF-guarded egress.
  billing/        Subscriptions, provider events, lapse.
  notifications/  Everything Adericel needs a person to see.
  shared/         Config, canonical JSON, clock, logging, errors.

  autonomy/       A five-valued authority engine. Pure. UNKNOWN never permits.
  vaol/           Veylith's own operating layer: the gate, the exception
                  queue, the business ledger, the commercial pipeline.
  triage/         The MSP exception queue and the connector coverage ladder.
                  What needs a person, ranked, and how far each customer got.
  value/          The proof-of-value engine. Counts what Adericel did, prices
                  it only with durations the MSP supplied, and refuses to
                  produce a figure it cannot substantiate.

apps/
  api/            Fastify HTTP API. Authentication, tenancy, every resource.
  worker/         Outbox dispatch, schedulers, reconciliation, dead letters.
  web/            React interface, on the Adericel brand.

database/migrations/   Versioned SQL, checksum-verified, RLS included.
workflows/n8n/         Deliverable B — the single importable export.
docs/adr/              Architecture decision records.
infrastructure/        Dockerfiles, edge proxy, deployment.
tests/                 unit · integration · tenancy · security · e2e
```

The last two packages are the company rather than the product. Adericel does not
depend on them — a customer running it on their own infrastructure gets the
assurance platform and none of Veylith's commercial machinery, and a test
asserts that separation holds.

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

## Verifying it

```bash
pnpm verify        # lint, typecheck, and the full test suite
pnpm n8n:validate  # structural and safety validation of the n8n export
```

The suites are separated by what a failure would mean:

| Suite              | A failure here means                                           |
| ------------------ | -------------------------------------------------------------- |
| `test:unit`        | The Truth Engine or the domain model computed the wrong answer |
| `test:tenancy`     | One organisation's data was reachable from another             |
| `test:security`    | Authentication or authorisation did not hold                   |
| `test:integration` | A component boundary is wrong                                  |
| `test:e2e`         | The product does not do what it claims end to end              |

`test:tenancy` and `test:security` exist as their own jobs deliberately. A red
tick there is not "a test broke"; it is a claim about isolation that no longer
holds, and it should say so in the checks list without anyone having to open it.

## The n8n export

`workflows/n8n/adericel.n8n.json` is one file: 20 workflows, 185 nodes, the
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
  audit log are append-only. You can ask what Adericel believed on a given date,
  and why ([ADR-0010](./docs/adr/ADR-0010-temporal-model.md)).

## Documentation

- [Architecture decision records](./docs/adr/README.md) — twenty-two decisions,
  each with what it costs
- [Threat model](./docs/security/threat-model.md) — including what it does not cover
- [Operations runbook](./docs/operations/runbook.md)
- [VPS sizing](./docs/operations/vps-sizing.md)
- [Brand](./docs/product/brand/README.md)

## Licence

See [LICENSE](./LICENSE).
