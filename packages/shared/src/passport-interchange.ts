import { z } from 'zod';
import { canonicalJson, contentHash } from './canonical.js';
import {
  SIGNATURE_ALGORITHM,
  signCanonical,
  verifyCanonical,
  type IssuerPublicKey,
  type IssuerSigningKey,
} from './issuer-key.js';

/**
 * The Assurance Passport interchange envelope.
 *
 * A portable assurance record whose authenticity and integrity a third party
 * can establish for themselves — offline, with no Adericel account, no network
 * call, and nothing to trust but a published issuer public key.
 *
 * WHAT IT IS FOR
 *
 * An insurer, a procurement team or a customer receives a passport from the
 * organisation it describes. Today they must trust the sender. With this they
 * verify the sender is irrelevant: either the canonical content matches the
 * signature made by the named issuer key, or it does not.
 *
 * WHAT THE ENVELOPE DELIBERATELY DOES NOT DO
 *
 * It does not add, summarise, score or simplify anything. The passport content
 * inside is byte-identical to the passport Adericel issued, because the whole
 * value of the envelope is that the thing verified is the thing issued.
 * UNKNOWN stays UNKNOWN, exceptions stay named, and limitations stay stated.
 *
 * Nor does the signature say the assurance is good. It says Adericel issued
 * this record. A signed passport reporting nine UNKNOWN controls is a signed
 * record of nine UNKNOWN controls, and every surface that renders a signature
 * says so, because "signed" reads as "approved" to almost everybody.
 */

export const INTERCHANGE_SCHEMA = 'adericel.passport-interchange/v1' as const;
export type InterchangeSchema = typeof INTERCHANGE_SCHEMA;

/**
 * The material that is signed.
 *
 * Deliberately a distinct object from the envelope: the envelope carries the
 * signature, and a signature cannot cover itself. Everything a verifier must be
 * able to rely on lives in here — the content, its hash, when it was issued,
 * who issued it and under which key — so none of it can be altered without the
 * signature failing.
 *
 * Note in particular that `keyId` is inside the signed material as well as on
 * the envelope. Without that, an attacker holding a valid signature could
 * relabel it as made by a different key, and a verifier checking the envelope's
 * keyId against a revoked-key list would be looking at an attacker-chosen value.
 */
export interface SignedMaterial {
  readonly schema: InterchangeSchema;
  /** The passport exactly as issued. Never reshaped for the envelope. */
  readonly passport: unknown;
  /** The passport's own content hash, as Adericel recorded it. */
  readonly passportHash: string;
  /** Adericel's identifier for this passport, so it can be cited. */
  readonly passportId: string;
  readonly sequence: number;
  /** The instant the assurance describes. */
  readonly asOf: string;
  /** The instant this envelope was produced. */
  readonly issuedAt: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
}

export interface PassportInterchange extends SignedMaterial {
  /** Detached signature over the canonical JSON of the material above. */
  readonly signature: string;
  /**
   * How to reproduce the signed bytes.
   *
   * Stated in the envelope rather than left to documentation, because a
   * verifier who canonicalises differently gets a false negative and has no way
   * to tell that from tampering.
   */
  readonly canonicalisation: 'adericel.canonical-json/v1';
}

export const interchangeSchemaValidator = z.object({
  schema: z.literal(INTERCHANGE_SCHEMA),
  passport: z.unknown(),
  passportHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  passportId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  asOf: z.string().min(1),
  issuedAt: z.string().min(1),
  issuer: z.string().min(1),
  keyId: z.string().min(1),
  algorithm: z.literal(SIGNATURE_ALGORITHM),
  signature: z.string().min(1),
  canonicalisation: z.literal('adericel.canonical-json/v1'),
});

/** Extract the signed material from an envelope, dropping signature fields. */
export function materialOf(envelope: PassportInterchange): SignedMaterial {
  return {
    schema: envelope.schema,
    passport: envelope.passport,
    passportHash: envelope.passportHash,
    passportId: envelope.passportId,
    sequence: envelope.sequence,
    asOf: envelope.asOf,
    issuedAt: envelope.issuedAt,
    issuer: envelope.issuer,
    keyId: envelope.keyId,
    algorithm: envelope.algorithm,
  };
}

