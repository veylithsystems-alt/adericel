import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentHash } from './canonical.js';
import {
  PASSPORT_INTERCHANGE_SCHEMA,
  buildInterchange,
  keySetResolver,
  verifyInterchange,
} from './passport-interchange.js';
import { createIssuerSigner, generateIssuerKeyPairPem, publicKeyFromPem } from './signing.js';

function issuer(keyId = 'adericel-2026-09') {
  const pair = generateIssuerKeyPairPem();
  const signer = createIssuerSigner(pair.privateKeyPem, keyId);
  const pub = publicKeyFromPem(pair.publicKeyPem, keyId);
  return { signer, pub };
}

// A passport-shaped content object that deliberately carries UNKNOWN and an
// exception, because their survival across the boundary is the invariant.
const CONTENT = {
  schema: 'adericel.passport/v1',
  organisation: { name: 'Northwind Ltd', countryCode: 'GB' },
  asOf: '2026-09-14T00:00:00.000Z',
  state: 'UNKNOWN',
  summary: {
    total: 30,
    satisfied: 8,
    failing: 1,
    unknown: 21,
    excepted: 0,
    notApplicable: 0,
    coverage: { determined: 9, inScope: 30 },
  },
  exceptions: [{ control: 'CE.1', justification: 'Compensating control in place', expiresAt: '2027-01-01T00:00:00.000Z' }],
  interpretation: 'UNKNOWN is not a pass.',
};

function envelope(keyId?: string) {
  const { signer, pub } = issuer(keyId);
  const env = buildInterchange(signer, {
    issuerName: 'Adericel',
    content: CONTENT,
    asOf: CONTENT.asOf,
    issuedAt: '2026-09-14T09:00:00.000Z',
  });
  return { env, pub };
}

describe('passport interchange envelope', () => {
  it('builds a well-formed, hashed, signed envelope', () => {
    const { env } = envelope();
    expect(env.schema).toBe(PASSPORT_INTERCHANGE_SCHEMA);
    expect(env.contentHash).toBe(contentHash(CONTENT));
    expect(env.issuer.algorithm).toBe('Ed25519');
    expect(env.signature.length).toBeGreaterThan(0);
  });

  it('verifies VALID against a trusted key set — offline, no I/O', () => {
    const { env, pub } = envelope();
    const result = verifyInterchange(env, keySetResolver([pub]));
    expect(result.verdict).toBe('VALID');
    expect(result.issuer?.name).toBe('Adericel');
    expect(result.asOf).toBe(CONTENT.asOf);
  });

  it('preserves UNKNOWN and exceptions across the boundary', () => {
    const { env, pub } = envelope();
    const result = verifyInterchange(env, keySetResolver([pub]));
    expect(result.verdict).toBe('VALID');
    // The content is verbatim: UNKNOWN never becomes PASS through interchange.
    expect((env.content as typeof CONTENT).state).toBe('UNKNOWN');
    expect((env.content as typeof CONTENT).summary.unknown).toBe(21);
    expect((env.content as typeof CONTENT).exceptions).toHaveLength(1);
  });

  it('returns INVALID when content is tampered after signing', () => {
    const { env, pub } = envelope();
    const tampered = { ...env, content: { ...CONTENT, state: 'PASS', summary: { ...CONTENT.summary, unknown: 0, satisfied: 29 } } };
    expect(verifyInterchange(tampered, keySetResolver([pub])).verdict).toBe('INVALID');
  });

  it('returns INVALID when the signature is tampered', () => {
    const { env, pub } = envelope();
    const bytes = Buffer.from(env.signature, 'base64');
    bytes[1] ^= 0x80;
    expect(verifyInterchange({ ...env, signature: bytes.toString('base64') }, keySetResolver([pub])).verdict).toBe('INVALID');
  });

  it('returns UNKNOWN_KEY when the signing key is not trusted', () => {
    const { env } = envelope('key-A');
    const other = issuer('key-B');
    expect(verifyInterchange(env, keySetResolver([other.pub])).verdict).toBe('UNKNOWN_KEY');
  });

  it('returns UNKNOWN_KEY when a forged envelope names a key the verifier lacks', () => {
    const { env } = envelope('genuine');
    const forged = { ...env, issuer: { ...env.issuer, keyId: 'made-up' } };
    expect(verifyInterchange(forged, () => null).verdict).toBe('UNKNOWN_KEY');
  });

  it('returns MALFORMED for a non-envelope', () => {
    expect(verifyInterchange({ hello: 'world' }, () => null).verdict).toBe('MALFORMED');
    expect(verifyInterchange(null, () => null).verdict).toBe('MALFORMED');
  });

  it('returns UNSUPPORTED_VERSION for a different schema', () => {
    const { env, pub } = envelope();
    const future = { ...env, schema: 'adericel.passport-interchange/v2' };
    expect(verifyInterchange(future, keySetResolver([pub])).verdict).toBe('UNSUPPORTED_VERSION');
  });

  it('returns MALFORMED when the hash field disagrees with content', () => {
    const { env, pub } = envelope();
    // Signature still valid over content, but the convenience hash is wrong.
    const bad = { ...env, contentHash: 'sha256:' + '0'.repeat(64) };
    expect(verifyInterchange(bad, keySetResolver([pub])).verdict).toBe('MALFORMED');
  });

  it('supports rotation: retired key still verifies historical envelopes', () => {
    const retired = issuer('2025-key');
    const active = issuer('2026-key');
    const historical = buildInterchange(retired.signer, {
      issuerName: 'Adericel',
      content: CONTENT,
      asOf: CONTENT.asOf,
      issuedAt: '2025-06-01T00:00:00.000Z',
    });
    // A verifier holding both keys (retired retained) verifies the old record.
    expect(verifyInterchange(historical, keySetResolver([retired.pub, active.pub])).verdict).toBe('VALID');
  });

  it('is deterministic: the same inputs give the same verdict', () => {
    const { env, pub } = envelope();
    const r1 = verifyInterchange(env, keySetResolver([pub]));
    const r2 = verifyInterchange(env, keySetResolver([pub]));
    expect(r1).toEqual(r2);
  });

  it('conforms to the published JSON Schema shape (required fields present)', () => {
    const { env } = envelope();
    const schemaPath = fileURLToPath(new URL('./passport-interchange.schema.json', import.meta.url));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    for (const field of schema.required) {
      expect(env).toHaveProperty(field);
    }
    expect(schema.properties.schema.const).toBe(PASSPORT_INTERCHANGE_SCHEMA);
    expect(schema.properties.contentHash.pattern).toBeDefined();
    expect(new RegExp(schema.properties.contentHash.pattern).test(env.contentHash)).toBe(true);
  });

  it('never embeds private key material', () => {
    const { env } = envelope();
    expect(JSON.stringify(env)).not.toMatch(/PRIVATE/i);
  });
});
