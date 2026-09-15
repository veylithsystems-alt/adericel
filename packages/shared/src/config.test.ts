import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { generateIssuerKey } from './issuer-key.js';

/** Fixed, because a key's provenance date is data, not a wall-clock read. */
const REGISTERED_AT = '2026-01-01T00:00:00.000Z';
/**
 * Configuration, at the one boundary where private signing material enters.
 *
 * The rule the whole design rests on: an issuer key is a SEPARATELY ESTABLISHED
 * credential. It is not derived from the deployment root secret, and it is not
 * invented when missing. These tests exist to make that rule expensive to
 * break by accident.
 */

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost:5432/adericel_test',
} satisfies NodeJS.ProcessEnv;

describe('passport signing configuration', () => {
  it('is off by default, and says so rather than half-configuring itself', () => {
    const config = loadConfig({ ...BASE });
    expect(config.passport.signingEnabled).toBe(false);
    expect(config.passport.signingKeyJson).toBe('');
  });

  it('refuses to start with signing on and no key', () => {
    expect(() => loadConfig({ ...BASE, PASSPORT_SIGNING_ENABLED: 'true' })).toThrow(
      /PASSPORT_SIGNING_KEY is empty/,
    );
  });

  it('never derives the issuer key from the deployment root secret', () => {
    // The specific failure this guards against: a future change that quietly
    // makes the issuer key a function of AUTH_JWT_SECRET or
    // AUTH_CREDENTIAL_ENCRYPTION_KEY. That would mean rotating an application
    // secret silently invalidates every signature Adericel ever issued, and a
    // compromise of one becomes a compromise of the other.
    const config = loadConfig({
      ...BASE,
      AUTH_JWT_SECRET: 'a'.repeat(48),
      AUTH_CREDENTIAL_ENCRYPTION_KEY: 'b'.repeat(48),
    });
    expect(config.passport.signingKeyJson).toBe('');
    expect(config.passport.signingKeyJson).not.toContain(config.auth.jwtSecret);
    expect(config.passport.signingKeyJson).not.toContain(config.auth.credentialEncryptionKey);
    expect(config.passport.signingEnabled).toBe(false);
  });

  it('carries a configured key through as an opaque string', () => {
    const { signing } = generateIssuerKey({
      keyId: 'adericel-2026-01',
      issuer: 'Veylith',
      registeredAt: REGISTERED_AT,
    });
    const config = loadConfig({
      ...BASE,
      PASSPORT_SIGNING_ENABLED: 'true',
      PASSPORT_SIGNING_KEY: JSON.stringify(signing),
    });
    expect(config.passport.signingEnabled).toBe(true);
    expect(JSON.parse(config.passport.signingKeyJson)).toEqual(signing);
  });

  it('keeps public verification on by default', () => {
    // A signature nobody can check is decoration. The keys endpoint is how a
    // recipient obtains what they need to verify offline, so it is on unless a
    // deployment deliberately turns it off.
    expect(loadConfig({ ...BASE }).passport.publicVerificationEnabled).toBe(true);
  });
});
