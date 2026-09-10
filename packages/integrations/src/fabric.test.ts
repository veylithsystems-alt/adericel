import { describe, expect, it } from 'vitest';
import {
  capabilityInformative,
  connectorManifestSchema,
  healthFromReports,
  unavailablePredicates,
  type CapabilityReport,
  type ConnectorManifest,
} from './manifest.js';
import { discoverCoverage, indexPredicateSources, planCollection } from './planning.js';
import { conflictBlocksClaim, resolveConflict, type SourcedValue } from './conflict.js';
import { detectDrift } from './drift.js';
import { normalise, predicatesForPayloadKeys, PREDICATE_MAP } from './normalise.js';

function manifest(over: Partial<ConnectorManifest> = {}): ConnectorManifest {
  return connectorManifestSchema.parse({
    id: 'test.connector',
    version: '1.0.0',
    vendor: 'Test',
    category: 'IDENTITY',
    authentication: ['API_KEY'],
    ...over,
  });
}

const identityCapability = {
  key: 'collect.identities',
  title: 'Identities',
  domain: 'IDENTITY',
  produces: ['IDENTITY_STATE'],
  predicates: ['identity.account.enabled', 'identity.mfa.enforced'],
  requiredPermission: 'User.Read.All',
};

const deviceCapability = {
  key: 'collect.devices',
  title: 'Devices',
  domain: 'ENDPOINT',
  produces: ['DEVICE_STATE'],
  predicates: ['device.disk.encrypted'],
  requiredPermission: 'DeviceManagementManagedDevices.Read.All',
  incremental: true,
};

describe('connector manifest', () => {
  it('refuses a collection capability that declares no predicates', () => {
    // A capability supplying nothing cannot participate in planning, and would
    // silently never be scheduled.
    expect(() =>
      manifest({ collect: [{ ...identityCapability, predicates: [] }] }),
    ).toThrow();
  });

  it('refuses a capability key outside the collect namespace', () => {
    expect(() => manifest({ collect: [{ ...identityCapability, key: 'identities' }] })).toThrow();
  });

  it('defaults fidelity to LIVE, so a fixture must say so deliberately', () => {
    expect(manifest().fidelity).toBe('LIVE');
    expect(manifest({ fidelity: 'DEMONSTRATION' }).fidelity).toBe('DEMONSTRATION');
  });
});

describe('capability outcomes', () => {
  const report = (over: Partial<CapabilityReport>): CapabilityReport => ({
    capability: 'collect.identities',
    outcome: 'AVAILABLE',
    detail: '',
    recordsCollected: 0,
    observationsProduced: 0,
    ...over,
  });

  it('treats EMPTY as informative — no devices is a fact, not a failure', () => {
    expect(capabilityInformative('EMPTY')).toBe(true);
    expect(
      unavailablePredicates(manifest({ collect: [identityCapability] }), [
        report({ outcome: 'EMPTY' }),
      ]),
    ).toEqual([]);
  });

  it('names the predicates a permission failure has cost us', () => {
    expect(
      unavailablePredicates(manifest({ collect: [identityCapability, deviceCapability] }), [
        report({ outcome: 'PERMISSION_DENIED' }),
        report({ capability: 'collect.devices', outcome: 'AVAILABLE' }),
      ]),
    ).toEqual(['identity.account.enabled', 'identity.mfa.enforced']);
  });

  it('ranks health deterministically, worst first', () => {
    expect(healthFromReports([report({}), report({ outcome: 'PARTIAL' })])).toBe('PARTIAL');
    expect(
      healthFromReports([report({ outcome: 'PARTIAL' }), report({ outcome: 'PERMISSION_DENIED' })]),
    ).toBe('AUTHORISED_BUT_RESTRICTED');
    expect(
      healthFromReports([
        report({ outcome: 'PERMISSION_DENIED' }),
        report({ outcome: 'AUTHENTICATION_FAILED' }),
      ]),
    ).toBe('AUTHENTICATION_FAILED');
    expect(healthFromReports([report({})])).toBe('HEALTHY');
  });

  it('reports a schema drift as drift, not as a healthy empty result', () => {
    expect(healthFromReports([report({ outcome: 'SCHEMA_DRIFT' })])).toBe('SCHEMA_DRIFT');
  });
});

