import { z } from 'zod';
import type { ObservationInput } from '@adericel/domain';
import type {
  ConnectionCheck,
  Connector,
  ConnectorContext,
  CollectionResult,
} from '../connector.js';
import { createHttpClient, type EgressPolicy } from '../http.js';
import { connectorManifestSchema, type ConnectorManifest } from '../manifest.js';

/**
 * Microsoft Intune connector.
 *
 * Collects endpoint posture from Graph device management. Intune reports
 * encryption, compliance and patch state per device, which maps directly onto
 * Adericel's device predicates.
 *
 * It offers no remediation for posture. Intune changes endpoint settings through
 * configuration profiles, which are tenant-wide objects: a change Adericel made
 * to one would affect devices far beyond the finding that prompted it. Endpoint
 * remediation is therefore left to the MSP's own change process, and the model
 * records that honestly rather than pretending to an autonomy the integration
 * does not safely support. The rulesets agree — no rule proposes an action that
 * nothing here can perform, and a test asserts it.
 *
 * It does offer one action, and it is worth explaining why it belongs.
 * `device.management.sync` forces a single device to check in. It changes no
 * setting; it refreshes what Intune knows about one device. That matters
 * because the most common reason a device control reports UNKNOWN is not a
 * missing control, it is a device that has not synced for a fortnight — and
 * "we cannot see this device" is a finding with a remedy, not a dead end.
 */

const configSchema = z.object({
  tenantId: z.string().min(1),
  graphBaseUrl: z.string().url().default('https://graph.microsoft.com/v1.0'),
  loginBaseUrl: z.string().url().default('https://login.microsoftonline.com'),
  /** Operating system builds still supported, used for device.os.supported. */
  supportedOsVersions: z.record(z.string(), z.string()).default({}),
  /** Days after which a device is considered to have missed the patch cadence. */
  patchCadenceDays: z.number().int().min(1).default(30),
  pageSize: z.number().int().min(1).max(999).default(200),
});

const credentialSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof credentialSchema>;

interface ManagedDevice {
  id: string;
  deviceName: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  complianceState: string | null;
  isEncrypted: boolean | null;
  managedDeviceOwnerType: string | null;
  lastSyncDateTime: string | null;
  userPrincipalName: string | null;
  managementAgent: string | null;
}

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

/** Compare dotted version strings numerically, e.g. "10.0.19045.4046". */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const b = minimum.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

