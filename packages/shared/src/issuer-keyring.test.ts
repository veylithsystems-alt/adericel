import { describe, expect, it } from 'vitest';
import {
  generateIssuerKey,
  publicKeyOf,
  REDACTED_KEY,
  redactSigningKey,
  type IssuerPublicKey,
} from './issuer-key.js';
import { loadIssuerKeyring, publishableKeyring, signWithKeyring } from './issuer-keyring.js';
import { sealPassport, verifyInterchange } from './passport-interchange.js';
import { contentHash } from './canonical.js';
import { redact } from './redaction.js';

/** Fixed, because a key's provenance date is data, not a wall-clock read. */
const REGISTERED_AT = '2026-01-01T00:00:00.000Z';
const PASSPORT = {
  schema: 'adericel.passport/v1',
  organisation: 'Northgate Dental',
  asOf: '2026-03-01T00:00:00.000Z',
  state: 'PARTIALLY_SATISFIED',
  summary: { total: 12, satisfied: 7, unknown: 4, failing: 1 },
};

function keyringSource(overrides: Partial<Parameters<typeof loadIssuerKeyring>[0]> = {}) {
  return { signingEnabled: false, signingKeyJson: '', keyringJson: '', ...overrides };
}

describe('loading the keyring', () => {
  it('returns a keyring that says it does not sign when signing is off', () => {
    const keyring = loadIssuerKeyring(keyringSource());
    expect(keyring.signingEnabled).toBe(false);
    expect(keyring.signing).toBeNull();
    expect(keyring.publicKeys).toEqual([]);
  });

  it('still publishes historical keys when signing is off', () => {
    // A deployment that has stopped signing must keep verifying what it signed.
    const { publicKey } = generateIssuerKey({
      keyId: 'adericel-2025-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const retired: IssuerPublicKey = { ...publicKey, status: 'RETIRED', retiredAt: '2026-01-01' };
    const keyring = loadIssuerKeyring(keyringSource({ keyringJson: JSON.stringify([retired]) }));
    expect(keyring.signingEnabled).toBe(false);
    expect(keyring.publicKeys).toHaveLength(1);
    expect(keyring.publicKeys[0]?.status).toBe('RETIRED');
  });

  it('loads a signing key and derives its public half', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const keyring = loadIssuerKeyring(
      keyringSource({ signingEnabled: true, signingKeyJson: JSON.stringify(signing) }),
    );
    expect(keyring.signingEnabled).toBe(true);
    expect(keyring.signing?.keyId).toBe('adericel-2026-01');
    expect(keyring.publicKeys.map((k) => k.keyId)).toEqual(['adericel-2026-01']);
    expect(keyring.publicKeys[0]?.publicKey).toBe(publicKeyOf(signing).publicKey);
  });
});

describe('refusing to start on a keyring that would produce unverifiable signatures', () => {
  it('refuses when the published public key does not match the signing key', () => {
    const mine = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const someoneElse = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });

    expect(() =>
      loadIssuerKeyring(
        keyringSource({
          signingEnabled: true,
          signingKeyJson: JSON.stringify(mine.signing),
          keyringJson: JSON.stringify([publicKeyOf(someoneElse.signing)]),
        }),
      ),
    ).toThrow(/does not match the configured signing key/);
  });

  it('refuses a key id published twice', () => {
    const a = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const b = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    expect(() =>
      loadIssuerKeyring(
        keyringSource({
          keyringJson: JSON.stringify([publicKeyOf(a.signing), publicKeyOf(b.signing)]),
        }),
      ),
    ).toThrow(/twice/);
  });

  it('refuses to sign with a key published as RETIRED', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2025-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const retired = { ...publicKeyOf(signing), status: 'RETIRED', retiredAt: '2026-01-01' };
    expect(() =>
      loadIssuerKeyring(
        keyringSource({
          signingEnabled: true,
          signingKeyJson: JSON.stringify(signing),
          keyringJson: JSON.stringify([retired]),
        }),
      ),
    ).toThrow(/must never issue new signatures/);
  });

  it('refuses to sign with a key published as REVOKED', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2025-06',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const revoked = { ...publicKeyOf(signing), status: 'REVOKED' };
    expect(() =>
      loadIssuerKeyring(
        keyringSource({
          signingEnabled: true,
          signingKeyJson: JSON.stringify(signing),
          keyringJson: JSON.stringify([revoked]),
        }),
      ),
    ).toThrow(/must never issue new signatures/);
  });

  it('refuses unparseable JSON without echoing the value', () => {
    // The value may BE the private key. An error message that quotes it puts it
    // in a log, a crash report, and an error-tracking service.
    const secret = 'MC4CAQAwBQYDK2VwBCIEIsecret-material-here';
    let message = '';
    try {
      loadIssuerKeyring(
        keyringSource({ signingEnabled: true, signingKeyJson: `{not json ${secret}` }),
      );
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).not.toContain(secret);
  });

  it('refuses a signing key whose private material is not a usable key', () => {
    expect(() =>
      loadIssuerKeyring(
        keyringSource({
          signingEnabled: true,
          signingKeyJson: JSON.stringify({
            keyId: 'adericel-2026-01',
            algorithm: 'Ed25519',
            issuer: 'Veylith',
            privateKey: 'x'.repeat(64),
          }),
        }),
      ),
    ).toThrow();
  });
});

