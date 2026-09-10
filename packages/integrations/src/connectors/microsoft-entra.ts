import { z } from 'zod';
import type { ObservationInput } from '@adericel/domain';
import type {
  ConnectionCheck,
  Connector,
  ConnectorContext,
  CollectionResult,
  ExecutionResult,
} from '../connector.js';
import { createHttpClient, type EgressPolicy } from '../http.js';
import {
  capabilityReport,
  connectorManifestSchema,
  reportFromError,
  type CapabilityReport,
  type ConnectorManifest,
} from '../manifest.js';

/**
 * Microsoft Entra ID (Azure AD) connector.
 *
 * Collects identity posture from Microsoft Graph and exposes two executable
 * remediations. Both are chosen because they are reversible, verifiable through
 * a subsequent read, and are things an MSP already does by hand:
 *
 *  - `identity.mfa.require` adds the identity to the security group that the
 *    tenant's Conditional Access policy targets. Adericel does not author
 *    Conditional Access policies; it operates the group the customer already
 *    uses, which keeps the change inside the customer's own design.
 *  - `identity.account.disable` sets accountEnabled to false.
 *
 * Graph reports MFA registration state via the reporting API, which requires
 * additional permission. When that permission is absent the connector reports a
 * missing scope and omits the claim entirely — leading to UNKNOWN rather than a
 * guess.
 */

const configSchema = z.object({
  tenantId: z.string().min(1),
  /** Object id of the security group targeted by the tenant's MFA Conditional Access policy. */
  mfaEnforcementGroupId: z.string().min(1).nullable().default(null),
  graphBaseUrl: z.string().url().default('https://graph.microsoft.com/v1.0'),
  loginBaseUrl: z.string().url().default('https://login.microsoftonline.com'),
  /** Skip identities matching these UPN patterns, e.g. break-glass accounts. */
  excludeUserPrincipalNames: z.array(z.string()).default([]),
  pageSize: z.number().int().min(1).max(999).default(200),
});

const credentialSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof credentialSchema>;

interface GraphUser {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  accountEnabled: boolean | null;
  signInActivity?: { lastSignInDateTime?: string | null } | null;
  userType?: string | null;
}

interface GraphRegistrationDetail {
  id: string;
  isMfaRegistered?: boolean | null;
  isMfaCapable?: boolean | null;
  methodsRegistered?: string[] | null;
  isAdmin?: boolean | null;
}

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export interface EntraConnectorDeps {
  readonly egressPolicy: EgressPolicy;
  readonly fetchImpl?: typeof fetch;
}

