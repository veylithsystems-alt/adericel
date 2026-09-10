#!/bin/sh
# Adericel database restore.
#
# Restores a dump into a named database, which is deliberately NOT the live one
# by default: the common case for running this is verification, and a restore
# script whose easiest invocation overwrites production is a script that will
# eventually overwrite production.
#
# Usage:
#   restore.sh <dump-file> [target-database]
#
# Verify the checksum against the manifest before restoring. A dump that has
# been truncated in transit restores partially and silently.

set -eu

dump="${1:?usage: restore.sh <dump-file> [target-database]}"
target="${2:-adericel_restore_check}"
PGUSER="${POSTGRES_USER:-adericel}"

if [ ! -f "${dump}" ]; then
  echo "adericel-restore: no such dump: ${dump}" >&2
  exit 1
fi

manifest="$(echo "${dump}" | sed 's/\.dump$/.json/')"
if [ -f "${manifest}" ]; then
  expected="$(sed -n 's/.*"sha256": "\([a-f0-9]*\)".*/\1/p' "${manifest}")"
  actual="$(sha256sum "${dump}" | cut -d' ' -f1)"
  if [ "${expected}" != "${actual}" ]; then
    echo "adericel-restore: checksum mismatch. Expected ${expected}, got ${actual}." >&2
    echo "adericel-restore: refusing to restore a dump that does not match its manifest." >&2
    exit 1
  fi
  echo "adericel-restore: checksum verified against ${manifest}"
else
  echo "adericel-restore: WARNING no manifest beside this dump; restoring unverified" >&2
fi

if [ "${target}" = "${POSTGRES_DB:-adericel}" ]; then
  # Restoring over the live database is a real operation and sometimes the right
  # one. It is not something that should happen because somebody omitted an
  # argument.
  if [ "${ADERICEL_RESTORE_OVER_LIVE:-no}" != "yes" ]; then
    echo "adericel-restore: refusing to restore over the live database." >&2
    echo "adericel-restore: set ADERICEL_RESTORE_OVER_LIVE=yes if that is genuinely intended." >&2
    exit 1
  fi
fi

echo "adericel-restore: recreating ${target}"
psql --username="${PGUSER}" --dbname=postgres -c "DROP DATABASE IF EXISTS ${target} WITH (FORCE)"
psql --username="${PGUSER}" --dbname=postgres -c "CREATE DATABASE ${target}"

echo "adericel-restore: restoring into ${target}"
# --no-owner and --no-privileges so the restore does not require the same role
# names to exist in the target. Row level security policies restore regardless;
# the application role is created by migration 0011 on the target if needed.
pg_restore --username="${PGUSER}" --dbname="${target}" \
  --no-owner --no-privileges --exit-on-error "${dump}"

echo "adericel-restore: restored. Verify with: pnpm verify:restore --target ${target}"
