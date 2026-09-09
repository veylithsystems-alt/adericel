import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCredentialCipher } from '@adericel/shared';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * Credential sealing, against a real database.
 *
 * The unit tests in packages/shared prove the cipher. These prove the wiring:
 * that a credential written by the previous release still opens, that it
 * re-seals itself, and that the per-organisation key is really per organisation
 * rather than one key with a column next to it.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('credential sealing', () => {
  let harness: Harness;
  let alpha: SeededTenant;
  let beta: SeededTenant;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    alpha = await seedTenant(harness, { slug: 'seal-alpha', records: [] });
    beta = await seedTenant(harness, { slug: 'seal-beta', records: [] });
  });

  afterAll(async () => {
    await harness.close();
  });

  const sealedFor = (integrationId: string) =>
    harness.db.withPlatform(async (ctx) =>
      ctx.one<{ sealed_credentials: string | null }>(
        `SELECT sealed_credentials FROM integrations WHERE id = $1`,
        [integrationId],
      ),
    );

  it('gives each organisation its own data key', async () => {
    await harness.app.credentials.seal('{"a":1}', {
      organisationId: alpha.organisationId,
      aad: alpha.integrationId,
    });
    await harness.app.credentials.seal('{"b":2}', {
      organisationId: beta.organisationId,
      aad: beta.integrationId,
    });

    const keys = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ organisation_id: string }>(
        `SELECT organisation_id FROM organisation_data_keys WHERE retired_at IS NULL`,
      ),
    );
    expect(new Set(keys.map((k) => k.organisation_id))).toEqual(
      new Set([alpha.organisationId, beta.organisationId]),
    );
  });

  it('never writes key material in the clear', async () => {
    const rows = await harness.db.withPlatform(async (ctx) =>
      ctx.many<{ wrapped_key: string }>(`SELECT wrapped_key FROM organisation_data_keys`),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A wrapped key is three base64url segments. Anything shorter or
      // differently shaped would mean something was stored raw.
      expect(row.wrapped_key.split('.')).toHaveLength(3);
      expect(row.wrapped_key).not.toMatch(/[^A-Za-z0-9_.-]/);
    }
  });

  it('refuses to open one organisation’s credential as another', async () => {
    const sealed = await harness.app.credentials.seal('{"secret":"alpha"}', {
      organisationId: alpha.organisationId,
      aad: alpha.integrationId,
    });
    await expect(
      harness.app.credentials.open(sealed, {
        organisationId: beta.organisationId,
        aad: alpha.integrationId,
      }),
    ).rejects.toThrow();
  });

  it('opens a credential written by the previous release, and re-seals it', async () => {
    // Exactly what is on disk after an upgrade: a v1 value, sealed directly
    // with the configured secret. Written straight to the column, bypassing the
    // new cipher, because that is how it got there.
    const legacy = createCredentialCipher(harness.config.auth.credentialEncryptionKey);
    const v1 = legacy.encrypt(
      JSON.stringify({ apiKey: 'from-the-old-release' }),
      alpha.integrationId,
    );
    expect(v1.startsWith('v1.')).toBe(true);

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE integrations SET sealed_credentials = $2 WHERE id = $1`, [
        alpha.integrationId,
        v1,
      ]);
    });

    const opened = await harness.app.unsealCredentials(
      v1,
      alpha.integrationId,
      alpha.organisationId,
    );
    expect(opened).toEqual({ apiKey: 'from-the-old-release' });

    // Re-sealing happens in the background so that an opportunistic write
    // cannot fail a successful read. Wait for it rather than asserting
    // immediately, which would be a race dressed up as a test.
    await expect
      .poll(async () => (await sealedFor(alpha.integrationId))?.sealed_credentials?.slice(0, 3), {
        timeout: 3000,
      })
      .toBe('v2.');

    const resealed = (await sealedFor(alpha.integrationId))!.sealed_credentials!;
    expect(
      await harness.app.unsealCredentials(resealed, alpha.integrationId, alpha.organisationId),
    ).toEqual({ apiKey: 'from-the-old-release' });
  });

  it('does not overwrite a credential that was rotated while re-sealing', async () => {
    // The re-seal is guarded on the value it read. A rotation that lands first
    // must win, or an upgrade would silently restore old credentials.
    const legacy = createCredentialCipher(harness.config.auth.credentialEncryptionKey);
    const v1 = legacy.encrypt(JSON.stringify({ apiKey: 'stale' }), beta.integrationId);

    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE integrations SET sealed_credentials = $2 WHERE id = $1`, [
        beta.integrationId,
        v1,
      ]);
    });

    // Read it (which schedules a re-seal) and immediately rotate.
    await harness.app.unsealCredentials(v1, beta.integrationId, beta.organisationId);
    const rotated = await harness.app.credentials.seal(JSON.stringify({ apiKey: 'rotated' }), {
      organisationId: beta.organisationId,
      aad: beta.integrationId,
    });
    await harness.db.withPlatform(async (ctx) => {
      await ctx.query(`UPDATE integrations SET sealed_credentials = $2 WHERE id = $1`, [
        beta.integrationId,
        rotated,
      ]);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = (await sealedFor(beta.integrationId))!.sealed_credentials!;
    expect(
      await harness.app.unsealCredentials(current, beta.integrationId, beta.organisationId),
    ).toEqual({ apiKey: 'rotated' });
  });
});

describe.skipIf(available)('credential sealing (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
