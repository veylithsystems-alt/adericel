import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from './canonical.js';
import {
  generateIssuerKey,
  publicKeyOf,
  redactSigningKey,
  REDACTED_KEY,
  signCanonical,
  verifyCanonical,
  type IssuerPublicKey,
} from './issuer-key.js';
import {
  INTERCHANGE_SCHEMA,
  materialOf,
  sealPassport,
  verifyInterchange,
  VERIFICATION_OUTCOMES,
  type PassportInterchange,
} from './passport-interchange.js';

/**
 * The interchange, attacked.
 *
 * A signature is only worth having if a forged or altered record fails. So most
 * of this file is attempts to make verification pass when it should not: edited
 * content, edited hashes, borrowed signatures, relabelled keys, downgraded
 * algorithms, unknown versions.
 *
 * A green happy-path test proves the code runs. These prove it refuses.
 */

const ISSUER = 'Veylith Systems Ltd';
/** Fixed, because a key's provenance date is data, not a wall-clock read. */
const REGISTERED_AT = '2026-01-01T00:00:00.000Z';

function issuer(keyId = 'adericel-test-1') {
  const generated = generateIssuerKey({ keyId, issuer: ISSUER, registeredAt: REGISTERED_AT });
  return {
    signing: generated.signing,
    publicKey: publicKeyOf(generated.signing, 'ACTIVE', generated.registeredAt),
  };
}

/** A passport whose content includes an UNKNOWN, because that must survive. */
const PASSPORT = {
  schema: 'adericel.passport/v1',
  organisation: { name: 'Northgate Joinery Ltd', countryCode: 'GB' },
  asOf: '2026-09-15T09:00:00.000Z',
  state: 'UNKNOWN',
  summary: {
    total: 26,
    satisfied: 14,
    failing: 3,
    unknown: 9,
    excepted: 1,
    notApplicable: 0,
    coverage: { determined: 17, inScope: 26 },
  },
  controls: [
    { key: 'identity.mfa.enforced', state: 'SATISFIED', unknownReason: null },
    { key: 'device.disk.encrypted', state: 'UNKNOWN', unknownReason: 'NO_EVIDENCE' },
  ],
  exceptions: [
    {
      control: 'identity.admin.separate',
      justification: 'Time-bounded admin exception',
      expiresAt: '2026-12-01T00:00:00.000Z',
    },
  ],
  interpretation: 'UNKNOWN means Adericel could not establish the fact, not that it is satisfied.',
};

function seal(key = issuer()): { envelope: PassportInterchange; publicKey: IssuerPublicKey } {
  return {
    envelope: sealPassport({
      passport: PASSPORT,
      passportHash: contentHash(PASSPORT),
      passportId: '11111111-1111-4111-8111-111111111111',
      sequence: 4,
      asOf: PASSPORT.asOf,
      issuedAt: '2026-09-15T09:05:00.000Z',
      key: key.signing,
    }),
    publicKey: key.publicKey,
  };
}

describe('sign and verify', () => {
  it('verifies a passport it sealed', () => {
    const { envelope, publicKey } = seal();
    const result = verifyInterchange(envelope, [publicKey]);
    expect(result.outcome).toBe('VALID');
    expect(result.verified).toBe(true);
    expect(result.issuer).toBe(ISSUER);
    expect(result.asOf).toBe(PASSPORT.asOf);
  });

  it('says what the signature does and does not establish', () => {
    // "Signed" reads as "approved" to almost everybody, and this passport
    // reports nine UNKNOWN controls.
    const { envelope, publicKey } = seal();
    const result = verifyInterchange(envelope, [publicKey]);
    expect(result.detail).toContain('has not been altered');
    expect(result.detail).toContain('not that the assurance it reports is satisfactory');
  });

  it('verifies with nothing but the envelope and a public key', () => {
    // No database, no network, no tenant context, no clock. Independent
    // verification means independent of Adericel.
    const { envelope, publicKey } = seal();
    const roundTripped = JSON.parse(JSON.stringify(envelope)) as unknown;
    const detached: IssuerPublicKey = JSON.parse(JSON.stringify(publicKey)) as IssuerPublicKey;
    expect(verifyInterchange(roundTripped, [detached]).outcome).toBe('VALID');
  });

  it('is deterministic', () => {
    const { envelope, publicKey } = seal();
    const first = verifyInterchange(envelope, [publicKey]);
    const second = verifyInterchange(envelope, [publicKey]);
    expect(first).toEqual(second);
  });
});

