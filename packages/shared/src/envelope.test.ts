import { describe, expect, it } from 'vitest';
import { createCredentialCipher } from './crypto.js';
import { createEnvelopeCipher, createLocalRootKeyProvider, type DataKeyStore } from './envelope.js';

const ROOT = 'root-secret-for-tests-at-least-32-bytes-long';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const INTEGRATION = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** In-memory store, so the cipher can be tested without a database. */
function memoryStore(): DataKeyStore & {
  keys: Map<string, { wrapped: string; organisationId: string }>;
} {
  const keys = new Map<string, { wrapped: string; organisationId: string }>();
  const currentByOrg = new Map<string, string>();
  let next = 0;
  return {
    keys,
    async current(organisationId) {
      const id = currentByOrg.get(organisationId);
      if (!id) return null;
      return { id, wrapped: keys.get(id)!.wrapped };
    },
    async byId(dataKeyId) {
      const record = keys.get(dataKeyId);
      return record ? { id: dataKeyId, ...record } : null;
    },
    async create(organisationId, wrapped) {
      const existing = currentByOrg.get(organisationId);
      if (existing) return { id: existing, wrapped: keys.get(existing)!.wrapped };
      const id = `key-${(next += 1)}`;
      keys.set(id, { wrapped, organisationId });
      currentByOrg.set(organisationId, id);
      return { id, wrapped };
    },
  };
}

function cipherWith(store: DataKeyStore, legacySecret?: string) {
  return createEnvelopeCipher({
    rootKeys: createLocalRootKeyProvider(ROOT),
    store,
    ...(legacySecret === undefined ? {} : { legacySecret }),
  });
}

