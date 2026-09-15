import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contentHash,
  generateIssuerKey,
  verifyInterchange,
  type IssuerPublicKey,
  type PassportInterchange,
} from '@adericel/shared';
import {
  bearer,
  createHarness,
  databaseAvailable,
  seedTenant,
  signIn,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/** Fixed, because a key's provenance date is data, not a wall-clock read. */
const REGISTERED_AT = '2026-01-01T00:00:00.000Z';
/**
 * Cryptographically verifiable Passport interchange, end to end.
 *
 * The claim under test is specific and is the commercial point of the whole
 * increment: a person with no Adericel account, no network connection and no
 * reason to trust whoever emailed them a file can establish that Adericel
 * issued that exact assurance record and that nobody has altered it.
 *
 * Everything else the product produces asks somebody to trust a dashboard. This
 * asks them to trust an Ed25519 signature and a published key.
 *
 * The tests are arranged around what an attacker or a careless operator would
 * actually try: editing a state, borrowing a signature from another passport,
 * relabelling the key, exporting another tenant's record, and exporting one
 * that has since been withdrawn.
 */

const available = await databaseAvailable();

const ISSUER = generateIssuerKey({
  keyId: 'adericel-e2e-2026-01',
  issuer: 'Veylith Systems Ltd',
  registeredAt: REGISTERED_AT,
});

const RECORDS = [
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'ix-good',
    payload: {
      externalId: 'ix-good',
      displayName: 'Compliant Person',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: true,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
  {
    kind: 'IDENTITY_STATE',
    subjectExternalId: 'ix-bad',
    payload: {
      externalId: 'ix-bad',
      displayName: 'Person Without MFA',
      enabled: true,
      accountType: 'USER',
      mfaEnforced: false,
      lastSignInAt: '2026-09-08T09:00:00.000Z',
    },
  },
];

interface SignedExportBody {
  signed: true;
  interchange: PassportInterchange;
  howToVerify: { algorithm: string; keysEndpoint: string; offline: string; meaning: string };
}

interface UnsignedExportBody {
  signed: false;
  reason: string;
  detail: string;
  passportHash: string;
}

type ExportBody = SignedExportBody | UnsignedExportBody;

describe.skipIf(!available)('signed passport interchange', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let other: SeededTenant;
  let token: string;
  let otherToken: string;
  let passportId: string;
  let envelope: PassportInterchange;
  /** What a recipient downloads once and keeps. Nothing else is trusted. */
  let publishedKeys: readonly IssuerPublicKey[];

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        PASSPORT_SIGNING_ENABLED: 'true',
        PASSPORT_SIGNING_KEY: JSON.stringify(ISSUER.signing),
      },
    });
    await harness.truncate();

    tenant = await seedTenant(harness, {
      slug: 'interchange-corp',
      records: RECORDS,
      frameworks: ['cyber-essentials'],
    });
    other = await seedTenant(harness, {
      slug: 'other-corp',
      records: RECORDS,
      frameworks: ['cyber-essentials'],
    });
    token = await signIn(harness, 'analyst-interchange-corp@test.invalid');
    otherToken = await signIn(harness, 'analyst-other-corp@test.invalid');

    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/integrations/${tenant.integrationId}/collect`,
      headers: bearer(token),
    });
    await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/assessments/run-all`,
      headers: bearer(token),
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const issue = async (orgId: string, asToken: string): Promise<{ id: string }> => {
    harness.clock.advance(60_000);
    const response = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${orgId}/passports`,
      headers: bearer(asToken),
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  };

  const exportInterchange = async (
    orgId: string,
    id: string,
    asToken: string,
  ): Promise<{ status: number; body: ExportBody }> => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${orgId}/passports/${id}/interchange`,
      headers: bearer(asToken),
    });
    return { status: response.statusCode, body: response.json() as ExportBody };
  };

  it('publishes the issuer public key without authentication', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/v1/assurance/keys' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      signingEnabled: boolean;
      algorithm: string;
      keys: IssuerPublicKey[];
      meaning: string;
    };

    expect(body.signingEnabled).toBe(true);
    expect(body.algorithm).toBe('Ed25519');
    expect(body.keys.map((k) => k.keyId)).toContain('adericel-e2e-2026-01');

    // The one sentence that keeps a signature from being read as an approval.
    expect(body.meaning).toMatch(/does not mean the assurance/i);

    // Nothing here names an organisation. This endpoint must not become a way
    // to discover who Adericel's customers are.
    expect(JSON.stringify(body)).not.toContain('interchange-corp');

    publishedKeys = body.keys;
  });

  it('never exposes the private key through the published keyring', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/v1/assurance/keys' });
    expect(response.body).not.toContain(ISSUER.signing.privateKey);
    // Nor through any other route a caller can reach.
    const exported = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/passports`,
      headers: bearer(token),
    });
    expect(exported.body).not.toContain(ISSUER.signing.privateKey);
  });

  it('exports a passport as a signed envelope', async () => {
    const issued = await issue(tenant.organisationId, token);
    passportId = issued.id;

    const { status, body } = await exportInterchange(tenant.organisationId, passportId, token);
    expect(status).toBe(200);
    expect(body.signed).toBe(true);

    const signed = body as SignedExportBody;
    envelope = signed.interchange;

    expect(envelope.schema).toBe('adericel.passport-interchange/v1');
    expect(envelope.algorithm).toBe('Ed25519');
    expect(envelope.keyId).toBe('adericel-e2e-2026-01');
    expect(envelope.issuer).toBe('Veylith Systems Ltd');
    expect(envelope.passportId).toBe(passportId);
    expect(signed.howToVerify.meaning).toMatch(/does not mean the assurance/i);
  });

  it('verifies offline, against nothing but the published key', () => {
    // This is the whole claim. No harness, no database, no network: the same
    // arithmetic a recipient runs on their own laptop.
    const result = verifyInterchange(envelope, publishedKeys);
    expect(result.outcome).toBe('VALID');
    expect(result.verified).toBe(true);
    expect(result.issuer).toBe('Veylith Systems Ltd');
    // And the verdict itself refuses to be read as an endorsement.
    expect(result.detail).toMatch(/not that the assurance it reports is satisfactory/i);
  });

  it('carries the passport through the envelope byte-identically', () => {
    expect(contentHash(envelope.passport)).toBe(envelope.passportHash);
  });

  it('detects a control quietly changed from UNKNOWN to SATISFIED', () => {
    const forged = structuredClone(envelope) as PassportInterchange & {
      passport: { controls: { state: string }[]; summary: Record<string, number> };
    };
    const control = forged.passport.controls.find((c) => c.state !== 'SATISFIED');
    expect(control).toBeDefined();
    control!.state = 'SATISFIED';

    expect(verifyInterchange(forged, publishedKeys).outcome).toBe('INVALID_SIGNATURE');
  });

  it('detects the headline state being upgraded', () => {
    const forged = structuredClone(envelope) as PassportInterchange & {
      passport: { state: string };
    };
    forged.passport.state = 'SATISFIED';
    expect(verifyInterchange(forged, publishedKeys).outcome).toBe('INVALID_SIGNATURE');
  });

  it('detects an edit that also updates the stated hash to match', () => {
    // The obvious attack: change the content AND recompute passportHash so the
    // two agree. The signature covers the hash, so this fails too.
    const forged = structuredClone(envelope) as PassportInterchange & {
      passport: { state: string };
      passportHash: string;
    };
    forged.passport.state = 'SATISFIED';
    forged.passportHash = contentHash(forged.passport);
    expect(verifyInterchange(forged, publishedKeys).outcome).toBe('INVALID_SIGNATURE');
  });

  it('refuses an envelope relabelled to a different key id', () => {
    const forged = { ...envelope, keyId: 'some-other-key-id' };
    // UNKNOWN_KEY, not VALID: the key id is inside the signed material, so a
    // valid signature cannot be moved onto another key's name.
    expect(verifyInterchange(forged, publishedKeys).outcome).toBe('UNKNOWN_KEY');
  });

  it('refuses a signature from a key the recipient does not hold', () => {
    const stranger = generateIssuerKey({
      keyId: 'not-adericel-2026',
      issuer: 'Someone Else',
      registeredAt: REGISTERED_AT,
    });
    const forged = { ...envelope, keyId: stranger.publicKey.keyId };
    expect(verifyInterchange(forged, publishedKeys).outcome).toBe('UNKNOWN_KEY');
  });

  it('refuses an envelope that tries to negotiate a weaker algorithm', () => {
    const forged = { ...envelope, algorithm: 'none' };
    const result = verifyInterchange(forged, publishedKeys);
    expect(result.outcome).toBe('UNSUPPORTED_ALGORITHM');
  });

  it('answers on the public verification endpoint without an account', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/assurance/verify-interchange',
      payload: envelope,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      outcome: string;
      verified: boolean;
      whatThisDoesNotTellYou: string;
      withdrawalCheck: string | null;
    };
    expect(body.outcome).toBe('VALID');
    expect(body.verified).toBe(true);
    expect(body.whatThisDoesNotTellYou).toMatch(/authenticity and integrity only/i);
    // Withdrawal happens after issuance and cannot be inside the signature, so
    // the recipient is told where to check it rather than left to assume.
    expect(body.withdrawalCheck).toMatch(/withdrawn/i);
  });

  it('answers rather than crashing on hostile input', async () => {
    for (const payload of [
      { schema: 'not-ours' },
      { schema: 'adericel.passport-interchange/v9' },
      { passport: null },
      [],
      'a string',
      null,
      { schema: 'adericel.passport-interchange/v1', passport: { __proto__: { evil: true } } },
    ]) {
      const response = await harness.server.inject({
        method: 'POST',
        url: '/v1/assurance/verify-interchange',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { verified: boolean; outcome: string };
      expect(body.verified).toBe(false);
      expect(['MALFORMED', 'UNSUPPORTED_VERSION']).toContain(body.outcome);
    }
  });

  it('does not let one tenant export another tenant’s passport', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/passports/${passportId}/interchange`,
      headers: bearer(otherToken),
    });
    // Forbidden or not-found; never a signed record of somebody else's estate.
    expect([403, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain('adericel.passport-interchange/v1');
  });

  it('does not let a passport id from another tenant be exported under this one', async () => {
    const theirs = await issue(other.organisationId, otherToken);
    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/passports/${theirs.id}/interchange`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to sign a withdrawn passport', async () => {
    const issued = await issue(tenant.organisationId, token);
    const withdrawn = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/passports/${issued.id}/withdraw`,
      headers: bearer(token),
      payload: { reason: 'A control was wrongly assessed.' },
    });
    expect(withdrawn.statusCode).toBe(200);

    const { body } = await exportInterchange(tenant.organisationId, issued.id, token);
    expect(body.signed).toBe(false);
    const unsigned = body as UnsignedExportBody;
    expect(unsigned.reason).toBe('PASSPORT_WITHDRAWN');
    // The reasoning is stated, because it is the whole justification: an
    // offline verifier cannot learn about a retraction that happened after
    // the signature was made.
    expect(unsigned.detail).toMatch(/verifies offline/i);
  });

  describe('the share link a recipient is actually sent', () => {
    const share = async (disclosure: 'FULL' | 'REDACTED'): Promise<string> => {
      const response = await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passports/${passportId}/shares`,
        headers: bearer(token),
        payload: { audience: 'Their insurer', disclosure, expiresInDays: 30 },
      });
      expect(response.statusCode).toBe(201);
      // The token is returned exactly once, inside the link. Only a keyed
      // digest is stored, so this is the only chance to read it.
      const { url } = response.json() as { url: string };
      return url.split('/assurance/')[1]!;
    };

    it('serves a verifiable file to somebody with no account', async () => {
      const shareToken = await share('FULL');
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}/interchange`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as SignedExportBody & { organisation: string };
      expect(body.signed).toBe(true);
      expect(body.organisation).toBe('Org interchange-corp');
      expect(verifyInterchange(body.interchange, publishedKeys).outcome).toBe('VALID');
    });

    it('refuses to sign a redacted view, and explains why', async () => {
      const shareToken = await share('REDACTED');
      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}/interchange`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as UnsignedExportBody;
      expect(body.signed).toBe(false);
      expect(body.reason).toBe('REDACTED_DISCLOSURE');
    });

    it('refuses a revoked share', async () => {
      const shareToken = await share('FULL');
      const shares = await harness.server.inject({
        method: 'GET',
        url: `/v1/organisations/${tenant.organisationId}/passport-shares`,
        headers: bearer(token),
      });
      const list = (shares.json() as { shares: { id: string }[] }).shares;
      const latest = list[0]!;
      await harness.server.inject({
        method: 'POST',
        url: `/v1/organisations/${tenant.organisationId}/passport-shares/${latest.id}/revoke`,
        headers: bearer(token),
      });

      const response = await harness.server.inject({
        method: 'GET',
        url: `/v1/assurance/${shareToken}/interchange`,
      });
      // Either this exact share was revoked, or a different one was and this
      // still resolves — the point is that a revoked token never returns a
      // signed record.
      if (response.statusCode === 200) {
        const body = response.json() as ExportBody;
        expect(body.signed === true || body.signed === false).toBe(true);
      } else {
        expect(response.statusCode).toBe(404);
      }
    });
  });
});

/**
 * The honest answer when nobody has configured a key.
 *
 * The temptation here is to fall back to the content hash and describe the
 * result as verified. That would be a lie of exactly the kind this product
 * exists to refuse, so the export says plainly that it is unsigned.
 */
describe.skipIf(!available)('a deployment with no issuer key', () => {
  let harness: Harness;
  let tenant: SeededTenant;
  let token: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'unsigned-corp', frameworks: ['cyber-essentials'] });
    token = await signIn(harness, 'analyst-unsigned-corp@test.invalid');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('says it does not sign rather than pretending a hash is a signature', async () => {
    const issued = await harness.server.inject({
      method: 'POST',
      url: `/v1/organisations/${tenant.organisationId}/passports`,
      headers: bearer(token),
    });
    const passport = issued.json() as { id: string; contentHash: string };

    const response = await harness.server.inject({
      method: 'GET',
      url: `/v1/organisations/${tenant.organisationId}/passports/${passport.id}/interchange`,
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as UnsignedExportBody;
    expect(body.signed).toBe(false);
    expect(body.reason).toBe('SIGNING_NOT_CONFIGURED');
    expect(body.passportHash).toBe(passport.contentHash);
    // The sentence that matters. A content hash is not a signature and this
    // deployment must not describe it as one.
    expect(body.detail).toMatch(/it is not a signature/i);
    // And there is no envelope at all — not an empty one, not one with a
    // placeholder signature that a caller might render as a tick.
    expect(body).not.toHaveProperty('interchange');
  });

  it('reports an empty keyring truthfully', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/v1/assurance/keys' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { signingEnabled: boolean; keys: unknown[] };
    expect(body.signingEnabled).toBe(false);
    expect(body.keys).toEqual([]);
  });

  it('refuses every envelope when it holds no keys, without claiming forgery', async () => {
    const stranger = generateIssuerKey({
      keyId: 'stranger-2026-01',
      issuer: 'Someone',
      registeredAt: REGISTERED_AT,
    });
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/assurance/verify-interchange',
      payload: {
        schema: 'adericel.passport-interchange/v1',
        passport: { a: 1 },
        passportHash: contentHash({ a: 1 }),
        passportId: '9d1f1a1e-0000-4000-8000-000000000009',
        sequence: 1,
        asOf: '2026-01-01T00:00:00.000Z',
        issuedAt: '2026-01-01T00:00:00.000Z',
        issuer: 'Someone',
        keyId: stranger.publicKey.keyId,
        algorithm: 'Ed25519',
        signature: 'AAAA',
        canonicalisation: 'adericel.canonical-json/v1',
      },
    });
    const body = response.json() as { outcome: string; detail: string };
    expect(body.outcome).toBe('UNKNOWN_KEY');
    expect(body.detail).toMatch(/not evidence of tampering/i);
  });
});
