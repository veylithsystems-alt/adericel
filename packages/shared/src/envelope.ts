import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createCredentialCipher, deriveSubkey } from './crypto.js';

/**
 * Envelope encryption for credentials at rest.
 *
 * Sealing everything directly with one configured key works, and it has two
 * problems that only show up once there is more than one customer.
 *
 * The first is rotation. Changing the key means re-sealing every credential in
 * the deployment in one maintenance window, which is the kind of operation that
 * gets postponed indefinitely.
 *
 * The second is blast radius. One key opens every tenant's credentials, so
 * there is no such thing as compromising one organisation.
 *
 * Envelope encryption gives each organisation its own data key. The data key
 * encrypts that organisation's credentials; the root key encrypts the data key
 * and nothing else. Rotating one organisation's data key touches only its rows.
 * A data key that leaks exposes one organisation.
 *
 * The honest limit, stated because it is easy to oversell this: the root key
 * still opens every data key, so a disclosure of the root key is a disclosure of
 * everything. What changes is that the root key is now used rarely, on small
 * inputs, and can live somewhere the application cannot read — a KMS, an HSM —
 * with `RootKeyProvider` as the substitution point. Until it does, this is
 * defence in depth rather than a new guarantee, and it is the prerequisite for
 * the guarantee rather than the guarantee itself.
 *
 * Format: `v2.<dataKeyId>.<iv>.<tag>.<ciphertext>`, all base64url.
 * Version 1 values (`v1.<iv>.<tag>.<ciphertext>`, sealed directly with a key
 * derived from the root secret) still open, and are re-sealed as v2 the next
 * time they are written. There is no migration window and no stop-the-world.
 */

const ENVELOPE_VERSION = 'v2';
const LEGACY_VERSION = 'v1';

/**
 * Wraps and unwraps data keys.
 *
 * The only operations a KMS needs to support, which is the point: swapping in
 * AWS KMS, Azure Key Vault or an HSM is an implementation of this interface, not
 * a change to anything that calls it.
 */
export interface RootKeyProvider {
  /** Identifies which root key was used, so rotation is detectable. */
  readonly keyId: string;
  wrap(dataKey: Buffer, context: string): Promise<string>;
  unwrap(wrapped: string, context: string): Promise<Buffer>;
}

/** Where wrapped data keys live. Implemented over the database by the app. */
export interface DataKeyStore {
  /** The organisation's current data key, or null if it has none yet. */
  current(organisationId: string): Promise<{ id: string; wrapped: string } | null>;
  /** A specific key by id, needed to open values sealed under a rotated key. */
  byId(dataKeyId: string): Promise<{ id: string; wrapped: string; organisationId: string } | null>;
  /**
   * Store a newly generated wrapped key.
   *
   * Returns the key that is now current, which is not necessarily the one that
   * was offered: two concurrent first-credentials for the same organisation
   * both generate a key, and only one can win. The winner is returned so the
   * loser seals under the key that was actually kept.
   */
  create(
    organisationId: string,
    wrapped: string,
    rootKeyId: string,
  ): Promise<{ id: string; wrapped: string }>;
}

export interface EnvelopeCipher {
  seal(plaintext: string, context: SealContext): Promise<string>;
  open(sealed: string, context: SealContext): Promise<string>;
  /** True when the value is not in the current format and should be re-sealed. */
  needsReseal(sealed: string): boolean;
}

export interface SealContext {
  readonly organisationId: string;
  /**
   * Additional authenticated data — the integration id. A sealed value moved to
   * another integration's row fails to open rather than silently granting
   * access to a different system.
   */
  readonly aad: string;
}

/**
 * A root key provider backed by a configured secret.
 *
 * The default, and the one a single-VPS deployment uses. `keyId` is derived from
 * the secret rather than configured, so a deployment that changes its root key
 * produces data keys that are visibly wrapped under a different one.
 */
