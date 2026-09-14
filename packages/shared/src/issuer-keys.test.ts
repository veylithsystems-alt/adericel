import { describe, expect, it } from 'vitest';
import { activeKeyId, issuerKeyRingSchema, publishableKeys } from './issuer-keys.js';
import { generateIssuerKeyPairPem } from './signing.js';

function descriptor(keyId: string, status: 'ACTIVE' | 'RETIRED') {
  const { publicKeyPem } = generateIssuerKeyPairPem();
  return {
    keyId,
    status,
    algorithm: 'Ed25519' as const,
    publicKeyPem,
    activatedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: status === 'RETIRED' ? '2026-06-01T00:00:00.000Z' : null,
  };
}

describe('issuer key ring', () => {
  it('accepts one active key and any number of retired keys', () => {
    const ring = issuerKeyRingSchema.parse({
      issuerName: 'Adericel',
      keys: [descriptor('2026', 'ACTIVE'), descriptor('2025', 'RETIRED'), descriptor('2024', 'RETIRED')],
    });
    expect(activeKeyId(ring)).toBe('2026');
    expect(publishableKeys(ring)).toHaveLength(3);
  });

  it('rejects more than one active key', () => {
    expect(() =>
      issuerKeyRingSchema.parse({ keys: [descriptor('a', 'ACTIVE'), descriptor('b', 'ACTIVE')] }),
    ).toThrow(/ACTIVE/);
  });

  it('rejects duplicate keyIds', () => {
    expect(() =>
      issuerKeyRingSchema.parse({ keys: [descriptor('dup', 'ACTIVE'), descriptor('dup', 'RETIRED')] }),
    ).toThrow(/Duplicate/);
  });

  it('publishes retired keys so historical verification survives retirement', () => {
    const ring = issuerKeyRingSchema.parse({ keys: [descriptor('old', 'RETIRED')] });
    expect(publishableKeys(ring).map((k) => k.keyId)).toContain('old');
    expect(activeKeyId(ring)).toBeNull();
  });
});
