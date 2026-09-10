import { z } from 'zod';
import type { ObservationInput } from '@adericel/domain';
import type {
  ConnectionCheck,
  Connector,
  ConnectorContext,
  CollectionResult,
} from '../connector.js';
import { connectorManifestSchema, type ConnectorManifest } from '../manifest.js';

/**
 * Adericel self-assurance connector.
 *
 * Adericel sells continuous assurance, so it operates under continuous
 * assurance itself. This connector collects the platform's own posture into an
 * organisation representing Adericel, where it is assessed by exactly the same
 * Truth Engine and rulesets as any customer.
 *
 * The probe is injected rather than reached for directly, so the connector
 * stays a pure adapter and the platform internals it reads are explicit.
 */

export interface SelfAssuranceSnapshot {
  readonly releaseVersion: string;
  readonly databaseReachable: boolean;
  readonly objectStorageReachable: boolean;
  readonly outboxDeadLetterCount: number;
  readonly outboxOldestPendingAgeSeconds: number | null;
  readonly failedIntegrations: number;
  readonly backupLastSuccessAt: string | null;
  readonly backupLastRestoreTestAt: string | null;
  readonly logRetentionDays: number;
  readonly loggingEnabled: boolean;
  readonly dependencyAdvisories: number;
  readonly adminAccountCount: number;
  readonly adminAccountsWithMfa: number;
  readonly tlsEnforced: boolean;
  readonly secretsExternallyManaged: boolean;
}

export type SelfAssuranceProbe = () => Promise<SelfAssuranceSnapshot>;

const configSchema = z.object({
  componentName: z.string().default('adericel-platform'),
});
const credentialSchema = z.object({});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof credentialSchema>;

export function createAdericelSelfConnector(
  probe: SelfAssuranceProbe,
): Connector<Config, Credentials> {
  return {
    key: 'adericel-self',
    name: 'Adericel self-assurance',
    vendor: 'Adericel',
    category: 'MANUAL',
    description:
      "Collects Adericel's own operational and security posture so the platform is assessed by the " +
      'same engine and rulesets as the organisations it serves.',
    authKind: 'NONE',
    configSchema,
    credentialSchema,
    requiredPermissions: ['None. The connector reads Adericel-internal health state only.'],
    defaultSchedule: '0 * * * *',
    manifest: adericelSelfManifest,
    capabilities: [],

    async checkConnection(_config, _credentials, _context): Promise<ConnectionCheck> {
      try {
        await probe();
        return { connected: true, detail: 'Self-assurance probe responded.' };
      } catch (error) {
        return { connected: false, detail: (error as Error).message };
      }
    },

    async collect(config, _credentials, context: ConnectorContext): Promise<CollectionResult> {
      const snapshot = await probe();
      const warnings: string[] = [];
      const observations: ObservationInput[] = [];

      observations.push({
        kind: 'CONFIGURATION_SETTING',
        sourceSystem: 'adericel-self',
        subjectExternalId: null,
        observedAt: context.nowIso,
        payload: {
          loggingEnabled: snapshot.loggingEnabled,
          logRetentionDays: snapshot.logRetentionDays,
          adminCount: snapshot.adminAccountCount,
          ...(snapshot.backupLastRestoreTestAt
            ? { lastRestoreTestAt: snapshot.backupLastRestoreTestAt }
            : {}),
        },
      });

      observations.push({
        kind: 'BACKUP_STATE',
        sourceSystem: 'adericel-self',
        subjectExternalId: `${config.componentName}:database`,
        observedAt: context.nowIso,
        payload: {
          externalId: `${config.componentName}:database`,
          name: 'Adericel primary database',
          system: 'postgresql',
          required: true,
          lastStatus: snapshot.backupLastSuccessAt ? 'SUCCEEDED' : 'UNKNOWN',
          ...(snapshot.backupLastSuccessAt ? { lastSuccessAt: snapshot.backupLastSuccessAt } : {}),
        },
      });

      observations.push({
        kind: 'APPLICATION_STATE',
        sourceSystem: 'adericel-self',
        subjectExternalId: config.componentName,
        observedAt: context.nowIso,
        payload: {
          externalId: config.componentName,
          name: 'Adericel platform',
          vendor: 'Adericel',
          version: snapshot.releaseVersion,
          vendorSupported: true,
          defaultCredentialsPresent: false,
        },
      });

      observations.push({
        kind: 'VULNERABILITY',
        sourceSystem: 'adericel-self',
        subjectExternalId: config.componentName,
        observedAt: context.nowIso,
        payload: {
          assetExternalId: config.componentName,
          openCount: snapshot.dependencyAdvisories,
          criticalOverdue: snapshot.dependencyAdvisories > 0,
          highOrCriticalOverdue14d: snapshot.dependencyAdvisories > 0,
        },
      });

      // Adericel's own administrators are identities in its assurance graph, so
      // the same MFA control that applies to a customer applies to us.
      observations.push({
        kind: 'IDENTITY_STATE',
        sourceSystem: 'adericel-self',
        subjectExternalId: `${config.componentName}:platform-admins`,
        observedAt: context.nowIso,
        payload: {
          externalId: `${config.componentName}:platform-admins`,
          displayName: 'Adericel platform administrators',
          enabled: true,
          accountType: 'USER',
          privileged: true,
          adminAccountSeparate: true,
          mfaEnforced:
            snapshot.adminAccountCount > 0 &&
            snapshot.adminAccountsWithMfa === snapshot.adminAccountCount,
          lastSignInAt: context.nowIso,
        },
      });

      if (!snapshot.databaseReachable) warnings.push('Database probe reported unreachable.');
      if (!snapshot.objectStorageReachable)
        warnings.push('Object storage probe reported unreachable.');
      if (snapshot.outboxDeadLetterCount > 0) {
        warnings.push(`${snapshot.outboxDeadLetterCount} event(s) in the dead-letter queue.`);
      }
      if (snapshot.failedIntegrations > 0) {
        warnings.push(`${snapshot.failedIntegrations} integration(s) are in a failed state.`);
      }
      if (!snapshot.tlsEnforced) warnings.push('TLS enforcement is not confirmed.');
      if (!snapshot.secretsExternallyManaged) {
        warnings.push('Secrets are not managed by an external secret manager.');
      }

      // Unreachable dependencies mean the self-assurance picture is incomplete.
      return {
        observations,
        warnings,
        partial: !snapshot.databaseReachable || !snapshot.objectStorageReachable,
        cursor: null,
      };
    },
  };
}

export const adericelSelfManifest: ConnectorManifest = connectorManifestSchema.parse({
  id: 'adericel.self',
  version: '1.0.0',
  vendor: 'Adericel',
  products: ['Adericel'],
  category: 'MANUAL',
  authentication: ['NONE'],
  collect: [
    {
      key: 'collect.platform_state',
      title: "Adericel's own operational state",
      domain: 'DOCUMENTATION',
      produces: ['CONFIGURATION_SETTING'],
      predicates: ['organisation.logging.enabled', 'organisation.logging.retention_days'],
      requiredPermission: '',
      incremental: false,
    },
  ],
  execute: [],
  verify: [],
  pagination: false,
  incrementalCollection: false,
  fidelity: 'LIVE',
});
