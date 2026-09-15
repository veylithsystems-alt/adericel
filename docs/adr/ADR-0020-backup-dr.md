# ADR-0020: Backup and disaster recovery

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel is a system of record. Losing it does not merely interrupt a service —
it destroys the assurance history an MSP would rely on to demonstrate what it
knew and when. For a customer facing a regulator or an insurer after an
incident, that history is the product.

The first deployment is a single VPS. There is no replica, no failover, and the
disk belongs to a hosting provider.

## Decision

**Two artefacts, backed up together, restored together, and tested.**

**PostgreSQL** — nightly `pg_dump --format=custom` with compression, plus
continuous WAL archiving where the deployment can afford the storage. The dump
is the floor: a deployment with only nightly dumps has a recovery point
objective of 24 hours and knows it.

**Object storage** — the evidence bytes, synced to a second location. A dump
without the objects restores an assurance history whose artefacts are missing.
That state is recoverable and inspectable — the records, hashes and provenance
are all in PostgreSQL — but it must be a known outcome rather than a discovery.

**Backups leave the machine.** A backup on the same VPS protects against
`DROP TABLE` and against nothing else. The target is a different provider,
because a provider-level failure or account suspension takes the primary and a
same-provider backup with it.

**The encryption key is not in the backup.** `AUTH_CREDENTIAL_ENCRYPTION_KEY`
lives in the environment; a backup that contains it is a backup that decrypts
itself. It is backed up separately, by a different mechanism, with different
access.

**Restore is tested, not assumed.** This was aspirational when first written:
the ADR described a control, and nothing implemented it — the compose file
mounted a `/backup` directory that did not exist and no script produced a dump.
It is now real. `infrastructure/docker/backup/backup.sh` runs in the PostgreSQL
image, the only container carrying `pg_dump` at exactly the server's version,
and writes a dump beside a manifest recording its SHA-256, the schema version it
was taken at, and row counts for the tables that carry the assurance record.
`restore.sh` refuses a dump whose checksum does not match its manifest, and
refuses to restore over the live database unless explicitly told to.
`pnpm verify:restore` then proves the restore rather than reporting that it
completed: row counts against the manifest, forced row level security on every
table carrying an `organisation_id`, and — the strongest check available — every
stored Assurance Passport re-hashed against its recorded hash. That hash is
derived from content rather than from any database identifier, so a match proves
the bytes came back. `tests/integration/backup-restore.test.ts` runs the whole
cycle, including two tests that deliberately corrupt the restored data to prove
the verifier is capable of failing.

## Alternatives considered

**Streaming replication to a standby.** The right answer for availability and
not a backup: replication faithfully replicates a `DELETE`. Worth adding when
there is a second machine; it does not replace dumps.

**Filesystem or VM snapshots only.** Convenient, provider-locked, and a
PostgreSQL snapshot taken without care is crash-consistent rather than
transaction-consistent. Usable as a supplement.

**Point-in-time recovery as the only strategy.** Best recovery point objective
and the most operational machinery: an archive that silently stops working is
discovered during a restore. Nightly dumps are the fallback that fails loudly.

**Backing up n8n's database.** Included, and explicitly _not_ treated as
assurance data. n8n execution history is pruned aggressively by design; losing
it loses operational visibility, not truth.

## Consequences

- Recovery point objective is 24 hours with dumps alone, minutes with WAL
  archiving. Both are stated to customers rather than implied.
- Recovery time objective on a single VPS is dominated by provisioning, not by
  restore: roughly an hour, of which the database restore is a small part.
- Backup storage grows with an append-only database (ADR-0009, ADR-0010).
  Retention is generational — daily for a fortnight, weekly for a quarter,
  monthly for a year — rather than "keep everything".
- The `pg_dump` duration is the practical trigger for moving PostgreSQL to its
  own host, ahead of any memory limit.

## Security implications

Backups contain everything except the sealing key, which means they contain
every tenant's assurance data in one file. They are encrypted at rest at the
destination, access to that destination is separate from access to the
production host, and restore is an audited operation.

An attacker who obtains a backup gets ciphertext for integration credentials
(ADR-0019) and plaintext for everything else. That asymmetry is deliberate and
is the reason the key is stored separately.

## Operational implications

The failure mode to design against is the backup that has been silently failing
for six weeks. Backup completion is monitored as a _positive_ signal — an alert
on the absence of a successful backup, not on the presence of a failure — and
the restore test is scheduled rather than performed when someone remembers.

## Migration implications

Moving to a managed PostgreSQL with its own backup machinery replaces the
mechanism, not the requirements: off-provider copies, separate key custody, and
a restore test that replays an assessment.
