-- migrate:up
-- =============================================================================
-- Erasure, and a retention clock that actually ticks.
--
-- Migration 0021 added `erasure_requested_at` and `erasure_completed_at` to
-- `organisations` and described, in a comment, an erasure process that was
-- separate from closure. Nothing anywhere referenced either column. A column
-- that names a capability nobody implemented is the same failure this product
-- exists to refuse: a record asserting something that was never done.
--
-- This migration gives erasure somewhere to leave its result, and gives the
-- retention sweep somewhere to record that it ran.
--
-- WHY A TOMBSTONE RATHER THAN A KEPT ROW
--
-- Erasing an organisation deletes it, and the cascade that hangs off
-- `organisations` takes its evidence, claims, graph, findings, actions and
-- audit trail with it. That is what erasure has to mean; anything less is
-- pseudonymisation wearing the word.
--
-- But some facts must outlive the data:
--
--   - that this organisation existed, so a customer's own record of having been
--     a customer can be reconciled;
--   - that a complete export was handed over first, and its hash, so the bundle
--     the customer holds can still be checked years later;
--   - who asked for erasure, when, and on what basis, because "we destroyed a
--     customer's entire record" is exactly the act that must be attributable.
--
-- The tombstone carries those and nothing else. It holds no name, no address,
-- no contact, and no evidence — only identifiers and dates. The slug is kept
-- because it is an identifier the customer chose and used, and because a
-- tombstone nobody can match to anything answers no question.
-- =============================================================================

CREATE TABLE erased_organisations (
  organisation_id       uuid PRIMARY KEY,
  msp_id                uuid REFERENCES msps (id) ON DELETE SET NULL,
  slug                  text NOT NULL,
  -- The hash of the export handed over before anything was destroyed. Erasure
  -- is refused without it, exactly as closure is.
  final_export_hash     text NOT NULL,
  final_export_at       timestamptz NOT NULL,
  closed_at             timestamptz NOT NULL,
  erasure_requested_at  timestamptz NOT NULL,
  erasure_requested_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  erasure_reason        text NOT NULL,
  erasure_completed_at  timestamptz NOT NULL,
  -- What the erasure actually did, table by table: the row counts destroyed.
  -- Recorded so the claim "erased" can be inspected rather than believed.
  destroyed             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Any table that still held rows after the cascade ran. Empty is the only
  -- acceptable value; a non-empty one means the erasure was INCOMPLETE and the
  -- service says so rather than reporting success.
  residual              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX erased_organisations_msp_idx ON erased_organisations (msp_id, erasure_completed_at DESC);

ALTER TABLE erased_organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE erased_organisations FORCE ROW LEVEL SECURITY;
-- A tombstone is a company record, not a tenant record: the tenant it describes
-- no longer exists.
CREATE POLICY platform_only ON erased_organisations
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- =============================================================================
-- The retention sweep's own record.
--
-- A retention policy nobody can prove ran is a policy in a document. Each sweep
-- writes one row per register entry it acted on, so "we delete session
-- addresses after ninety days" is answerable with evidence rather than with the
-- policy that says so.
-- =============================================================================

CREATE TABLE retention_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at          timestamptz NOT NULL DEFAULT now(),
  -- The register entry this row is about, as `table(column, column)`.
  entry           text NOT NULL,
  table_name      text NOT NULL,
  treatment       text NOT NULL CHECK (treatment IN ('DELETE', 'PSEUDONYMISE')),
  retention_days  integer NOT NULL,
  cutoff          timestamptz NOT NULL,
  rows_affected   bigint NOT NULL,
  -- False when the sweep was asked what it would do rather than told to do it.
  applied         boolean NOT NULL DEFAULT true
);

CREATE INDEX retention_runs_recent_idx ON retention_runs (ran_at DESC);
CREATE INDEX retention_runs_entry_idx ON retention_runs (entry, ran_at DESC);

ALTER TABLE retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON retention_runs
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- Erasure may only be requested for an organisation that has already closed,
-- and closure already requires an export. Enforced here rather than only in the
-- service, because this is the constraint whose violation is unrecoverable.
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_erasure_after_closure;
ALTER TABLE organisations ADD CONSTRAINT organisations_erasure_after_closure CHECK (
  erasure_requested_at IS NULL OR (status = 'CLOSED' AND closed_at IS NOT NULL)
);

-- migrate:down
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_erasure_after_closure;
DROP TABLE IF EXISTS retention_runs;
DROP TABLE IF EXISTS erased_organisations;
