#!/bin/sh
# Adericel database backup.
#
# Runs inside the PostgreSQL image, which is the only container in the stack
# that carries pg_dump at exactly the server's version. A dump taken by a
# different major version is a dump that may not restore, and finding that out
# during an incident is the whole failure mode this file exists to prevent.
#
# Produces two files per run:
#
#   adericel-<timestamp>.dump   custom format, compressed, restorable with
#                               pg_restore into an empty database
#   adericel-<timestamp>.json   a manifest: SHA-256 of the dump, the schema
#                               version it was taken at, and row counts for the
#                               tables that carry the assurance record
#
# The manifest is what makes a restore verifiable rather than merely completed.
# Without it, "the restore finished" and "the data came back" are different
# claims and only the first one is observable.
#
# It deliberately does NOT contain AUTH_CREDENTIAL_ENCRYPTION_KEY or any other
# secret. Sealed credentials restore as ciphertext and stay unreadable without
# the key, which is the intended property: a stolen backup is not a stolen
# estate. Losing the key means losing the integrations, so it belongs in a
# password manager, not in this directory.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backup}"
PGDATABASE="${POSTGRES_DB:-adericel}"
PGUSER="${POSTGRES_USER:-adericel}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="${BACKUP_DIR}/adericel-${timestamp}.dump"
manifest="${BACKUP_DIR}/adericel-${timestamp}.json"

mkdir -p "${BACKUP_DIR}"

echo "adericel-backup: dumping ${PGDATABASE} to ${dump}"
# --clean --if-exists so the dump can be restored over an existing schema.
# -Fc (custom) rather than plain SQL: it is compressed, and pg_restore can
# reorder and parallelise it.
pg_dump --username="${PGUSER}" --dbname="${PGDATABASE}" \
  --format=custom --compress=6 --clean --if-exists \
  --file="${dump}"

checksum="$(sha256sum "${dump}" | cut -d' ' -f1)"
size="$(wc -c < "${dump}" | tr -d ' ')"

# Row counts for the tables that carry the assurance record. A restore that
# completes with an empty `assessments` table has not restored anything worth
# having, and only a count taken at dump time can reveal it.
counts="$(psql --username="${PGUSER}" --dbname="${PGDATABASE}" -At -F',' -c "
  SELECT 'organisations', count(*) FROM adericel.organisations
  UNION ALL SELECT 'evidence', count(*) FROM adericel.evidence
  UNION ALL SELECT 'claims', count(*) FROM adericel.claims
  UNION ALL SELECT 'assessments', count(*) FROM adericel.assessments
  UNION ALL SELECT 'assessment_inputs', count(*) FROM adericel.assessment_inputs
  UNION ALL SELECT 'assurance_passports', count(*) FROM adericel.assurance_passports
  UNION ALL SELECT 'actions', count(*) FROM adericel.actions
  UNION ALL SELECT 'audit_log', count(*) FROM adericel.audit_log
  ORDER BY 1")"

schema_version="$(psql --username="${PGUSER}" --dbname="${PGDATABASE}" -At \
  -c 'SELECT max(id) FROM public.schema_migrations')"

{
  printf '{\n'
  printf '  "schema": "adericel.backup/v1",\n'
  printf '  "takenAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "database": "%s",\n' "${PGDATABASE}"
  printf '  "dumpFile": "adericel-%s.dump",\n' "${timestamp}"
  printf '  "sha256": "%s",\n' "${checksum}"
  printf '  "sizeBytes": %s,\n' "${size}"
  printf '  "schemaVersion": "%s",\n' "${schema_version}"
  printf '  "rowCounts": {\n'
  first=1
  echo "${counts}" | while IFS=',' read -r table count; do
    [ -z "${table}" ] && continue
    if [ "${first}" -eq 1 ]; then first=0; else printf ',\n'; fi
    printf '    "%s": %s' "${table}" "${count}"
  done
  printf '\n  }\n'
  printf '}\n'
} > "${manifest}"

echo "adericel-backup: wrote ${manifest} (sha256 ${checksum}, ${size} bytes)"

# Retention. Deliberately after the new backup is written and checksummed, so a
# failed dump never causes the previous good one to be deleted.
if [ "${RETAIN_DAYS}" -gt 0 ]; then
  find "${BACKUP_DIR}" -name 'adericel-*.dump' -mtime "+${RETAIN_DAYS}" -delete
  find "${BACKUP_DIR}" -name 'adericel-*.json' -mtime "+${RETAIN_DAYS}" -delete
fi

echo "adericel-backup: done"