describe('tampering', () => {
  it('rejects an edited assurance state', () => {
    // The attack that matters: turning UNKNOWN into something reassuring.
    const { envelope, publicKey } = seal();
    const forged = structuredClone(envelope) as PassportInterchange & {
      passport: { state: string };
    };
    forged.passport.state = 'SATISFIED';
    const result = verifyInterchange(forged, [publicKey]);
    expect(result.outcome).toBe('INVALID_SIGNATURE');
    expect(result.detail).toContain('altered since it was issued');
  });

  it('rejects a removed exception', () => {
    const { envelope, publicKey } = seal();
    const forged = structuredClone(envelope) as PassportInterchange & {
      passport: { exceptions: unknown[] };
    };
    forged.passport.exceptions = [];
    expect(verifyInterchange(forged, [publicKey]).outcome).toBe('INVALID_SIGNATURE');
  });

  it('rejects an edited summary count', () => {
    const { envelope, publicKey } = seal();
    const forged = structuredClone(envelope) as PassportInterchange & {
      passport: { summary: { unknown: number } };
    };
    forged.passport.summary.unknown = 0;
    expect(verifyInterchange(forged, [publicKey]).outcome).toBe('INVALID_SIGNATURE');
  });

  it('rejects an edited as-of date', () => {
    // Making stale assurance look current.
    const { envelope, publicKey } = seal();
    const forged = { ...envelope, asOf: '2026-09-15T23:59:00.000Z' };
    expect(verifyInterchange(forged, [publicKey]).outcome).toBe('INVALID_SIGNATURE');
  });

  it('rejects a tampered signature', () => {
    const { envelope, publicKey } = seal();
    const flipped = envelope.signature.slice(0, -4) + 'AAAA';
    expect(verifyInterchange({ ...envelope, signature: flipped }, [publicKey]).outcome).toBe(
      'INVALID_SIGNATURE',
    );
  });

  it('rejects a signature borrowed from another passport', () => {
    const key = issuer();
    const first = seal(key);
    const other = sealPassport({
      passport: { ...PASSPORT, state: 'SATISFIED' },
      passportHash: contentHash({ ...PASSPORT, state: 'SATISFIED' }),
      passportId: '22222222-2222-4222-8222-222222222222',
      sequence: 5,
      asOf: PASSPORT.asOf,
      issuedAt: '2026-09-15T09:06:00.000Z',
      key: key.signing,
    });
    const spliced = { ...first.envelope, signature: other.signature };
    expect(verifyInterchange(spliced, [first.publicKey]).outcome).toBe('INVALID_SIGNATURE');
  });

  it('rejects a relabelled key id', () => {
    // keyId is inside the signed material as well as on the envelope. Without
    // that, a valid signature could be relabelled as made by another key and a
    // verifier checking a revocation list would be reading an attacker's value.
    const { envelope, publicKey } = seal();
    const relabelled = { ...envelope, keyId: 'some-other-key' };
    // Reported as UNKNOWN_KEY when the verifier does not hold it...
    expect(verifyInterchange(relabelled, [publicKey]).outcome).toBe('UNKNOWN_KEY');
    // ...and as a bad signature when they do, because the material changed.
    const impostor = { ...publicKey, keyId: 'some-other-key' };
    expect(verifyInterchange(relabelled, [impostor]).outcome).toBe('INVALID_SIGNATURE');
  });

  it('rejects a passport whose hash was edited to match altered content', () => {
    // Both content and hash changed consistently — which the passport's own
    // hash check would accept, and the signature will not.
    const { envelope, publicKey } = seal();
    const altered = { ...PASSPORT, state: 'SATISFIED' };
    const forged = {
      ...envelope,
      passport: altered,
      passportHash: contentHash(altered),
    };
    expect(verifyInterchange(forged, [publicKey]).outcome).toBe('INVALID_SIGNATURE');
  });
});

