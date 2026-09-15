import { createSign } from 'node:crypto';
import { z } from 'zod';
import type { ObservationInput } from '@adericel/domain';
import type {
  CollectionResult,
  ConnectionCheck,
  Connector,
  ConnectorContext,
  ExecutionResult,
} from '../connector.js';
import { createHttpClient, type EgressPolicy } from '../http.js';
import { connectorManifestSchema, type ConnectorManifest } from '../manifest.js';

/**
 * Google Workspace connector.
 *
 * The second identity provider, and the reason the connector contract exists.
 * Nothing in the Truth Engine, the rulesets, the API or the interface learns
 * that Google is different from Microsoft: this file turns the Directory API's
 * shape into the same canonical observations, and everything above it is
 * unchanged (ADR-0013).
 *
 * Authentication is a domain-wide delegated service account. Google does not
 * offer a client-credentials grant for Directory data — a service account has
 * to impersonate an administrator, which means signing a JWT assertion with the
 * service account's private key and exchanging it for an access token. That is
 * implemented here rather than pulled in, for the same reason the JWT verifier
 * in the API is: it is thirty lines, and it is the part where a mistake means
 * either no access or too much of it.
 *
 * What is deliberately not done: Google reports whether a user is enrolled in
 * two-step verification (`isEnrolledIn2Sv`) and whether it is enforced
 * (`isEnforcedIn2Sv`). Those are different facts. Enrolment is a property of
 * the user; enforcement is a property of the policy applied to them, and only
 * the second one is what a control about enforced MFA is asking. Reporting
 * enrolment as enforcement would make an organisation look compliant because
 * its users happen to have opted in, which is exactly the kind of quiet
 * substitution this product exists to refuse.
 */

const configSchema = z.object({
  /** The Workspace domain, e.g. "example.co.uk". */
  domain: z.string().min(1),
  /**
   * The administrator the service account impersonates. Domain-wide delegation
   * grants access as this person, so it should be a dedicated, minimally
   * privileged account rather than a founder's mailbox.
   */
  impersonateSubject: z.string().email(),
  directoryBaseUrl: z.string().url().default('https://admin.googleapis.com/admin/directory/v1'),
  tokenUrl: z.string().url().default('https://oauth2.googleapis.com/token'),
  /** Accounts excluded from assessment — break-glass, service identities. */
  excludeEmails: z.array(z.string()).default([]),
  pageSize: z.number().int().min(1).max(500).default(200),
});

const credentialSchema = z.object({
  clientEmail: z.string().email(),
  /** PEM private key from the service account key file. */
  privateKey: z.string().min(1),
});

type Config = z.infer<typeof configSchema>;
type Credentials = z.infer<typeof credentialSchema>;

interface DirectoryUser {
  id: string;
  primaryEmail: string;
  name?: { fullName?: string };
  suspended?: boolean;
  archived?: boolean;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  isEnrolledIn2Sv?: boolean;
  isEnforcedIn2Sv?: boolean;
  lastLoginTime?: string;
  creationTime?: string;
}

interface DirectoryPage {
  users?: DirectoryUser[];
  nextPageToken?: string;
}

const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.user',
];

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build and sign the assertion Google exchanges for an access token.
 *
 * RS256 over `{header}.{claims}`. The `sub` claim is what makes this domain-wide
 * delegation rather than a plain service account: the token acts as that
 * administrator.
 */
export function buildServiceAccountAssertion(options: {
  clientEmail: string;
  privateKey: string;
  subject: string;
  tokenUrl: string;
  scopes: readonly string[];
  nowEpochSeconds: number;
  /** Google rejects assertions valid for more than an hour. */
  lifetimeSeconds?: number;
}): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: options.clientEmail,
      sub: options.subject,
      scope: options.scopes.join(' '),
      aud: options.tokenUrl,
      iat: options.nowEpochSeconds,
      exp: options.nowEpochSeconds + (options.lifetimeSeconds ?? 3600),
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(options.privateKey.replace(/\\n/g, '\n'), 'base64url');
  return `${signingInput}.${signature}`;
}