describe('envelope encryption', () => {
  it('round-trips a value', async () => {
    const cipher = cipherWith(memoryStore());
    const sealed = await cipher.seal('{"clientSecret":"s3cret"}', {
      organisationId: ORG_A,
      aad: INTEGRATION,
    });
    expect(sealed.startsWith('v2.')).toBe(true);
    expect(sealed).not.toContain('s3cret');
    expect(await cipher.open(sealed, { organisationId: ORG_A, aad: INTEGRATION })).toBe(
      '{"clientSecret":"s3cret"}',
    );
  });

  it('gives each organisation its own data key', async () => {
    const store = memoryStore();
    const cipher = cipherWith(store);
    await cipher.seal('a', { organisationId: ORG_A, aad: INTEGRATION });
    await cipher.seal('b', { organisationId: ORG_B, aad: INTEGRATION });
    expect(store.keys.size).toBe(2);
    expect(new Set([...store.keys.values()].map((k) => k.organisationId))).toEqual(
      new Set([ORG_A, ORG_B]),
    );
  });

  it('creates no key material for an organisation that stores no credential', async () => {
    const store = memoryStore();
    cipherWith(store);
    expect(store.keys.size).toBe(0);
  });

  it('reuses one data key for the same organisation', async () => {
    const store = memoryStore();
    const cipher = cipherWith(store);
    await cipher.seal('a', { organisationId: ORG_A, aad: INTEGRATION });
    await cipher.seal('b', { organisationId: ORG_A, aad: 'another-integration' });
    expect(store.keys.size).toBe(1);
  });

  it('refuses to open a value under a different integration id', async () => {
    // The additional authenticated data is what stops a sealed blob being moved
    // between rows and decrypted where it does not belong.
    const cipher = cipherWith(memoryStore());
    const sealed = await cipher.seal('secret', { organisationId: ORG_A, aad: INTEGRATION });
    await expect(
      cipher.open(sealed, { organisationId: ORG_A, aad: 'a-different-integration' }),
    ).rejects.toThrow();
  });

  it('refuses to open one organisation’s value as another', async () => {
    // Even with the correct sealed string and the correct integration id, the
    // key is looked up under the organisation it belongs to.
    const cipher = cipherWith(memoryStore());
    const sealed = await cipher.seal('secret', { organisationId: ORG_A, aad: INTEGRATION });
    await expect(cipher.open(sealed, { organisationId: ORG_B, aad: INTEGRATION })).rejects.toThrow(
      /different organisation/,
    );
  });

  it('refuses a value whose data key has been deleted', async () => {
    const store = memoryStore();
    const cipher = cipherWith(store);
    const sealed = await cipher.seal('secret', { organisationId: ORG_A, aad: INTEGRATION });
    store.keys.clear();
    await expect(cipher.open(sealed, { organisationId: ORG_A, aad: INTEGRATION })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('detects a tampered ciphertext rather than returning rubbish', async () => {
    const cipher = cipherWith(memoryStore());
    const sealed = await cipher.seal('secret', { organisationId: ORG_A, aad: INTEGRATION });
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[4]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[4] = flipped.toString('base64url');
    await expect(
      cipher.open(parts.join('.'), { organisationId: ORG_A, aad: INTEGRATION }),
    ).rejects.toThrow();
  });

  it('does not wrap a data key that another root key can unwrap', async () => {
    const store = memoryStore();
    const sealed = await cipherWith(store).seal('secret', {
      organisationId: ORG_A,
      aad: INTEGRATION,
    });
    const otherRoot = createEnvelopeCipher({
      rootKeys: createLocalRootKeyProvider('a-completely-different-root-secret-value'),
      store,
    });
    await expect(
      otherRoot.open(sealed, { organisationId: ORG_A, aad: INTEGRATION }),
    ).rejects.toThrow();
  });
});

describe('opening values written before this format existed', () => {
  const LEGACY_SECRET = 'the-previous-credential-encryption-key!!!';

  it('opens a v1 value sealed by the old cipher', async () => {
    // Written by the code that shipped before envelope encryption. It has to
    // keep opening, or the upgrade loses every stored credential.
    const legacy = createCredentialCipher(LEGACY_SECRET);
    const v1 = legacy.encrypt('{"apiKey":"old"}', INTEGRATION);
    expect(v1.startsWith('v1.')).toBe(true);

    const cipher = cipherWith(memoryStore(), LEGACY_SECRET);
    expect(await cipher.open(v1, { organisationId: ORG_A, aad: INTEGRATION })).toBe(
      '{"apiKey":"old"}',
    );
  });

  it('marks a v1 value as needing re-sealing and a v2 value as not', async () => {
    const cipher = cipherWith(memoryStore(), LEGACY_SECRET);
    const v1 = createCredentialCipher(LEGACY_SECRET).encrypt('old', INTEGRATION);
    expect(cipher.needsReseal(v1)).toBe(true);

    const v2 = await cipher.seal('new', { organisationId: ORG_A, aad: INTEGRATION });
    expect(cipher.needsReseal(v2)).toBe(false);
  });

  it('says so plainly when a v1 value is present and no legacy secret is configured', async () => {
    const v1 = createCredentialCipher(LEGACY_SECRET).encrypt('old', INTEGRATION);
    await expect(
      cipherWith(memoryStore()).open(v1, { organisationId: ORG_A, aad: INTEGRATION }),
    ).rejects.toThrow(/legacy secret is configured/);
  });

  it('refuses a format it does not recognise', async () => {
    await expect(
      cipherWith(memoryStore()).open('v9.nonsense.values.here', {
        organisationId: ORG_A,
        aad: INTEGRATION,
      }),
    ).rejects.toThrow(/Unrecognised/);
  });
});

describe('two callers racing to create the first key', () => {
  it('both seal under the key that was actually kept', async () => {
    // The store's create() is what arbitrates, because the unique index is. A
    // caller that loses the race must not seal with the key it generated — that
    // value would reference a key id whose stored key is different, and nothing
    // would ever open it again.
    const store = memoryStore();
    const cipher = cipherWith(store);

    const [first, second] = await Promise.all([
      cipher.seal('one', { organisationId: ORG_A, aad: INTEGRATION }),
      cipher.seal('two', { organisationId: ORG_A, aad: INTEGRATION }),
    ]);

    expect(store.keys.size).toBe(1);
    expect(await cipher.open(first, { organisationId: ORG_A, aad: INTEGRATION })).toBe('one');
    expect(await cipher.open(second, { organisationId: ORG_A, aad: INTEGRATION })).toBe('two');
  });
});

describe('data key caching', () => {
  it('unwraps once for repeated use, and again after the cache expires', async () => {
    const store = memoryStore();
    const root = createLocalRootKeyProvider(ROOT);
    let unwraps = 0;
    let clock = 1_000;

    const cipher = createEnvelopeCipher({
      rootKeys: {
        keyId: root.keyId,
        wrap: (key, context) => root.wrap(key, context),
        unwrap: (wrapped, context) => {
          unwraps += 1;
          return root.unwrap(wrapped, context);
        },
      },
      store,
      cacheTtlMs: 60_000,
      nowEpochMs: () => clock,
    });

    const sealed = await cipher.seal('a', { organisationId: ORG_A, aad: INTEGRATION });
    // Sealing the first value generated the key, so nothing was unwrapped.
    expect(unwraps).toBe(0);

    await cipher.open(sealed, { organisationId: ORG_A, aad: INTEGRATION });
    await cipher.open(sealed, { organisationId: ORG_A, aad: INTEGRATION });
    expect(unwraps).toBe(0);

    // In a hosted deployment each unwrap is a KMS call, so this is the
    // difference between one call and one per credential in a collection run.
    clock += 61_000;
    await cipher.open(sealed, { organisationId: ORG_A, aad: INTEGRATION });
    expect(unwraps).toBe(1);
  });
});
