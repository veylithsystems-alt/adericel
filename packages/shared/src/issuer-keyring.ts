import { z } from 'zod';
import {
  KEY_STATUSES,
  SIGNATURE_ALGORITHM,
  keyIdSchema,
  parseSigningKey,
  publicKeyOf,
  signCanonical,
  type IssuerPublicKey,
  type IssuerSigningKey,
} from './issuer-key.js';

/**
 * The keyring: which key signs, and which keys a verifier should trust.
 *
 * Loaded once at start-up from configuration, held in memory, and never written
 * anywhere. Two rules shape the whole module:
 *
 *  1. TRUST COMES FROM THE KEYRING, NEVER FROM THE ENVELOPE. An interchange
 *     file states an issuer and a key id. Those are selectors — they say which
 *     key to look up — and they establish nothing on their own. A verifier that
 *     trusted the issuer field in a document it was handed would accept any
 *     document that claimed to be from Adericel.
 *
 *  2. RETIRED KEYS STAY ON THE KEYRING. A key that has stopped signing has not
 *     stopped being the key that signed things. Dropping it from the keyring
 *     makes every Passport it ever issued fail verification, and to the person
 *     holding that file a failed verification looks exactly like a forgery.
 *     REVOKED is the separate, deliberate case: a key believed compromised is
 *     marked revoked and its signatures are refused, on purpose, with a
 *     distinct outcome so nobody confuses "we withdrew this key" with "this
 *     file was tampered with".
 */

/** The public half of the keyring as published, one JSON array. */
export const issuerPublicKeySchema = z.object({
  keyId: keyIdSchema,
  algorithm: z.literal(SIGNATURE_ALGORITHM),
  publicKey: z.string().min(20),
  status: z.enum(KEY_STATUSES),
  issuer: z.string().min(2).max(120),
  registeredAt: z.string().min(4).nullable(),
  activatedAt: z.string().min(4).nullable(),
  retiredAt: z.string().min(4).nullable(),
});

export const issuerKeyringSchema = z.array(issuerPublicKeySchema);

export interface IssuerKeyring {
  /**
   * Whether this deployment signs.
   *
   * False is an honest answer with consequences, not a degraded mode: exports
   * carry a content hash and say plainly that they are unsigned. Nothing
   * substitutes a hash for a signature and calls the result verified.
   */
  readonly signingEnabled: boolean;
  /** The key that signs now. Null when signing is off. */
  readonly signing: IssuerSigningKey | null;
  /** Every key a verifier should consider, current and historical. */
  readonly publicKeys: readonly IssuerPublicKey[];
}

export interface KeyringSource {
  readonly signingEnabled: boolean;
  readonly signingKeyJson: string;
  readonly keyringJson: string;
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `${what} is not valid JSON: ${error instanceof Error ? error.message : 'unparseable'}. ` +
        'The value itself is not repeated here because it may contain private key material.',
    );
  }
}

/**
 * Build the keyring from configuration.
 *
 * Throws on anything it cannot make sense of. This runs at start-up precisely
 * so that a broken keyring is a process that does not come up, rather than a
 * customer whose export fails at the moment their insurer asked for it.
 */
export function loadIssuerKeyring(source: KeyringSource): IssuerKeyring {
  const published: IssuerPublicKey[] =
    source.keyringJson.trim() === ''
      ? []
      : issuerKeyringSchema.parse(parseJson(source.keyringJson, 'PASSPORT_KEYRING'));

  const byId = new Map<string, IssuerPublicKey>();
  for (const key of published) {
    if (byId.has(key.keyId)) {
      throw new Error(
        `PASSPORT_KEYRING lists key id "${key.keyId}" twice. A key id identifies exactly one ` +
          'key pair for all time; two entries mean a verifier would pick one of them arbitrarily.',
      );
    }
    byId.set(key.keyId, key);
  }

  if (!source.signingEnabled) {
    return { signingEnabled: false, signing: null, publicKeys: [...byId.values()] };
  }

  const signing = parseSigningKey(parseJson(source.signingKeyJson, 'PASSPORT_SIGNING_KEY'));

  // Derive the active public key from the private key rather than trusting the
  // published entry. If the operator pasted a mismatched pair, this is where it
  // is caught — not months later, when a recipient cannot verify a signature
  // and has no way to tell a mistake from an attack.
  const derived = publicKeyOf(signing, 'ACTIVE');
  const listed = byId.get(signing.keyId);

  if (listed !== undefined && listed.publicKey !== derived.publicKey) {
    throw new Error(
      `Refusing to start: the public key published for "${signing.keyId}" does not match the ` +
        'configured signing key. Signatures produced by this deployment would fail verification ' +
        'against the published keyring, which a recipient cannot distinguish from tampering.',
    );
  }

  if (listed !== undefined && (listed.status === 'REVOKED' || listed.status === 'RETIRED')) {
    throw new Error(
      `Refusing to start: key "${signing.keyId}" is published as ${listed.status} but is ` +
        'configured to sign. A retired or revoked key must never issue new signatures.',
    );
  }

  byId.set(signing.keyId, listed ?? derived);

  return { signingEnabled: true, signing, publicKeys: [...byId.values()] };
}

/**
 * Sign with the keyring's active key.
 *
 * Refuses rather than returning an empty signature when signing is off. A
 * caller that gets a value back must be able to treat it as a signature.
 */
export function signWithKeyring(keyring: IssuerKeyring, material: string): string {
  if (keyring.signing === null) {
    throw new Error('This deployment is not configured to sign Passports.');
  }
  return signCanonical(material, keyring.signing);
}

/**
 * What may be told to anyone about the keyring.
 *
 * Public keys are public — that is the point of publishing them — and the
 * status and dates are what a verifier needs to judge a historical signature.
 * The private half has no representation in this shape at all, so there is no
 * code path that could include it.
 */
export function publishableKeyring(keyring: IssuerKeyring): {
  signingEnabled: boolean;
  algorithm: string;
  keys: readonly IssuerPublicKey[];
} {
  return {
    signingEnabled: keyring.signingEnabled,
    algorithm: SIGNATURE_ALGORITHM,
    keys: keyring.publicKeys,
  };
}
