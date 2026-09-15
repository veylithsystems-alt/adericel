import {
  AdericelError,
  sealPassport,
  type IssuerKeyring,
  type PassportInterchange,
} from '@adericel/shared';
import type { AppContext } from '../context.js';
import { resolveShare, type PassportContent } from './passport.js';

/**
 * Exporting a Passport as a signed, independently verifiable file.
 *
 * WHAT THIS ADDS TO THE EXISTING SHARE LINK
 *
 * A share link proves nothing on its own: a recipient who is emailed a JSON
 * file has to trust whoever sent it, and the hash-verification endpoint helps
 * only while they can reach Adericel. A signed envelope is checkable on a
 * laptop with no network, against a public key the recipient obtained once, and
 * it survives being forwarded, archived, and produced two years later by
 * somebody's insurer.
 *
 * WHAT IT DOES NOT ADD
 *
 * A signature says: Adericel issued this exact record, and nobody has altered
 * it. It says nothing whatever about whether the assurance it reports is good.
 * A signed Passport reporting nine UNKNOWN controls is a signed record of nine
 * UNKNOWN controls. That sentence travels with every envelope, because "signed"
 * reads as "approved" to almost everyone who has not thought about it.
 *
 * TWO THINGS THIS DELIBERATELY REFUSES
 *
 *  1. A WITHDRAWN PASSPORT IS NEVER SEALED. Withdrawal happens after issuance,
 *     so it cannot be inside the signed content. An offline verifier would read
 *     VALID and have no way to learn the issuer had retracted it. Refusing is
 *     the only honest option: a signature that outlives its own retraction is
 *     worse than no signature.
 *
 *  2. A REDACTED SHARE IS NEVER SEALED. The hash is over the content as issued.
 *     Signing a redacted view would either sign a document whose hash does not
 *     match, or require re-hashing — which would produce a second valid-looking
 *     record of the same passport and destroy the one-record-one-hash property
 *     the whole scheme rests on.
 */

export interface InterchangeSigned {
  readonly signed: true;
  readonly interchange: PassportInterchange;
  readonly howToVerify: InterchangeGuidance;
}

export type InterchangeRefusal =
  'SIGNING_NOT_CONFIGURED' | 'PASSPORT_WITHDRAWN' | 'REDACTED_DISCLOSURE';

export interface InterchangeUnsigned {
  readonly signed: false;
  readonly reason: InterchangeRefusal;
  readonly detail: string;
  /** Still given, so the caller is not left with nothing. */
  readonly passport: PassportContent;
  readonly passportHash: string;
}

export type InterchangeExport = InterchangeSigned | InterchangeUnsigned;

export interface InterchangeGuidance {
  readonly algorithm: string;
  readonly canonicalisation: string;
  readonly keysEndpoint: string;
  readonly verifyEndpoint: string;
  readonly offline: string;
  readonly meaning: string;
}

function guidance(app: AppContext, keyring: IssuerKeyring): InterchangeGuidance {
  const base = app.config.api.publicUrl.replace(/\/+$/, '');
  return {
    algorithm: 'Ed25519',
    canonicalisation: 'adericel.canonical-json/v1',
    keysEndpoint: `${base}/v1/assurance/keys`,
    verifyEndpoint: `${base}/v1/assurance/verify-interchange`,
    offline:
      'Take every field of this envelope except "signature" and "canonicalisation", encode it ' +
      'as canonical JSON (schemas/adericel.passport-interchange.v1.schema.json describes the ' +
      'exact rules), and verify the base64url Ed25519 signature against the issuer public key ' +
      `for "${keyring.signing?.keyId ?? 'the named key id'}". No network call is required, and ` +
      'the answer does not depend on trusting Adericel at the moment you check it.',
    meaning:
      'A valid signature establishes that Adericel issued this exact record and that it has not ' +
      'been altered. It does not mean the assurance position it describes is satisfactory, and ' +
      'it does not mean the record is still current — it describes the instant in its "asOf" ' +
      'field. Read the record.',
  };
}

interface PassportRow {
  readonly id: string;
  readonly content: PassportContent;
  readonly contentHash: string;
  readonly sequence: number;
  readonly asOf: string;
  readonly issuedAt: string;
  readonly withdrawnAt: string | null;
}

