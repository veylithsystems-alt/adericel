import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { nullLogger } from '@adericel/shared';
import { PERMISSIVE_EGRESS } from '../http.js';
import { normalise } from '../normalise.js';
import type { ConnectorContext, Connector } from '../connector.js';
import { createMicrosoftEntraConnector } from './microsoft-entra.js';
import { createMicrosoftIntuneConnector } from './microsoft-intune.js';
import { createGoogleWorkspaceConnector } from './google-workspace.js';

/**
 * Does each connector supply what its manifest promises?
 *
 * The rest of the conformance suite checks that a declared predicate is
 * canonical and that its observation kind could carry it. Neither catches the
 * failure that matters most here: a manifest claiming a predicate the
 * connector never actually writes.
 *
 * That overclaim is quietly severe. planCollection resolves the predicate to
 * this connector, believes the control is covered, and the control then reads
 * as a genuine gap in the customer's estate — "you have no firewall data" —
 * when the truth is that Adericel never asked for any. It is precisely the
 * class of lie §8 exists to prevent, dressed up as a configuration file.
 *
 * So each connector is driven against a realistic upstream response and the
 * predicates it genuinely produces are compared against what it declares.
 */

const NOW = '2026-09-09T12:00:00.000Z';

const context: ConnectorContext = {
  organisationId: '11111111-1111-4111-8111-111111111111',
  integrationId: '22222222-2222-4222-8222-222222222222',
  logger: nullLogger,
  correlationId: 'test',
  nowIso: NOW,
  cursor: null,
};

/** Respond to any URL matching a pattern with fixture JSON. */
function routedFetch(routes: readonly (readonly [RegExp, unknown])[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [pattern, body] of routes) {
      if (pattern.test(url)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as unknown as typeof fetch;
}

/** Every canonical predicate a collection run actually produced. */
async function producedPredicates(
  connector: Connector,
  config: unknown,
  credentials: unknown,
): Promise<Set<string>> {
  const result = await connector.collect(
    connector.configSchema.parse(config) as never,
    connector.credentialSchema.parse(credentials) as never,
    context,
  );
  const produced = new Set<string>();
  for (const observation of result.observations) {
    const normalisation = normalise({
      id: 'o',
      organisationId: context.organisationId,
      integrationId: context.integrationId,
      sourceSystem: observation.sourceSystem,
      collectedAt: NOW,
      contentHash: 'sha256:x',
      evidenceId: null,
      ...observation,
    } as never);
    for (const claim of normalisation.claims) produced.add(claim.predicate);
  }
  return produced;
}

function declaredPredicates(connector: Connector): Set<string> {
  return new Set(connector.manifest.collect.flatMap((capability) => capability.predicates));
}

describe('Microsoft Entra', () => {
  const connector = createMicrosoftEntraConnector({
    egressPolicy: PERMISSIVE_EGRESS,
    fetchImpl: routedFetch([
      [/\/token|oauth2/, { access_token: 'stub', expires_in: 3600 }],
      [
        /\/users\?/,
        {
          value: [
            {
              id: 'u1',
              displayName: 'Alex Doe',
              userPrincipalName: 'alex@example.test',
              accountEnabled: true,
              userType: 'Member',
              signInActivity: { lastSignInDateTime: '2026-09-01T09:00:00Z' },
            },
          ],
        },
      ],
      [
        /userRegistrationDetails/,
        { value: [{ id: 'u1', isMfaRegistered: true, methodsRegistered: ['microsoftAuthenticator'] }] },
      ],
      [/directoryRoles\/[^/]+\/members/, { value: [{ id: 'u1' }] }],
      [/directoryRoles/, { value: [{ id: 'r1', displayName: 'Global Administrator' }] }],
    ]),
  }) as unknown as Connector;

  it('produces every predicate it declares', async () => {
    const produced = await producedPredicates(
      connector,
      {
        tenantId: 'tenant-1',
        graphBaseUrl: 'https://graph.microsoft.test/v1.0',
        loginBaseUrl: 'https://login.microsoftonline.test',
      },
      { clientId: 'id', clientSecret: 'secret' },
    );
    const overclaimed = [...declaredPredicates(connector)].filter((p) => !produced.has(p)).sort();
    expect(overclaimed, 'declared but never produced').toEqual([]);
  });

  it('reports each capability outcome, not one flag for the run', async () => {
    const result = await connector.collect(
      connector.configSchema.parse({
        tenantId: 'tenant-1',
        graphBaseUrl: 'https://graph.microsoft.test/v1.0',
        loginBaseUrl: 'https://login.microsoftonline.test',
      }) as never,
      connector.credentialSchema.parse({ clientId: 'id', clientSecret: 'secret' }) as never,
      context,
    );
    expect(result.capabilityReports?.map((r) => r.capability).sort()).toEqual([
      'collect.identities',
      'collect.mfa',
      'collect.privileged_roles',
    ]);
    expect(result.capabilityReports?.every((r) => r.outcome === 'AVAILABLE')).toBe(true);
  });

  it('names the permission to grant when one capability is refused', async () => {
    const refusing = createMicrosoftEntraConnector({
      egressPolicy: PERMISSIVE_EGRESS,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (/\/token|oauth2/.test(url)) return json({ access_token: 'stub', expires_in: 3600 });
        if (/userRegistrationDetails/.test(url)) return json({ error: 'Forbidden' }, 403);
        if (/\/users\?/.test(url)) return json({ value: [] });
        if (/directoryRoles/.test(url)) return json({ value: [] });
        return json({}, 404);
      }) as unknown as typeof fetch,
    }) as unknown as Connector;

    const result = await refusing.collect(
      refusing.configSchema.parse({
        tenantId: 'tenant-1',
        graphBaseUrl: 'https://graph.microsoft.test/v1.0',
        loginBaseUrl: 'https://login.microsoftonline.test',
      }) as never,
      refusing.credentialSchema.parse({ clientId: 'id', clientSecret: 'secret' }) as never,
      context,
    );

    const mfa = result.capabilityReports?.find((r) => r.capability === 'collect.mfa');
    expect(mfa?.outcome).toBe('PERMISSION_DENIED');
    // The whole point: the message says what to grant.
    expect(mfa?.detail).toContain('UserAuthenticationMethod.Read.All');
    expect(mfa?.requiredPermission).toBe('UserAuthenticationMethod.Read.All');

    // An empty directory is EMPTY, not a failure. A one-person company must not
    // be shown as broken.
    const identities = result.capabilityReports?.find((r) => r.capability === 'collect.identities');
    expect(identities?.outcome).toBe('EMPTY');
  });
});