describe('the keyring is not a way to reach private material', () => {
  it('publishableKeyring has no field that could hold a private key', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const keyring = loadIssuerKeyring(
      keyringSource({ signingEnabled: true, signingKeyJson: JSON.stringify(signing) }),
    );
    const published = JSON.stringify(publishableKeyring(keyring));
    expect(published).not.toContain(signing.privateKey);
    expect(published).toContain('"signingEnabled":true');
  });

  it('the log redactor removes the private key from anything containing one', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const logged = JSON.stringify(redact({ context: { key: signing } }));
    expect(logged).not.toContain(signing.privateKey);
    expect(logged).toContain('[redacted]');
  });

  it('redactSigningKey replaces the material with a marker', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const redacted = redactSigningKey(signing);
    expect(redacted.privateKey).toBe(REDACTED_KEY);
    expect(redacted.keyId).toBe('adericel-2026-01');
  });
});

describe('signing through the keyring', () => {
  it('refuses to sign when signing is off, rather than returning nothing', () => {
    const keyring = loadIssuerKeyring(keyringSource());
    expect(() => signWithKeyring(keyring, 'anything')).toThrow(/not configured to sign/);
  });

  it('produces a signature a holder of the published keys can verify', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const keyring = loadIssuerKeyring(
      keyringSource({ signingEnabled: true, signingKeyJson: JSON.stringify(signing) }),
    );

    const envelope = sealPassport({
      passport: PASSPORT,
      passportHash: contentHash(PASSPORT),
      passportId: '9d1f1a1e-0000-4000-8000-000000000001',
      sequence: 4,
      asOf: PASSPORT.asOf,
      issuedAt: '2026-03-01T09:00:00.000Z',
      key: keyring.signing!,
    });

    // A recipient holds only what /v1/assurance/keys returns.
    const asRecipientSeesThem = JSON.parse(
      JSON.stringify(publishableKeyring(keyring)),
    ) as ReturnType<typeof publishableKeyring>;

    expect(verifyInterchange(envelope, asRecipientSeesThem.keys).outcome).toBe('VALID');
  });
});

describe('rotation, as an operator actually performs it', () => {
  it('a passport signed by the old key still verifies after the new key takes over', () => {
    const old = generateIssuerKey({
      keyId: 'adericel-2025-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const fresh = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });

    const signedLastYear = sealPassport({
      passport: PASSPORT,
      passportHash: contentHash(PASSPORT),
      passportId: '9d1f1a1e-0000-4000-8000-000000000002',
      sequence: 1,
      asOf: PASSPORT.asOf,
      issuedAt: '2025-03-01T09:00:00.000Z',
      key: old.signing,
    });

    // The operator retires the old key and activates the new one. The old
    // public key STAYS on the keyring.
    const afterRotation = loadIssuerKeyring(
      keyringSource({
        signingEnabled: true,
        signingKeyJson: JSON.stringify(fresh.signing),
        keyringJson: JSON.stringify([
          { ...publicKeyOf(old.signing), status: 'RETIRED', retiredAt: '2026-01-01' },
        ]),
      }),
    );

    expect(verifyInterchange(signedLastYear, afterRotation.publicKeys).outcome).toBe('VALID');

    const signedToday = sealPassport({
      passport: PASSPORT,
      passportHash: contentHash(PASSPORT),
      passportId: '9d1f1a1e-0000-4000-8000-000000000003',
      sequence: 2,
      asOf: PASSPORT.asOf,
      issuedAt: '2026-03-01T09:00:00.000Z',
      key: afterRotation.signing!,
    });
    expect(verifyInterchange(signedToday, afterRotation.publicKeys).outcome).toBe('VALID');
  });

  it('dropping the retired key is what breaks history — the reason it is never dropped', () => {
    const old = generateIssuerKey({
      keyId: 'adericel-2025-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const fresh = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const signedLastYear = sealPassport({
      passport: PASSPORT,
      passportHash: contentHash(PASSPORT),
      passportId: '9d1f1a1e-0000-4000-8000-000000000004',
      sequence: 1,
      asOf: PASSPORT.asOf,
      issuedAt: '2025-03-01T09:00:00.000Z',
      key: old.signing,
    });

    const forgotten = loadIssuerKeyring(
      keyringSource({ signingEnabled: true, signingKeyJson: JSON.stringify(fresh.signing) }),
    );

    const result = verifyInterchange(signedLastYear, forgotten.publicKeys);
    expect(result.outcome).toBe('UNKNOWN_KEY');
    // And note what the recipient is told: NOT that it was tampered with.
    expect(result.detail).toContain('not evidence of tampering');
  });

  it('a revoked key verifies cryptographically and is still refused', () => {
    const compromised = generateIssuerKey({
      keyId: 'adericel-2025-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const fresh = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const signedBeforeRevocation = sealPassport({
      passport: PASSPORT,
      passportHash: contentHash(PASSPORT),
      passportId: '9d1f1a1e-0000-4000-8000-000000000005',
      sequence: 1,
      asOf: PASSPORT.asOf,
      issuedAt: '2025-03-01T09:00:00.000Z',
      key: compromised.signing,
    });

    const afterRevocation = loadIssuerKeyring(
      keyringSource({
        signingEnabled: true,
        signingKeyJson: JSON.stringify(fresh.signing),
        keyringJson: JSON.stringify([{ ...publicKeyOf(compromised.signing), status: 'REVOKED' }]),
      }),
    );

    const result = verifyInterchange(signedBeforeRevocation, afterRevocation.publicKeys);
    expect(result.outcome).toBe('REVOKED_KEY');
    expect(result.verified).toBe(false);
    // Distinct from INVALID_SIGNATURE on purpose: one is a forgery, the other
    // is a key compromise affecting many genuine documents.
    expect(result.detail).toContain('revoked');
  });
});