describe('collection planning', () => {
  const entra = {
    integrationId: 'int-entra',
    connectorKey: 'microsoft.entra',
    displayName: 'Microsoft Entra ID',
    manifest: manifest({ id: 'microsoft.entra', collect: [identityCapability] }),
  };
  const intune = {
    integrationId: 'int-intune',
    connectorKey: 'microsoft.intune',
    displayName: 'Microsoft Intune',
    manifest: manifest({ id: 'microsoft.intune', collect: [deviceCapability] }),
  };
  const rmm = {
    integrationId: 'int-rmm',
    connectorKey: 'generic.http',
    displayName: 'Our RMM',
    manifest: manifest({ id: 'generic.http', collect: [deviceCapability] }),
  };

  it('collects a capability once however many predicates need it', () => {
    const plan = planCollection(
      ['identity.account.enabled', 'identity.mfa.enforced'],
      [entra, intune],
    );
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.capability).toBe('collect.identities');
    expect(plan.tasks[0]!.predicates).toEqual([
      'identity.account.enabled',
      'identity.mfa.enforced',
    ]);
  });

  it('records a predicate nothing can supply instead of dropping it', () => {
    const plan = planCollection(['network.firewall.present'], [entra, intune]);
    expect(plan.tasks).toEqual([]);
    expect(plan.unsatisfiable).toEqual(['network.firewall.present']);
  });

  it('collects from every source rather than picking one', () => {
    // Choosing here would hide a disagreement. Both are collected so the
    // conflict becomes visible after collection.
    const plan = planCollection(['device.disk.encrypted'], [intune, rmm]);
    expect(plan.tasks.map((t) => t.integrationId).sort()).toEqual(['int-intune', 'int-rmm']);
    expect(plan.multiplySourced).toHaveLength(1);
    expect(plan.multiplySourced[0]!.sources).toHaveLength(2);
  });

  it('is deterministic for a given ruleset and integration set', () => {
    const a = planCollection(['device.disk.encrypted', 'identity.mfa.enforced'], [rmm, entra, intune]);
    const b = planCollection(['identity.mfa.enforced', 'device.disk.encrypted'], [intune, entra, rmm]);
    expect(a).toEqual(b);
  });

  it('excludes a capability disabled by configuration', () => {
    const plan = planCollection(['device.disk.encrypted'], [
      { ...intune, disabledCapabilities: ['collect.devices'] },
    ]);
    expect(plan.unsatisfiable).toEqual(['device.disk.encrypted']);
  });

  it('indexes a predicate to every integration that supplies it', () => {
    const index = indexPredicateSources([intune, rmm]);
    expect(index.get('device.disk.encrypted')).toHaveLength(2);
  });

  it('reports coverage per domain, marking what nothing supplies', () => {
    const coverage = discoverCoverage([entra], [identityCapability, deviceCapability] as never);
    const endpoint = coverage.find((c) => c.domain === 'ENDPOINT');
    const identity = coverage.find((c) => c.domain === 'IDENTITY');
    expect(identity?.capabilities[0]).toMatchObject({ available: true, sources: ['Microsoft Entra ID'] });
    expect(endpoint?.capabilities[0]).toMatchObject({ available: false, sources: [] });
  });
});

describe('source conflict', () => {
  const at = (iso: string, over: Partial<SourcedValue> = {}): SourcedValue => ({
    integrationId: 'int-a',
    connectorKey: 'a',
    displayName: 'System A',
    value: true,
    observedAt: iso,
    collectedAt: iso,
    ...over,
  });

  it('agrees when only one source spoke', () => {
    const outcome = resolveConflict('device.disk.encrypted', 'd1', [at('2026-01-01T00:00:00Z')]);
    expect(outcome.resolution).toBe('AGREED');
    expect(outcome.value).toBe(true);
    expect(conflictBlocksClaim(outcome)).toBe(false);
  });

  it('agrees when sources say the same thing in a different key order', () => {
    const outcome = resolveConflict('identity.mfa.methods', 'u1', [
      at('2026-01-01T00:00:00Z', { value: { app: true, sms: false } }),
      at('2026-01-01T01:00:00Z', {
        integrationId: 'int-b',
        displayName: 'System B',
        value: { sms: false, app: true },
      }),
    ]);
    expect(outcome.resolution).toBe('AGREED');
  });

  it('refuses to choose when sources disagree and nothing resolves it', () => {
    const outcome = resolveConflict('device.disk.encrypted', 'd1', [
      at('2026-01-01T00:00:00Z', { value: true }),
      at('2026-01-01T00:05:00Z', {
        integrationId: 'int-b',
        displayName: 'System B',
        value: false,
      }),
    ]);
    expect(outcome.resolution).toBe('UNRESOLVED');
    expect(outcome.value).toBeNull();
    expect(conflictBlocksClaim(outcome)).toBe(true);
    expect(outcome.detail).toContain('will not choose');
  });

  it('does not let five minutes of scheduling decide the answer', () => {
    // Freshness is off unless configured, and even then it needs a real margin.
    const sources = [
      at('2026-01-01T00:00:00Z', { value: true }),
      at('2026-01-01T00:05:00Z', {
        integrationId: 'int-b',
        displayName: 'System B',
        value: false,
      }),
    ];
    expect(resolveConflict('p', null, sources, { freshnessWindowHours: 24 }).resolution).toBe(
      'UNRESOLVED',
    );
  });

  it('honours a configured authority over a fresher contradiction', () => {
    const outcome = resolveConflict(
      'device.disk.encrypted',
      'd1',
      [
        at('2026-01-01T00:00:00Z', { value: true }),
        at('2026-06-01T00:00:00Z', {
          integrationId: 'int-b',
          displayName: 'System B',
          value: false,
        }),
      ],
      { authoritativeIntegrationIds: ['int-a'], freshnessWindowHours: 1 },
    );
    expect(outcome.resolution).toBe('RESOLVED_BY_AUTHORITY');
    expect(outcome.value).toBe(true);
  });

  it('resolves by freshness only past the configured window', () => {
    const outcome = resolveConflict(
      'p',
      null,
      [
        at('2026-01-01T00:00:00Z', { value: true }),
        at('2026-01-05T00:00:00Z', {
          integrationId: 'int-b',
          displayName: 'System B',
          value: false,
        }),
      ],
      { freshnessWindowHours: 24 },
    );
    expect(outcome.resolution).toBe('RESOLVED_BY_FRESHNESS');
    expect(outcome.value).toBe(false);
  });
});

