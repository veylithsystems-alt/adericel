# ADR-0009: Evidence is append-only with explicit validity

**Status:** Accepted · **Date:** 2026-09-09

## Context

Every assurance statement Adericel makes rests on evidence. If evidence can be
overwritten, back-dated or silently replaced, then an assessment cannot be
replayed and the product's central claim fails. If evidence has no expiry, a
screenshot from 2023 supports a statement about today.

"Evidence" here covers three different things that are often conflated: an
**observation** (a machine-collected fact from an integration), an **artefact**
(a document, export or screenshot a human supplied), and a **claim** (an
assertion derived from either, in the domain's vocabulary). They have different
trust properties and must not share a table.

## Decision

**Evidence records are append-only; supersession is a new row, not an update.**

- An evidence record carries its **provenance**: which integration or person
  produced it, under which credential, and by what method.
- It carries a **content hash** of the bytes, so the artefact can be shown not
  to have changed since collection.
- It carries an explicit **validity window** (`valid_from`, `valid_until`) which
  is a property of the evidence, not of the row.
- Superseding evidence writes a new record pointing at the one it replaces. The
  old record stays and stays queryable.
- Revocation sets a revocation reason and time; it does not delete. An
  assessment that used revoked evidence remains inspectable, and the fact that
  its input was later revoked is exactly what an auditor needs to see.

Freshness is evaluated at assessment time against the validity window and the
control's freshness requirement. Stale evidence does not become false — it
becomes **UNKNOWN with reason `STALE_EVIDENCE`**, which is a different and more
honest outcome than either passing or failing.

Bytes live in S3-compatible object storage; the record lives in PostgreSQL. The
record is the evidence as far as the assurance chain is concerned, which is why
the bytes may be moved to cold storage under a retention policy while the record
stays.

## Alternatives considered

**Mutable evidence rows with an updated timestamp.** Simplest, and it destroys
replayability. Rejected outright.

**A blockchain or external notary for integrity.** Considered and rejected as
disproportionate. The threat is accidental overwrite and internal dispute, not
a database administrator forging history in collusion with the operator. Content
hashing plus an append-only audit log addresses the former; the latter is
addressed by backups and by not being your own auditor.

**Storing bytes in PostgreSQL as `bytea`.** Simplifies deployment at small
scale, and makes the database an order of magnitude larger, backups slow, and
retention pruning a `VACUUM FULL`. Rejected; the object store is a supported
dependency with a filesystem driver for single-node deployments.

## Consequences

- Storage grows monotonically. Deliberate, bounded in practice by evidence
  volume rather than assessment volume, and addressed by retention policy on
  bytes rather than on records (`docs/operations/vps-sizing.md`).
- "Show me the evidence this assessment used" is a foreign key, not a
  reconstruction.
- Uploading a corrected document is an explicit supersession with a reason,
  which is a small friction that produces a real audit trail.

## Security implications

Uploads are validated against an allow-list of content types
(`SECURITY_ALLOWED_EVIDENCE_MIME_TYPES`) and a size cap, and stored under
tenant-scoped keys. Retrieval goes through the API so authorisation applies; the
object store is not publicly reachable and is not exposed by the edge proxy.

Content hashing is over the bytes as stored. A hash that no longer matches is
surfaced as an integrity failure on the evidence record rather than being
repaired, because a silent repair is indistinguishable from tampering.

## Operational implications

The object store is a second thing to back up. `docs/operations/` covers the
pairing: a PostgreSQL dump without the corresponding objects restores an
assurance history whose artefacts are missing, which is recoverable but should
be a known state rather than a surprise.

## Migration implications

Adding a field to an evidence record is additive. Changing the meaning of
`valid_until` for existing records is not, and would require a new field —
historical records mean what they meant when they were written.