export function createMicrosoftEntraConnector(
  deps: EntraConnectorDeps,
): Connector<Config, Credentials> {
  function http(context: ConnectorContext) {
    return createHttpClient({
      policy: deps.egressPolicy,
      logger: context.logger,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      userAgent: 'Adericel-Entra/1.0',
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
        `Entra token request failed: ${response.error_description ?? 'no token returned'}`,
      );
    }
    return response.access_token;
  }

  async function pageThrough<T>(
    context: ConnectorContext,
    accessToken: string,
    firstUrl: string,
    maxPages = 50,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const client = http(context);
    const items: T[] = [];
    let url: string | undefined = firstUrl;
    let pages = 0;
    while (url && pages < maxPages) {
      const page: GraphPage<T> = await client.json<GraphPage<T>>({
        url,
        headers: { authorization: `Bearer ${accessToken}` },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      items.push(...(page.value ?? []));
      url = page['@odata.nextLink'];
      pages += 1;
    }
    return { items, truncated: Boolean(url) };
  }

  return {
    key: 'microsoft-entra',
    name: 'Microsoft Entra ID',
    vendor: 'Microsoft',
    category: 'IDENTITY',
    description:
      'Collects identity posture (account state, MFA registration, privilege, sign-in recency) from ' +
      'Microsoft Graph, and can enforce MFA or disable an account.',
    authKind: 'OAUTH2_CLIENT_CREDENTIALS',
    configSchema,
    credentialSchema,
    requiredPermissions: [
      'User.Read.All (application) — read user accounts and sign-in activity',
      'AuditLog.Read.All (application) — read MFA registration details',
      'Directory.Read.All (application) — read directory roles',
      'GroupMember.ReadWrite.All (application) — only if MFA enforcement actions are used',
      'User.ReadWrite.All (application) — only if account disable actions are used',
    ],
    defaultSchedule: '0 */6 * * *',
    manifest: microsoftEntraManifest,

    capabilities: [
      {
        actionType: 'identity.mfa.require',
        title: 'Add the identity to the MFA enforcement group',
        description:
          'Adds the user to the security group targeted by the tenant Conditional Access policy that ' +
          'requires multi-factor authentication.',
        riskClass: 'CONFIGURATION',
        parameterSchema: z.object({ enforcement: z.literal('REQUIRED').default('REQUIRED') }),
        verification: {
          method: 'graph.group.member.read',
          description: 'Re-read the enforcement group membership and confirm the user is present.',
          predicate: 'identity.mfa.enforced',
          expectedValue: true,
        },
      },
      {
        actionType: 'identity.account.disable',
        title: 'Disable the account',
        description:
          'Sets accountEnabled to false, preventing sign-in while preserving the account.',
        riskClass: 'DISRUPTIVE',
        parameterSchema: z.object({ reason: z.string().min(1).max(500) }),
        verification: {
          method: 'graph.user.read',
          description: 'Re-read the user and confirm accountEnabled is false.',
          predicate: 'identity.account.enabled',
          expectedValue: false,
        },
      },
    ],

    async checkConnection(config, credentials, context): Promise<ConnectionCheck> {
      try {
        const accessToken = await token(config, credentials, context);
        const client = http(context);
        await client.json({
          url: `${config.graphBaseUrl}/users`,
          query: { $top: '1', $select: 'id' },
          headers: { authorization: `Bearer ${accessToken}` },
        });

        const missing: string[] = [];
        try {
          await client.json({
            url: `${config.graphBaseUrl}/reports/authenticationMethods/userRegistrationDetails`,
            query: { $top: '1' },
            headers: { authorization: `Bearer ${accessToken}` },
          });
        } catch {
          missing.push('AuditLog.Read.All');
        }

        return {
          connected: true,
          detail:
            missing.length === 0
              ? 'Connected to Microsoft Graph with the permissions Adericel needs.'
              : `Connected, but MFA registration state is unavailable without: ${missing.join(', ')}. ` +
                'MFA controls will report UNKNOWN until this is granted.',
          grantedScopes: ['User.Read.All'],
          missingScopes: missing,
        };
      } catch (error) {
        return { connected: false, detail: (error as Error).message };
      }
    },

    async collect(config, credentials, context): Promise<CollectionResult> {
      const accessToken = await token(config, credentials, context);
      const warnings: string[] = [];
      // Per-capability, not one flag for the whole run. "The integration is
      // degraded" is not actionable; "MFA registration returned
      // PERMISSION_DENIED, grant AuditLog.Read.All" is.
      const capabilityReports: CapabilityReport[] = [];

      const usersUrl = new URL(`${config.graphBaseUrl}/users`);
      usersUrl.searchParams.set(
        '$select',
        'id,displayName,userPrincipalName,accountEnabled,signInActivity,userType',
      );
      usersUrl.searchParams.set('$top', String(config.pageSize));

      const { items: users, truncated } = await pageThrough<GraphUser>(
        context,
        accessToken,
        usersUrl.toString(),
      );
      if (truncated) {
        warnings.push(
          'User collection stopped at the page limit; some identities were not collected.',
        );
      }

      // MFA registration state lives behind a separate permission. If it is not
      // granted we omit the predicate rather than guessing, so the control
      // reports UNKNOWN and the gap is visible.
      let registrationById = new Map<string, GraphRegistrationDetail>();
      let mfaAvailable = true;
      try {
        const { items } = await pageThrough<GraphRegistrationDetail>(
          context,
          accessToken,
          `${config.graphBaseUrl}/reports/authenticationMethods/userRegistrationDetails`,
        );
        registrationById = new Map(items.map((item) => [item.id, item]));
        capabilityReports.push(
          capabilityReport(microsoftEntraManifest, 'collect.mfa', 'AVAILABLE', 'MFA registration state collected.', {
            records: registrationById.size,
          }),
        );
      } catch (error) {
        mfaAvailable = false;
        capabilityReports.push(reportFromError(microsoftEntraManifest, 'collect.mfa', error));
        warnings.push(
          `MFA registration state unavailable (${(error as Error).message}). ` +
            'MFA controls will report UNKNOWN until AuditLog.Read.All is granted.',
        );
      }

      const privilegedIds = new Set<string>();
      try {
        const { items: roles } = await pageThrough<{ id: string; displayName: string }>(
          context,
          accessToken,
          `${config.graphBaseUrl}/directoryRoles`,
        );
        for (const role of roles) {
          const { items: members } = await pageThrough<{ id: string }>(
            context,
            accessToken,
            `${config.graphBaseUrl}/directoryRoles/${role.id}/members`,
            5,
          );
          for (const member of members) privilegedIds.add(member.id);
        }
        capabilityReports.push(
          capabilityReport(
            microsoftEntraManifest,
            'collect.privileged_roles',
            'AVAILABLE',
            `Directory role membership collected across ${roles.length} role(s).`,
            { records: privilegedIds.size },
          ),
        );
      } catch (error) {
        capabilityReports.push(
          reportFromError(microsoftEntraManifest, 'collect.privileged_roles', error),
        );
        warnings.push(`Directory role membership unavailable (${(error as Error).message}).`);
      }

      const excluded = new Set(config.excludeUserPrincipalNames.map((u) => u.toLowerCase()));
      const observations: ObservationInput[] = [];

      for (const user of users) {
        const upn = user.userPrincipalName?.toLowerCase() ?? '';
        if (upn && excluded.has(upn)) continue;

        const registration = registrationById.get(user.id);
        observations.push({
          kind: 'IDENTITY_STATE',
          sourceSystem: 'microsoft-entra',
          subjectExternalId: user.id,
          observedAt: context.nowIso,
          payload: {
            externalId: user.id,
            displayName: user.displayName,
            userPrincipalName: user.userPrincipalName,
            enabled: user.accountEnabled,
            accountType: user.userType === 'Guest' ? 'GUEST' : 'USER',
            privileged: privilegedIds.has(user.id),
            lastSignInAt: user.signInActivity?.lastSignInDateTime ?? null,
            ...(mfaAvailable
              ? {
                  mfaEnforced: registration?.isMfaRegistered ?? false,
                  mfaMethods: registration?.methodsRegistered ?? [],
                }
              : {}),
          },
        });
      }

      observations.push({
        kind: 'CONFIGURATION_SETTING',
        sourceSystem: 'microsoft-entra',
        subjectExternalId: null,
        observedAt: context.nowIso,
        payload: { adminCount: privilegedIds.size },
      });

      capabilityReports.push(
        capabilityReport(
          microsoftEntraManifest,
          'collect.identities',
          // Truncation is a hole the connector can see, so it is PARTIAL rather
          // than AVAILABLE. Zero users is EMPTY: a real, informative answer.
          truncated ? 'PARTIAL' : users.length === 0 ? 'EMPTY' : 'AVAILABLE',
          truncated
            ? 'User collection stopped at the page limit; some identities were not collected.'
            : users.length === 0
              ? 'The directory returned no users.'
              : `Collected ${users.length} user account(s).`,
          { records: users.length, observations: observations.length },
        ),
      );

      // Truncated pages or an unavailable permission mean the picture has holes
      // the connector can see, so the run is explicitly partial.
      return {
        observations,
        warnings,
        partial: truncated || !mfaAvailable,
        capabilityReports,
        cursor: null,
      };
    },

    async execute(config, credentials, request, context): Promise<ExecutionResult> {
      const accessToken = await token(config, credentials, context);
      const client = http(context);

      if (!request.targetExternalId) {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: 'No target identity was supplied',
          errorCode: 'MISSING_TARGET',
          retryable: false,
        };
      }

      try {
        switch (request.actionType) {
          case 'identity.mfa.require': {
            if (!config.mfaEnforcementGroupId) {
              return {
                status: 'FAILED',
                externalOperationRef: null,
                detail:
                  'No MFA enforcement group is configured for this integration. Set mfaEnforcementGroupId ' +
                  'to the security group your Conditional Access policy targets.',
                errorCode: 'NOT_CONFIGURED',
                retryable: false,
              };
            }
            const response = await client.request({
              method: 'POST',
              url: `${config.graphBaseUrl}/groups/${config.mfaEnforcementGroupId}/members/$ref`,
              headers: {
                authorization: `Bearer ${accessToken}`,
                'client-request-id': request.idempotencyKey,
              },
              body: {
                '@odata.id': `${config.graphBaseUrl}/directoryObjects/${request.targetExternalId}`,
              },
            });
            return {
              status: 'SUCCEEDED',
              externalOperationRef: response.headers['request-id'] ?? request.idempotencyKey,
              detail: 'Identity added to the MFA enforcement group.',
            };
          }

          case 'identity.account.disable': {
            const response = await client.request({
              method: 'PATCH',
              url: `${config.graphBaseUrl}/users/${request.targetExternalId}`,
              headers: {
                authorization: `Bearer ${accessToken}`,
                'client-request-id': request.idempotencyKey,
              },
              body: { accountEnabled: false },
            });
            return {
              status: 'SUCCEEDED',
              externalOperationRef: response.headers['request-id'] ?? request.idempotencyKey,
              detail: 'Account disabled.',
            };
          }

          default:
            return {
              status: 'FAILED',
              externalOperationRef: null,
              detail: `Unsupported action type ${request.actionType}`,
              errorCode: 'UNSUPPORTED_ACTION',
              retryable: false,
            };
        }
      } catch (error) {
        const message = (error as Error).message;
        // Graph returns 409 when the member already exists. That is the desired
        // end state, so the action is idempotent rather than failed.
        if (message.includes('409')) {
          return {
            status: 'SUCCEEDED',
            externalOperationRef: request.idempotencyKey,
            detail: 'Target was already in the desired state.',
          };
        }
        const retryable = /\b(429|5\d\d)\b/.test(message);
        return {
          status: retryable ? 'UNKNOWN_OUTCOME' : 'FAILED',
          externalOperationRef: null,
          detail: message,
          errorCode: 'GRAPH_ERROR',
          retryable,
        };
      }
    },
  };
}

/**
 * Manifest.
 *
 * Declares the canonical predicates this connector supplies — never what they
 * prove. Entra saying "MFA is enforced" is an observation; whether that
 * satisfies a Cyber Essentials control is the ruleset's business, and no
 * connector may encode it.
 */
export const microsoftEntraManifest: ConnectorManifest = connectorManifestSchema.parse({
  id: 'microsoft-entra',
  version: '1.0.0',
  vendor: 'Microsoft',
  products: ['Entra ID'],
  category: 'IDENTITY',
  authentication: ['OAUTH2_CLIENT_CREDENTIALS'],
  collect: [
    {
      key: 'collect.identities',
      title: 'User accounts and their sign-in state',
      domain: 'IDENTITY',
      produces: ['IDENTITY_STATE'],
      predicates: [
        'identity.account.enabled',
        'identity.account.type',
        'identity.last_sign_in_at',
      ],
      requiredPermission: 'User.Read.All',
      incremental: false,
    },
    {
      key: 'collect.mfa',
      title: 'Multi-factor authentication registration and enforcement',
      domain: 'IDENTITY',
      produces: ['IDENTITY_STATE'],
      predicates: ['identity.mfa.enforced', 'identity.mfa.methods'],
      requiredPermission: 'UserAuthenticationMethod.Read.All',
      incremental: false,
    },
    {
      key: 'collect.privileged_roles',
      title: 'Directory role assignments',
      domain: 'IDENTITY',
      produces: ['IDENTITY_STATE', 'CONFIGURATION_SETTING'],
      predicates: ['identity.privileged', 'organisation.identity.admin_count'],
      // `identity.admin_account_separate` is deliberately absent. Whether an
      // administrator holds a separate day-to-day account is not something
      // Graph states; inferring it from a naming convention would be a guess
      // dressed as an observation. Nothing supplies it, so the Cyber Essentials
      // control that needs it reads UNKNOWN and names the missing evidence —
      // which is the truth, and is actionable.
      requiredPermission: 'RoleManagement.Read.Directory',
      incremental: false,
    },
  ],
  execute: ['identity.mfa.require', 'identity.account.disable'],
  verify: ['identity.mfa.enforced', 'identity.account.enabled'],
  pagination: true,
  incrementalCollection: false,
  fidelity: 'LIVE',
});
