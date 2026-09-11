import { z } from 'zod';
import { OBSERVATION_KINDS, type ObservationInput, type ObservationKind } from '@adericel/domain';
import type {
  ConnectionCheck,
  Connector,
  CollectionResult,
  ConnectorContext,
  ExecutionRequest,
  ExecutionResult,
} from '../connector.js';
import {
  capabilityReport,
  connectorManifestSchema,
  DOMAIN_BY_OBSERVATION_KIND,
  type CapabilityReport,
  type ConnectorManifest,
} from '../manifest.js';
import { predicatesForPayloadKeys } from '../normalise.js';

/**
 * Demonstration fixture connector.
 *
 * This connector exists so that the seeded demonstration environment and the
 * end-to-end tests can exercise the complete chain — collection, normalisation,
 * assessment, action, external mutation, re-observation, verification — without
 * requiring credentials for a real tenant.
 *
 * It is NOT a simulated integration presented as real:
 *
 *  - every observation it produces carries `demonstrationData: true`;
 *  - its evidence is recorded with source system `adericel-demo-fixture`, which
 *    the UI renders with an explicit demonstration badge;
 *  - it is registered only when `allowDemoConnectors` is enabled, which
 *    `assertProductionSafety` will not permit alongside a production config.
 *
 * Its executions do mutate real state: the connector holds a mutable dataset and
 * an execution genuinely changes it, so a subsequent collection observes the
 * change and verification either confirms or refutes it on the evidence. A
 * verification that always confirms would make the demonstration worthless.
 */

const recordSchema = z.object({
  kind: z.enum(OBSERVATION_KINDS),
  subjectExternalId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  observedAt: z.string().datetime().nullable().default(null),
});

const configSchema = z.object({
  datasetName: z.string().min(1).default('default'),
  records: z.array(recordSchema).default([]),
  /** Action types this fixture will accept and apply to its dataset. */
  executableActionTypes: z
    .array(z.string())
    .default([
      'identity.mfa.require',
      'identity.account.disable',
      'cloud.storage.block_public_access',
    ]),
  /** Simulate an execution that reports success but does not change state. */
  failVerificationFor: z.array(z.string()).default([]),
});

const credentialSchema = z.object({});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof credentialSchema>;

/** Effects applied by executions, keyed by `${integrationId}:${subjectExternalId}`. */
export interface FixtureState {
  apply(integrationId: string, subjectExternalId: string, patch: Record<string, unknown>): void;
  effectsFor(integrationId: string, subjectExternalId: string): Record<string, unknown>;
  reset(integrationId?: string): void;
}

export function createFixtureState(): FixtureState {
  const store = new Map<string, Record<string, unknown>>();
  const key = (integrationId: string, subject: string) => `${integrationId}:${subject}`;
  return {
    apply(integrationId, subjectExternalId, patch) {
      const k = key(integrationId, subjectExternalId);
      store.set(k, { ...(store.get(k) ?? {}), ...patch });
    },
    effectsFor(integrationId, subjectExternalId) {
      return store.get(key(integrationId, subjectExternalId)) ?? {};
    },
    reset(integrationId) {
      if (!integrationId) {
        store.clear();
        return;
      }
      for (const k of [...store.keys()]) {
        if (k.startsWith(`${integrationId}:`)) store.delete(k);
      }
    },
  };
}

const ACTION_EFFECTS: Record<string, Record<string, unknown>> = {
  'identity.mfa.require': { mfaEnforced: true },
  'identity.account.disable': { enabled: false },
  'cloud.storage.block_public_access': { publicAccess: false },
  'device.encryption.enable': { diskEncrypted: true },
  'device.firewall.enable': { firewallEnabled: true },
};

