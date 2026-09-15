# The issuer key: generate, register, activate, sign, rotate, retire

This is the operational procedure for the key that signs Assurance Passports.
Read it before generating one, not after losing one.

**What the key is.** An Ed25519 key pair. The private half signs Passport
interchange envelopes. The public half is published so that anyone holding one
of those envelopes can verify it offline, with no Adericel account and no
network.

**What it is not.** It is not the application's JWT secret, and it is not the
credential encryption key. It is deliberately independent of both, so that
rotating an application secret does not invalidate every signature ever issued,
and so a disclosure of an application secret is not a disclosure of Adericel's
issuance identity. Never derive one from the other.

---

## The lifecycle

```
GENERATE ──► REGISTER ──► ACTIVATE ──► SIGN ──► ROTATE ──► RETIRE
                                        │
                                        └──► (on compromise) ──► REVOKE
```

A key moves forward only. A RETIRED key is never reactivated, a REVOKED key is
never trusted again, and a key id is never reused — a reused id would make a
historical signature fail in a way that looks exactly like tampering.

---

## 1. GENERATE

```
pnpm passport:keygen adericel-prod-2026-01 "Veylith Systems Ltd"
```

The key id is lowercase, hyphenated, and permanent. Date it: `-2026-01` makes
"never reuse an id" easy to keep true, and makes the rotation history legible
two years later without a database.

The issuer name is the legal entity issuing the Passports, spelled as recipients
should see it. It goes inside the signed material, so it cannot be changed later
without re-issuing.

The command prints the private half **once**, to stdout. It writes nothing to
disk. Do not redirect it to a file, do not paste it into a ticket or a chat, do
not put it in a tracked `.env`.

## 2. REGISTER

Put the private half into your secret store as `PASSPORT_SIGNING_KEY`.

Put the public half into `PASSPORT_KEYRING`, **keeping every previous entry**.
The keyring is a JSON array and it only ever grows.

At this point the key's published status is `REGISTERED`: it exists and is
trusted, and nothing has been signed with it.

## 3. ACTIVATE

Set the published entry's `status` to `ACTIVE` and `activatedAt` to the instant.
Set `PASSPORT_SIGNING_ENABLED=true`. Restart.

Start-up will refuse if:

- signing is on and `PASSPORT_SIGNING_KEY` is empty;
- the private material is not a usable Ed25519 key;
- the published public key for this key id does not match the configured private
  key;
- the same key id appears twice in the keyring;
- the key is published as `RETIRED` or `REVOKED`.

Every one of those is a deployment that would produce signatures nobody could
verify. A process that does not start is the correct outcome.

**Verify the activation before you tell anyone.** Issue a Passport, export it,
and check it:

```
curl -s $PUBLIC_URL/v1/assurance/keys
curl -s -X POST $PUBLIC_URL/v1/assurance/verify-interchange \
  -H 'content-type: application/json' --data @envelope.json
```

`outcome` must be `VALID`.

## 4. SIGN

Nothing to do. Exports are signed, and the envelope names the key id so a
recipient can select the right public key without guessing.

## 5. ROTATE

Routine rotation. Annually is a reasonable default; there is no forced expiry,
because an expiry date on a signing key is a date on which historical documents
start failing for no security reason.

1. GENERATE a new key with a new, dated id.
2. REGISTER it: add its public half to `PASSPORT_KEYRING`, alongside the old one.
3. Change the old key's published entry to `status: "RETIRED"` and set
   `retiredAt`. **Do not remove it.**
4. Replace `PASSPORT_SIGNING_KEY` with the new private half.
5. Restart, and run the activation check above.

New Passports are signed by the new key. Every Passport signed by the old key
keeps verifying, because its public half is still published.

**The thing that goes wrong here** is deleting the retired public key while
tidying up. Do not. A recipient with a two-year-old Passport would get
`UNKNOWN_KEY` — which the verifier is careful to say is _not_ evidence of
tampering, but which is still a support call and a moment of doubt about a
document that was always genuine.

## 6. RETIRE

Covered in ROTATE. A retired key's public half stays published permanently. Its
private half should be destroyed once rotation is verified — there is no reason
to keep material that can only be misused.

---

## On compromise: REVOKE

If the private key is disclosed, or you suspect it is:

1. **Rotate immediately** — steps 1, 2, 4, 5 of ROTATE. Get a new key signing.
2. Set the compromised key's published `status` to `"REVOKED"` (not `RETIRED`).
3. Restart. Start-up refuses to sign with a revoked key, so a half-applied
   change stops the deployment rather than continuing to use it.
4. Tell anyone who holds Passports signed by that key. This is the step
   technology cannot do for you.

What a recipient sees afterwards: `outcome: "REVOKED_KEY"`, with the explanation
that the signature is cryptographically valid and is not to be relied upon, and
that they should ask the issuer to re-issue the record.

**Why REVOKED is a different status from RETIRED.** A retired key's signatures
are still good — it simply stopped signing new things. A revoked key's
signatures may have been made by somebody else. Collapsing the two would either
break years of genuine documents or keep trusting a compromised key. The
verifier reports them as distinct outcomes for the same reason.

**Revocation is not retroactive proof of forgery.** A Passport signed before the
compromise is probably genuine. Revocation says nobody can any longer tell the
difference, which is why re-issuance is the remedy.

---

## Where private material is allowed to be

One place: the secret store your deployment reads `PASSPORT_SIGNING_KEY` from,
and the process memory of the API after start-up.

It must never appear in:

- a database record;
- a Passport export, or any API response;
- a log line or telemetry field;
- source control;
- a test fixture.

The code is arranged so that these are not merely rules. `publishableKeyring()`
has no field that could hold private material; the log redactor matches
`privateKey` by name; the signing key is parsed once at the configuration
boundary and held only in `AppContext.issuerKeys`; and tests assert the key
bytes are absent from every response body and from redacted log output.

## Running without a key

Entirely supported. Leave `PASSPORT_SIGNING_ENABLED=false`.

Exports then return the Passport, its content hash, and a plain statement that
this deployment cannot sign. The content hash is still checkable against
`/v1/assurance/verify`. It is **not** a signature, and nothing in the product
describes it as one.

## What a signature means, when you explain it to a customer

It means: Adericel issued this exact record, and nobody has altered it since.

It does not mean the assurance position described is good. It does not mean the
record is current — it describes the instant in its `asOf` field. And it does not
survive withdrawal: a Passport the organisation later withdraws still verifies,
which is why Adericel refuses to sign an already-withdrawn Passport, and why the
verification response tells recipients where to check for withdrawal.