describe('wrong and unknown keys', () => {
  it('rejects a signature made by a different issuer key', () => {
    const { envelope } = seal(issuer('adericel-test-1'));
    const attacker = issuer('adericel-test-1');
    // Same key id, different key material: the classic impersonation attempt.
    expect(verifyInterchange(envelope, [attacker.publicKey]).outcome).toBe('INVALID_SIGNATURE');
  });

  it('distinguishes a key it does not hold from a forgery', () => {
    const { envelope } = seal(issuer('adericel-rotated-2'));
    const other = issuer('adericel-test-1');
    const result = verifyInterchange(envelope, [other.publicKey]);
    // These call for entirely different responses: one is an incident, the
    // other is a missing download.
    expect(result.outcome).toBe('UNKNOWN_KEY');
    expect(result.detail).toContain('not evidence of tampering');
  });

  it('refuses a revoked key without calling it a forgery', () => {
    const key = issuer();
    const { envelope } = seal(key);
    const revoked: IssuerPublicKey = { ...key.publicKey, status: 'REVOKED' };
    const result = verifyInterchange(envelope, [revoked]);
    expect(result.outcome).toBe('REVOKED_KEY');
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('has been revoked');
  });
});

describe('malformed and unsupported input', () => {
  it('answers rather than throwing on hostile input', () => {
    const { publicKey } = seal();
    for (const hostile of [null, undefined, 42, 'a string', [], {}, { schema: 'something-else' }]) {
      const result = verifyInterchange(hostile, [publicKey]);
      expect(result.outcome).toBe('MALFORMED');
      expect(result.verified).toBe(false);
    }
  });

  it('tells a verifier when the version is one it does not implement', () => {
    const { envelope, publicKey } = seal();
    const future = { ...envelope, schema: 'adericel.passport-interchange/v99' };
    const result = verifyInterchange(future, [publicKey]);
    // Distinct from MALFORMED so the verifier knows to go and find a newer one.
    expect(result.outcome).toBe('UNSUPPORTED_VERSION');
    expect(result.detail).toContain(INTERCHANGE_SCHEMA);
  });

  it('refuses to attempt an algorithm it does not accept', () => {
    const { envelope, publicKey } = seal();
    // Pinned, not negotiated. Attempting an algorithm because the document
    // asked for it is how a verifier accepts something weaker.
    const downgraded = { ...envelope, algorithm: 'RS256' };
    const result = verifyInterchange(downgraded, [publicKey]);
    // Reported as an algorithm problem, not a version problem. An adversarial
    // test caught this being conflated, which would have sent a verifier
    // looking for a newer tool while somebody negotiated them down.
    expect(result.outcome).toBe('UNSUPPORTED_ALGORITHM');
    expect(result.detail).toContain('will not be attempted');
    expect(result.verified).toBe(false);
  });

  it('names every outcome it can return', () => {
    // A change to this list changes what a verifier can be told.
    expect([...VERIFICATION_OUTCOMES].sort()).toEqual([
      'CONTENT_HASH_MISMATCH',
      'INVALID_SIGNATURE',
      'MALFORMED',
      'REVOKED_KEY',
      'UNKNOWN_KEY',
      'UNSUPPORTED_ALGORITHM',
      'UNSUPPORTED_VERSION',
      'VALID',
    ]);
  });
});

describe('canonicalisation', () => {
  it('verifies regardless of key order in transit', () => {
    // JSON key order is not preserved by every transport. If verification
    // depended on it, a passport would fail for being routed through the wrong
    // proxy, which is indistinguishable from tampering to the recipient.
    const { envelope, publicKey } = seal();
    const reordered = Object.fromEntries(
      Object.entries(envelope).reverse(),
    ) as unknown as PassportInterchange;
    expect(verifyInterchange(reordered, [publicKey]).outcome).toBe('VALID');
  });

  it('signs the same bytes the verifier reconstructs', () => {
    const key = issuer();
    const { envelope } = seal(key);
    const material = canonicalJson(materialOf(envelope));
    expect(verifyCanonical(material, envelope.signature, key.publicKey)).toBe(true);
  });

  it('states its canonicalisation in the envelope', () => {
    // A verifier who canonicalises differently gets a false negative and no way
    // to tell that from tampering.
    const { envelope } = seal();
    expect(envelope.canonicalisation).toBe('adericel.canonical-json/v1');
  });
});

