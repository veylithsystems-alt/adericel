import { contentHash } from './canonical.js';
import {
  SIGNING_ALGORITHM,
  verifyCanonicalSignature,
  type IssuerPublicKey,
  type IssuerSigner,
  type SigningAlgorithm,
} from './signing.js';

/**
 * The portable Assurance Passport interchange envelope.
 *
 * A passport already exists inside the product as issued, frozen,
 * content-hashed content (ADR-0026). This envelope is what leaves the building:
 * that same content, unchanged, wrapped with the issuer's identity, a content
 * hash and a detached Ed25519 signature, so a recipient can establish
 * authenticity and integrity offline, with no Adericel account and without
 * trusting whoever sent them the file.
 *
 * What this does NOT do, stated because the distinction is the whole point:
 *
 *   The signature covers *authenticity and integrity of the issued record*.
 *   It says "Adericel issued exactly this content, and it has not been
 *   altered". It does not say the organisation is secure, that its controls
 *   pass, or anything beyond the evidence and rules that produced the content.
 *   A signed passport carrying UNKNOWN controls is a valid signed passport
 *   that says UNKNOWN, and the signature makes that statement *more*
 *   trustworthy, not less.
 *
 *   It adds no assurance content. The `content` field is the passport verbatim;
 *   the envelope neither summarises nor scores it. UNKNOWN, exceptions and
 *   coverage cross the interchange boundary exactly as issued.
 *
 * The envelope is deliberately transport- and presentation-free: it is the
 * bytes, suitable for an HTTP body, a file on disk, or a future registry, and
 * carries nothing a UI happens to want.
 */

export const PASSPORT_INTERCHANGE_SCHEMA = 'adericel.passport-interchange/v1' as const;
export type PassportInterchangeSchema = typeof PASSPORT_INTERCHANGE_SCHEMA;

/**
 * Everything a verifier needs about the issuer, and nothing that establishes
 * trust by itself. The `keyId` names *which* Adericel key signed; trust comes
 * from resolving that keyId to a public key the verifier already trusts (a
 * published key, a pinned key, a registry), never from this block asserting its
 * own legitimacy. See `verifyInterchange`: caller-supplied issuer metadata is
 * never sufficient.
 */
export interface InterchangeIssuer {
  /** Stable issuer name, e.g. "Adericel". Descriptive; not a trust anchor. */
  readonly name: string;
  readonly keyId: string;
  readonly algorithm: SigningAlgorithm;
}

export interface PassportInterchange<TContent = unknown> {
  readonly schema: PassportInterchangeSchema;
  readonly issuer: InterchangeIssuer;
  /**
   * The passport content, verbatim. Typed as unknown here because @adericel/shared
   * must not depend on the API's PassportContent shape; the API layer supplies
   * and re-narrows it. Whatever it is, it is what gets signed and hashed.
   */
  readonly content: TContent;
  /** sha256:... over the canonical encoding of `content`. Convenience; the
   * signature is the authority. A verifier recomputes it and does not trust it. */
  readonly contentHash: string;
  /** As-of instant of the assurance record, lifted from content for the
   * verifier's convenience and covered by the signature. */
  readonly asOf: string;
  /** When the envelope was signed. Distinct from asOf: an envelope may be
   * exported after the instant it describes. */
  readonly issuedAt: string;
  /** base64 Ed25519 detached signature over the canonical encoding of `content`. */
  readonly signature: string;
}

/**
 * Assemble and sign an interchange envelope.
 *
 * Pure apart from reading the signer's key and the two timestamps the caller
 * supplies. The signer holds the private key; this function never sees key
 * material as bytes and cannot leak it.
 */
export function buildInterchange<TContent>(
  signer: IssuerSigner,
  input: {
    readonly issuerName: string;
    readonly content: TContent;
    readonly asOf: string;
    readonly issuedAt: string;
  },
): PassportInterchange<TContent> {
  return {
    schema: PASSPORT_INTERCHANGE_SCHEMA,
    issuer: { name: input.issuerName, keyId: signer.keyId, algorithm: signer.algorithm },
    content: input.content,
    contentHash: contentHash(input.content),
    asOf: input.asOf,
    issuedAt: input.issuedAt,
    signature: signer.sign(input.content),
  };
}

/**
 * The outcome vocabulary. Kept distinct on purpose: collapsing these into a
 * boolean throws away the one thing a verifier most needs when a check fails,
 * which is *why*. "The signature is bad" and "I don't recognise this key" lead
 * a recipient to entirely different next actions.
 */
export type InterchangeVerdict =
  | 'VALID'
  | 'INVALID'
  | 'MALFORMED'
  | 'UNKNOWN_KEY'
  | 'UNSUPPORTED_VERSION';

export interface InterchangeVerification {
  readonly verdict: InterchangeVerdict;
  /** A plain-language reason, safe to show a recipient. Never leaks internals. */
  readonly reason: string;
  /** Present only on VALID: the facts the caller may now rely on. */
  readonly issuer?: InterchangeIssuer;
  readonly asOf?: string;
  readonly contentHash?: string;
}

