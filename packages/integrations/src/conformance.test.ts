import { describe, expect, it } from 'vitest';
import { OBSERVATION_KINDS } from '@adericel/domain';
import { buildConnectorRegistry } from './registry.js';
import { connectorManifestSchema, EVIDENCE_DOMAINS } from './manifest.js';
import { PREDICATE_MAP, predicatesForKind } from './normalise.js';
import type { Connector } from './connector.js';

/**
 * The connector conformance suite.
 *
 * Every connector, present and future, is held to the same contract here.
 * A vendor adapter is only replaceable if all adapters behave identically at
 * the boundary — otherwise "swap Intune for an RMM" quietly means "and change
 * four other things". This suite is what makes that claim testable rather than
 * aspirational, and a new connector is not finished until it passes.
 */

const { registry } = buildConnectorRegistry({
  egressPolicy: { allowPrivateAddresses: false, allowedHosts: [] } as never,
  allowDemoConnectors: true,
  selfProbe: {
    collect: async () => ({ observations: [], warnings: [], cursor: null }),
  } as never,
});

const connectors = registry.list();

/** Predicates every canonical normaliser can produce, for validity checks. */
const CANONICAL_PREDICATES = new Set(
  OBSERVATION_KINDS.flatMap((kind) => predicatesForKind(kind)),
);

it('registers every connector Adericel ships', () => {
  expect(connectors.map((c) => c.key).sort()).toEqual([
    'adericel-demo-fixture',
    'adericel-self',
    'generic-http-json',
    'google-workspace',
    'microsoft-entra',
    'microsoft-intune',
  ]);
});