describe('refusing to sign a bad record', () => {
  it('will not seal content that disagrees with its recorded hash', () => {
    // Sealing it would put a valid signature over a corrupted record: the one
    // outcome this whole mechanism exists to prevent.
    const key = issuer();
    expect(() =>
      sealPassport({
        passport: PASSPORT,
        passportHash: 'sha256:' + '0'.repeat(64),
        passportId: 'x',
        sequence: 1,
        asOf: PASSPORT.asOf,
        issuedAt: PASSPORT.asOf,
        key: key.signing,
      }),
    ).toThrow(/does not match its recorded hash/);
  });
});

describe('key material never leaks', () => {
  it('redacts private material when a key is serialised', () => {
    const key = issuer();
    const redacted = redactSigningKey(key.signing);
    expect(redacted.privateKey).toBe(REDACTED_KEY);
    expect(JSON.stringify(redacted)).not.toContain(key.signing.privateKey);
  });

  it('never puts private material in an envelope', () => {
    const key = issuer();
    const { envelope } = seal(key);
    const serialised = JSON.stringify(envelope);
    expect(serialised).not.toContain(key.signing.privateKey);
    // Nor any recognisable fragment of it.
    expect(serialised).not.toContain(key.signing.privateKey.slice(0, 24));
  });

  it('publishes a public key that verifies but cannot sign', () => {
    const key = issuer();
    const material = canonicalJson({ hello: 'world' });
    const signature = signCanonical(material, key.signing);
    expect(verifyCanonical(material, signature, key.publicKey)).toBe(true);
    // The published object contains only the SPKI public half.
    expect(JSON.stringify(key.publicKey)).not.toContain(key.signing.privateKey);
  });
});

describe('key rotation and historical verification', () => {
  it('verifies a passport signed by a retired key', () => {
    // Retired keys are never destroyed. Destroying one would make every
    // passport it signed unverifiable, which looks exactly like forgery.
    const old = issuer('adericel-2025-1');
    const { envelope } = seal(old);
    const retired: IssuerPublicKey = {
      ...old.publicKey,
      status: 'RETIRED',
      retiredAt: '2026-01-01T00:00:00.000Z',
    };
    const current = issuer('adericel-2026-1');
    // A verifier holding both keys verifies the old record against the old key.
    expect(verifyInterchange(envelope, [current.publicKey, retired]).outcome).toBe('VALID');
  });

  it('verifies new and old passports side by side after rotation', () => {
    const old = issuer('adericel-2025-1');
    const current = issuer('adericel-2026-1');
    const historical = seal(old).envelope;
    const recent = seal(current).envelope;
    const keyring = [{ ...old.publicKey, status: 'RETIRED' as const }, current.publicKey];
    expect(verifyInterchange(historical, keyring).outcome).toBe('VALID');
    expect(verifyInterchange(recent, keyring).outcome).toBe('VALID');
  });
});

describe('the passport survives the envelope intact', () => {
  it('carries UNKNOWN through unchanged', () => {
    const { envelope } = seal();
    const passport = envelope.passport as typeof PASSPORT;
    expect(passport.state).toBe('UNKNOWN');
    expect(passport.summary.unknown).toBe(9);
    expect(passport.controls.some((c) => c.state === 'UNKNOWN')).toBe(true);
  });

  it('carries exceptions and their expiry through unchanged', () => {
    const { envelope } = seal();
    const passport = envelope.passport as typeof PASSPORT;
    expect(passport.exceptions).toHaveLength(1);
    expect(passport.exceptions[0]?.expiresAt).toBe('2026-12-01T00:00:00.000Z');
  });

  it('adds nothing, removes nothing and reorders nothing', () => {
    // The whole value of the envelope is that the thing verified is the thing
    // issued. Any reshaping here would break that.
    const { envelope } = seal();
    expect(envelope.passport).toEqual(PASSPORT);
    expect(contentHash(envelope.passport)).toBe(contentHash(PASSPORT));
  });

  it('never produces a score or a simplification', () => {
    const { envelope } = seal();
    const serialised = JSON.stringify(envelope).toLowerCase();
    expect(serialised).not.toContain('"score"');
    expect(serialised).not.toContain('percentage');
    expect(serialised).not.toContain('"compliant":true');
  });
});
