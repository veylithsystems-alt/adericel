-- migrate:up
-- =============================================================================
-- Events, audit, idempotency and operational tables.
--
-- The outbox is written in the same transaction as the state change it
-- describes. That is what makes "an event was published" and "the change was
-- committed" the same fact, and it is why n8n can trust what it receives.
-- =============================================================================

CREATE TABLE outbox_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type              text NOT NULL,
  schema_version    integer NOT NULL DEFAULT 1,
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  msp_id            uuid REFERENCES msps (id) ON DELETE CASCADE,
  subject_type      text NOT NULL,
  subject_id        text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id    uuid NOT NULL,
  causation_id      uuid,
  actor             text NOT NULL,
  state             text NOT NULL DEFAULT 'PENDING'
                      CHECK (state IN ('PENDING', 'IN_FLIGHT', 'DELIVERED', 'DEAD_LETTER')),
  attempts          integer NOT NULL DEFAULT 0,
  available_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at        timestamptz,
  claimed_by        text,
  last_error        text,
  delivered_at      timestamptz,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- The worker claims work with FOR UPDATE SKIP LOCKED over this index.
CREATE INDEX outbox_pending_idx ON outbox_events (available_at, id)
  WHERE state IN ('PENDING', 'IN_FLIGHT');
CREATE INDEX outbox_org_idx ON outbox_events (organisation_id, occurred_at DESC);
CREATE INDEX outbox_correlation_idx ON outbox_events (correlation_id);
CREATE INDEX outbox_dead_letter_idx ON outbox_events (occurred_at DESC) WHERE state = 'DEAD_LETTER';

-- Durable, append-only event log. Separate from the outbox so that trimming
-- delivered outbox rows never destroys the historical record.
CREATE TABLE event_log (
  id                uuid PRIMARY KEY,
  type              text NOT NULL,
  schema_version    integer NOT NULL DEFAULT 1,
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  msp_id            uuid REFERENCES msps (id) ON DELETE CASCADE,
  subject_type      text NOT NULL,
  subject_id        text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id    uuid NOT NULL,
  causation_id      uuid,
  actor             text NOT NULL,
  occurred_at       timestamptz NOT NULL
);
CREATE INDEX event_log_org_idx ON event_log (organisation_id, occurred_at DESC, id DESC);
CREATE INDEX event_log_type_idx ON event_log (type, occurred_at DESC);
CREATE INDEX event_log_correlation_idx ON event_log (correlation_id);
CREATE INDEX event_log_subject_idx ON event_log (subject_type, subject_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Audit: who did what, including denials. A denied request is often the most
-- interesting record in the table, so it is stored with the same weight as a
-- successful one.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  msp_id            uuid REFERENCES msps (id) ON DELETE CASCADE,
  actor_type        text NOT NULL,
  actor_id          text NOT NULL,
  actor_display     text NOT NULL,
  action            text NOT NULL,
  resource_type     text NOT NULL,
  resource_id       text,
  outcome           text NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
  reason            text,
  request_id        text,
  correlation_id    uuid,
  source_ip         inet,
  user_agent        text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (organisation_id, occurred_at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_log_denied_idx ON audit_log (occurred_at DESC) WHERE outcome = 'DENIED';
CREATE INDEX audit_log_resource_idx ON audit_log (resource_type, resource_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- API-level idempotency. A repeated POST with the same key returns the stored
-- response rather than performing the operation twice.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  principal_id      text NOT NULL,
  key               text NOT NULL,
  method            text NOT NULL,
  path              text NOT NULL,
  request_digest    text NOT NULL,
  response_status   integer,
  response_body     jsonb,
  state             text NOT NULL DEFAULT 'IN_PROGRESS'
                      CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  expires_at        timestamptz NOT NULL
);
CREATE UNIQUE INDEX idempotency_keys_unique ON idempotency_keys (principal_id, key);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Scheduled work. Kept in the database rather than in n8n so that a workflow
-- outage delays execution but never loses the schedule.
-- ---------------------------------------------------------------------------
CREATE TABLE scheduled_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  job_type          text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  cron              text,
  next_run_at       timestamptz NOT NULL,
  last_run_at       timestamptz,
  last_status       text CHECK (last_status IN ('SUCCEEDED', 'FAILED', 'SKIPPED')),
  last_error        text,
  enabled           boolean NOT NULL DEFAULT true,
  locked_at         timestamptz,
  locked_by         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (next_run_at) WHERE enabled;
CREATE UNIQUE INDEX scheduled_jobs_unique
  ON scheduled_jobs (COALESCE(organisation_id, '00000000-0000-0000-0000-000000000000'), job_type);
CREATE TRIGGER scheduled_jobs_touch BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Reports produced for customers and MSPs, retained so a delivered report can
-- always be reproduced exactly as it was sent.
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  msp_id            uuid REFERENCES msps (id) ON DELETE CASCADE,
  report_type       text NOT NULL,
  parameters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'GENERATING', 'READY', 'FAILED')),
  content           jsonb,
  storage_key       text,
  content_hash      text,
  requested_by      text NOT NULL,
  period_start      timestamptz,
  period_end        timestamptz,
  generated_at      timestamptz,
  error_detail      text,
  correlation_id    uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_org_idx ON reports (organisation_id, created_at DESC);
CREATE INDEX reports_msp_idx ON reports (msp_id, created_at DESC) WHERE msp_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Health probe results, so Adericel can distinguish "the customer has an
-- assurance problem" from "Adericel has an operational problem".
-- ---------------------------------------------------------------------------
CREATE TABLE health_checks (
  component       text NOT NULL,
  status          text NOT NULL CHECK (status IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),
  detail          text,
  latency_ms      integer,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component)
);

-- migrate:down
DROP TABLE IF EXISTS health_checks;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS scheduled_jobs;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS event_log;
DROP TABLE IF EXISTS outbox_events;
