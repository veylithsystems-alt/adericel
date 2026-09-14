import {
  createIssuerSigner,
  publicKeyFromPem,
  type AdericelConfig,
  type IssuerPublicKey,
  type IssuerSigner,
  type Logger,
} from '@adericel/shared';

/**
 * Construction of the Assurance Passport issuer signer from configuration.
 *
 * This is the one place private signing material is turned into a signer, and
 * it is deliberately narrow. The private key comes only from configuration the
 * deployment supplies (never derived from the root secret, never generated at
 * runtime from a request), and the signer it produces exposes no way to read
 * that material back out.
 *
 * Absence is a first-class, safe state. A deployment that has not configured a
 * signing key gets `undefined` here; passports are still issued and content
 * hashed exactly as before, and the interchange export tells the caller signing
 * is unavailable rather than emitting something that looks signed but is not.
 */

export type PassportSigner = IssuerSigner;

export function buildPassportSigner(
  config: AdericelConfig,
  logger: Logger,
): PassportSigner | undefined {
  const { activeKeyId, activePrivateKeyPem } = config.passport;
  if (activeKeyId === '' || activePrivateKeyPem === '') {
    // Half-configured signing is refused at start-up by assertProductionSafety;
    // reaching here with neither set is the legitimate "signing disabled" case.
    return undefined;
  }
  try {
    return createIssuerSigner(activePrivateKeyPem, activeKeyId);
  } catch (error) {
    // A configured-but-invalid key is a hard operational error: log the fact
    // (never the material) and leave signing unavailable rather than crash the
    // whole API, so every other route keeps serving.
    logger.error(
      { keyId: activeKeyId, error: String(error) },
      'passport signing key is configured but could not be loaded; signed export is unavailable',
    );
    return undefined;
  }
}

/**
 * The verification keys this deployment publishes, parsed from config entries
 * of the form `keyId:base64(spki-pem)`. Includes retired keys so historical
 * passports keep verifying. Malformed entries are skipped with a warning rather
 * than taking down discovery for the well-formed ones.
 */
export function publishedVerificationKeys(
  config: AdericelConfig,
  logger: Logger,
): IssuerPublicKey[] {
  const keys: IssuerPublicKey[] = [];
  for (const entry of config.passport.verificationKeys) {
    const sep = entry.indexOf(':');
    if (sep === -1) {
      logger.warn({ entry: entry.slice(0, 24) }, 'skipping malformed passport verification key');
      continue;
    }
    const keyId = entry.slice(0, sep);
    const pem = Buffer.from(entry.slice(sep + 1), 'base64').toString('utf8');
    try {
      keys.push(publicKeyFromPem(pem, keyId));
    } catch (error) {
      logger.warn({ keyId, error: String(error) }, 'skipping unparseable passport verification key');
    }
  }
  return keys;
}
