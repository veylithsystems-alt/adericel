# The observation fabric

How Adericel turns heterogeneous external systems into canonical assurance
observations without coupling the assurance model to any vendor.

Read [ADR-0028](../adr/ADR-0028-connector-manifests-and-capability-resolution.md)
and [ADR-0029](../adr/ADR-0029-source-conflict.md) for why it is shaped this
way. This document is how to work with it.

## The shape of it

```
external system
      │  connector.collect()          adapter — the only vendor-aware code
      ▼
 observation                          canonical kind + canonical payload keys
      │  normalise()                  PREDICATE_MAP, deterministic
      ▼
   claims                             canonical predicates
      │  claims.assert()              conflict adjudication happens here
      ▼
 truth engine                         Kleene logic over claims
```

Nothing below the adapter knows what Entra, Intune or a customer's own API is.
That is the property that makes vendors replaceable, and every rule in this
document exists to protect it.

## Writing a connector

### 1. Map onto canonical payload keys, not vendor fields

A connector's job is translation. Look up the canonical payload keys for the
observation kind you are producing (`payloadKeysForKind` in
`packages/integrations/src/normalise.ts`) and write those.

```ts
observations.push({
  kind: 'DEVICE_STATE',
  sourceSystem: 'microsoft-intune',
  subjectExternalId: device.id,
  observedAt: device.lastSyncDateTime ?? context.nowIso,
  payload: {
    externalId: device.id,
    diskEncrypted: device.isEncrypted,   // canonical key, not `isEncrypted`
  },
});
```

**Omit what the source did not say.** An absent field must stay absent so the
predicate becomes UNKNOWN rather than a default. Writing `diskEncrypted: false`
because the vendor returned nothing is how a product invents certainty.

### 2. Declare a manifest, and be held to it

```ts
export const myConnectorManifest = connectorManifestSchema.parse({
  id: 'my-connector',            // must equal the registry key
  version: '1.0.0',
  vendor: 'Vendor Name',
  category: 'ENDPOINT',
  authentication: ['OAUTH2_CLIENT_CREDENTIALS'],
  collect: [{
    key: 'collect.devices',       // must start with `collect.`
    title: 'Managed device inventory',
    domain: 'ENDPOINT',
    produces: ['DEVICE_STATE'],
    predicates: ['device.managed', 'device.disk.encrypted'],
    requiredPermission: 'DeviceManagementManagedDevices.Read.All',
  }],
  execute: [],
  verify: [],
  fidelity: 'LIVE',
});
```

Declare only predicates your connector genuinely produces. The conformance suite
drives your connector against a fixture and fails if it declares one it does not
write — because an overclaim makes a control read as a real gap in the
customer's estate when in fact Adericel never asked for the evidence.

### 3. Report per capability, not per run

```ts
capabilityReports.push(
  capabilityReport(manifest, 'collect.devices', 'AVAILABLE',
    `Collected ${devices.length} device(s).`, { records: devices.length }),
);
// ...or, when a capability is refused:
capabilityReports.push(reportFromError(manifest, 'collect.mfa', error));
```

The nine outcomes are in `packages/integrations/src/manifest.ts`. Two are worth
stating explicitly:

- **`EMPTY` is informative.** An organisation with no cloud resources is a fact,
  not a failure. Treating it as one makes every small customer look broken.
- **`PERMISSION_DENIED` must name the permission.** `reportFromError` takes it
  from your manifest so the message says exactly what to grant. That is the
  difference between an integration fixed before lunch and one broken for a
  fortnight.

### 4. Executable capabilities must be verifiable

Every action declares a predicate re-observed to confirm it, and the connector
must be able to collect that predicate. An action Adericel can take and cannot
check would sit at UNVERIFIED forever, which makes the autonomy it enables
worthless.

Two comparisons are available:

- `EQUALS` — the predicate must hold a constant. Disable an account, and
  `identity.account.enabled` must read `false`.
- `OBSERVED_AFTER_EXECUTION` — the predicate is a timestamp that must be later
  than the moment the action ran. Suits an action whose effect is that something
  happened at all, such as asking a device to check in. A stale timestamp equal
  to the previous one is exactly the failure it catches.

### 5. Never decide assurance truth

A connector may not:

- assert what a predicate means for a control,
- declare itself authoritative over another source,
- default an unobserved value,
- or return a `DEMONSTRATION` fidelity while pretending to be live.

## Adding a predicate

1. Add it to `PREDICATE_MAP` in `normalise.ts` against the observation kind that
   carries it and the canonical payload key a connector will write.
2. Declare it on whichever connector capability supplies it.
3. Reference it from a rule.

The conformance suite fails if a ruleset requires a predicate no observation
kind can produce — the state three ISO 27001 controls were silently in, where
the explanation said "record this manually", a customer did, and nothing
changed.

## Source authority

When two integrations supply the same predicate, both are collected. Choosing at
collection time would hide the disagreement, and a disagreement is the thing a
system of record must surface rather than resolve by accident.

Configure which source wins per predicate:

```
PUT /v1/organisations/:id/source-authority
{ "predicatePattern": "device.", "integrationIds": ["<intune-id>"] }
```

Longest matching pattern wins, so `device.disk.encrypted` beats `device.`.
`freshnessWindowHours` is null by default: recency is not authority.

With nothing configured, a disagreement makes both claims `DISPUTED` and the
dependent controls `UNKNOWN`. That is the safe default and it is correct.

## Where things live

| Concern | File |
| --- | --- |
| Connector contract | `packages/integrations/src/connector.ts` |
| Manifest, capability outcomes, health | `packages/integrations/src/manifest.ts` |
| Payload key to predicate map | `packages/integrations/src/normalise.ts` |
| Collection planning, coverage discovery | `packages/integrations/src/planning.ts` |
| Conflict adjudication (pure) | `packages/domain/src/conflict.ts` |
| Conflict persistence | `packages/evidence/src/conflicts.ts` |
| Schema drift detection | `packages/integrations/src/drift.ts` |
| Conformance suite | `packages/integrations/src/conformance.test.ts` |
| Manifest honesty suite | `packages/integrations/src/connectors/manifest-honesty.test.ts` |
| Coverage and gap explanation | `apps/api/src/services/observation-coverage.ts` |

## Current coverage

Measured, not claimed. Shipped live connectors (Entra, Intune, Google
Workspace) supply **13 of the 41** predicates the three built-in rulesets need,
and **8 of the 15** Cyber Essentials asks for.

The remainder fall into two groups, and the distinction matters:

- **Needs a connector Adericel does not yet ship**: cloud storage posture,
  backup state, vulnerability state, boundary firewall.
- **Needs a person to record it**: policy publication and review dates, supplier
  assurance, incident-plan publication, training completion. These have a route
  in — the observation ingest endpoint — and are legitimately human-asserted
  facts rather than gaps in the fabric.

`GET /v1/organisations/:id/observation-coverage` reports this per organisation
against what is actually connected.
