# Operations runbook

For the person on the other end of the alert. Each section is a symptom, what it
means, and what to do — in that order, because at 3am the diagnosis matters more
than the architecture.

## First things to check

```bash
docker compose ps                          # what is running
docker compose logs --tail=200 api         # recent API activity
curl -s localhost/health/ready | jq        # API, database, object store
docker stats --no-stream                   # memory against the limits
```

`/health/ready` failing while `/health/live` succeeds means the process is fine
and a dependency is not. That distinction is the first fork in almost every
diagnosis.

---

## The API will not start

**`AUTH_JWT_SECRET must be set` / `AUTH_CREDENTIAL_ENCRYPTION_KEY must be set`**

Working as designed: Adericel refuses to boot into a known-insecure default in
production. Generate and set them:

```bash
openssl rand -base64 48   # AUTH_JWT_SECRET
openssl rand -base64 32   # AUTH_CREDENTIAL_ENCRYPTION_KEY
```

**Do not regenerate `AUTH_CREDENTIAL_ENCRYPTION_KEY` on an existing
deployment.** Every stored integration credential becomes unrecoverable and must
be re-entered.

**`migrate` exits non-zero**

Read its logs before anything else. A checksum mismatch means a migration file
changed after it was applied — restore the file to its applied content rather
than forcing past it, because the schema and the code no longer agree about what
that migration did.

## The API refuses to start: "tenant isolation is not enforced"

Working as designed, and the most important refusal in the product.

Row level security is bypassed unconditionally by a superuser, and `FORCE ROW
LEVEL SECURITY` does nothing about that. Every transaction therefore assumes the
`adericel_app` role, created by migration 0011, and startup verifies that the
effective role cannot bypass RLS before a single request is served.

If this fires:

```sql
-- Does the role exist, and is it safe?
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'adericel_app';

-- Can the connecting role assume it?
SELECT pg_has_role(current_user, 'adericel_app', 'MEMBER');
```

Missing role: re-run migrations. If the migration runner lacks CREATEROLE it
will have failed with the exact statement for a DBA to run.

Role exists but is a superuser: `ALTER ROLE adericel_app NOSUPERUSER NOBYPASSRLS;`

**Do not work around this by unsetting `DATABASE_APPLICATION_ROLE`.** An
instance in that state serves every request correctly right up until it serves
one customer another customer's assurance data, with no signal in between.

## Everything returns no data, but nothing errors

The classic fail-closed signature: tenant context was not established, so
row-level security correctly returned nothing (ADR-0007).

Check that `DATABASE_APPLICATION_ROLE` is set and — this is the one that catches
people — that the application is **not** connecting as the table owner. An owner
connection bypasses nothing (`FORCE` is enabled) but a misconfigured role can
fail to see rows at all.

```sql
SELECT current_user, session_user;
SELECT current_setting('adericel.organisation_id', true);
```

## PostgreSQL was killed by the OOM killer

```bash
dmesg | grep -i 'killed process'
```

The compose limits exist to prevent this. If it happened anyway:

1. Confirm the limits are actually applied — `docker stats` shows the limit.
2. Confirm swap exists (2 GB, `vm.swappiness=10`; see the sizing document).
3. If the `ai` profile is running, stop it and see whether the pressure goes.
   Ollama is the only service large enough to displace PostgreSQL.

## Actions are stuck in VERIFYING

Usually not a fault. Verification re-observes through the connector, and many
vendors take minutes to propagate a change. An action past its timeout becomes
`TIMED_OUT`, which is a recorded outcome and not a failure to investigate on its
own.

Investigate when _every_ action for one integration times out: that is a
collection problem, not a propagation delay. Check `integration_runs` for that
organisation, then the connector's last successful collection.

**Never** resolve this by marking an action confirmed. An unverified action is
information; a falsely confirmed one closes a finding that is still open.

## Outbox events are dead-lettering

```sql
SELECT event_type, COUNT(*), MAX(last_error)
  FROM outbox_events WHERE status = 'DEAD_LETTER'
 GROUP BY event_type;
```

Dead letters mean delivery failed `WORKER_MAX_DELIVERY_ATTEMPTS` times. The
event is not lost — it is parked. Fix the downstream cause, then replay through
the recovery workflow in the n8n export, which replays under an operator's
control rather than automatically.

Before replaying, confirm the idempotency retention window still exceeds the age
of the dead letters. If it does not, a replay can re-execute (ADR-0016).

## An integration is reporting DEGRADED

`DEGRADED` means the last collection was **partial** — a truncated page or a
refused permission — not that it failed. The consequence is that rules over the
subject kinds it did not fully see resolve to UNKNOWN, which is correct and is
the reason this matters.