describe('schema drift', () => {
  const expectations = [
    { path: 'id', presence: 'always' as const },
    { path: 'authentication.mfa', presence: 'population' as const },
  ];

  it('does not call an empty response drift', () => {
    const report = detectDrift([], expectations);
    expect(report.drifted).toBe(false);
    expect(report.recordsInspected).toBe(0);
  });

  it('detects a field that has moved out from under the connector', () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}` }));
    const report = detectDrift(records, expectations);
    expect(report.drifted).toBe(true);
    expect(report.missingFields).toEqual(['authentication.mfa']);
    expect(report.detail).toContain('schema');
  });

  it('tolerates a population field that only some records carry', () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: `u${i}`,
      ...(i === 0 ? { authentication: { mfa: 'enabled' } } : {}),
    }));
    expect(detectDrift(records, expectations).drifted).toBe(false);
  });

  it('treats an always-present field missing from one record as drift', () => {
    const records = [{ id: 'u1', authentication: { mfa: 'x' } }, { authentication: { mfa: 'x' } }];
    expect(detectDrift(records, expectations).missingFields).toEqual(['id']);
  });

  it('samples rather than inspecting the whole population', () => {
    const records = Array.from({ length: 500 }, () => ({ id: 'u', authentication: { mfa: 'x' } }));
    expect(detectDrift(records, expectations, { sampleSize: 10 }).recordsInspected).toBe(10);
  });
});

describe('the predicate map is the single source of truth', () => {
  it('translates payload keys to canonical predicates', () => {
    expect(predicatesForPayloadKeys('DEVICE_STATE', ['diskEncrypted', 'managed'])).toEqual([
      'device.disk.encrypted',
      'device.managed',
    ]);
  });

  it('does not invent a predicate for an unrecognised payload key', () => {
    expect(predicatesForPayloadKeys('DEVICE_STATE', ['someVendorField'])).toEqual([]);
  });

  it('declares no predicate twice within one observation kind', () => {
    for (const [kind, mappings] of Object.entries(PREDICATE_MAP)) {
      const predicates = (mappings ?? []).map((m) => m.predicate);
      expect(new Set(predicates).size, `${kind} declares a duplicate predicate`).toBe(
        predicates.length,
      );
    }
  });

  it('still omits a predicate the source did not speak to', () => {
    const result = normalise({
      id: 'o1',
      organisationId: 'org',
      integrationId: 'i',
      kind: 'DEVICE_STATE',
      sourceSystem: 'test',
      subjectExternalId: 'd1',
      payload: { externalId: 'd1', managed: true },
      observedAt: '2026-01-01T00:00:00Z',
      collectedAt: '2026-01-01T00:00:00Z',
      contentHash: 'sha256:x',
      evidenceId: null,
    } as never);
    expect(result.claims.map((c) => c.predicate)).toEqual(['device.managed']);
  });

  it('attaches an organisation-wide setting to no subject', () => {
    const result = normalise({
      id: 'o1',
      organisationId: 'org',
      integrationId: 'i',
      kind: 'CONFIGURATION_SETTING',
      sourceSystem: 'test',
      subjectExternalId: null,
      payload: { passwordMinLength: 12 },
      observedAt: '2026-01-01T00:00:00Z',
      collectedAt: '2026-01-01T00:00:00Z',
      contentHash: 'sha256:x',
      evidenceId: null,
    } as never);
    expect(result.claims).toEqual([
      expect.objectContaining({
        predicate: 'organisation.password.min_length',
        value: 12,
        subjectExternalId: null,
      }),
    ]);
  });
});
