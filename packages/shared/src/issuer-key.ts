import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { z } from 'zod';

/**
 * Issuer signing keys.
 *
 * An Assurance Passport that can only be hashed proves that a document has not
 * changed since somebody computed a hash of it. It does not prove who issued
 * it, and a recipient who cannot establish that is trusting whoever handed them
 * the file.
 *
 * A detached Ed25519 signature over the canonical content closes that gap: the
 * recipient verifies against a published issuer public key and learns that this
 * exact assurance record was issued by that key. Offline, with no Adericel
 * account, no network call, and nothing to trust but the key they already have.
 *
 * WHAT A SIGNATURE DOES NOT ESTABLISH
 *
 * Authenticity and integrity. Nothing else. A signed passport reporting nine
 * UNKNOWN controls is a signed record of nine UNKNOWN controls; the signature
 * says Adericel issued it, not that the estate is in good order. The
 * distinction is stated wherever a signature is rendered, because "signed"
 * reads as "approved" to almost everybody.
 *
 * ALGORITHM
 *
 * Ed25519, pinned. Not negotiated. Algorithm agility in a verification path is
 * how a verifier gets talked into accepting something weaker — the envelope
 * carries an algorithm field so a future version can migrate deliberately, and
 * anything that is not the pinned value is refused rather than attempted.
 */

/** The one signature algorithm this version supports. */
export const SIGNATURE_ALGORITHM = 'Ed25519' as const;
export type SignatureAlgorithm = typeof SIGNATURE_ALGORITHM;

/**
 * A key identifier.
 *
 * Immutable, and carried in every envelope so a verifier can select the right
 * public key without guessing. Rotation issues a new id; it never reuses one,
 * because a reused id would make a historical signature unverifiable in a way
 * that looks like tampering.
 */
export const keyIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A key id is lowercase alphanumeric with hyphens');

export const KEY_STATUSES = [
  /** Registered, not yet signing. */
  'REGISTERED',
  /** The key new passports are signed with. Exactly one at a time. */
  'ACTIVE',
  /**
   * No longer signing, still trusted for verification.
   *
   * Retired keys are never deleted. Destroying one would make every passport
   * it signed unverifiable, which is indistinguishable from those passports
   * having been forged.
   */
  'RETIRED',
  /**
   * Compromised. Signatures made by it are no longer trusted.
   *
   * Distinct from RETIRED precisely so a verifier can tell "this key stopped
   * signing" from "do not believe what this key signed".
   */
  'REVOKED',
] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

/** A public key, as published for verification. Safe to distribute. */
export interface IssuerPublicKey {
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  /** Base64url SPKI DER. Self-describing and stable across Node versions. */
  readonly publicKey: string;
  readonly status: KeyStatus;
  /** Who this key speaks for. */
  readonly issuer: string;
  /**
   * When an operator established this key, as they recorded it.
   *
   * Null when it is not known — which happens when a public key is derived from
   * a configured signing key that was never added to the published keyring.
   * Deliberately null rather than "now": a provenance record that invents its
   * own date is worse than one that admits it does not have one, and the
   * inventing would happen precisely when somebody had skipped the
   * registration step this field exists to evidence.
   */
  readonly registeredAt: string | null;
  readonly activatedAt: string | null;
  readonly retiredAt: string | null;
}

