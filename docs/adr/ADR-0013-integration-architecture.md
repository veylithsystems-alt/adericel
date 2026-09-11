# ADR-0013: One connector contract for every integration

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel's value depends on reaching the systems that hold the truth: identity
providers, endpoint management, backup, email security, RMM. Each vendor has its
own authentication, pagination, rate limits, error semantics and data model.

The path of least resistance is a bespoke module per vendor. After six of them,
there are six different retry strategies, six interpretations of "the API
returned a partial result", and six places where a vendor's `enabled: true`
becomes an assurance conclusion by a slightly different route.

## Decision

**Every integration implements one interface** (`packages/integrations/src/connector.ts`):

```
checkConnection()  →  ConnectionCheck
collect(context)   →  CollectionResult   // observations and claims
execute(request)   →  ExecutionResult    // capability invocation
capabilities       →  what this vendor can actually do
```

A connector's only job is to turn a vendor's data into **canonical
observations** in the domain's vocabulary. It does not decide whether anything
is satisfied, and it does not know what a control is. The Truth Engine never
learns that Microsoft Entra exists.

Three properties are enforced by the contract rather than left to each
connector:

**Partial results are explicit.** `CollectionResult.partial` is a boolean the
connector sets only when it genuinely truncated a page or was refused a
permission. It is not inferred from the presence of warnings — an earlier
version did infer it, and the result was healthy integrations being reported as
DEGRADED because the connector had logged an advisory note. A partial collection
means the observations do not cover the whole subject set, which means rules
over that subject kind must resolve to UNKNOWN rather than to a conclusion drawn
from half the data.

**Absence is not negation.** A connector that cannot see a subject kind reports
that it did not observe it. `observedSubjectKinds` travels with the assessment
input, and the Truth Engine distinguishes "no devices exist" from "we have never
looked at devices" (ADR-0003).

**Egress is guarded centrally.** All connector HTTP goes through
`packages/integrations/src/http.ts`, which resolves DNS and rejects private,
loopback, link-local and carrier-grade NAT destinations before connecting, and
honours an allow-list. A connector cannot opt out.

## Alternatives considered

**Bespoke modules per vendor.** Rejected as above. The specific harm is not
duplication; it is that each module quietly develops its own opinion about what
missing data means.

**A generic HTTP + JSONPath mapping engine, integrations as configuration.**
Genuinely appealing: new integrations without a deployment. Rejected for now
because vendor authentication is where the real complexity lives — device-code
flows, certificate credentials, per-tenant consent — and none of that is
expressible as a mapping. It remains a plausible future addition _on top of_ the
contract, for the subset of vendors that are simple.

**An off-the-shelf integration platform for collection.** Would put a third
party between Adericel and the customer's most sensitive systems, and would make
provenance depend on their correctness. Not acceptable for evidence that must be
defensible.

## Consequences

- Adding a vendor means implementing four methods and a normalisation map. It is
  a bounded, reviewable, testable unit of work.
- Connectors are registered in `packages/integrations/src/registry.ts`, so the
  set is enumerable and capabilities can be queried before an action is
  proposed. Adericel never proposes an action it has no connector capability to
  perform.
- Vendor-specific quirks that do not fit the contract require a contract change,
  reviewed once, rather than a local workaround.
- There will be no fake connectors. A connector that cannot reach its vendor
  reports UNKNOWN, and there is no demonstration mode that fabricates
  observations.

## Security implications

Integration credentials are sealed with AES-256-GCM using the integration's own
id as additional authenticated data (ADR-0019), so a sealed credential cannot be
moved to a different integration record and decrypted there.

SSRF is the dominant risk in this component: a customer configures an endpoint,
and Adericel's server makes a request to it. Resolution-then-check ordering
matters — checking the hostname before resolving permits a DNS entry that
resolves to a private address. The check is on the resolved addresses, and it is
on by default (`SECURITY_BLOCK_PRIVATE_EGRESS`).

## Operational implications

Every collection produces an `integration_runs` record with a status, a count
and a partial flag, so "when did this last work, and did it see everything?" is
answerable per organisation without reading logs.

## Migration implications

Adding a method to the contract breaks every connector at compile time, which is
the intended behaviour: an unimplemented capability should not be discovered at
runtime in a customer's tenant.