export function createLocalRootKeyProvider(secret: string): RootKeyProvider {
  // HKDF, with the purpose in `info`. The previous construction put the public
  // label in HMAC's key position and the secret in the message position, which
  // is the wrong way round and was flagged as a hard-coded credential — with
  // justification, because a key-derivation whose key is public is not keyed.
  const key = deriveSubkey(secret, 'root-key-wrapping');
  const keyId = `local:${deriveSubkey(secret, 'root-key-id').toString('hex').slice(0, 16)}`;

  return {
    keyId,
    async wrap(dataKey, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return [
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    async unwrap(wrapped, context) {
      const [ivB64, tagB64, dataB64] = wrapped.split('.');
      if (!ivB64 || !tagB64 || dataB64 === undefined) {
        throw new Error('Malformed wrapped data key');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
    },
  };
}

export interface EnvelopeCipherOptions {
  readonly rootKeys: RootKeyProvider;
  readonly store: DataKeyStore;
  /**
   * The secret v1 values were sealed with. Required to open anything written
   * before this format existed; omit it once no v1 values remain.
   */
  readonly legacySecret?: string;
  /**
   * How long an unwrapped data key stays in memory. Unwrapping is a KMS call in
   * a hosted deployment, so caching is what keeps a collection run from making
   * one per credential. Short enough that revoking a key takes effect within a
   * few minutes.
   */
  readonly cacheTtlMs?: number;
  readonly nowEpochMs?: () => number;
}

export function createEnvelopeCipher(options: EnvelopeCipherOptions): EnvelopeCipher {
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  const now = options.nowEpochMs ?? (() => Date.now());
  const cache = new Map<string, { key: Buffer; expiresAtMs: number }>();

  async function unwrapCached(
    dataKeyId: string,
    wrapped: string,
    context: string,
  ): Promise<Buffer> {
    const cached = cache.get(dataKeyId);
    if (cached && cached.expiresAtMs > now()) return cached.key;
    const key = await options.rootKeys.unwrap(wrapped, context);
    cache.set(dataKeyId, { key, expiresAtMs: now() + cacheTtlMs });
    return key;
  }

  async function dataKeyFor(organisationId: string): Promise<{ id: string; key: Buffer }> {
    const existing = await options.store.current(organisationId);
    if (existing) {
      return {
        id: existing.id,
        key: await unwrapCached(existing.id, existing.wrapped, organisationId),
      };
    }
    // First credential for this organisation. The key is generated here rather
    // than at organisation creation so that an organisation that never stores a
    // credential never has key material associated with it at all.
    const key = randomBytes(32);
    const wrapped = await options.rootKeys.wrap(key, organisationId);
    const created = await options.store.create(organisationId, wrapped, options.rootKeys.keyId);

    // A concurrent caller may have won the race. Sealing with the key that was
    // generated here while recording the id of the key that was kept would
    // produce a value nothing can ever open, so the stored key is authoritative.
    if (created.wrapped !== wrapped) {
      const kept = await unwrapCached(created.id, created.wrapped, organisationId);
      return { id: created.id, key: kept };
    }

    cache.set(created.id, { key, expiresAtMs: now() + cacheTtlMs });
    return { id: created.id, key };
  }

  return {
    needsReseal(sealed) {
      return !sealed.startsWith(`${ENVELOPE_VERSION}.`);
    },

    async seal(plaintext, context) {
      const dataKey = await dataKeyFor(context.organisationId);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', dataKey.key, iv);
      cipher.setAAD(Buffer.from(context.aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [
        ENVELOPE_VERSION,
        dataKey.id,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },

    async open(sealed, context) {
      const parts = sealed.split('.');
      const version = parts[0];

      if (version === LEGACY_VERSION) {
        if (!options.legacySecret) {
          throw new Error(
            'Value is sealed in the legacy format and no legacy secret is configured',
          );
        }
        // Delegated to the v1 cipher rather than reimplemented. Keeping a
        // second copy of a key derivation here is how the two silently diverge:
        // it happened once already, when the derivation in crypto.ts moved to
        // HKDF and this copy did not, which would have made every legacy value
        // unopenable with no test able to tell.
        return createCredentialCipher(options.legacySecret).decrypt(sealed, context.aad);
      }

      if (version !== ENVELOPE_VERSION) throw new Error('Unrecognised sealed value format');

      const [, dataKeyId, ivB64, tagB64, dataB64] = parts;
      if (!dataKeyId || !ivB64 || !tagB64 || dataB64 === undefined) {
        throw new Error('Malformed sealed value');
      }

      const record = await options.store.byId(dataKeyId);
      if (!record) throw new Error('The data key this value was sealed with no longer exists');
      // The key is unwrapped under the organisation it belongs to, not under the
      // one the caller claims. A sealed value carrying another organisation's
      // data key id therefore fails here rather than opening.
      if (record.organisationId !== context.organisationId) {
        throw new Error('Sealed value belongs to a different organisation');
      }

      const key = await unwrapCached(record.id, record.wrapped, record.organisationId);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      decipher.setAAD(Buffer.from(context.aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
