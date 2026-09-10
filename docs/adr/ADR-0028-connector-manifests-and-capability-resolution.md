# ADR-0028: Connectors declare capability in canonical predicates

**Status:** Accepted · **Date:** 2026-09-10

## Context

Adericel had connectors and no way to reason about them.

A connector's metadata lived in TypeScript interface fields — `vendor`,
`category`, `requiredPermissions`, `capabilities`. TypeScript could read them;
nothing else could. `capabilities` meant _executable_ actions only, so there was
no representation at all of the thing a connector spends almost all its time
doing: collecting.

That left one question unanswerable, and it is the question the product turns on:

> What can this customer's integrations actually tell us?

Without an answer, a control with no evidence reads the same whether nothing is
connected that could ever see it, or something is connected and was refused a
permission this morning. Adericel could say `UNKNOWN` but not _why_, and an
`UNKNOWN` with no cause is a dead end rather than a finding.

It also meant collection was untargeted. Every integration ran its whole
repertoire on a schedule, whether or not any active rule needed what it
returned.

## Decision

**Every connector carries a machine-readable manifest, and a collection
capability is defined by the canonical predicates it supplies.**

```
collect: [{
  key: 'collect.endpoint_protection',
  domain: 'ENDPOINT',
  produces: ['DEVICE_STATE'],
  predicates: [
    'device.firewall.enabled',
    'device.endpoint_protection.installed',
    'device.endpoint_protection.realtime_enabled',
  ],
  requiredPermission: 'DeviceManagementConfiguration.Read.All',
}]
```

`predicates` is the load-bearing field. It is how a required predicate resolves
to a connector, how a collection plan is built, and how a control that
**cannot be assessed** is told apart from one that **failed**.

The predicates are canonical and never vendor-shaped: `identity.mfa.enforced`,
not `entra_strongAuthenticationRequirements`. Vendor vocabulary stops at the
adapter boundary. That is what lets Intune, an RMM and a customer's own API all
feed one rule, and it is why swapping a vendor is an adapter change rather than
a ruleset change.

**A connector declares capability, never meaning.** A connector says "I can
supply `device.disk.encrypted`". What that proves about Cyber Essentials is the
ruleset's business, and no connector may encode it.

### The mapping is a table, not control flow

The payload-key to predicate mapping used to exist only as a sequence of
statements inside each normaliser. That runs but cannot be _read_ — and a
declaratively configured connector, whose capability is a property of its
configuration rather than its code, needs to read it to derive its own manifest.
`PREDICATE_MAP` is now the single source both use.

### Conformance is enforced, not documented

A connector is not finished until it passes a suite that holds every adapter to
the same contract: canonical predicates only, no vendor name in the vocabulary,
an executable capability must be verifiable against something the connector can
also collect, credentials must not appear in non-secret configuration, and —
the one that matters most — **the connector must actually produce every
predicate its manifest declares**, checked by driving it against a realistic
upstream response.

That last check found five overclaims on its first run. An overclaimed predicate
is quietly severe: planning resolves it to the connector, believes the control
is covered, and the control then reads as a genuine gap in the customer's estate
when the truth is that Adericel never asked for any evidence at all.

## Consequences

Capability discovery, collection planning, source-conflict resolution and
evidence-gap explanation all become possible, because all four are the same
operation: resolving a canonical predicate to the sources that can supply it.

A new vendor for an existing capability is a new manifest and a new adapter. No
rule, engine, API or interface change.

The cost is that a connector author must state, precisely and in canonical
terms, what their adapter supplies — and be held to it by a test. That is the
intended cost.
