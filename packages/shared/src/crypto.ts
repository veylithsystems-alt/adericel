import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing uses scrypt from the Node standard library. This avoids a
 * native build dependency while remaining a memory-hard KDF; parameters are
 * embedded in the stored hash so they can be raised later without invalidating
 * existing credentials.
 */
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

export function createPasswordHasher(pepper = ''): PasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      const salt = randomBytes(16);
      const derived = await scrypt(password + pepper, salt, 32, SCRYPT_PARAMS);
      const { N, r, p } = SCRYPT_PARAMS;
      return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
    },
    async verify(password: string, stored: string): Promise<boolean> {
      const parts = stored.split('$');
      if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
      const [, nRaw, rRaw, pRaw, saltB64, digestB64] = parts;
      const N = Number(nRaw);
      const r = Number(rRaw);
      const p = Number(pRaw);
      if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
      const salt = Buffer.from(saltB64 ?? '', 'base64');
      const expected = Buffer.from(digestB64 ?? '', 'base64');
      if (salt.length === 0 || expected.length === 0) return false;
      const derived = await scrypt(password + pepper, salt, expected.length, {
        N,
        r,
        p,
        maxmem: Math.max(SCRYPT_PARAMS.maxmem, 128 * N * r * 2),
      });
      return constantTimeEquals(derived, expected);
    },
  };
}

export function constantTimeEquals(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the timing does not reveal length equality
    // for same-length candidates.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** HMAC-SHA256, hex encoded. Used for webhook signatures and API key lookup. */
export function hmacSha256(key: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

export function verifyHmacSha256(
  key: string | Buffer,
  payload: string | Buffer,
  signature: string,
): boolean {
  const expected = hmacSha256(key, payload);
  return constantTimeEquals(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
}

/**
 * Authenticated encryption for integration credentials at rest.
 *
 * Format: v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 * The key is derived from the configured encryption key so that any key length
 * is accepted while the cipher always receives 32 bytes.
 */
const AEAD_VERSION = 'v1';

/**
 * Derive a purpose-bound subkey from the deployment's root secret.
 *
 * This replaces a construction that CodeQL flagged as a hard-coded credential
 * and that was, on inspection, genuinely the wrong shape:
 * `createHmac('sha256', '<public label>').update(secret)` puts the public label
 * in the key position and the secret in the message position. HMAC's security
 * as a key-derivation function rests on the *key* being secret, so that
 * construction was a domain-separated hash of the secret rather than a keyed
 * derivation — and where the input was low-entropy, an attacker with the
 * database could reproduce it without knowing anything.
 *
 * HKDF is the primitive this always wanted: the root secret is the input keying
 * material, and the label is `info`, which is exactly what `info` is for.
 */
export function deriveSubkey(rootSecret: string, purpose: string, length = 32): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(rootSecret, 'utf8'), ADERICEL_HKDF_SALT, purpose, length),
  );
}

/**
 * A fixed, public salt. HKDF's salt is not required to be secret — its job is
 * domain separation between applications sharing a secret, and `info` carries
 * the per-purpose separation within Adericel.
 */
const ADERICEL_HKDF_SALT = Buffer.from('adericel/hkdf/v1', 'utf8');

function deriveKey(secret: string): Buffer {
  return deriveSubkey(secret, 'credential-encryption');
}

export interface CredentialCipher {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(sealed: string, aad?: string): string;
}

