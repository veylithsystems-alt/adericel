-- migrate:up
-- =============================================================================
-- Recorded assessment inputs.
--
-- Assessments already record the ruleset key, version, hash and an input
-- digest. What they did NOT record was the inputs themselves. A digest is a
-- one-way hash: it can confirm that a candidate set of facts is the one that
-- was used, but it cannot reconstruct them.
--
-- The consequence was that `replay` rebuilt the engine's input from the live
-- graph and merely stamped it with the historical timestamp. Claims are stored
-- as one live row per (subject, predicate) — a re-collection supersedes the
-- previous row — so the moment any scheduled collection ran, replay could no
-- longer reproduce anything. It reported "inputs have changed", truthfully, and
-- was thereafter incapable of ever answering the question it exists to answer:
-- on what basis did Adericel say this?
--
-- That is the difference between a system that records a determination and one
-- that can defend it. An auditor asking "show me why you said this control was
-- satisfied on 14 March" must not be told "our data has moved on".
--
-- The snapshot is content-addressed by the input digest. Re-assessing an
-- unchanged control produces the same digest by construction, so the common
-- case — a nightly run over a stable estate — writes no new snapshot bytes and
-- simply increments a counter. Distinct inputs are stored exactly once.
-- =============================================================================

CREATE TABLE assessment_inputs (
  organisation_id    uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  input_digest       text NOT NULL,
  -- The exact ControlAssessmentInput handed to the engine, canonically encoded.
  snapshot           jsonb NOT NULL,
  engine_version     text NOT NULL,
  ruleset_key        text NOT NULL,
  ruleset_version    text NOT NULL,
  ruleset_hash       text NOT NULL,
  control_id         uuid NOT NULL REFERENCES controls (id) ON DELETE CASCADE,
  rule_key           text NOT NULL,
  first_recorded_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  use_count          bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organisation_id, input_digest)
);

CREATE INDEX assessment_inputs_control_idx
  ON assessment_inputs (organisation_id, control_id, last_used_at DESC);

ALTER TABLE assessment_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assessment_inputs
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- Migration 0011's default privileges already cover tables created by the
-- migration runner, but state the grant explicitly so a deployment that ran
-- 0012 under a different role than 0011 is not silently left without it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adericel_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.assessment_inputs TO adericel_app';
  END IF;
END;
$$;

-- migrate:down
DROP POLICY IF EXISTS tenant_isolation ON assessment_inputs;
DROP TABLE IF EXISTS assessment_inputs;
