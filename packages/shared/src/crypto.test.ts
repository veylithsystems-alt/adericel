import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  createCredentialCipher,
  createTokenHasher,
  deriveSubkey,
  generateApiKey,
  parseApiKey,
  TOKEN_PURPOSES,
} from './crypto.js';

const hasher = createTokenHasher('a-test-root-secret-of-sufficient-length-32');

describe('API key material', () => {
  it('round-trips every key it generates', () => {
    // Generated keys used to be unparseable whenever the key id happened to
    // contain a base64url underscore — which was about three in five. The
    // symptom was "Malformed API key" on a key the system had just issued, and
    // nothing caught it because no test ever minted one and presented it back.
    const failures: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const key = generateApiKey(hasher);
      const parsed = parseApiKey(key.presented);
      if (!parsed || parsed.keyId !== key.keyId || parsed.secret !== key.secret) {
        failures.push(key.presented);
      }
    }
    expect(failures).toEqual([]);
  });

  it('generates key ids that cannot collide with the delimiter', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateApiKey(hasher).keyId).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('parses a secret that contains underscores', () => {
    // The secret stays base64url and is the final field, so underscores in it
    // are fine — but only because it is parsed as the remainder rather than
    // split on.
    const parsed = parseApiKey('adk_0123456789abcdef01_aa_bb__cc');
    expect(parsed).toEqual({ keyId: '0123456789abcdef01', secret: 'aa_bb__cc' });
  });

  it('rejects malformed keys rather than guessing', () => {
    for (const bad of [
      '',
      'adk',
      'adk_',
      'adk_onlykeyid',
      'wrong_keyid_secret',
      '_a_b',
      'adk__b',
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('stores only a keyed digest of the secret', () => {
    const key = generateApiKey(hasher);
    expect(key.secretHash).not.toContain(key.secret);
    expect(hasher.matches('api-key', key.secret, key.secretHash)).toBe(true);
    expect(hasher.matches('api-key', `${key.secret}x`, key.secretHash)).toBe(false);
  });

  it('has enough entropy that the digest cannot be brute-forced offline', () => {
    // 32 random bytes. The keyed hash is the second line of defence; this is
    // the first, and it is the one that does not depend on a secret staying
    // secret.
    const key = generateApiKey(hasher);
    expect(Buffer.from(key.secret, 'base64url')).toHaveLength(32);
  });
});

describe('token hashing', () => {
  it('separates purposes, so one token class cannot be replayed as another', () => {
    const token = 'the-same-token-value';
    const digests = TOKEN_PURPOSES.map((purpose) => hasher.hash(purpose, token));
    expect(new Set(digests).size).toBe(TOKEN_PURPOSES.length);
    for (const purpose of TOKEN_PURPOSES) {
      for (const other of TOKEN_PURPOSES) {
        expect(hasher.matches(purpose, token, hasher.hash(other, token))).toBe(purpose === other);
      }
    }
  });

  it('depends on the root secret, not only on the label', () => {
    const other = createTokenHasher('a-different-root-secret-of-length-32-ok');
    expect(other.hash('api-key', 'token')).not.toBe(hasher.hash('api-key', 'token'));
  });
});

describe('subkey derivation', () => {
  it('is deterministic for a purpose and divergent between purposes', () => {
    expect(deriveSubkey('root', 'a')).toEqual(deriveSubkey('root', 'a'));
    expect(deriveSubkey('root', 'a')).not.toEqual(deriveSubkey('root', 'b'));
    expect(deriveSubkey('root', 'a')).not.toEqual(deriveSubkey('other-root', 'a'));
  });
});

describe('credential cipher', () => {
  it('detects a tampered ciphertext rather than returning wrong plaintext', () => {
    const cipher = createCredentialCipher('a-test-root-secret-of-sufficient-length-32');
    const sealed = cipher.encrypt('{"token":"secret"}', 'integration-1');
    expect(cipher.decrypt(sealed, 'integration-1')).toBe('{"token":"secret"}');

    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'), 'integration-1')).toThrow();
  });

  it('refuses to decrypt under a different integration', () => {
    const cipher = createCredentialCipher('a-test-root-secret-of-sufficient-length-32');
    const sealed = cipher.encrypt('{"token":"secret"}', 'integration-1');
    // The integration id is the AAD, so a credential sealed for one integration
    // cannot be unsealed in the context of another.
    expect(() => cipher.decrypt(sealed, 'integration-2')).toThrow();
  });
});

describe('constant-time comparison', () => {
  it('is correct for equal, unequal and differently sized inputs', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });
});
