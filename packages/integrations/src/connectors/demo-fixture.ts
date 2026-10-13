import { z } from 'zod';
import {
  collectionFailureCodeSchema,
  CollectionFailure,
  OBSERVATION_KINDS,
  type ObservationInput,
  type ObservationKind,
} from '@adericel/domain';
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
import { predicatesForKind, predicatesForPayloadKeys } from '../normalise.js';

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

  /**
   * Make collection fail, deliberately.
   *
   * Every real connector fails, and the failures that matter are not the ones
   * that throw loudly — those are easy. The dangerous ones are the quiet
   * kinds: a source that returns ninety per cent of the estate, or starts
   * omitting a field, or keeps answering in a shape nothing can read. Each can
   * be mistaken for a healthy collection that happens to look good.
   *
   * These let a test reproduce each one against the real assessment path, so
   * "a failing source never produces a pass" is something the suite
   * establishes rather than something the design intends. This connector is
   * already refused when `nodeEnv === 'production'`, which is why the
   * injection lives here rather than behind a runtime flag that could be set
   * on a customer deployment.
   */
  failCollectionWith: collectionFailureCodeSchema.nullable().default(null),

  /**
   * The source renames its fields, and keeps answering.
   *
   * Modelled separately from `failCollectionWith` because it is not a refusal.
   * The request succeeds, the response is well-formed, the run is recorded as
   * a success — and every field normalisation was looking for is now called
   * something else, so nothing can be read out of it. A vendor shipping a v2
   * API does this on a Tuesday without telling anyone.
   *
   * Making this throw, as an earlier version of this connector did, would have
   * been the comfortable choice and the wrong one: it would have tested the
   * loud path twice and left the quiet one untested.
   */
  driftFieldNames: z.boolean().default(false),

  /**
   * Subjects the source silently stops returning.
   *
   * The quietest failure of all: collection succeeds, reports no error, and
   * simply does not mention three of the forty devices. Nothing is broken from
   * the connector's point of view, and a system that assessed only what
   * arrived would report those three as fine.
   */
  omitSubjects: z.array(z.string()).default([]),

  /**
   * Fields the source stops reporting, while still returning the subject.
   *
   * Distinct from `omitSubjects` and worse. The subject is present and looks
   * healthy; one fact about it has quietly gone missing.
   *
   * These are the source's own payload field names — `diskEncrypted`, not
   * `device.disk.encrypted`. Naming them predicates would have been a lie
   * about where the boundary is: a connector reports vendor fields, and which
   * predicate each one becomes is Adericel's decision, made in normalisation.
   */
  omitFields: z.array(z.string()).default([]),

  /**
   * Whether this source reports when the fact became true.
   *
   * Many do not. A configuration export, a settings snapshot, a policy
   * listing — these say what is the case, not when it became the case, so
   * their only recency anchor is when Adericel collected them.
   *
   * That distinction decides which half of the refresh keeps a stable estate
   * proven. Evidence usability is anchored on `observed_at ?? collected_at`,
   * so a source that reports a timestamp is carried by `observed_at` and one
   * that does not is carried by `collected_at` — and the mutation harness
   * found that only the first was tested, because this fixture always
   * reported a timestamp. A guard with no test over it is the thing this
   * repository exists not to have.
   */
  reportsObservedAt: z.boolean().default(true),
});

/** The observation kinds a fixture dataset may contain. */
const FIXTURE_KINDS = ['IDENTITY_STATE', 'DEVICE_STATE', 'CLOUD_RESOURCE_STATE'] as const;

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
      if (config.failCollectionWith !== null) {
        /**
         * A `CollectionFailure`, not a bare Error, because that is what the
         * real connectors throw and the code is the whole point: the
         * collection service records it and the assessment path turns it into
         * a named repair. Throwing an Error here would exercise the
         * UNCLASSIFIED path on every injection and prove nothing about the
         * rest of the vocabulary.
         */
        throw new CollectionFailure(
          config.failCollectionWith,
          `Injected collection failure: ${config.failCollectionWith}`,
        );
      }

      const visible = config.records.filter(
        (record) =>
          record.subjectExternalId === null ||
          !config.omitSubjects.includes(record.subjectExternalId),
      );

      const observations: ObservationInput[] = visible.map((record) => {
        const effects = record.subjectExternalId
          ? state.effectsFor(context.integrationId, record.subjectExternalId)
          : {};
        return {
          kind: record.kind as ObservationKind,
          sourceSystem: 'adericel-demo-fixture',
          subjectExternalId: record.subjectExternalId,
          observedAt: config.reportsObservedAt ? (record.observedAt ?? context.nowIso) : null,
          payload: Object.fromEntries(
            Object.entries({
              ...record.payload,
              ...effects,
              demonstrationData: true,
              // A source that stops reporting a field does not report it as
              // null — the key is simply absent, which is why this deletes
              // rather than nulls. A null would be an answer.
            })
              .filter(([key]) => !config.omitFields.includes(key))
              // Renamed, not removed. The field is still there and still
              // carries the right value; normalisation simply has no mapping
              // for its new name, so no claim is derived from it.
              .map(([key, value]) => [config.driftFieldNames ? `v2_${key}` : key, value] as const),
          ),
        };
      });

      // Reported per capability like any other connector. The demonstration
      // path must exercise the same machinery a live one does, or the first
      // time an operator sees a capability report will be the day a real
      // integration breaks.
      const manifest = demoFixtureManifestFor(config);
      const countByKind = new Map<string, number>();
      // Counted from what was actually returned, not from the configured
      // dataset. A capability report that counted the dataset would say forty
      // devices were collected on a run that returned thirty-seven, which is
      // the connector lying about its own coverage.
      for (const record of visible) {
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
      produces: FIXTURE_KINDS,
      /**
       * Derived, not listed.
       *
       * A fixture's dataset is supplied by whoever configures it, so any field
       * the normaliser understands for these kinds may turn up — which makes a
       * hand-written list wrong by construction. It was wrong: the list used to
       * omit `device.managed` while the connector produced it on every run,
       * and because impairment is matched predicate by predicate, every
       * control gated on that predicate reported INSUFFICIENT_EVIDENCE
       * ("connect something") when the real answer was "this credential
       * expired". The chaos suite found it; a hand-maintained list is how it
       * got there.
       */
      predicates: FIXTURE_KINDS.flatMap((kind) => predicatesForKind(kind)),
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
