import { z } from 'zod';
import type { ObservationInput } from '@adericel/domain';
import type {
  ConnectionCheck,
  Connector,
  ConnectorContext,
  CollectionResult,
} from '../connector.js';
import { createHttpClient, type EgressPolicy } from '../http.js';

/**
 * Microsoft Intune connector.
 *
 * Collects endpoint posture from Graph device management. Intune reports
 * encryption, compliance and patch state per device, which maps directly onto
 * Adericel's device predicates.
 *
 * This connector is deliberately read-only. Intune remediations are performed
 * through configuration profiles, which are tenant-wide objects: a change
 * Adericel made to one would affect devices far beyond the finding that
 * prompted it. Endpoint remediation is therefore proposed and left to the MSP's
 * own change process, and the model records that honestly rather than
 * pretending to an autonomy the integration does not safely support.
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
    capabilities: [],

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