describe.each(connectors.map((c) => [c.key, c] as const))('conformance: %s', (_key, connector) => {
  const c = connector as Connector;

  it('carries a manifest that validates against the schema', () => {
    expect(() => connectorManifestSchema.parse(c.manifest)).not.toThrow();
  });

  it('agrees with itself about vendor and category', () => {
    // The manifest is authoritative; the interface fields exist for TypeScript.
    // If they disagree, one of them is lying to somebody.
    expect(c.manifest.vendor).toBe(c.vendor);
    expect(c.manifest.category).toBe(c.category);
  });

  it('declares its own authentication kind as supported', () => {
    expect(c.manifest.authentication).toContain(c.authKind);
  });

  it('declares only canonical predicates, never vendor vocabulary', () => {
    // This is the boundary the whole fabric rests on. A predicate the
    // normalisers never produce can never match a rule, so a connector
    // declaring one would look capable and supply nothing.
    for (const capability of c.manifest.collect) {
      for (const predicate of capability.predicates) {
        expect(
          CANONICAL_PREDICATES.has(predicate),
          `${c.key}/${capability.key} declares non-canonical predicate ${predicate}`,
        ).toBe(true);
      }
    }
  });

  it('declares only observation kinds the domain model knows', () => {
    for (const capability of c.manifest.collect) {
      for (const kind of capability.produces) {
        expect(OBSERVATION_KINDS as readonly string[]).toContain(kind);
      }
    }
  });

  it('declares predicates its produced observation kinds can actually carry', () => {
    for (const capability of c.manifest.collect) {
      const producible = new Set(
        capability.produces.flatMap((kind) => predicatesForKind(kind as never)),
      );
      for (const predicate of capability.predicates) {
        expect(
          producible.has(predicate),
          `${c.key}/${capability.key} claims ${predicate}, which none of ${capability.produces.join(', ')} produces`,
        ).toBe(true);
      }
    }
  });

  it('uses a recognised evidence domain for every capability', () => {
    for (const capability of c.manifest.collect) {
      expect(EVIDENCE_DOMAINS as readonly string[]).toContain(capability.domain);
    }
  });

  it('names the permission needed for each capability it can collect', () => {
    // A PERMISSION_DENIED that cannot name what to grant leaves the customer
    // to guess, which is how an integration stays broken for weeks.
    if (c.authKind === 'NONE') return;
    for (const capability of c.manifest.collect) {
      expect(
        capability.requiredPermission.length,
        `${c.key}/${capability.key} declares no required permission`,
      ).toBeGreaterThan(0);
    }
  });

  it('lists every executable capability in the manifest', () => {
    expect([...c.manifest.execute].sort()).toEqual(
      [...c.capabilities.map((cap) => cap.actionType)].sort(),
    );
  });

  it('declares a verification predicate for every executable capability', () => {
    for (const capability of c.capabilities) {
      expect(capability.verification.predicate.length).toBeGreaterThan(0);
      expect(
        CANONICAL_PREDICATES.has(capability.verification.predicate),
        `${c.key} verifies ${capability.actionType} against non-canonical ${capability.verification.predicate}`,
      ).toBe(true);
      expect(c.manifest.verify).toContain(capability.verification.predicate);
    }
  });

  it('can re-observe whatever it claims to verify', () => {
    // An action Adericel can take and cannot check would sit at UNVERIFIED
    // forever, which makes the autonomy it enables worthless.
    const collectible = new Set(c.manifest.collect.flatMap((cap) => cap.predicates));
    for (const predicate of c.manifest.verify) {
      expect(
        collectible.has(predicate),
        `${c.key} verifies against ${predicate} but cannot collect it`,
      ).toBe(true);
    }
  });

  it('implements execute() if and only if it declares executable capabilities', () => {
    expect(typeof c.execute === 'function').toBe(c.capabilities.length > 0);
  });

  it('declares a valid cron schedule', () => {
    expect(c.defaultSchedule.trim().split(/\s+/)).toHaveLength(5);
  });

  it('states its fidelity, and only the fixture may be DEMONSTRATION', () => {
    if (c.key === 'adericel-demo-fixture') {
      expect(c.manifest.fidelity).toBe('DEMONSTRATION');
    } else {
      expect(c.manifest.fidelity).toBe('LIVE');
    }
  });

  it('keeps credentials out of the configuration schema', () => {
    // Config is stored in the clear; credentials are sealed. A secret that
    // wandered into config would be readable in a database dump.
    const shape = (c.configSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    for (const field of Object.keys(shape)) {
      // `tokenUrl` and the like are endpoints, not secrets; it is the bare
      // secret-shaped name that must never appear in non-secret configuration.
      expect(
        /^(secret|password|passphrase|token|apiKey|privateKey|clientSecret|credential)s?$/i.test(
          field,
        ),
        `${c.key} config field ${field} looks like a credential`,
      ).toBe(false);
    }
  });

  it('has a unique manifest id matching its registry key', () => {
    expect(c.manifest.id).toBe(c.key);
  });
});

describe('the fixture connector is registered only when explicitly allowed', () => {
  it('is absent from a production registry', () => {
    const { registry: production } = buildConnectorRegistry({
      egressPolicy: { allowPrivateAddresses: false, allowedHosts: [] } as never,
    });
    expect(production.tryGet('adericel-demo-fixture')).toBeNull();
  });

  it('is present, and marked DEMONSTRATION, when allowed', () => {
    const { registry: dev } = buildConnectorRegistry({
      egressPolicy: { allowPrivateAddresses: false, allowedHosts: [] } as never,
      allowDemoConnectors: true,
    });
    expect(dev.get('adericel-demo-fixture').manifest.fidelity).toBe('DEMONSTRATION');
  });
});

describe('canonical predicate vocabulary', () => {
  it('covers every predicate any connector declares', () => {
    const declared = new Set(
      connectors.flatMap((c) => c.manifest.collect.flatMap((cap) => cap.predicates)),
    );
    const orphans = [...declared].filter((p) => !CANONICAL_PREDICATES.has(p));
    expect(orphans, 'connectors declare predicates no normaliser produces').toEqual([]);
  });

  it('namespaces every canonical predicate by domain', () => {
    for (const predicate of CANONICAL_PREDICATES) {
      expect(predicate, `${predicate} is not namespaced`).toMatch(/^[a-z][a-z0-9_]*\./);
    }
  });

  it('leaks no vendor name into the canonical vocabulary', () => {
    // The moment `entra_` or `intune.` appears here, swapping vendors stops
    // being an adapter change and becomes a ruleset change.
    for (const predicate of CANONICAL_PREDICATES) {
      expect(predicate).not.toMatch(/entra|intune|azure|graph|google|okta|jamf|crowdstrike/i);
    }
  });

  it('maps every observation kind that produces claims to an evidence domain', async () => {
    const { DOMAIN_BY_OBSERVATION_KIND } = await import('./manifest.js');
    for (const kind of Object.keys(PREDICATE_MAP)) {
      expect(
        DOMAIN_BY_OBSERVATION_KIND[kind as never],
        `${kind} produces claims but belongs to no evidence domain`,
      ).toBeDefined();
    }
  });
});