Check the integration's granted permissions at the vendor first. A vendor
permission removed by a customer's own administrator is the most common cause.

## n8n is not receiving events

1. `N8N_ENABLED=true` in the API's environment.
2. `N8N_WEBHOOK_SIGNING_SECRET` set to the _same_ value on both sides. Left
   empty, webhook ingestion is disabled outright rather than accepting unsigned
   deliveries.
3. Clocks. Deliveries outside a five-minute window are rejected as replays.
4. The workflow is active. Five activate on import; the rest are sub-workflows.

## Disk is filling

Largest consumers, in the order they usually appear:

1. **n8n execution data.** Pruning is configured (14 days, 20,000 executions);
   confirm it is actually running. None of this is Adericel truth.
2. **Object storage** — evidence bytes. Apply the retention policy: bytes past
   retention can move to cold storage while the evidence _record_ stays.
3. **`outbox_events`** — completed rows are pruned; dead letters are not.
4. **PostgreSQL WAL** if archiving is configured and the archive command is
   failing. This one takes the database down if ignored.

Never prune assessments, the event log, the audit log, or evidence records. If
that becomes tempting, it is the signal to move PostgreSQL to its own host.

## Taking a backup

```bash
docker compose --profile core --profile backup run --rm backup
```

Both profiles: compose rejects a dependency on a service outside the active
profile set, and the database has to be up to dump it. Schedule it from the
host's own crontab rather than from a container, so it cannot stop running
because something in the stack is unhealthy:

```
0 2 * * *  cd /srv/adericel && \
  docker compose --profile core --profile backup run --rm backup
```

Each run writes two files into `BACKUP_DIR`: the dump, and a manifest recording
its SHA-256, the schema version it was taken at, and row counts for the tables
carrying the assurance record. The manifest is what makes a restore verifiable
rather than merely completed — without it, "the restore finished" and "the data
came back" are different claims and only the first is observable.

**Copy both files off the host.** A backup on the same VPS does not survive
losing the VPS, which is the failure it exists for.

## Restoring from backup

```bash
# Into a scratch database. The script refuses to overwrite the live one unless
# ADERICEL_RESTORE_OVER_LIVE=yes, because the common reason to run this is
# verification and a script whose easiest invocation destroys production will
# eventually destroy production.
docker compose --profile core --profile backup run --rm \
  --entrypoint /scripts/restore.sh backup /backup/adericel-<timestamp>.dump \
  adericel_restore_check
```

It refuses a dump whose checksum does not match its manifest. A dump truncated
in transit restores partially and silently, which is worse than failing.

Then prove it:

```bash
pnpm verify:restore --target adericel_restore_check \
  --manifest var/backup/adericel-<timestamp>.json
```

That checks four things, and reports each separately:

1. **Row counts** against the manifest. A restore that completes with an empty
   `assessments` table has restored nothing worth having, and reports success.
2. **Forced row level security** on every table carrying an `organisation_id`.
   A restored database that has quietly lost tenant isolation is worse than no
   restore at all: it works, and it leaks.
3. **Passport integrity** — every stored Assurance Passport re-hashed against
   its recorded hash. That hash is derived from content rather than from any
   database identifier, so a match proves the bytes came back, not merely the
   rows.
4. **Recorded assessment inputs** restored as well-formed snapshots, so
   historical replay still works against the restored data.

A non-zero exit means the backup is not proven. Treat that as an incident in
itself: the backup you have is not the backup you thought you had.

Restore the evidence objects to match the same point in time. A database restore
without them leaves records whose artefacts are missing: recoverable and
inspectable, but it should be a known state rather than a discovery.

## A restart left `migrate` in a failed state

If `docker compose restart` runs while PostgreSQL is briefly unavailable, the
one-shot `migrate` service exits non-zero and stays that way. Because `api` and
`worker` depend on it completing successfully, the next `up` will not start
them.

This is the intended behaviour — an API whose migrations failed should not
serve — but it looks like a hung deployment. Re-run it once the database is
healthy:

```bash
docker compose --profile core up -d
docker compose --profile core logs migrate --tail 20   # expect "up to date"
```

Migrations are idempotent: a second run applies nothing and reports "database is
up to date".

## Rotating the credential encryption key

There is no online rotation yet (ADR-0019). The procedure is:

1. Stop the API and worker.
2. Re-seal every integration credential with the new key.
3. Update `AUTH_CREDENTIAL_ENCRYPTION_KEY` and start.

Take a backup first, and keep the old key until the re-seal is verified.

## Escalating

Collect before asking: the correlation id, `docker compose ps`, the failing
service's last 200 log lines, and `/health/ready`. The correlation id alone
assembles the whole operation across API, worker and workflow — "send me the
correlation id" is a complete diagnostic request (ADR-0021).
