import { describe, expect, it } from 'vitest';
import {
  predicatesForConnectorFrom,
  predicatesOf,
  sourceImpairments,
  type IntegrationHealthFacts,
} from './impairment.js';
import { buildConnectorRegistry } from './registry.js';

/**
 * What a broken source says about itself.
 *
 * This module decides nothing about any control — the engine does that, and
 * its safety rule is that impairment may only ever rename an UNKNOWN. What is
 * tested here is narrower and still load-bearing: a healthy connector must
 * produce no impairment at all, and an unhealthy one must name a repair rather
 * than a symptom.
 */
const facts = (overrides: Partial<IntegrationHealthFacts> = {}): IntegrationHealthFacts => ({
  integrationId: 'int-1',
  name: 'Contoso Entra',
  connectorKey: 'microsoft-entra',
  status: 'DEGRADED',
  latestFailureCode: 'CREDENTIAL_INVALID',
  consecutiveFailures: 1,
  lastSuccessAt: '2026-09-09T06:00:00.000Z',
  predicates: ['identity.mfa.enforced', 'identity.account.enabled'],
  ...overrides,
});

describe('source impairment', () => {
  it('produces nothing at all for a healthy integration', () => {
    // The property worth being certain about. A working connector that
    // degraded even one control would make the whole mechanism unusable.
    for (const status of ['CONNECTED', 'CONFIGURED', 'PENDING']) {
      expect(sourceImpairments({ integrations: [facts({ status })] }), status).toEqual([]);
    }
  });

  it('names the repair rather than the symptom', () => {
    const [impairment] = sourceImpairments({ integrations: [facts()] });
    expect(impairment?.kind).toBe('DEGRADED');
    expect(impairment?.reason).toBe('CREDENTIAL_EXPIRED');
    // The detail is what an operator reads. It must say which integration, and
    // what the connector reported — not "an integration is unhealthy".
    expect(impairment?.detail).toContain('Contoso Entra');
    expect(impairment?.detail).toContain('CREDENTIAL_INVALID');
  });

  it('routes a withdrawn consent as BLOCKED, not DEGRADED', () => {
    const [impairment] = sourceImpairments({
      integrations: [facts({ latestFailureCode: 'CONSENT_WITHDRAWN' })],
    });
    expect(impairment?.kind).toBe('BLOCKED');
    expect(impairment?.reason).toBe('CONSENT_REQUIRED');
  });

  it('still speaks up when the failure has not been classified', () => {
    /**
     * Staying silent until a code is known would mean the first minutes of
     * every outage looked identical to normal operation — and those are the
     * minutes in which somebody could still act.
     */
    const [impairment] = sourceImpairments({
      integrations: [facts({ latestFailureCode: null })],
    });
    expect(impairment?.kind).toBe('DEGRADED');
    expect(impairment?.reason).toBe('COLLECTION_FAILING');
    expect(impairment?.detail).toContain('not been classified');
  });

  it('covers every predicate the integration supplies, and no others', () => {
    const impairments = sourceImpairments({
      integrations: [facts({ predicates: ['a.one', 'a.two', 'a.three'] })],
    });
    expect(impairments.map((i) => i.predicate)).toEqual(['a.one', 'a.three', 'a.two']);
  });

  it('keeps two integrations of the same connector apart', () => {
    /**
     * Two Microsoft 365 tenants under one MSP is the normal shape, not an edge
     * case. Attributing one tenant's predicates to the other would degrade
     * controls in a customer whose connector is working perfectly.
     */
    const impairments = sourceImpairments({
      integrations: [
        facts({ integrationId: 'int-1', name: 'Tenant A', predicates: ['a.one'] }),
        facts({
          integrationId: 'int-2',
          name: 'Tenant B',
          status: 'CONNECTED',
          predicates: ['b.one'],
        }),
      ],
    });
    expect(impairments.map((i) => i.predicate)).toEqual(['a.one']);
  });

  it('is deterministic, because the result goes inside the assessment digest', () => {
    // Replay compares digests byte for byte. An ordering that happens to be
    // stable today is not a guarantee.
    const integrations = [
      facts({ integrationId: 'b', name: 'B', predicates: ['z.one', 'a.one'] }),
      facts({ integrationId: 'a', name: 'A', predicates: ['m.one'] }),
    ];
    const first = sourceImpairments({ integrations });
    const second = sourceImpairments({ integrations: [...integrations].reverse() });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('says nothing about an integration that supplies no predicates', () => {
    expect(sourceImpairments({ integrations: [facts({ predicates: [] })] })).toEqual([]);
  });

  describe('the registry-backed predicate lookup', () => {
    const { registry } = buildConnectorRegistry({
      egressPolicy: { allowlist: [], blockPrivate: false },
      allowDemoConnectors: true,
    });
    const lookup = predicatesForConnectorFrom(registry);

    it('reports a connector withdrawn since the integration was configured as supplying nothing', () => {
      // `tryGet`, not `get`. An unknown connector key — a connector removed in
      // a later release, a database restored from an older one — must not stop
      // a whole organisation being assessed.
      expect(lookup('a-connector-that-was-removed')).toEqual([]);
    });

    it('derives a shipped connector real predicates from its manifest', () => {
      const predicates = lookup('microsoft-intune');
      expect(predicates.length).toBeGreaterThan(0);
      for (const predicate of predicates) expect(predicate).toMatch(/^[a-z]+(\.[a-z0-9_]+)+$/);
    });

    it('declares every predicate the demonstration connector can actually produce', () => {
      /**
       * The defect this test exists for.
       *
       * The fixture's manifest used to list its predicates by hand and omitted
       * `device.managed`, which it produced on every run. Because impairment is
       * matched predicate by predicate, every control gated on that predicate
       * reported INSUFFICIENT_EVIDENCE — "connect something" — when the real
       * answer was "this credential expired".
       */
      const predicates = lookup('adericel-demo-fixture');
      expect(predicates).toContain('device.managed');
      expect(predicates).toContain('device.disk.encrypted');
      expect(predicates).toContain('identity.mfa.enforced');
    });

    it('agrees with the manifest it was derived from', () => {
      const connector = registry.get('microsoft-entra');
      expect([...lookup('microsoft-entra')].sort()).toEqual(
        [...predicatesOf(connector.manifest)].sort(),
      );
    });
  });
});
