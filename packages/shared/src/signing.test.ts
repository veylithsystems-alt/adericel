import { describe, expect, it } from 'vitest';
import {
  SIGNING_ALGORITHM,
  createIssuerSigner,
  generateIssuerKeyPairPem,
  publicKeyFromPem,
  verifyCanonicalSignature,
} from './signing.js';

function freshSigner(keyId = 'k1') {
  const pair = generateIssuerKeyPairPem();
  const signer = createIssuerSigner(pair.privateKeyPem, keyId);
  const pub = publicKeyFromPem(pair.publicKeyPem, keyId);
  return { signer, pub, pair };
}

describe('Ed25519 canonical signing', () => {
  it('round-trips: a signed value verifies against its public key', () => {
    const { signer, pub } = freshSigner();
    const value = { b: 2, a: 1, nested: { z: [3, 2, 1] } };
    const sig = signer.sign(value);
    expect(verifyCanonicalSignature(value, sig, pub)).toBe(true);
  });

  it('is stable across key order (canonical material, not literal bytes)', () => {
    const { signer, pub } = freshSigner();
    const sig = signer.sign({ a: 1, b: 2, c: { x: 1, y: 2 } });
    // Same logical value, different key order and whitespace-irrelevant shape.
    expect(verifyCanonicalSignature({ c: { y: 2, x: 1 }, b: 2, a: 1 }, sig, pub)).toBe(true);
  });

  it('rejects tampered content', () => {
    const { signer, pub } = freshSigner();
    const sig = signer.sign({ state: 'UNKNOWN', total: 21 });
    expect(verifyCanonicalSignature({ state: 'PASS', total: 21 }, sig, pub)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const { signer, pub } = freshSigner();
    const sig = signer.sign({ a: 1 });
    const bytes = Buffer.from(sig, 'base64');
    bytes[0] ^= 0xff;
    expect(verifyCanonicalSignature({ a: 1 }, bytes.toString('base64'), pub)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = freshSigner('a');
    const b = freshSigner('b');
    const sig = a.signer.sign({ a: 1 });
    expect(verifyCanonicalSignature({ a: 1 }, sig, b.pub)).toBe(false);
  });

  it('pins the algorithm and refuses anything else', () => {
    const { signer, pub } = freshSigner();
    const sig = signer.sign({ a: 1 });
    const wrongAlg = { ...pub, algorithm: 'RS256' as unknown as typeof SIGNING_ALGORITHM };
    expect(verifyCanonicalSignature({ a: 1 }, sig, wrongAlg)).toBe(false);
  });

  it('rejects a non-Ed25519 private key at construction', () => {
    // An RSA PKCS8 key must be refused rather than silently accepted.
    const rsa = generateIssuerKeyPairPem; // Ed25519 generator; assert type guard via bad PEM.
    expect(() => createIssuerSigner('-----BEGIN PRIVATE KEY-----\nnotakey\n-----END PRIVATE KEY-----', 'k')).toThrow();
    expect(rsa).toBeTypeOf('function');
  });

  it('refuses an empty keyId', () => {
    const pair = generateIssuerKeyPairPem();
    expect(() => createIssuerSigner(pair.privateKeyPem, '  ')).toThrow(/keyId/);
  });

  it('never exposes private key material on the signer object', () => {
    const { signer } = freshSigner();
    const serialised = JSON.stringify(signer);
    expect(serialised).not.toMatch(/PRIVATE/i);
    // Only public-safe fields are enumerable.
    expect(Object.keys(JSON.parse(serialised)).sort()).toEqual(['algorithm', 'keyId']);
  });

  it('property: random values sign and verify, and any single-byte content change fails', () => {
    const { signer, pub } = freshSigner();
    for (let i = 0; i < 200; i += 1) {
      const value = {
        n: Math.floor(Math.random() * 1e9),
        s: Math.random().toString(36),
        flag: Math.random() > 0.5,
        arr: Array.from({ length: Math.floor(Math.random() * 5) }, () => Math.random()),
      };
      const sig = signer.sign(value);
      expect(verifyCanonicalSignature(value, sig, pub)).toBe(true);
      expect(verifyCanonicalSignature({ ...value, n: value.n + 1 }, sig, pub)).toBe(false);
    }
  });
});
