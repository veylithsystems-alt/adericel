# ADR-0049: Adericel is the product; Veylith is the company that operates it

**Status:** Accepted · **Date:** 2026-09-17

## Context

Adericel is sold to MSPs, some of whom will run it on their own infrastructure.
Veylith Systems Ltd is the company that builds and operates it, and Veylith has
its own operating machinery in this repository: the autonomy gate, the exception
queue, the business ledger, the commercial pipeline — `packages/vaol`, and the
`veylith.*` schema created by migrations 0018 to 0020.

The README said:

> The last two packages are the company rather than the product. Adericel does
> not depend on them — a customer running it on their own infrastructure gets
> the assurance platform and none of Veylith's commercial machinery, and a test
> asserts that separation holds.

**Two of those three sentences were false.**

The test existed and passed. It asserted that no package under `packages/`
depends on VAOL — and the dependency was in `apps/`:

- `apps/api/src/main.ts` imported `DEFAULT_COMPANY_POLICY` and
  `ensureAutonomyPolicy` at the top of the file and called them during startup,
  so the API would not boot without the company layer.
- `apps/api/src/app.ts` called `registerVeylithRoutes` unconditionally, so every
  deployment served `/v1/veylith/*`.
- Migrations 0018–0020 created the `veylith.*` schema on every install.

So a customer self-hosting Adericel received Veylith's commercial pipeline in
their database, backed it up nightly, and exposed it to anyone holding their
database credentials. The documentation asserted the opposite and the test was
true about the wrong thing, which is the worst combination available: a claim
nobody would think to check because something appeared to be checking it.

`value/` was also described as company machinery. That is wrong in the other
direction — see below.

## Decision

**One flag, defaulting to off, enforced at four layers.**

`ADERICEL_COMPANY_LAYER` is `false` unless explicitly set. The direction of that
default is the whole decision: wrong one way, a Veylith operator sees a 404 and
sets a flag; wrong the other way, a customer's database holds Veylith's
commercial pipeline. Being wrong should be cheap in the direction it is likely
to happen.

It reads strictly, not through `Boolean()`. `Boolean('false')` is `true`, and a
configuration flag that treats its own negation as affirmative is the most
expensive one-line bug available here.

| Layer        | What it does                                                                           |
| ------------ | -------------------------------------------------------------------------------------- |
| Routes       | `registerVeylithRoutes` is **not called**, so the paths are absent rather than refused |
| Module graph | The company layer is reached through `await import()` inside that branch               |
| Schema       | `MIGRATION_LAYER=product` skips the company migrations entirely                        |
| Image        | `--target product` removes the company layer's compiled output                         |

### Absent, not refused

An unregistered path resolves to no surface, and `decide` already refuses every
authorisation question asked with no surface — so authorisation would have
caught it. Not registering is stronger: there is nothing to probe, nothing to
enumerate, and nothing for a later change to accidentally open.

### The dynamic import is the substance, not a style choice

A static `import` puts `@adericel/vaol` in the module graph of every deployment.
The product could then not be built or shipped without the company layer even
though it never called it, and a bundler, an SBOM and a vulnerability scan would
all report it as part of the product — because it would be. `await import()`
inside the branch means a product build genuinely does not load it.

Two tests hold that line: one asserts there is no static import of the company
layer anywhere in `apps/` outside the company layer's own module, and one
asserts that every dynamic import of it sits in a file that mentions
`companyLayerEnabled` — because a dynamic import nothing decides about is the
same dependency with extra steps.

### Migrations: a manifest, because the checksum is right to refuse

The obvious design is a `-- migrate:layer company` marker inside each file. It
cannot be used: the runner refuses a migration whose checksum has changed since
it was applied, and adding a line changes the checksum. That refusal is correct
and worth more than the tidiness, so the classification lives in
`database/migrations/layers.json` instead.

The usual cost of a manifest is drift. `tests/unit/migration-layers.test.ts`
removes it by derivation — any migration whose SQL touches the `veylith` schema
must be listed, and anything listed must actually touch it. Both directions
matter: an unlisted company migration installs Veylith's tables into a customer
database, and an over-listed product migration silently omits a table from every
customer database with no error until something reads it.

A missing manifest is a hard failure rather than a default, because the default
the runner would reach for — "treat everything as product" — is the one that
installs company tables where they must not be.

### The image removes the code, not the manifest

`--target product` deletes `packages/vaol/dist` and the compiled company route,
keeping the manifest so pnpm's symlink tree stays intact and the image starts.
Setting `ADERICEL_COMPANY_LAYER=true` on a product image then **fails loudly**.
That is the intended behaviour: a silent success would mean the separation was
decorative.

## `value/` is product, and the README was wrong about it

`packages/value` counts what Adericel actually did and prices it only with
durations the MSP supplied, refusing to produce a figure it cannot substantiate.
That is the MSP's own argument to their client at renewal — the most useful thing
in the product for the conversation that pays for it.

Withholding it from a self-hosted deployment would have been withholding the
argument for the deployment. It stays in the product; `vaol` does not. The line
is not "which packages feel internal" but "whose business is this": VAOL is how
Veylith runs itself, and proof-of-value is how an MSP runs its client
relationship.

## On repository separation

Already correct, and worth recording so it is not re-litigated:
`veylithsystems-alt/adericel` is its own repository with its own `main` and its
own branches. Sentinel is not in it — the only occurrences of the word are the
programming term for a placeholder value, in `action-service.ts` and ADR-0024.

What was mixed was never the repository. It was the build, and this ADR is that
fix. A future Sentinel belongs in its own repository for the same reason the
company layer belongs behind a flag: the boundary should be the thing that is
hard to cross, not the thing everyone remembers not to.

## Consequences

An MSP self-hosting Adericel now receives the assurance platform and nothing
else, provably. Veylith's own deployment sets one environment variable.

The cost is a switch that can be set wrong, which is why the default is the safe
side and why the product image cannot be talked into loading what it does not
contain.

`tests/e2e/control-room.test.ts` and the company-layer assertions in
`tests/security/information-boundary.test.ts` now opt in explicitly. That is an
improvement in what they mean: the boundary test in particular runs with the
company routes **registered**, so it asserts that a client is refused by the
surface model rather than by the route being absent.

## Evidence

- `packages/shared/src/config.ts` — the flag, read strictly.
- `apps/api/src/app.ts`, `apps/api/src/main.ts` — the gate and the dynamic imports.
- `scripts/migrate.ts`, `database/migrations/layers.json` — the layered schema.
- `infrastructure/docker/Dockerfile` — the `product` target.
- `tests/unit/architecture.test.ts` — no static path, the flag guards every
  dynamic one, and the default is off across seven spellings.
- `tests/unit/migration-layers.test.ts` — the manifest cannot drift in either
  direction.
- `tests/e2e/product-separation.test.ts` — a product deployment has no company
  route, still does the whole job, and keeps proof of value; a company
  deployment has the layer, so the flag is a switch rather than a deletion.
