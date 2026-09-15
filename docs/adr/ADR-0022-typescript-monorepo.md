# ADR-0022: TypeScript monorepo

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel is one product with several deployable units — API, worker, interface —
and a domain model that all of them must agree on exactly. The vocabulary of
assurance states, unknown reasons, action lifecycle states and permissions is
the product; a disagreement about it between two components is a correctness
failure, not an inconvenience.

The company building it is very small. Language and repository choices are
therefore also a question of how much attention they consume.

## Decision

**One repository, TypeScript throughout, pnpm workspaces with `tsc -b` project
references.**

Package boundaries follow the architecture rather than convenience:

- `truth-engine` depends on `domain` and nothing else. It cannot import a
  database client because the dependency does not exist in its package. The
  boundary in ADR-0002 is enforced by the module graph, not by a convention.
- `domain` depends on nothing but validation. It is the vocabulary.
- Apps depend on packages; packages never depend on apps.

Configuration is strict: `strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `isolatedModules`, ESM with NodeNext resolution.
`noUncheckedIndexedAccess` in particular is the one that repeatedly caught real
bugs — an array index in this domain is very often absent, and the type system
saying so is worth the noise.

A `development` export condition lets `tsx` run sources directly while compiled
output is used in production, so development needs no build step and production
ships no source.

## Alternatives considered

**Separate repositories per component.** Rejected: the domain package would
become a published dependency, and every change to the vocabulary would become a
version negotiation between repositories owned by the same one person.

**Rust or Go for the Truth Engine.** Genuinely considered. The engine is pure,
performance-sensitive in aggregate, and would benefit from exhaustiveness
checking stronger than TypeScript's. Rejected on total cost: a second toolchain,
a foreign-function boundary or a service hop, and a second language for one
developer to stay fluent in. TypeScript's discriminated unions and
`noUncheckedIndexedAccess` get most of the way, and the engine's tests are the
real guarantee.

**A build system such as Nx, Turborepo or Bazel.** Rejected as premature.
`tsc -b` does incremental builds across project references, which is what a
build system would be wrapping. Revisit when build time is a complaint.

**Deno or Bun.** Better ergonomics in places. Rejected for ecosystem maturity in
the specific dependencies that matter — PostgreSQL drivers and Fastify — where
being boring is the correct choice.

## Consequences

- One `pnpm install`, one `pnpm verify`, one CI configuration.
- A change to the domain vocabulary breaks every consumer at compile time, which
  is the intended behaviour.
- The interface shares the domain package with the server, so the screen cannot
  display a state the domain does not have.
- Test suites are separated by _what a failure means_ — unit, tenancy, security,
  integration, e2e — rather than by which directory they live in. A red tick on
  "tenant isolation" should be legible from the checks list without opening it.
- Everything is deployed together. Independent versioning is not available, and
  is not wanted while there is one team.

## Security implications

One dependency tree means one audit surface, one lockfile, and one place a
supply-chain advisory has to be assessed. `pnpm`'s strict, non-flat
`node_modules` prevents a package from importing something it does not declare,
which removes a class of accidental — and phantom-dependency — coupling.

Server images exclude the interface's dependency tree entirely
(ADR-0018): React has no business in the SBOM of a process that faces the
network.

## Operational implications

Node 22 is the floor. The runtime relies on ESM, `node:` prefixed builtins, and
native `fetch`; the migration runner additionally relies on type stripping, which
is why every source file stays within erasable syntax.

## Migration implications

Extracting a package to its own repository later is mechanical, because the
dependency graph is already acyclic and the boundaries are enforced by
`package.json` rather than by discipline. That option is preserved; it is simply
not exercised.
