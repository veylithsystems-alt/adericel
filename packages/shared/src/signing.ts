import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from './canonical.js';

/**
 * Ed25519 detached signatures over canonical JSON.
 *
 * This is the primitive ADR-0026 deliberately deferred: the Assurance Passport
 * was content-hashed from the outset, and the ADR noted that a signature "is
 * exactly what such a signature would later cover". This module is that later,
 * and nothing about it changes what a passport *says* — it establishes who
 * issued a record and that it has not been altered, never whether the
 * underlying controls pass.
 *
 * Three properties are load-bearing and each is enforced below rather than
 * documented and hoped for:
 *
 *   The algorithm is pinned. Only Ed25519 is accepted. A verifier is never
 *   asked to trust an algorithm named in the artefact it is checking, because
 *   "which algorithm?" is a question an attacker gets to answer otherwise
 *   (the classic algorithm-confusion downgrade). There is no negotiation and
 *   no `alg: none`.
 *
 *   The signing material is the canonical encoding, byte-for-byte the same
 *   bytes `contentHash` covers. Sign and verify both canonicalise, so a
 *   caller cannot sign one serialisation and have a differently-keyed
 *   serialisation verify.
 *
 *   Verification is pure. Given (canonical content, signature, public key) it
 *   returns the same answer with no clock, database, network or model — so it
 *   runs in a recipient's own environment, offline, forever.
 *
 * Private key material never leaves this module as anything but a `KeyObject`,
 * is never serialised by the interchange layer, and has no `toJSON`. Only the
 * public half is exportable.
 */

export const SIGNING_ALGORITHM = 'Ed25519' as const;
export type SigningAlgorithm = typeof SIGNING_ALGORITHM;

/** A public verification key in the portable form a recipient receives. */
export interface IssuerPublicKey {
  /** Immutable identifier for this key. Names which key signed, for rotation. */
  readonly keyId: string;
  readonly algorithm: SigningAlgorithm;
  /** SPKI DER, base64. Sufficient to reconstruct the key with no other input. */
  readonly publicKeySpkiB64: string;
}

/** An issuer signer. Holds a private key; only ever produced from a secret. */
export interface IssuerSigner {
  readonly keyId: string;
  readonly algorithm: SigningAlgorithm;
  /** Sign a value by its canonical encoding. Returns base64 signature bytes. */
  sign(value: unknown): string;
  /** The public half, safe to publish and to embed in an export. */
  publicKey(): IssuerPublicKey;
}

function assertEd25519(key: KeyObject): void {
  // asymmetricKeyType is 'ed25519' for both halves of an Ed25519 pair.
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(
      `Adericel signing accepts Ed25519 keys only; received ${String(key.asymmetricKeyType)}`,
    );
  }
}

/**
 * Build a signer from PEM private key material and an explicit key id.
 *
 * The key id is supplied by configuration, not derived from the key, so an
 * operator names their keys in a way that survives re-encoding and matches
 * whatever registry or KMS they later move to.
 */
export function createIssuerSigner(privateKeyPem: string, keyId: string): IssuerSigner {
  if (keyId.trim() === '') throw new TypeError('Issuer keyId must not be empty');
  const privateKey = createPrivateKey(privateKeyPem);
  assertEd25519(privateKey);
  const publicKey = createPublicKey(privateKey);
  const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  return {
    keyId,
    algorithm: SIGNING_ALGORITHM,
    sign(value: unknown): string {
      const message = Buffer.from(canonicalJson(value), 'utf8');
      // Ed25519 takes null for the algorithm argument: the hash is intrinsic.
      return edSign(null, message, privateKey).toString('base64');
    },
    publicKey(): IssuerPublicKey {
      return { keyId, algorithm: SIGNING_ALGORITHM, publicKeySpkiB64: spkiB64 };
    },
  };
}

/**
 * Verify a detached signature over a value's canonical encoding.
 *
 * Pure and total: never throws for a bad signature, malformed key or wrong
 * algorithm — it returns false. Callers that need to distinguish *why*
 * verification failed use the interchange layer, which reports a reason;
 * this primitive answers the one cryptographic question.
 */
export function verifyCanonicalSignature(
  value: unknown,
  signatureB64: string,
  key: IssuerPublicKey,
): boolean {
  if (key.algorithm !== SIGNING_ALGORITHM) return false;
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    assertEd25519(publicKey);
  } catch {
    return false;
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, 'base64');
  } catch {
    return false;
  }
  if (signature.length === 0) return false;
  const message = Buffer.from(canonicalJson(value), 'utf8');
  try {
    return edVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Generate a fresh Ed25519 issuer keypair as PEM.
 *
 * For key provisioning and tests only. Adericel does not generate signing keys
 * at runtime from a request; keys are provisioned out of band, registered, and
 * supplied to the process as configuration. Exposed so the documented
 * GENERATE step and the test suite share exactly one code path.
 */
export function generateIssuerKeyPairPem(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

/** Reconstruct a public key from PEM, for publishing a verification key. */
export function publicKeyFromPem(publicKeyPem: string, keyId: string): IssuerPublicKey {
  const publicKey = createPublicKey(publicKeyPem);
  assertEd25519(publicKey);
  return {
    keyId,
    algorithm: SIGNING_ALGORITHM,
    publicKeySpkiB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}