export function createMicrosoftIntuneConnector(deps: {
  egressPolicy: EgressPolicy;
  fetchImpl?: typeof fetch;
}): Connector<Config, Credentials> {
  function http(context: ConnectorContext) {
    return createHttpClient({
      policy: deps.egressPolicy,
      logger: context.logger,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      userAgent: 'Adericel-Intune/1.0',
    });
  }

  async function token(
    config: Config,
    credentials: Credentials,
    context: ConnectorContext,
  ): Promise<string> {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const response = await http(context).json<{
      access_token?: string;
      error_description?: string;
    }>({
      method: 'POST',
      url: `${config.loginBaseUrl}/${config.tenantId}/oauth2/v2.0/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.access_token) {
      throw new Error(
        `Intune token request failed: ${response.error_description ?? 'no token returned'}`,
      );
    }
    return response.access_token;
  }

  return {
    key: 'microsoft-intune',
    name: 'Microsoft Intune',
    vendor: 'Microsoft',
    category: 'ENDPOINT',
    description:
      'Collects managed device posture — encryption, compliance, operating system currency and sync ' +
      'recency — from Microsoft Intune via Graph.',
    authKind: 'OAUTH2_CLIENT_CREDENTIALS',
    configSchema,
    credentialSchema,
    requiredPermissions: [
      'DeviceManagementManagedDevices.Read.All (application) — read managed device inventory and state',
      'DeviceManagementConfiguration.Read.All (application) — read configuration profile assignment',
    ],
    defaultSchedule: '0 */4 * * *',
    manifest: microsoftIntuneManifest,

    capabilities: [
      {
        actionType: 'device.management.sync',
        title: 'Ask the device to check in',
        description:
          'Requests an immediate Intune check-in for one device. Changes no setting on the device: ' +
          'it refreshes what Intune knows, which is what resolves a device reporting UNKNOWN ' +
          'because its posture data is stale.',
        riskClass: 'READ_ONLY',
        parameterSchema: z.object({}),
        verification: {
          method: 'intune.managedDevice.read',
          description:
            'Re-read the device and confirm it has synced since the request. A device that is ' +
            'switched off will not, and the action reports UNVERIFIED rather than success.',
          predicate: 'device.sync.recent',
          expectedValue: true,
        },
      },
    ],

    async checkConnection(config, credentials, context): Promise<ConnectionCheck> {
      try {
        const accessToken = await token(config, credentials, context);
        await http(context).json({
          url: `${config.graphBaseUrl}/deviceManagement/managedDevices`,
          query: { $top: '1' },
          headers: { authorization: `Bearer ${accessToken}` },
        });
        return { connected: true, detail: 'Connected to Intune device management.' };
      } catch (error) {
        return { connected: false, detail: (error as Error).message };
      }
    },

    async execute(config, credentials, request, context) {
      if (request.actionType !== 'device.management.sync') {
        return {
          status: 'FAILED' as const,
          externalOperationRef: null,
          detail: `The Intune connector does not perform ${request.actionType}`,
          errorCode: 'UNSUPPORTED_ACTION',
          retryable: false,
        };
      }
      if (!request.targetExternalId) {
        return {
          status: 'FAILED' as const,
          externalOperationRef: null,
          detail: 'No target device was supplied',
          errorCode: 'MISSING_TARGET',
          retryable: false,
        };
      }

      try {
        const accessToken = await token(config, credentials, context);
        const response = await http(context).request({
          method: 'POST',
          url: `${config.graphBaseUrl}/deviceManagement/managedDevices/${request.targetExternalId}/syncDevice`,
          headers: {
            authorization: `Bearer ${accessToken}`,
            'client-request-id': request.idempotencyKey,
          },
        });
        return {
          // Graph accepting the request means the request was queued, not that
          // the device has checked in. Verification re-reads the sync time; a
          // device that is switched off never confirms, and that is the correct
          // outcome rather than a failure.
          status: 'SUCCEEDED' as const,
          externalOperationRef: response.headers['request-id'] ?? request.idempotencyKey,
          detail: 'Check-in requested. The device confirms it by syncing.',
        };
      } catch (error) {
        return {
          status: 'FAILED' as const,
          externalOperationRef: null,
          detail: (error as Error).message,
          errorCode: 'GRAPH_ERROR',
          retryable: true,
        };
      }
    },

    async collect(config, credentials, context): Promise<CollectionResult> {
      const accessToken = await token(config, credentials, context);
      const client = http(context);
      const warnings: string[] = [];
      const observations: ObservationInput[] = [];

      let url: string | undefined =
        `${config.graphBaseUrl}/deviceManagement/managedDevices?$top=${config.pageSize}`;
      let pages = 0;

      while (url && pages < 50) {
        const page: GraphPage<ManagedDevice> = await client.json<GraphPage<ManagedDevice>>({
          url,
          headers: { authorization: `Bearer ${accessToken}` },
          ...(context.signal ? { signal: context.signal } : {}),
        });

        for (const device of page.value ?? []) {
          const os = device.operatingSystem ?? '';
          const minimum = config.supportedOsVersions[os];
          // When no minimum is configured for this operating system we simply do
          // not assert support status. Guessing would turn an operational gap
          // into a false negative.
          const osSupported =
            minimum && device.osVersion ? versionAtLeast(device.osVersion, minimum) : undefined;

          observations.push({
            kind: 'DEVICE_STATE',
            sourceSystem: 'microsoft-intune',
            subjectExternalId: device.id,
            observedAt: device.lastSyncDateTime ?? context.nowIso,
            payload: {
              externalId: device.id,
              name: device.deviceName,
              operatingSystem: device.operatingSystem,
              osVersion: device.osVersion,
              owner: device.userPrincipalName,
              managed: true,
              diskEncrypted: device.isEncrypted,
              ...(osSupported === undefined ? {} : { osSupported }),
              // Intune's compliance state is a tenant-defined rollup. It is
              // recorded as an attribute for context but is not mapped to a
              // control predicate: what "compliant" means differs per tenant.
              complianceState: device.complianceState,
              lastSyncAt: device.lastSyncDateTime,
            },
          });
        }

        url = page['@odata.nextLink'];
        pages += 1;
      }

      const truncated = pages >= 50;
      if (truncated) warnings.push('Device collection stopped at the page limit.');
      if (observations.length === 0) {
        warnings.push('No managed devices were returned. Endpoint controls will report UNKNOWN.');
      }

      return { observations, warnings, partial: truncated, cursor: null };
    },
  };
}

export const microsoftIntuneManifest: ConnectorManifest = connectorManifestSchema.parse({
  id: 'microsoft.intune',
  version: '1.0.0',
  vendor: 'Microsoft',
  products: ['Intune', 'Endpoint Manager'],
  category: 'ENDPOINT',
  authentication: ['OAUTH2_CLIENT_CREDENTIALS'],
  collect: [
    {
      key: 'collect.devices',
      title: 'Managed device inventory',
      domain: 'ENDPOINT',
      produces: ['DEVICE_STATE'],
      predicates: ['device.managed', 'device.os.version', 'device.os.supported'],
      requiredPermission: 'DeviceManagementManagedDevices.Read.All',
      incremental: false,
    },
    {
      key: 'collect.device_compliance',
      title: 'Device compliance, encryption and firewall state',
      domain: 'ENDPOINT',
      produces: ['DEVICE_STATE'],
      predicates: [
        'device.disk.encrypted',
        'device.firewall.enabled',
        'device.endpoint_protection.installed',
        'device.endpoint_protection.realtime_enabled',
      ],
      requiredPermission: 'DeviceManagementConfiguration.Read.All',
      incremental: false,
    },
    {
      key: 'collect.patch_state',
      title: 'Operating system patch currency',
      domain: 'ENDPOINT',
      produces: ['PATCH_STATE'],
      predicates: ['device.patch.last_applied_at'],
      requiredPermission: 'DeviceManagementManagedDevices.Read.All',
      incremental: false,
    },
  ],
  execute: [],
  verify: [],
  pagination: true,
  incrementalCollection: false,
  fidelity: 'LIVE',
});