/** Seal a passport into a signed envelope. */
export function sealPassport(input: {
  readonly passport: unknown;
  readonly passportHash: string;
  readonly passportId: string;
  readonly sequence: number;
  readonly asOf: string;
  readonly issuedAt: string;
  readonly key: IssuerSigningKey;
}): PassportInterchange {
  // The hash Adericel recorded must match the content being sealed. A mismatch
  // means the passport was altered between issuance and export, and sealing it
  // would put a valid signature over a corrupted record — the one outcome this
  // whole mechanism exists to prevent.
  const actual = contentHash(input.passport);
  if (actual !== input.passportHash) {
    throw new Error(
      `Passport content does not match its recorded hash (${input.passportHash} vs ${actual}). ` +
        'Refusing to sign.',
    );
  }

  const material: SignedMaterial = {
    schema: INTERCHANGE_SCHEMA,
    passport: input.passport,
    passportHash: input.passportHash,
    passportId: input.passportId,
    sequence: input.sequence,
    asOf: input.asOf,
    issuedAt: input.issuedAt,
    issuer: input.key.issuer,
    keyId: input.key.keyId,
    algorithm: SIGNATURE_ALGORITHM,
  };

  return {
    ...material,
    signature: signCanonical(canonicalJson(material), input.key),
    canonicalisation: 'adericel.canonical-json/v1',
  };
}

/**
 * Every way verification can turn out.
 *
 * Never collapsed into a boolean. A verifier who is told only "invalid" cannot
 * tell a forged passport from one signed by a key they have not fetched yet,
 * and those call for completely different responses — the first is an incident,
 * the second is a missing download.
 */
export const VERIFICATION_OUTCOMES = [
  /** The signature is good and the content matches its hash. */
  'VALID',
  /** Well-formed, correct key, and the signature does not verify. */
  'INVALID_SIGNATURE',
  /** The signature verifies and the content does not match its stated hash. */
  'CONTENT_HASH_MISMATCH',
  /** Not a passport interchange envelope at all, or missing required fields. */
  'MALFORMED',
  /** A valid-looking envelope naming a key the verifier does not hold. */
  'UNKNOWN_KEY',
  /** A schema version this verifier does not implement. */
  'UNSUPPORTED_VERSION',
  /** An algorithm this verifier will not attempt. */
  'UNSUPPORTED_ALGORITHM',
  /**
   * Signed by a key that has since been revoked.
   *
   * Cryptographically valid, and not to be trusted. Kept distinct from
   * INVALID_SIGNATURE because the remedies differ: one is a forgery, the other
   * is a key compromise that may affect many genuine documents.
   */
  'REVOKED_KEY',
] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface VerificationResult {
  readonly outcome: VerificationOutcome;
  /** True only for VALID. Provided for callers that want the short answer. */
  readonly verified: boolean;
  /** What a person should be told, in their words. */
  readonly detail: string;
  /** Present when the envelope was well-formed enough to read them. */
  readonly keyId: string | null;
  readonly issuer: string | null;
  readonly asOf: string | null;
  readonly passportId: string | null;
}

function result(
  outcome: VerificationOutcome,
  detail: string,
  envelope?: Partial<PassportInterchange>,
): VerificationResult {
  return {
    outcome,
    verified: outcome === 'VALID',
    detail,
    keyId: envelope?.keyId ?? null,
    issuer: envelope?.issuer ?? null,
    asOf: envelope?.asOf ?? null,
    passportId: envelope?.passportId ?? null,
  };
}

/**
 * Verify an interchange envelope. Pure.
 *
 * No database, no network, no tenant context, no clock, no AI. Given the same
 * envelope and the same keys this returns the same answer on any machine, which
 * is what makes independent verification meaningful rather than a courtesy
 * endpoint Adericel operates.
 *
 * Anything that throws is caught and reported as MALFORMED: a verifier handed a
 * hostile file must get an answer, not a stack trace.
 */
