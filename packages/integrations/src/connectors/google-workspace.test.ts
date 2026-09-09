import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nullLogger } from '@adericel/shared';
import {
  buildServiceAccountAssertion,
  createGoogleWorkspaceConnector,
} from './google-workspace.js';
import { PERMISSIVE_EGRESS } from '../http.js';
import type { ConnectorContext } from '../connector.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NOW = '2026-09-09T12:00:00.000Z';

const context: ConnectorContext = {
  organisationId: '11111111-1111-4111-8111-111111111111',
  integrationId: '22222222-2222-4222-8222-222222222222',
  logger: nullLogger,
  correlationId: 'test',
  nowIso: NOW,
  cursor: null,
};

const config = {
  domain: 'example.test',
  impersonateSubject: 'adericel-collector@example.test',
  directoryBaseUrl: 'https://admin.googleapis.test/admin/directory/v1',
  tokenUrl: 'https://oauth2.googleapis.test/token',
  excludeEmails: [],
  pageSize: 200,
};

const credentials = { clientEmail: 'collector@project.iam.gserviceaccount.test', privateKey };

/** A fetch that answers the token endpoint and one page of users. */
function stubFetch(users: unknown[], options: { nextPageToken?: string } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/token')) return json({ access_token: 'stub-access-token' });
    if (url.includes('/users')) {
      return json({
        users,
        ...(options.nextPageToken ? { nextPageToken: options.nextPageToken } : {}),
      });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
}

function connectorWith(fetchImpl: typeof fetch) {
  return createGoogleWorkspaceConnector({ egressPolicy: PERMISSIVE_EGRESS, fetchImpl });
}

describe('the service account assertion', () => {
  it('is a verifiable RS256 JWT', () => {
    const assertion = buildServiceAccountAssertion({
      clientEmail: 'collector@project.iam.gserviceaccount.test',
      privateKey,
      subject: 'admin@example.test',
      tokenUrl: 'https://oauth2.googleapis.test/token',
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      nowEpochSeconds: 1_800_000_000,
    });

    const [header, claims, signature] = assertion.split('.');
    expect(header && claims && signature).toBeTruthy();

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
  });

  it('carries the impersonated subject, which is what makes it delegated', () => {
    const assertion = buildServiceAccountAssertion({
      clientEmail: 'collector@project.iam.gserviceaccount.test',
      privateKey,
      subject: 'admin@example.test',
      tokenUrl: 'https://oauth2.googleapis.test/token',
      scopes: ['scope-a', 'scope-b'],
      nowEpochSeconds: 1_800_000_000,
    });
    const claims = JSON.parse(
      Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(claims.sub).toBe('admin@example.test');
    expect(claims.iss).toBe('collector@project.iam.gserviceaccount.test');
    expect(claims.aud).toBe('https://oauth2.googleapis.test/token');
    expect(claims.scope).toBe('scope-a scope-b');
    // Google refuses an assertion valid for more than an hour.
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(3600);
  });
});

describe('collection', () => {
  it('normalises a user into the same shape Entra produces', async () => {
    const connector = connectorWith(
      stubFetch([
        {
          id: 'user-1',
          primaryEmail: 'jo@example.test',
          name: { fullName: 'Jo Whitfield' },
          suspended: false,
          isAdmin: true,
          isEnrolledIn2Sv: true,
          isEnforcedIn2Sv: true,
          lastLoginTime: '2026-09-08T09:00:00.000Z',
        },
      ]),
    );

    const result = await connector.collect(config, credentials, context);
    const identity = result.observations.find((o) => o.kind === 'IDENTITY_STATE');
    expect(identity?.payload).toMatchObject({
      externalId: 'user-1',
      userPrincipalName: 'jo@example.test',
      enabled: true,
      privileged: true,
      mfaEnforced: true,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    });
  });

  it('reports enrolled-but-not-enforced two-step verification as not enforced', async () => {
    // The substitution this refuses: a user who switched two-step verification
    // on for themselves has not made it a control, and reporting the two as one
    // is how an organisation comes to believe it has enforcement it does not.
    const connector = connectorWith(
      stubFetch([
        {
          id: 'user-2',
          primaryEmail: 'sam@example.test',
          isEnrolledIn2Sv: true,
          isEnforcedIn2Sv: false,
        },
      ]),
    );

    const identity = (await connector.collect(config, credentials, context)).observations.find(
      (o) => o.kind === 'IDENTITY_STATE',
    );
    expect(identity?.payload).toMatchObject({ mfaEnforced: false, mfaMethods: ['GOOGLE_2SV'] });
  });

  it('treats an archived account as disabled', async () => {
    const connector = connectorWith(
      stubFetch([{ id: 'user-3', primaryEmail: 'old@example.test', archived: true }]),
    );
    const identity = (await connector.collect(config, credentials, context)).observations.find(
      (o) => o.kind === 'IDENTITY_STATE',
    );
    expect((identity?.payload as { enabled: boolean }).enabled).toBe(false);
  });

  it('reports never-signed-in as null rather than as 1970', async () => {
    // Google returns the epoch for an account that has never signed in. Passed
    // through, a dormant-account rule reads it as a sign-in fifty years ago —
    // technically true and useless. Null is what the rule needs to see.
    const connector = connectorWith(
      stubFetch([
        {
          id: 'user-4',
          primaryEmail: 'new@example.test',
          lastLoginTime: '1970-01-01T00:00:00.000Z',
        },
      ]),
    );
    const identity = (await connector.collect(config, credentials, context)).observations.find(
      (o) => o.kind === 'IDENTITY_STATE',
    );
    expect((identity?.payload as { lastSignInAt: string | null }).lastSignInAt).toBeNull();
  });

  it('excludes the accounts it was told to exclude', async () => {
    const connector = connectorWith(
      stubFetch([
        { id: 'user-5', primaryEmail: 'breakglass@example.test' },
        { id: 'user-6', primaryEmail: 'ordinary@example.test' },
      ]),
    );
    const result = await connector.collect(
      { ...config, excludeEmails: ['BreakGlass@example.test'] },
      credentials,
      context,
    );
    const emails = result.observations
      .filter((o) => o.kind === 'IDENTITY_STATE')
      .map((o) => (o.payload as { userPrincipalName: string }).userPrincipalName);
    expect(emails).toEqual(['ordinary@example.test']);
  });

  it('counts administrators for the organisation-level control', async () => {
    const connector = connectorWith(
      stubFetch([
        { id: 'a', primaryEmail: 'a@example.test', isAdmin: true },
        { id: 'b', primaryEmail: 'b@example.test', isDelegatedAdmin: true },
        { id: 'c', primaryEmail: 'c@example.test' },
      ]),
    );
    const setting = (await connector.collect(config, credentials, context)).observations.find(
      (o) => o.kind === 'CONFIGURATION_SETTING',
    );
    expect(setting?.payload).toMatchObject({ adminCount: 2 });
  });

  it('is not partial when the collection was complete', async () => {
    const connector = connectorWith(stubFetch([{ id: 'a', primaryEmail: 'a@example.test' }]));
    const result = await connector.collect(config, credentials, context);
    expect(result.partial).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('is partial when paging stopped early, so rules resolve to UNKNOWN', async () => {
    const connector = connectorWith(
      stubFetch([{ id: 'a', primaryEmail: 'a@example.test' }], { nextPageToken: 'more' }),
    );
    const result = await connector.collect(config, credentials, context);
    expect(result.partial).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/some identities were not collected/);
  });
});

describe('failure reporting', () => {
  it('says plainly when domain-wide delegation has not been granted', async () => {
    // The single most common setup mistake. "invalid_grant" is not a useful
    // thing to show an MSP engineer at four in the afternoon.
    const connector = connectorWith(
      (async () =>
        new Response(JSON.stringify({ error: 'unauthorized_client' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    const check = await connector.checkConnection(config, credentials, context);
    expect(check.connected).toBe(false);
    expect(check.detail).toMatch(/domain-wide delegation/);
  });

  it('refuses an action it does not implement rather than reporting success', async () => {
    const connector = connectorWith(stubFetch([]));
    const result = await connector.execute!(
      config,
      credentials,
      {
        actionType: 'device.encryption.enable',
        targetExternalId: 'user-1',
        parameters: {},
        idempotencyKey: 'key-1',
      },
      context,
    );
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('UNSUPPORTED_ACTION');
  });
});
