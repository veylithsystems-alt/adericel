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

**Integration credentials are sealed with AES-256-GCM before they reach the
database, with the integration's own id as additional authenticated data.**

The AAD binding is the part that matters. Without it, a sealed credential row is
portable: an attacker with database write access moves the ciphertext to an
integration record they control and the application decrypts it for them. With
the integration id as AAD, decryption fails outside its original record.

The rest of the model:

- The sealing key comes from `AUTH_CREDENTIAL_ENCRYPTION_KEY`, held in the
  environment and never in the database. A database-only disclosure yields
  ciphertext.
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

**Envelope encryption with per-organisation data keys.** Better blast-radius
containment, and rejected for now on complexity: it needs key rotation
machinery, a key hierarchy, and a recovery story, none of which is justified
before the KMS integration it should be built on top of. Recorded here as the
intended next step rather than as a rejected idea.

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
- Key rotation currently requires re-sealing every credential in a maintenance
  operation. Acceptable at present scale; the envelope scheme above is the fix.
- Configuration refuses to start in production without the key rather than
  falling back to a development default. Development defaults exist and are
  refused when `NODE_ENV=production`.

## Security implications

The threat model this addresses is database disclosure — backup theft, a SQL
injection with read access, a decommissioned disk. It does not address a
compromise of the running host, which has the key in memory by necessity. That
limit is stated rather than glossed: an attacker with code execution on the API
container can decrypt credentials, and the controls against that are host
hardening, egress restriction and detection, not cryptography.

## Operational implications

Secrets enter through the environment. `.env` is gitignored, `.env.example`
carries no values, and CI fails on credential-shaped material in tracked files.

## Migration implications

The sealing format carries a version prefix, so a future scheme can be
introduced with lazy re-sealing on next write rather than a stop-the-world
migration.
