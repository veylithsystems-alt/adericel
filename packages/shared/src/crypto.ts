import {
  createCipheriv,
  createDecipheriv,
  createHmac,
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

function deriveKey(secret: string): Buffer {
  return createHmac('sha256', 'adericel-credential-encryption').update(secret).digest();
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
 * hash of the secret, keyed by keyId, so a database disclosure does not yield
 * usable credentials and lookup remains a single indexed read.
 */
export interface ApiKeyMaterial {
  readonly keyId: string;
  readonly secret: string;
  readonly presented: string;
  readonly secretHash: string;
}

export function generateApiKey(prefix = 'adk'): ApiKeyMaterial {
  const keyId = randomBytes(9).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return {
    keyId,
    secret,
    presented: `${prefix}_${keyId}_${secret}`,
    secretHash: hashApiKeySecret(secret),
  };
}

export function hashApiKeySecret(secret: string): string {
  return createHmac('sha256', 'adericel-api-key').update(secret).digest('hex');
}

export function parseApiKey(presented: string): { keyId: string; secret: string } | null {
  const parts = presented.split('_');
  if (parts.length !== 3) return null;
  const [prefix, keyId, secret] = parts;
  if (prefix !== 'adk' || !keyId || !secret) return null;
  return { keyId, secret };
}
