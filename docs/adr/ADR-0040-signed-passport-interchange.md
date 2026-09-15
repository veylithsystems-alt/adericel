# ADR-0040: A Passport is signed, and the signature is what a stranger checks

**Status:** Accepted · **Date:** 2026-09-15

## Context

The Assurance Passport already carried a content hash. A recipient could POST
that hash to `/v1/assurance/verify` and be told whether Adericel had issued a
record with that content.

That is a real control and it is not enough, for three reasons that only become
obvious once you imagine the actual recipient.

**It requires Adericel to be reachable, and trusted, at the moment of checking.**
An underwriter opening a file in a review two years from now, an auditor working
from an archive, a procurement team behind a corporate proxy — each of them is
being asked to trust an endpoint run by the vendor whose customer is the subject
of the document. "Ask the vendor whether the vendor's customer's document is
genuine" is not independent verification.

**It proves content, not issuance.** A hash says: some record with these exact
bytes was issued. It does not say by whom, under what identity, or that the
issuer is who the covering email claims. Anyone can compute a SHA-256.

**It cannot survive the file.** Assurance records get forwarded, attached to
tender responses, and filed. The hash check is a live service; the document
outlives it.

Meanwhile the commercial reality: an MSP's customer is asked for evidence by an
insurer or a large client. What they can hand over today is a link to a vendor
dashboard. What closes the sale is a file the recipient can check themselves.

## Decision

**Adericel issues Passports as detached-signed interchange envelopes, verifiable
offline against a published issuer public key.**

Specifically:

1. **Ed25519, pinned.** One algorithm. Not negotiated. The envelope carries an
   `algorithm` field so a future version can migrate deliberately, and anything
   that is not the pinned value is refused rather than attempted. Algorithm
   agility in a verification path is how a verifier gets talked into accepting
   something weaker.

2. **A detached signature over canonical JSON.** The signed material is every
   envelope field except `signature` and `canonicalisation`, encoded with the
   existing `adericel.canonical-json/v1` rules — the same canonicalisation that
   already produces `contentHash`. The passport travels inside the envelope
   byte-identically to how it was issued.

3. **`keyId` and `issuer` are inside the signed material.** A valid signature
   therefore cannot be relabelled onto another key's name or another issuer's
   identity. They are selectors for the verifier, never a source of trust.

4. **Issuer keys are separately established credentials.** `PASSPORT_SIGNING_KEY`
   is its own secret. It is NOT derived from `AUTH_JWT_SECRET` or
   `AUTH_CREDENTIAL_ENCRYPTION_KEY`, and never will be — see Consequences.

5. **Signing is off unless configured, and says so.** A deployment with no
   issuer key exports the passport and a plain statement that it is unsigned. It
   does not fall back to the content hash and describe the result as verified.

6. **Retired keys are never removed from the published keyring.** REVOKED is a
   separate, deliberate status with its own verification outcome.

7. **Verification is a pure function**, `verifyInterchange(envelope, keys)`, in
   `@adericel/shared`. No database, no network, no tenant context, no clock, no
   AI. The hosted endpoint at `/v1/assurance/verify-interchange` calls that same
   function and is a convenience, not the mechanism.

8. **Withdrawn passports are never signed**, and redacted share views are never
   signed. Both are explained below.

## Why these particular refusals

**Why a withdrawn passport is never sealed.** Withdrawal happens after issuance,
so it cannot be inside the signed content. A recipient verifying offline next
year would be told the record is authentic and unaltered, with no way to learn
the issuer had retracted it. A signature that outlives its own retraction is
worse than no signature, so the export refuses and says why.

**Why a redacted share is never sealed.** The hash and signature are over the
record as issued. Signing a redacted view would either sign a document whose
hash does not match it, or require re-hashing — which would put a second
valid-looking record of the same passport into the world and destroy the
one-record-one-hash property the whole scheme rests on.

**Why the keyring refuses to start on a mismatch.** If the published public key
and the configured signing key disagree, every signature the deployment produces
will fail verification against the published keyring. To the person holding that
file, a failed verification is indistinguishable from a forgery. That must be a
process that does not start, not a discovery made by a customer's insurer.

**Why a retired key is never deleted.** Destroying it makes every Passport it
ever signed unverifiable — again indistinguishable from tampering, to exactly
the people the product is trying to convince.

**Why the public keys endpoint names no organisation and looks nothing up.** An
unauthenticated endpoint that accepts an identifier and answers about it is an
enumeration oracle. `/v1/assurance/keys` returns keys; `verify-interchange`
verifies what it was given. Neither reads a tenant row.

## What a signature does not establish

Authenticity and integrity. Nothing else.

A signed Passport reporting nine UNKNOWN controls is a signed record of nine
UNKNOWN controls. The signature says Adericel issued it; it says nothing about
whether the estate is in good order, and it does not mean the record is current
— it describes the instant in its `asOf` field.

This is stated in the verification result itself, on VALID as well as on
failure, and beside every rendering of a signature. "Signed" reads as "approved"
to almost everybody who has not thought about it, and a recipient misled by our
green tick has been misled by us, not by the customer.

## Consequences

**Key management becomes an operational responsibility.** There is now a secret
whose loss is unrecoverable and whose compromise is serious. `docs/operations/
issuer-key-lifecycle.md` is the procedure. The cost is real and is accepted: the
alternative is a verification story that depends on Adericel being up and
trusted.

**The issuer key cannot be rotated by rotating the application secrets, and vice
versa.** That is the point of the separation. If the issuer key were derived
from `AUTH_JWT_SECRET`, rotating a JWT secret — an ordinary, low-drama operation
— would silently invalidate every signature Adericel had ever produced, and a
disclosure of the application secret would become a disclosure of the issuer
identity. Two independent secrets, two independent rotations, two independent
blast radii.

**Private material has exactly one entry point.** `PASSPORT_SIGNING_KEY`, parsed
once at start-up into `AppContext.issuerKeys`. It is never written to a database
row, an export, a log line, a telemetry field, a test fixture or source control.
The log redactor matches `privateKey` by name, `publishableKeyring` has no field
that could carry it, and tests assert its absence from every response body.

**Verification can be reimplemented by anyone.** The envelope schema and the
canonicalisation rules are published in `schemas/`, so a recipient who does not
want to run our code can write twenty lines against a standard Ed25519 library.
That is a feature: verification that only works with the vendor's tool is not
independent verification.

## Alternatives considered

**X.509 / a public CA.** Recipients have a certificate chain they already trust.
But a WebPKI certificate attests to a domain name, not to an issuance identity,
and the chain machinery would put revocation, expiry and path validation between
the recipient and a fifteen-line check. Rejected as ceremony that makes the
common case harder without making the guarantee stronger for this use.

**JWS / JOSE.** A standard envelope with libraries everywhere. Rejected because
its algorithm agility is exactly the property this decision refuses — `alg` is a
negotiation, and the family of `alg: none` and algorithm-confusion attacks are
well documented. A pinned algorithm in a purpose-built envelope removes a class
of attack rather than mitigating it.

**A transparency log / blockchain anchor.** Would add public,
non-repudiable timestamping. Rejected for now as solving a problem nobody has
yet: no recipient has asked us to prove when a passport was issued to a third
party's satisfaction, and the operational surface is large. The envelope carries
`issuedAt` inside the signature, so this can be added later without changing the
scheme.

**Signing the passport content directly rather than an envelope.** Simpler, and
loses `passportId`, `sequence` and the issuer identity from the signed material
— which is precisely what makes a signature non-transferable between records.
