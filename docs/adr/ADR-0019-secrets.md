# ADR-0019: Secret handling and credential sealing

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel holds credentials that reach into customers' identity providers and
endpoint estates. A disclosure of the Adericel database would, done naïvely,
compromise every customer of every MSP using it. That is the worst outcome the
system can produce, and it is worse than the disclosure of the assurance data
itself.

There are three distinct populations: **deployment secrets** (signing keys,
database passwords), **integration credentials** (per-organisation, per-vendor),
and **derived material** (session tokens, API keys).

## Decision

**Integration credentials are sealed under a per-organisation data key, with
the integration's own id as additional authenticated data.**

Two bindings, each closing a different move.

The **AAD binding** stops a sealed credential being portable between rows.
Without it, an attacker with database write access moves the ciphertext to an
integration record they control and the application decrypts it for them. With
the integration id as AAD, decryption fails outside its original record.

The **data key binding** stops it being portable between tenants. Each
organisation has its own data key (`organisation_data_keys`); the root key
encrypts data keys and nothing else. A value carrying another organisation's
data key id is refused on the key lookup, before any decryption is attempted.

The rest of the model:

- The root key comes from `AUTH_CREDENTIAL_ENCRYPTION_KEY`, held in the
  environment and never in the database. A database-only disclosure yields
  ciphertext and wrapped keys.
- Data keys are never stored or logged in plaintext, and unwrapped keys are held
  in memory for five minutes so that a collection run does not unwrap once per
  credential.
- Secrets that belong to a **person** rather than an organisation — a user's
  TOTP seed — cannot use a per-organisation data key, because a user is not
  inside an organisation; they hold grants over several. Those are sealed
  directly under the root secret with the user id as AAD. Two scopes, two
  mechanisms, stated rather than blurred.
- **Credentials are never in ordinary application tables in plaintext**, and
  never in the graph, evidence, event log, or audit log.
- Sealed values are never returned by the API. There is no "reveal" endpoint. A
  credential can be replaced, not read back.
- Passwords are hashed with a per-credential salt and an optional
  deployment-wide pepper (`AUTH_PASSWORD_PEPPER`) held outside the database, so
  a database-only disclosure is not sufficient for offline cracking.
- Session refresh tokens are stored hashed. A read of the sessions table does
  not yield usable tokens.
- **The n8n export contains no credentials.** Endpoints come from `$env`,
  authentication from a named n8n credential created after import. The validator
  fails the build on embedded key material, inline passwords, or a hard-coded
  Adericel hostname.
- Errors and logs redact known secret-bearing fields structurally rather than by
  pattern-matching the output, because a redaction that runs after formatting
  has already lost.

## Alternatives considered

**A dedicated secret manager (Vault, cloud KMS) as the only option.** The right
answer at scale and the wrong requirement for a single VPS. The sealing
interface is deliberately narrow so a KMS-backed implementation is a
substitution rather than a rewrite.

**Sealing everything directly with one configured key.** What Adericel did
first, and it has two problems that appear once there is more than one customer.
Rotation means re-sealing every credential in the deployment in one maintenance
window, which is the kind of operation that gets postponed indefinitely. And one
key opens every tenant's credentials, so there is no such thing as compromising
a single organisation. Superseded rather than rejected: those values still open,
and re-seal themselves on next read.

**PostgreSQL `pgcrypto` with the key in the database.** Encryption whose key
travels with the ciphertext. Rejected.

**Storing credentials only in n8n.** Attractive — n8n has its own encrypted
credential store — and rejected because it would make n8n load-bearing for
assurance (ADR-0012) and would put customer credentials on the instance whose
environment access is deliberately widened.

## Consequences

- Losing `AUTH_CREDENTIAL_ENCRYPTION_KEY` makes every integration credential
  unrecoverable and they must be re-entered. This is correct behaviour and is
  stated in `.env.example` next to the variable, along with the instruction to
  back it up somewhere other than the machine it protects.
- Rotating one organisation's data key touches only that organisation's rows.
  Rotating the root key re-wraps data keys — a few rows per organisation —
  rather than every credential.
- Upgrading is not an event. Values written before this format still open, and
  are re-sealed in the background the next time they are read. The re-seal is
  guarded on the value that was read, so a credential rotated in the meantime is
  not overwritten with the old one; and a failed re-seal is logged and swallowed,
  because turning a successful credential read into an error over an
  opportunistic write would be the wrong trade.
- Configuration refuses to start in production without the key rather than
  falling back to a development default. Development defaults exist and are
  refused when `NODE_ENV=production`.

## Security implications

The threat model this addresses is database disclosure — backup theft, a SQL
injection with read access, a decommissioned disk. It does not address a
compromise of the running host, which has the root key in memory by necessity.
That limit is stated rather than glossed: an attacker with code execution on the
API container can decrypt credentials, and the controls against that are host
hardening, egress restriction and detection, not cryptography.

It is also worth being precise about what envelope encryption does **not** buy
while the root key sits in an environment variable. The root key still opens
every data key, so disclosing it discloses everything. What has changed is that
the root key is now used rarely, on small inputs, through an interface
(`RootKeyProvider`) whose whole surface is wrap and unwrap — which is exactly
what a KMS or HSM exposes. Moving it there means the application never holds it,
and that is the guarantee. This decision is the prerequisite for it, not the
thing itself.

## Operational implications

Secrets enter through the environment. `.env` is gitignored, `.env.example`
carries no values, and CI fails on credential-shaped material in tracked files.

## Migration implications

The sealing format carries a version prefix and lazy re-sealing is already
implemented, so a future scheme is introduced the same way this one was: write
in the new format, keep opening the old, and let the estate migrate itself as it
is used. There is no stop-the-world migration and no deployment in which a
credential is briefly unreadable.

Substituting a KMS is an implementation of `RootKeyProvider`. Nothing that calls
it changes, and existing wrapped data keys are re-wrapped once rather than
credentials being re-sealed.