/** Structural guard. Does not trust the values; only that the fields exist. */
function looksLikeInterchange(value: unknown): value is PassportInterchange {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schema === 'string' &&
    typeof v.signature === 'string' &&
    typeof v.contentHash === 'string' &&
    typeof v.asOf === 'string' &&
    typeof v.issuedAt === 'string' &&
    'content' in v &&
    typeof v.issuer === 'object' &&
    v.issuer !== null
  );
}

/**
 * Verify an interchange envelope against a trusted set of public keys.
 *
 * `resolveKey` is how trust actually enters: the caller maps a keyId to a
 * public key *they already trust* (published, pinned, from a registry), or
 * returns null. The envelope's own issuer block never establishes trust — it
 * only names which key to look for, and a forged envelope naming a key the
 * verifier does not hold resolves to UNKNOWN_KEY, not VALID.
 *
 * Pure and total: no I/O, no throw. The same inputs give the same verdict on
 * any machine, which is what "independently verifiable offline" requires.
 *
 * Order of checks matters and is fixed: shape, then version, then key
 * resolution, then the cryptographic signature, then the hash cross-check. A
 * later step never runs on input an earlier step could not vouch for.
 */
export function verifyInterchange(
  envelope: unknown,
  resolveKey: (keyId: string, issuer: InterchangeIssuer) => IssuerPublicKey | null,
): InterchangeVerification {
  if (!looksLikeInterchange(envelope)) {
    return { verdict: 'MALFORMED', reason: 'Not a well-formed passport interchange envelope.' };
  }

  if (envelope.schema !== PASSPORT_INTERCHANGE_SCHEMA) {
    return {
      verdict: 'UNSUPPORTED_VERSION',
      reason:
        `This verifier understands ${PASSPORT_INTERCHANGE_SCHEMA}. The envelope declares ` +
        `${JSON.stringify(envelope.schema)}, which it cannot check. Obtain a verifier for that ` +
        'version rather than treating the record as trusted or as forged.',
    };
  }

  const issuer = envelope.issuer as InterchangeIssuer;
  if (
    typeof issuer.keyId !== 'string' ||
    typeof issuer.name !== 'string' ||
    issuer.algorithm !== SIGNING_ALGORITHM
  ) {
    return {
      verdict: 'MALFORMED',
      reason: `Issuer block is missing fields or names an unsupported algorithm. Only ${SIGNING_ALGORITHM} is accepted.`,
    };
  }

  const key = resolveKey(issuer.keyId, issuer);
  if (key === null) {
    return {
      verdict: 'UNKNOWN_KEY',
      reason:
        `The envelope was signed by key ${JSON.stringify(issuer.keyId)}, which is not among the ` +
        'issuer keys this verifier trusts. Obtain that key from a source you trust before relying ' +
        'on the record. This is not a statement that the record is forged.',
    };
  }

  // The resolved key's algorithm and keyId are the authority. A mismatch
  // between the envelope's claimed algorithm and the trusted key is refused
  // rather than reconciled — no downgrade, no negotiation.
  if (key.algorithm !== SIGNING_ALGORITHM || key.keyId !== issuer.keyId) {
    return {
      verdict: 'UNKNOWN_KEY',
      reason: 'The resolved verification key does not match the key named by the envelope.',
    };
  }

  const signatureOk = verifyCanonicalSignature(envelope.content, envelope.signature, key);
  if (!signatureOk) {
    return {
      verdict: 'INVALID',
      reason:
        'The signature does not verify against the issuer key. The content was altered after ' +
        'signing, the signature was tampered with, or it was not signed by this key.',
    };
  }

  // Signature already covers the canonical content; the hash is a convenience
  // field, so a mismatch means a malformed envelope, not a broken signature.
  const recomputed = contentHash(envelope.content);
  if (recomputed !== envelope.contentHash) {
    return {
      verdict: 'MALFORMED',
      reason:
        'The stated content hash does not match the content. The signature verified, so the ' +
        'content is authentic; the envelope\'s hash field is inconsistent and should be regenerated.',
    };
  }

  return {
    verdict: 'VALID',
    reason:
      'This exact assurance record was signed by the named Adericel issuer key and has not been ' +
      'altered since. Authenticity and integrity only: read the record itself for what it states, ' +
      'including any UNKNOWN controls.',
    issuer,
    asOf: envelope.asOf,
    contentHash: recomputed,
  };
}

/**
 * Build a resolver over a fixed set of trusted keys — the common case for a
 * verifier that has fetched Adericel's published keys. Retired keys stay in the
 * set so historical records keep verifying; retirement stops signing, never
 * verification.
 */
export function keySetResolver(
  keys: readonly IssuerPublicKey[],
): (keyId: string) => IssuerPublicKey | null {
  const byId = new Map(keys.map((k) => [k.keyId, k]));
  return (keyId: string) => byId.get(keyId) ?? null;
}