export function verifyInterchange(
  candidate: unknown,
  keys: readonly IssuerPublicKey[],
): VerificationResult {
  let envelope: PassportInterchange;
  try {
    /**
     * Version and algorithm are read before the full parse.
     *
     * Both are `z.literal` in the schema, so a downgraded algorithm and an
     * unknown version both fail validation identically — and an adversarial
     * test caught this reporting an attempted algorithm substitution as
     * UNSUPPORTED_VERSION. That would send a verifier looking for a newer
     * verifier while somebody tries to talk them into a weaker signature.
     *
     * The two are distinguished here, before anything else, because the
     * diagnostic is the point: a verifier must be able to tell "I need a newer
     * tool" from "this document is trying to negotiate me down".
     */
    const declared = candidate as { schema?: unknown; algorithm?: unknown } | null;
    if (
      declared !== null &&
      typeof declared === 'object' &&
      typeof declared.algorithm === 'string' &&
      declared.algorithm !== SIGNATURE_ALGORITHM
    ) {
      return result(
        'UNSUPPORTED_ALGORITHM',
        `This verifier accepts ${SIGNATURE_ALGORITHM} only. The envelope declares ` +
          `${declared.algorithm}, and it will not be attempted.`,
      );
    }

    const parsed = interchangeSchemaValidator.safeParse(candidate);
    if (!parsed.success) {
      // A recognisable schema value with the wrong version is a different
      // problem from a file that is not an envelope at all, and a verifier
      // needs to know which so they can go and find the right verifier.
      const schema = (candidate as { schema?: unknown } | null)?.schema;
      if (typeof schema === 'string' && schema.startsWith('adericel.passport-interchange/')) {
        return result(
          'UNSUPPORTED_VERSION',
          `This verifier implements ${INTERCHANGE_SCHEMA}. The envelope declares ${schema}.`,
        );
      }
      return result(
        'MALFORMED',
        'This is not a well-formed Adericel passport interchange envelope.',
      );
    }
    envelope = parsed.data as PassportInterchange;
  } catch {
    return result('MALFORMED', 'The envelope could not be read.');
  }

  // Defence in depth. The check above catches this before parsing, and the
  // schema's literal would reject it too. Kept because an algorithm that
  // reaches signature verification is the one mistake in this file that cannot
  // be recovered from, and three cheap guards are worth one of those.
  if (envelope.algorithm !== SIGNATURE_ALGORITHM) {
    return result(
      'UNSUPPORTED_ALGORITHM',
      `This verifier accepts ${SIGNATURE_ALGORITHM} only. The envelope declares ` +
        `${String(envelope.algorithm)}, and it will not be attempted.`,
      envelope,
    );
  }

  const key = keys.find((candidateKey) => candidateKey.keyId === envelope.keyId);
  if (!key) {
    return result(
      'UNKNOWN_KEY',
      `The envelope is signed by key "${envelope.keyId}", which this verifier does not hold. ` +
        'Obtain the issuer public key and verify again — this is not evidence of tampering.',
      envelope,
    );
  }

  if (!verifyCanonical(canonicalJson(materialOf(envelope)), envelope.signature, key)) {
    return result(
      'INVALID_SIGNATURE',
      'The signature does not match the content. This record has been altered since it was ' +
        'issued, or it was not issued by the key it names.',
      envelope,
    );
  }

  // The signature is good. Now check the passport's own hash, which catches a
  // record whose content and stated hash disagreed at the moment it was sealed.
  const actual = contentHash(envelope.passport);
  if (actual !== envelope.passportHash) {
    return result(
      'CONTENT_HASH_MISMATCH',
      `The signature is valid and the passport content does not match its own recorded hash ` +
        `(${envelope.passportHash} vs ${actual}).`,
      envelope,
    );
  }

  // Cryptographically sound, and signed by a key that is no longer trusted.
  if (key.status === 'REVOKED') {
    return result(
      'REVOKED_KEY',
      `The signature is valid, and key "${key.keyId}" has been revoked. Signatures made by a ` +
        'revoked key are not to be relied upon. Ask the issuer to re-issue this record.',
      envelope,
    );
  }

  return result(
    'VALID',
    `This exact assurance record was issued by ${envelope.issuer} under key "${envelope.keyId}" ` +
      `and has not been altered. It describes the position as of ${envelope.asOf}. ` +
      'The signature establishes authenticity and integrity — not that the assurance it ' +
      'reports is satisfactory.',
    envelope,
  );
}
