-- migrate:up
-- =============================================================================
-- Total ordering for append-only history.
--
-- PostgreSQL's now() returns the transaction start time, so several rows written
-- inside one transaction share a timestamp. For history that is read back as a
-- sequence of events — an action's state transitions, an audit trail, an event
-- log — that produces an arbitrary order on replay, which is unacceptable for
-- an audit artefact.
--
-- Two changes:
--   * a monotonic sequence column gives a total order independent of clocks;
--   * clock_timestamp() records the real instant of each statement rather than
--     the instant the surrounding transaction began.
--
-- The sequence is the ordering key. The timestamp remains what a human reads.
-- =============================================================================

ALTER TABLE action_transitions ADD COLUMN seq bigserial NOT NULL;
ALTER TABLE action_transitions ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();
CREATE INDEX action_transitions_seq_idx ON action_transitions (action_id, seq);

ALTER TABLE audit_log ADD COLUMN seq bigserial NOT NULL;
ALTER TABLE audit_log ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();
CREATE INDEX audit_log_org_seq_idx ON audit_log (organisation_id, seq DESC);

ALTER TABLE event_log ADD COLUMN seq bigserial NOT NULL;
CREATE INDEX event_log_org_seq_idx ON event_log (organisation_id, seq DESC);

ALTER TABLE outbox_events ADD COLUMN seq bigserial NOT NULL;
CREATE INDEX outbox_events_seq_idx ON outbox_events (seq);

-- Assessments recorded in one transaction (a control, then its requirement,
-- framework and organisation roll-ups) need the same treatment.
ALTER TABLE assessments ADD COLUMN seq bigserial NOT NULL;
CREATE INDEX assessments_org_seq_idx ON assessments (organisation_id, seq DESC);

-- migrate:down
DROP INDEX IF EXISTS assessments_org_seq_idx;
ALTER TABLE assessments DROP COLUMN IF EXISTS seq;
DROP INDEX IF EXISTS outbox_events_seq_idx;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS seq;
DROP INDEX IF EXISTS event_log_org_seq_idx;
ALTER TABLE event_log DROP COLUMN IF EXISTS seq;
DROP INDEX IF EXISTS audit_log_org_seq_idx;
ALTER TABLE audit_log ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE audit_log DROP COLUMN IF EXISTS seq;
DROP INDEX IF EXISTS action_transitions_seq_idx;
ALTER TABLE action_transitions ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE action_transitions DROP COLUMN IF EXISTS seq;
