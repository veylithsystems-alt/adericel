-- migrate:up

-- Where a verification's reading came from.
--
-- A `verifications` row said CONFIRMED or REFUTED and recorded the method and
-- the detail, but not which collection run produced the value it judged. The
-- action service accepted that value from its caller (RR-095), so there was
-- nothing to record: the row asserted that the external system had been looked
-- at without holding anything that showed it.
--
-- Now a verification either names the `integration_runs` row its reading came
-- out of, or names the reason no run was possible. Exactly one of the two, by
-- constraint, so a row cannot claim both or neither.
ALTER TABLE verifications
  ADD COLUMN integration_run_id uuid REFERENCES integration_runs (id) ON DELETE SET NULL,
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN not_observable_reason text
    CHECK (not_observable_reason IN ('NO_INTEGRATION', 'NO_TARGET'));

-- Deliberately NOT VALID.
--
-- Rows written before this migration have all three columns null, which the
-- constraint forbids. Validating would fail the upgrade on any database that
-- has ever verified an action — the exact class of defect the populated-upgrade
-- suite exists to catch (RR-091). New and updated rows are checked; the
-- historical ones are left as the honest record that their provenance was not
-- captured, rather than backfilled with a guess.
ALTER TABLE verifications
  ADD CONSTRAINT verifications_provenance_exclusive
  CHECK (
    (integration_run_id IS NOT NULL AND observed_at IS NOT NULL AND not_observable_reason IS NULL)
    OR
    (integration_run_id IS NULL AND observed_at IS NULL AND not_observable_reason IS NOT NULL)
    OR
    (integration_run_id IS NULL AND observed_at IS NULL AND not_observable_reason IS NULL)
  ) NOT VALID;

CREATE INDEX verifications_run_idx
  ON verifications (integration_run_id)
  WHERE integration_run_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS verifications_run_idx;
ALTER TABLE verifications DROP CONSTRAINT IF EXISTS verifications_provenance_exclusive;
ALTER TABLE verifications
  DROP COLUMN IF EXISTS not_observable_reason,
  DROP COLUMN IF EXISTS observed_at,
  DROP COLUMN IF EXISTS integration_run_id;