describe('Microsoft Intune', () => {
  const connector = createMicrosoftIntuneConnector({
    egressPolicy: PERMISSIVE_EGRESS,
    fetchImpl: routedFetch([
      [/\/token|oauth2/, { access_token: 'stub', expires_in: 3600 }],
      [
        /windowsProtectionState/,
        {
          firewallEnabled: true,
          realTimeProtectionEnabled: true,
          malwareProtectionEnabled: true,
          signatureUpdateDateTime: '2026-09-09T06:00:00Z',
        },
      ],
      [
        /managedDevices/,
        {
          value: [
            {
              id: 'd1',
              deviceName: 'laptop-17',
              operatingSystem: 'Windows',
              osVersion: '10.0.22631',
              userPrincipalName: 'alex@example.test',
              isEncrypted: true,
              complianceState: 'compliant',
              lastSyncDateTime: '2026-09-09T08:00:00Z',
            },
          ],
        },
      ],
    ]),
  }) as unknown as Connector;

  it('produces every predicate it declares', async () => {
    const produced = await producedPredicates(
      connector,
      {
        tenantId: 'tenant-1',
        graphBaseUrl: 'https://graph.microsoft.test/v1.0',
        loginBaseUrl: 'https://login.microsoftonline.test',
        supportedOsVersions: { Windows: '10.0.19045' },
      },
      { clientId: 'id', clientSecret: 'secret' },
    );
    const overclaimed = [...declaredPredicates(connector)].filter((p) => !produced.has(p)).sort();
    expect(overclaimed, 'declared but never produced').toEqual([]);
  });
});

describe('Google Workspace', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const connector = createGoogleWorkspaceConnector({
    egressPolicy: PERMISSIVE_EGRESS,
    fetchImpl: routedFetch([
      [/\/token/, { access_token: 'stub' }],
      [
        /\/users/,
        {
          users: [
            {
              id: 'g1',
              primaryEmail: 'alex@example.test',
              name: { fullName: 'Alex Doe' },
              suspended: false,
              archived: false,
              isAdmin: true,
              isEnrolledIn2Sv: true,
              lastLoginTime: '2026-09-01T09:00:00Z',
            },
          ],
        },
      ],
    ]),
  }) as unknown as Connector;

  it('produces every predicate it declares', async () => {
    const produced = await producedPredicates(
      connector,
      {
        domain: 'example.test',
        impersonateSubject: 'collector@example.test',
        directoryBaseUrl: 'https://admin.googleapis.test/admin/directory/v1',
        tokenUrl: 'https://oauth2.googleapis.test/token',
      },
      { clientEmail: 'collector@project.iam.gserviceaccount.test', privateKey },
    );
    const overclaimed = [...declaredPredicates(connector)].filter((p) => !produced.has(p)).sort();
    expect(overclaimed, 'declared but never produced').toEqual([]);
  });
});