async function loadPassport(
  app: AppContext,
  organisationId: string,
  passportId: string,
): Promise<PassportRow> {
  // Tenant-scoped. RLS is the boundary, not the WHERE clause: the organisation
  // id in the query is belt to that braces, and a passport belonging to another
  // organisation is invisible to this transaction regardless.
  const row = await app.db.withTenant(organisationId, async (ctx) =>
    ctx.one<{
      id: string;
      content: PassportContent;
      content_hash: string;
      sequence: number;
      as_of: Date;
      issued_at: Date;
      withdrawn_at: Date | null;
    }>(
      `SELECT id, content, content_hash, sequence, as_of, issued_at, withdrawn_at
       FROM assurance_passports WHERE id = $1 AND organisation_id = $2`,
      [passportId, organisationId],
    ),
  );

  if (!row) throw new AdericelError('NOT_FOUND', 'Passport not found');

  return {
    id: row.id,
    content: row.content,
    contentHash: row.content_hash,
    sequence: row.sequence,
    asOf: row.as_of.toISOString(),
    issuedAt: row.issued_at.toISOString(),
    withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
  };
}

/**
 * Seal a passport, or explain precisely why not.
 *
 * Never throws for the ordinary refusals. A caller asking for a signed export
 * of an unsigned deployment needs the passport and a sentence, not a 500.
 */
function seal(
  app: AppContext,
  row: PassportRow,
  disclosure: 'FULL' | 'REDACTED',
): InterchangeExport {
  const keyring = app.issuerKeys;

  if (row.withdrawnAt !== null) {
    return {
      signed: false,
      reason: 'PASSPORT_WITHDRAWN',
      detail:
        `This passport was withdrawn on ${row.withdrawnAt} and will not be signed. A signed ` +
        'envelope verifies offline, so a recipient checking it next year would be told it is ' +
        'authentic and unaltered with no way to learn it had been retracted. Issue a current ' +
        'passport and sign that.',
      passport: row.content,
      passportHash: row.contentHash,
    };
  }

  if (disclosure === 'REDACTED') {
    return {
      signed: false,
      reason: 'REDACTED_DISCLOSURE',
      detail:
        'This share redacts the passport, and the signature is over the record as issued. ' +
        'Signing the redacted view would put a second valid-looking record of the same passport ' +
        'into the world. Share at full disclosure if the recipient needs a verifiable file.',
      passport: row.content,
      passportHash: row.contentHash,
    };
  }

  if (!keyring.signingEnabled || keyring.signing === null) {
    return {
      signed: false,
      reason: 'SIGNING_NOT_CONFIGURED',
      detail:
        'This Adericel deployment has no issuer signing key configured, so it cannot produce a ' +
        'signed envelope. The content hash below identifies the record and can be checked ' +
        'against Adericel, but it is not a signature and nothing here should be described as ' +
        'cryptographically verified.',
      passport: row.content,
      passportHash: row.contentHash,
    };
  }

  // Throws if the stored content does not hash to the stored hash — a corrupted
  // or tampered row. That is the one case where an exception is right: signing
  // it would put a valid signature over a corrupted record, which is the exact
  // outcome this mechanism exists to prevent.
  const interchange = sealPassport({
    passport: row.content,
    passportHash: row.contentHash,
    passportId: row.id,
    sequence: row.sequence,
    asOf: row.asOf,
    issuedAt: row.issuedAt,
    key: keyring.signing,
  });

  return { signed: true, interchange, howToVerify: guidance(app, keyring) };
}

/** Authenticated export, for the organisation or its MSP. */
export async function exportPassportInterchange(
  app: AppContext,
  organisationId: string,
  passportId: string,
): Promise<InterchangeExport> {
  const row = await loadPassport(app, organisationId, passportId);
  return seal(app, row, 'FULL');
}

/**
 * Export through a share token, for a recipient with no account.
 *
 * This is the path that matters commercially: the insurer, the procurement
 * reviewer, the client's security team. `resolveShare` enforces expiry,
 * revocation and disclosure, and records the view — an unauthenticated download
 * of a customer's assurance record is a fact the customer is entitled to see.
 */
export async function exportSharedInterchange(
  app: AppContext,
  token: string,
  view: { readonly ip: string | null; readonly userAgent: string | null },
): Promise<InterchangeExport & { readonly organisation: string }> {
  const resolved = await resolveShare(app, token, view);

  // resolveShare returns the redacted view when the share is redacted, and the
  // hash of the record as issued either way. Comparing the two is how this
  // detects redaction without needing the share row again.
  const row: PassportRow = {
    id: resolved.passportId,
    content: resolved.passport,
    contentHash: resolved.contentHash,
    sequence: resolved.sequence,
    asOf: resolved.passport.asOf,
    issuedAt: resolved.issuedAt,
    withdrawnAt: resolved.withdrawn?.at ?? null,
  };

  const exported = seal(app, row, resolved.disclosure);
  return { ...exported, organisation: resolved.organisationName };
}
