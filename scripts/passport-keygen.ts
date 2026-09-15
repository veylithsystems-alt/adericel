#!/usr/bin/env tsx
import { generateIssuerKey, publicKeyOf, systemClock } from '@adericel/shared';

/**
 * Generate an issuer signing key for verifiable Passport interchange.
 *
 * Run once per deployment, by a person, deliberately. Adericel does not mint
 * its own issuer keys at runtime: a system that can create an issuer can create
 * an issuer, and the entire value of the signature is that somebody established
 * this key on purpose and published the public half.
 *
 *   pnpm passport:keygen adericel-prod-2026-01 "Veylith Systems Ltd"
 *
 * The private half is printed to stdout ONCE and never written to disk by this
 * script. Put it straight into the secret store the deployment reads
 * PASSPORT_SIGNING_KEY from. If you lose it, generate a new key with a new id
 * and publish it alongside the old one — never reuse an id, and never delete
 * the retired public key.
 */

const [, , keyIdArg, ...issuerParts] = process.argv;
const issuer = issuerParts.join(' ').trim();

if (!keyIdArg || issuer === '') {
  process.stderr.write(
    'Usage: pnpm passport:keygen <key-id> <issuer name>\n' +
      '\n' +
      '  <key-id>      lowercase, hyphenated, and NEVER reused. Dating it is the easiest way\n' +
      '                to keep that true: adericel-prod-2026-01.\n' +
      '  <issuer name> the legal entity issuing the passports, as recipients should see it.\n',
  );
  process.exit(2);
}

const registeredAt = systemClock.nowIso();
const { signing, publicKey } = generateIssuerKey({ keyId: keyIdArg, issuer, registeredAt });
const active = publicKeyOf(signing, 'ACTIVE', publicKey.registeredAt);

process.stdout.write(
  [
    '',
    '=== PRIVATE. Shown once. Put this in your secret store as PASSPORT_SIGNING_KEY. ===',
    '',
    JSON.stringify(signing),
    '',
    '  Do not commit it. Do not paste it into a ticket, a chat, or an .env file that is',
    '  tracked. It is not recoverable from anything else, and it is not derived from',
    '  AUTH_JWT_SECRET or AUTH_CREDENTIAL_ENCRYPTION_KEY — rotating those does not rotate this,',
    '  and a compromise of those is not a compromise of this. That separation is the point.',
    '',
    '=== PUBLIC. Publish this. Add it to PASSPORT_KEYRING, keeping every previous entry. ===',
    '',
    JSON.stringify([active], null, 2),
    '',
    '  Recipients verify against this. Serve it at /v1/assurance/keys and anywhere else people',
    '  will look for it. When this key is eventually retired, change its status to RETIRED and',
    '  set retiredAt — do NOT remove it, or every passport it ever signed will start failing',
    '  verification, which to the person holding that file is indistinguishable from a forgery.',
    '',
    '=== Then ===',
    '',
    '  Set PASSPORT_SIGNING_ENABLED=true and restart. The API refuses to start if the keyring',
    '  and the signing key disagree, so a half-applied change stops the deployment rather than',
    '  producing signatures nobody can verify.',
    '',
  ].join('\n'),
);