export function createCredentialCipher(secret: string): CredentialCipher {
  const key = deriveKey(secret);
  return {
    encrypt(plaintext: string, aad?: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        AEAD_VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decrypt(sealed: string, aad?: string): string {
      const [version, ivB64, tagB64, dataB64] = sealed.split('.');
      if (version !== AEAD_VERSION || !ivB64 || !tagB64 || dataB64 === undefined) {
        throw new Error('Malformed sealed credential');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

/**
 * API keys are presented as `adk_<keyId>_<secret>`. The database stores only a
 * keyed hash of the secret (see `createTokenHasher`), indexed by keyId, so a
 * disclosure does not yield usable credentials and lookup remains one indexed
 * read.
 */
export interface ApiKeyMaterial {
  readonly keyId: string;
  readonly secret: string;
  readonly presented: string;
  readonly secretHash: string;
}

export function generateApiKey(hasher: TokenHasher, prefix = 'adk'): ApiKeyMaterial {
  // Hex, not base64url, and deliberately so: the key id sits between two
  // underscore delimiters, and base64url's alphabet contains an underscore.
  // A key id that happened to include one made the presented key unparseable,
  // and roughly three in five issued keys did. The secret may still contain
  // underscores because it is the final field and is parsed as the remainder.
  const keyId = randomBytes(9).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return {
    keyId,
    secret,
    presented: `${prefix}_${keyId}_${secret}`,
    secretHash: hasher.hash('api-key', secret),
  };
}

/**
 * Keyed hashing for bearer tokens held at rest.
 *
 * Refresh tokens, API key secrets and MFA recovery codes are all the same
 * shape: a bearer value the user holds, stored only as a digest so a database
 * disclosure does not yield usable credentials. That guarantee only holds if
 * the digest is *keyed* — otherwise anyone with the table can brute-force it
 * offline, and the cost of doing so is set entirely by the token's entropy.
 *
 * The previous construction was not keyed. It passed a public label where HMAC
 * expects a secret, so the digests were reproducible by anyone. For 32-byte
 * random tokens that was survivable; for MFA recovery codes, which were 50 bits
 * so a person can type them, it was not — roughly a day of GPU time to recover
 * every code in the table and defeat the second factor guarding approvals.
 *
 * The key is derived from the deployment's root secret rather than configured
 * separately: HKDF exists so that one well-guarded secret can safely produce
 * many purpose-bound subkeys, and a fourth secret for an operator to mismanage
 * would be a worse outcome than the one it prevents.
 */
export const TOKEN_PURPOSES = ['refresh-token', 'api-key', 'recovery-code'] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export interface TokenHasher {
  hash(purpose: TokenPurpose, token: string): string;
  /** Constant-time comparison against a stored digest. */
  matches(purpose: TokenPurpose, token: string, storedHex: string): boolean;
}

export function createTokenHasher(rootSecret: string): TokenHasher {
  // Derived once. Each purpose gets its own key, so a digest from one table can
  // never be replayed against another.
  const keys = new Map<TokenPurpose, Buffer>(
    TOKEN_PURPOSES.map((purpose) => [purpose, deriveSubkey(rootSecret, `token-hash/${purpose}`)]),
  );

  return {
    hash(purpose, token) {
      const key = keys.get(purpose);
      if (!key) throw new Error(`Unknown token purpose: ${purpose}`);
      return createHmac('sha256', key).update(token, 'utf8').digest('hex');
    },
    matches(purpose, token, storedHex) {
      return constantTimeEquals(
        Buffer.from(this.hash(purpose, token), 'utf8'),
        Buffer.from(storedHex, 'utf8'),
      );
    },
  };
}

export function parseApiKey(presented: string): { keyId: string; secret: string } | null {
  // Split on the first two underscores only. The secret is base64url, whose
  // alphabet includes an underscore, so splitting on every delimiter rejected
  // most valid keys — a defect that made the majority of issued API keys fail
  // authentication as "malformed". Every key that ever worked under the old
  // parser still parses identically here.
  const firstSeparator = presented.indexOf('_');
  if (firstSeparator === -1) return null;
  const secondSeparator = presented.indexOf('_', firstSeparator + 1);
  if (secondSeparator === -1) return null;

  const prefix = presented.slice(0, firstSeparator);
  const keyId = presented.slice(firstSeparator + 1, secondSeparator);
  const secret = presented.slice(secondSeparator + 1);
  if (prefix !== 'adk' || !keyId || !secret) return null;
  return { keyId, secret };
}