export function createGoogleWorkspaceConnector(deps: {
  egressPolicy: EgressPolicy;
  fetchImpl?: typeof fetch;
}): Connector<Config, Credentials> {
  function http(context: ConnectorContext) {
    return createHttpClient({
      policy: deps.egressPolicy,
      logger: context.logger,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      userAgent: 'Adericel-GoogleWorkspace/1.0',
    });
  }

  async function token(
    config: Config,
    credentials: Credentials,
    context: ConnectorContext,
  ): Promise<string> {
    const assertion = buildServiceAccountAssertion({
      clientEmail: credentials.clientEmail,
      privateKey: credentials.privateKey,
      subject: config.impersonateSubject,
      tokenUrl: config.tokenUrl,
      scopes: SCOPES,
      nowEpochSeconds: Math.floor(Date.parse(context.nowIso) / 1000),
    });

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await http(context).json<{
      access_token?: string;
      error?: string;
      error_description?: string;
    }>({
      method: 'POST',
      url: config.tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.access_token) {
      // The two failures here mean very different things to whoever is
      // configuring this, so they are distinguished rather than collapsed.
      const reason =
        response.error === 'unauthorized_client'
          ? 'the service account is not authorised for domain-wide delegation with these scopes'
          : (response.error_description ?? response.error ?? 'no token returned');
      throw new Error(`Google token request failed: ${reason}`);
    }
    return response.access_token;
  }

  async function pageThrough(
    config: Config,
    accessToken: string,
    context: ConnectorContext,
    maxPages = 20,
  ): Promise<{ users: DirectoryUser[]; truncated: boolean }> {
    const client = http(context);
    const users: DirectoryUser[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const page = await client.json<DirectoryPage>({
        url: `${config.directoryBaseUrl}/users`,
        query: {
          domain: config.domain,
          maxResults: config.pageSize,
          projection: 'full',
          ...(pageToken ? { pageToken } : {}),
        },
        headers: { authorization: `Bearer ${accessToken}` },
      });
      users.push(...(page.users ?? []));
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken && pages < maxPages);

    return { users, truncated: Boolean(pageToken) };
  }

  return {
    key: 'google-workspace',
    name: 'Google Workspace',
    vendor: 'Google',
    category: 'IDENTITY',
    description:
      'Collects identity posture — account state, administrative privilege, enforced two-step ' +
      'verification and sign-in recency — from the Google Workspace Directory API.',
    authKind: 'OAUTH2_CLIENT_CREDENTIALS',
    configSchema,
    credentialSchema,
    requiredPermissions: [
      'admin.directory.user.readonly — read the user directory and two-step verification state',
      'admin.directory.user — only if account suspension actions are used',
      'Domain-wide delegation, authorised in the Admin console for the service account client id',
    ],
    defaultSchedule: '0 */6 * * *',
    manifest: googleWorkspaceManifest,

    capabilities: [
      {
        actionType: 'identity.account.disable',
        title: 'Suspend the account',
        description:
          'Suspends the user, preventing sign-in while preserving the account and its data. ' +
          'Suspension is reversible; deletion is not, and Adericel does not offer deletion.',
        riskClass: 'DISRUPTIVE',
        parameterSchema: z.object({ reason: z.string().min(1).max(500) }),
        verification: {
          method: 'directory.user.read',
          description: 'Re-read the user and confirm suspended is true.',
          predicate: 'identity.account.enabled',
          expectedValue: false,
        },
      },
    ],

    async checkConnection(config, credentials, context): Promise<ConnectionCheck> {
      try {
        const accessToken = await token(config, credentials, context);
        await http(context).json({
          url: `${config.directoryBaseUrl}/users`,
          query: { domain: config.domain, maxResults: 1 },
          headers: { authorization: `Bearer ${accessToken}` },
        });
        return {
          connected: true,
          detail: `Connected to Google Workspace for ${config.domain} as ${config.impersonateSubject}.`,
          grantedScopes: [SCOPES[0]!],
          missingScopes: [],
        };
      } catch (error) {
        return { connected: false, detail: (error as Error).message };
      }
    },

    async collect(config, credentials, context): Promise<CollectionResult> {
      const accessToken = await token(config, credentials, context);
      const warnings: string[] = [];

      const { users, truncated } = await pageThrough(config, accessToken, context);
      if (truncated) {
        warnings.push(
          'User collection stopped at the page limit; some identities were not collected.',
        );
      }

      const excluded = new Set(config.excludeEmails.map((email) => email.toLowerCase()));
      const observations: ObservationInput[] = [];
      let adminCount = 0;

      for (const user of users) {
        if (excluded.has(user.primaryEmail.toLowerCase())) continue;

        const privileged = Boolean(user.isAdmin || user.isDelegatedAdmin);
        if (privileged) adminCount += 1;

        observations.push({
          kind: 'IDENTITY_STATE',
          sourceSystem: 'google-workspace',
          subjectExternalId: user.id,
          observedAt: context.nowIso,
          payload: {
            externalId: user.id,
            displayName: user.name?.fullName ?? user.primaryEmail,
            userPrincipalName: user.primaryEmail,
            // Archived accounts cannot sign in, so they are not enabled even
            // though Google reports suspension separately.
            enabled: !(user.suspended ?? false) && !(user.archived ?? false),
            accountType: 'USER',
            privileged,
            // Enforced, not enrolled. A user who has switched two-step
            // verification on for themselves has not made it a control, and
            // reporting the two as one is how an organisation comes to believe
            // it has enforcement it does not have.
            mfaEnforced: user.isEnforcedIn2Sv ?? false,
            mfaMethods: user.isEnrolledIn2Sv ? ['GOOGLE_2SV'] : [],
            lastSignInAt:
              // Google returns the epoch for accounts that have never signed
              // in. Passing that through would make a dormant-account rule read
              // it as a sign-in in 1970 — technically true, and useless. Null
              // means never, which is what the rule needs to see.
              user.lastLoginTime && !user.lastLoginTime.startsWith('1970')
                ? user.lastLoginTime
                : null,
          },
        });
      }

      observations.push({
        kind: 'CONFIGURATION_SETTING',
        sourceSystem: 'google-workspace',
        subjectExternalId: null,
        observedAt: context.nowIso,
        payload: { adminCount },
      });

      return {
        observations,
        warnings,
        // Only truncation makes the picture genuinely incomplete. Warnings on
        // their own do not, and treating them as partial marks healthy
        // integrations DEGRADED.
        partial: truncated,
        cursor: null,
      };
    },

    async execute(config, credentials, request, context): Promise<ExecutionResult> {
      if (request.actionType !== 'identity.account.disable') {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: `The Google Workspace connector does not perform ${request.actionType}`,
          errorCode: 'UNSUPPORTED_ACTION',
          retryable: false,
        };
      }
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
        const accessToken = await token(config, credentials, context);
        await http(context).request({
          method: 'PUT',
          url: `${config.directoryBaseUrl}/users/${request.targetExternalId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          body: { suspended: true },
        });
        return {
          status: 'SUCCEEDED',
          externalOperationRef: request.idempotencyKey,
          detail: 'Account suspended.',
        };
      } catch (error) {
        return {
          status: 'FAILED',
          externalOperationRef: null,
          detail: (error as Error).message,
          errorCode: 'DIRECTORY_ERROR',
          retryable: true,
        };
      }
    },
  };
}

export const googleWorkspaceManifest: ConnectorManifest = connectorManifestSchema.parse({
  id: 'google-workspace',
  version: '1.0.0',
  vendor: 'Google',
  products: ['Google Workspace', 'Cloud Identity'],
  category: 'IDENTITY',
  authentication: ['OAUTH2_CLIENT_CREDENTIALS'],
  collect: [
    {
      key: 'collect.identities',
      title: 'Directory users and their sign-in state',
      domain: 'IDENTITY',
      produces: ['IDENTITY_STATE'],
      predicates: [
        'identity.account.enabled',
        'identity.account.type',
        'identity.last_sign_in_at',
        'identity.privileged',
      ],
      requiredPermission: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
      incremental: false,
    },
    {
      key: 'collect.mfa',
      title: 'Two-step verification enrolment',
      domain: 'IDENTITY',
      produces: ['IDENTITY_STATE'],
      predicates: ['identity.mfa.enforced'],
      requiredPermission: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
      incremental: false,
    },
  ],
  execute: ['identity.account.disable'],
  verify: ['identity.account.enabled'],
  pagination: true,
  incrementalCollection: false,
  fidelity: 'LIVE',
});