export function createDemoFixtureConnector(state: FixtureState): Connector<Config, Credentials> {
  return {
    key: 'adericel-demo-fixture',
    name: 'Adericel demonstration fixture',
    vendor: 'Adericel',
    category: 'MANUAL',
    description:
      'Serves a fixed demonstration dataset and applies executions to it. For seeded demonstration ' +
      'environments and automated tests only — every observation is marked as demonstration data.',
    authKind: 'NONE',
    configSchema,
    credentialSchema,
    requiredPermissions: ['None. The fixture holds its dataset in configuration.'],
    defaultSchedule: '*/15 * * * *',
    manifest: demoFixtureManifest,

    capabilities: [
      {
        actionType: 'identity.mfa.require',
        title: 'Require MFA (demonstration)',
        description: 'Marks the demonstration identity as MFA-enforced.',
        riskClass: 'CONFIGURATION',
        parameterSchema: z.object({ enforcement: z.literal('REQUIRED').default('REQUIRED') }),
        verification: {
          method: 'fixture.reobserve',
          description: 'Re-collect the dataset and confirm the identity now reports MFA enforced.',
          predicate: 'identity.mfa.enforced',
          expectedValue: true,
        },
      },
      {
        actionType: 'identity.account.disable',
        title: 'Disable account (demonstration)',
        description: 'Marks the demonstration identity as disabled.',
        riskClass: 'DISRUPTIVE',
        parameterSchema: z.object({ reason: z.string().min(1) }),
        verification: {
          method: 'fixture.reobserve',
          description: 'Re-collect the dataset and confirm the identity is disabled.',
          predicate: 'identity.account.enabled',
          expectedValue: false,
        },
      },
      {
        actionType: 'cloud.storage.block_public_access',
        title: 'Block public access (demonstration)',
        description: 'Marks the demonstration storage resource as no longer publicly accessible.',
        riskClass: 'CONFIGURATION',
        parameterSchema: z.object({}),
        verification: {
          method: 'fixture.reobserve',
          description: 'Re-collect the dataset and confirm public access is disabled.',
          predicate: 'cloud.storage.public_access',
          expectedValue: false,
        },
      },
    ],

    async checkConnection(config): Promise<ConnectionCheck> {
      return {
        connected: true,
        detail: `Demonstration dataset "${config.datasetName}" holds ${config.records.length} record(s).`,
      };
    },

    async collect(config, _credentials, context: ConnectorContext): Promise<CollectionResult> {
      const observations: ObservationInput[] = config.records.map((record) => {
        const effects = record.subjectExternalId
          ? state.effectsFor(context.integrationId, record.subjectExternalId)
          : {};
        return {
          kind: record.kind as ObservationKind,
          sourceSystem: 'adericel-demo-fixture',
          subjectExternalId: record.subjectExternalId,
          observedAt: record.observedAt ?? context.nowIso,
          payload: {
            ...record.payload,
            ...effects,
            demonstrationData: true,
          },
        };
      });

      // Reported per capability like any other connector. The demonstration
      // path must exercise the same machinery a live one does, or the first
      // time an operator sees a capability report will be the day a real
      // integration breaks.
      const manifest = demoFixtureManifestFor(config);
      const countByKind = new Map<string, number>();
      for (const record of config.records) {
        countByKind.set(record.kind, (countByKind.get(record.kind) ?? 0) + 1);
      }
      const capabilityReports: CapabilityReport[] = manifest.collect.map((capability) => {
        const records = capability.produces.reduce(
          (total, kind) => total + (countByKind.get(kind) ?? 0),
          0,
        );
        return capabilityReport(
          manifest,
          capability.key,
          records === 0 ? 'EMPTY' : 'AVAILABLE',
          records === 0
            ? 'The configured dataset contains no records of this kind.'
            : `Replayed ${records} demonstration record(s).`,
          { records, observations: records },
        );
      });

      return {
        observations,
        warnings: [
          'This is demonstration data produced by the Adericel fixture connector. It does not ' +
            'describe a real environment.',
        ],
        // Advisory only. The fixture returns its whole dataset every time, so
        // the collection is complete even though the data is not real.
        partial: false,
        capabilityReports,
        cursor: null,
      };
    },

    async execute(
      config,
      _credentials,
      request: ExecutionRequest,
      context: ConnectorContext,
    ): Promise<ExecutionResult> {
      if (!config.executableActionTypes.includes(request.actionType)) {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: `Fixture is not configured to execute ${request.actionType}`,
          errorCode: 'UNSUPPORTED_ACTION',
          retryable: false,
        };
      }
      if (!request.targetExternalId) {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: 'No target was supplied',
          errorCode: 'MISSING_TARGET',
          retryable: false,
        };
      }

      /**
       * A target marked to fail execution.
       *
       * Set through the fixture state rather than through configuration, so a
       * single organisation can be made to fail one action while the rest of a
       * portfolio succeeds. The demonstration needs that: an MSP portfolio in
       * which every remediation either works or does not is not a portfolio
       * anybody recognises.
       *
       * A demonstration connector is the only place this belongs. No live
       * connector has, or may have, a way to be told to fail.
       */
      const targetState = state.effectsFor(context.integrationId, request.targetExternalId);
      if (targetState.__failExecution === true) {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: 'The upstream rejected the change.',
          errorCode: 'UPSTREAM_REJECTED',
          retryable: true,
        };
      }

      // Configured to report success without changing state. This exists so the
      // demonstration and the tests can show verification correctly refuting an
      // action that claimed to succeed.
      if (config.failVerificationFor.includes(request.actionType)) {
        return {
          status: 'SUCCEEDED',
          externalOperationRef: `fixture-${request.idempotencyKey}`,
          detail:
            'Execution reported success (state deliberately unchanged for verification testing).',
        };
      }

      const effect = ACTION_EFFECTS[request.actionType];
      if (!effect) {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: `No fixture effect is defined for ${request.actionType}`,
          errorCode: 'UNSUPPORTED_ACTION',
          retryable: false,
        };
      }

      state.apply(context.integrationId, request.targetExternalId, effect);
      return {
        status: 'SUCCEEDED',
        externalOperationRef: `fixture-${request.idempotencyKey}`,
        detail: `Applied ${JSON.stringify(effect)} to ${request.targetExternalId}.`,
      };
    },
  };
}