/** A signing key. Private material never leaves the process that loads it. */
export interface IssuerSigningKey {
  readonly keyId: string;
  readonly algorithm: SignatureAlgorithm;
  readonly issuer: string;
  /**
   * Base64url PKCS8 DER.
   *
   * Held as a string only at the configuration boundary. It is never written to
   * a database, an export, a log, a test fixture or a telemetry field, and
   * `redactSigningKey` exists so that an accidental serialisation of a value
   * containing one produces a marker rather than the key.
   */
  readonly privateKey: string;
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/**
 * Generate a new issuer key pair.
 *
 * Used by the key-generation command and by tests. Deliberately not called at
 * runtime by the application: a system that can mint its own issuer keys can
 * mint an issuer, and the point of the key is that somebody deliberately
 * established it.
 */
export function generateIssuerKey(input: {
  readonly keyId: string;
  readonly issuer: string;
  /**
   * The instant of generation, supplied by the caller.
   *
   * Not read from the wall clock here. This module is used inside the
   * verification path, which has to be reproducible on any machine at any time,
   * and a function that reaches for the current time cannot be.
   */
  readonly registeredAt: string;
}): {
  signing: IssuerSigningKey;
  publicKey: IssuerPublicKey;
  registeredAt: string;
} {
  const keyId = keyIdSchema.parse(input.keyId);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { registeredAt } = input;

  return {
    signing: {
      keyId,
      algorithm: SIGNATURE_ALGORITHM,
      issuer: input.issuer,
      privateKey: toBase64Url(privateKey.export({ type: 'pkcs8', format: 'der' })),
    },
    publicKey: {
      keyId,
      algorithm: SIGNATURE_ALGORITHM,
      publicKey: toBase64Url(publicKey.export({ type: 'spki', format: 'der' })),
      status: 'REGISTERED',
      issuer: input.issuer,
      registeredAt,
      activatedAt: null,
      retiredAt: null,
    },
    registeredAt,
  };
}

/** Derive the public key from a signing key, so the two cannot drift apart. */
export function publicKeyOf(
  signing: IssuerSigningKey,
  status: KeyStatus = 'ACTIVE',
  registeredAt: string | null = null,
): IssuerPublicKey {
  const key = createPrivateKey({
    key: fromBase64Url(signing.privateKey),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(key);
  return {
    keyId: signing.keyId,
    algorithm: SIGNATURE_ALGORITHM,
    publicKey: toBase64Url(publicKey.export({ type: 'spki', format: 'der' })),
    status,
    issuer: signing.issuer,
    registeredAt,
    activatedAt: status === 'ACTIVE' ? registeredAt : null,
    retiredAt: null,
  };
}

/**
 * Sign canonical material.
 *
 * Takes the exact bytes to be signed rather than an object, so there is no
 * chance of this function canonicalising differently from the caller. The
 * caller produces canonical JSON once and both signs and publishes that.
 */
export function signCanonical(material: string, key: IssuerSigningKey): string {
  const privateKey = createPrivateKey({
    key: fromBase64Url(key.privateKey),
    format: 'der',
    type: 'pkcs8',
  });
  // Ed25519 signs the message directly; the algorithm argument must be null.
  return toBase64Url(sign(null, Buffer.from(material, 'utf8'), privateKey));
}

/**
 * Verify a detached signature.
 *
 * Returns a boolean because this is the primitive; the interchange layer turns
 * it into a structured result that distinguishes a bad signature from an
 * unknown key from a malformed envelope. Anything that throws — a corrupt key,
 * a truncated signature — is a failed verification, not an exception, because a
 * verifier handed a hostile file must get an answer rather than a stack trace.
 */
export function verifyCanonical(
  material: string,
  signature: string,
  key: Pick<IssuerPublicKey, 'publicKey' | 'algorithm'>,
): boolean {
  if (key.algorithm !== SIGNATURE_ALGORITHM) return false;
  try {
    const publicKey = createPublicKey({
      key: fromBase64Url(key.publicKey),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(material, 'utf8'), publicKey, fromBase64Url(signature));
  } catch {
    return false;
  }
}

/**
 * The marker that replaces private material anywhere a key might be serialised.
 *
 * A test asserts this appears instead of key bytes in every export path.
 */
export const REDACTED_KEY = '[redacted: issuer signing key]';

export function redactSigningKey(key: IssuerSigningKey): Record<string, string> {
  return {
    keyId: key.keyId,
    algorithm: key.algorithm,
    issuer: key.issuer,
    privateKey: REDACTED_KEY,
  };
}

/**
 * Parse an issuer signing key from configuration.
 *
 * Configuration is the only place private material enters the process, and it
 * is deliberately separate from the deployment root secret: a system whose
 * issuer key is derived from its application secret cannot rotate one without
 * the other, and an application-secret compromise would become an issuer
 * compromise.
 */
export const issuerSigningKeySchema = z.object({
  keyId: keyIdSchema,
  algorithm: z.literal(SIGNATURE_ALGORITHM),
  issuer: z.string().min(2).max(120),
  privateKey: z.string().min(40),
});

export function parseSigningKey(raw: unknown): IssuerSigningKey {
  const parsed = issuerSigningKeySchema.parse(raw);
  // Prove the material is usable now rather than at the first signature, so a
  // misconfigured deployment fails at start-up instead of at the moment a
  // customer asks for a passport.
  createPrivateKey({
    key: fromBase64Url(parsed.privateKey),
    format: 'der',
    type: 'pkcs8',
  });
  return parsed;
}
