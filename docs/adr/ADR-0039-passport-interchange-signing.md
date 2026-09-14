# ADR-0039: Cryptographically verifiable Assurance Passport interchange

**Status:** Accepted · **Date:** 2026-09-14 · **Supersedes:** none · **Relates to:** ADR-0026 (Assurance Passport content hashing)

## Context

The Assurance Passport is issued as frozen, canonical, content-hashed content
(ADR-0026). ADR-0026 closed with the observation that a content hash is the
natural signing material "if we later choose to sign". A passport is only
useful once it leaves Adericel — handed to an insurer, a client, an auditor, a
procurement team — and the recipient holds no Adericel account and never will.

A content hash alone lets a recipient check that two copies of a record are
byte-identical. It does not let them establish **who issued it**, or that it was
not manufactured wholesale by whoever handed them the file. Hashing is not
authentication, and claiming otherwise would be exactly the kind of manufactured
certainty this product exists to refuse.

We need a portable artefact whose **authenticity and integrity** a third party
can establish **offline**, with no account, no network call to us, and no trust
in the sender — only in a public key they obtain from a source they trust.

## Decision

Introduce a versioned interchange envelope, `adericel.passport-interchange/v1`,
carrying the passport content verbatim, an issuer identity, a content hash, and
a **detached Ed25519 signature over the canonical encoding** of the content.

- **Ed25519, pinned.** One algorithm, using Node's built-in crypto (no new
  dependency). The verifier never trusts an algorithm named in the artefact it
  is checking: unsupported algorithms are rejected, never negotiated. There is
  no `alg: none` and no downgrade path.
- **Canonical content is the signing material** — the same bytes ADR-0026's
  `contentHash` covers. Sign and verify both canonicalise, so a serialisation
  cannot be swapped after signing.
- **Verification is pure and total.** `verifyInterchange(envelope, resolveKey)`
  takes canonical content + signature + a resolver to a *trusted* public key and
  returns `VALID / INVALID / MALFORMED / UNKNOWN_KEY / UNSUPPORTED_VERSION`.
  No database, tenant, network, clock or model. Same inputs, same verdict, on
  any machine, forever. The five-way verdict is kept distinct on purpose: "the
  signature is bad" and "I don't recognise this key" demand different actions.
- **Trust enters through the resolver, never the envelope.** The envelope's
  issuer block only *names* which key signed. A forged envelope naming a key the
  verifier does not hold resolves to `UNKNOWN_KEY`, not `VALID`. Caller-supplied
  issuer metadata never establishes trust.
- **Signing keys are separate credentials.** Configured independently and
  **never derived from the deployment/root secret** or any application secret,
  so signing authority can be custodied differently (KMS/HSM later) and its
  compromise is contained. Private material never enters a record, an export, a
  log, telemetry, source control or a test fixture.
- **Absence is a safe, explicit state.** With no signing key configured,
  passports are still issued and hashed exactly as before; the interchange
  export returns `503 SIGNING_UNAVAILABLE` rather than emitting an unsigned
  artefact dressed as signed. A half-configured signer refuses start-up.

### Issuer key lifecycle

```
GENERATE -> REGISTER -> ACTIVATE -> SIGN -> ROTATE -> RETIRE
```

- keyIds are unique and immutable.
- Exactly one key is `ACTIVE` (signing) at a time; enforced by config schema.
- `RETIRED` keys are **retained, never destroyed** — destroying a key destroys
  the ability to verify every passport it ever signed. Retirement stops signing,
  not verification.
- Rotation: register + activate the new key, retire the previous. Historical
  envelopes continue to verify against the retained retired key. Demonstrated in
  `passport-interchange.test.ts` and `issuer-keys.test.ts`.
- Compromise/revocation: retire the key immediately so it stops signing;
  publish the revocation out of band; re-issue affected passports under the new
  key. Verifiers pinning the compromised key remove it from their trust set.

### Positioning

The user-facing story is **Issued → Signed → Verifiable → As-of →
Evidence-backed**. A signed passport establishes that *this exact issued record*
came from the named Adericel key and has not been altered. It says **nothing**
about whether the underlying controls pass. A signed passport carrying UNKNOWN
controls is a valid signed passport that says UNKNOWN — and the signature makes
that honest statement more trustworthy, not less. UNKNOWN can never become PASS
through interchange.

## Consequences

- Adericel produces a portable assurance record whose authenticity and integrity
  are independently verifiable offline: the step from "a record that can be
  hashed" to "a record whose origin can be proven".
- The envelope is the stable contract beneath future assurance exchange,
  supplier assurance, machine-to-machine trust, registries and KMS/HSM custody —
  none built now, none requiring the passport to be redesigned to add later.
- No scoring, no AI in determination or signing, tenant isolation and privacy
  unchanged, existing passport behaviour fully backward compatible.

## Alternatives considered

- **Hash only (status quo).** Integrity without authenticity; cannot answer "who
  issued this". Rejected — it is the gap this ADR exists to close.
- **Derive a signing key from the root secret.** Simpler configuration, but
  conflates signing authority with encryption and hashing secrets, widens blast
  radius, and blocks a clean move to external custody. Rejected explicitly by
  the increment contract and on its merits.
- **JWT/JWS envelope.** Brings algorithm negotiation and `alg: none` as a
  standing footgun, and a header-driven trust model we would have to defend. A
  pinned, minimal envelope is smaller attack surface for the same guarantee.
- **A live verification service as the trust foundation.** Would make offline
  verification impossible and reintroduce the account dependency the passport
  exists to escape. A thin public key-discovery endpoint is offered as a
  convenience, explicitly not as the trust anchor.