/**
 * Manifest.
 *
 * `fidelity: DEMONSTRATION` is the important field. This connector serves a
 * dataset from its own configuration and observes nothing. Presenting that as a
 * live integration would put fabricated data into an assurance record, so the
 * API and the interface carry the distinction through to anywhere a customer
 * can see it.
 */
export const demoFixtureManifest: ConnectorManifest = connectorManifestSchema.parse({
  id: 'adericel-demo-fixture',
  version: '1.0.0',
  vendor: 'Adericel',
  products: ['Demonstration fixture'],
  category: 'MANUAL',
  authentication: ['NONE'],
  collect: [
    {
      key: 'collect.fixture_records',
      title: 'Demonstration dataset',
      domain: 'IDENTITY',
      produces: ['IDENTITY_STATE', 'DEVICE_STATE', 'CLOUD_RESOURCE_STATE'],
      predicates: [
        'identity.mfa.enforced',
        'identity.account.enabled',
        'identity.account.type',
        'identity.last_sign_in_at',
        'device.disk.encrypted',
        'device.firewall.enabled',
        'cloud.storage.public_access',
      ],
      requiredPermission: '',
      incremental: false,
    },
  ],
  execute: [
    'identity.mfa.require',
    'identity.account.disable',
    'cloud.storage.block_public_access',
  ],
  verify: ['identity.mfa.enforced', 'identity.account.enabled', 'cloud.storage.public_access'],
  pagination: false,
  incrementalCollection: false,
  fidelity: 'DEMONSTRATION',
});

/**
 * The manifest this fixture actually has, given the dataset it was configured
 * with.
 *
 * Like the generic HTTP connector, the fixture's capability is a property of
 * its configuration rather than of its code. A fixed declaration would be wrong
 * in both directions: overclaiming makes a control read as a real gap in the
 * estate, and underclaiming makes the coverage report tell a customer to
 * connect a source for evidence something connected is already supplying.
 */
export function demoFixtureManifestFor(config: {
  readonly records: readonly { readonly kind: string; readonly payload: Record<string, unknown> }[];
}): ConnectorManifest {
  const byKind = new Map<string, Set<string>>();
  for (const record of config.records) {
    const keys = byKind.get(record.kind) ?? new Set<string>();
    for (const key of Object.keys(record.payload)) keys.add(key);
    byKind.set(record.kind, keys);
  }

  const collect = [...byKind.entries()]
    .map(([kind, keys]) => ({
      kind,
      predicates: predicatesForPayloadKeys(kind as never, [...keys]),
    }))
    .filter((entry) => entry.predicates.length > 0)
    .map((entry) => ({
      key: `collect.fixture_${entry.kind.toLowerCase()}`,
      title: `Demonstration ${entry.kind.replace(/_/g, ' ').toLowerCase()} records`,
      domain: DOMAIN_BY_OBSERVATION_KIND[entry.kind as never] ?? 'DOCUMENTATION',
      produces: [entry.kind],
      predicates: entry.predicates,
      requiredPermission: '',
      incremental: false,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return connectorManifestSchema.parse({ ...demoFixtureManifest, collect });
}
