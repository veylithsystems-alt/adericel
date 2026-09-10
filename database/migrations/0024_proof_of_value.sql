-- migrate:up
-- =============================================================================
-- What the work is worth, according to the MSP.
--
-- Adericel measures what it did. It does not, and must not, decide what that is
-- worth to somebody else's business. "A hundred customers used to take 180
-- staff-hours a month" is not a fact Adericel can observe, and asserting it
-- would be manufactured certainty pointed directly at the person paying.
--
-- So durations live here, supplied by the MSP, carrying their own provenance,
-- and every one of them is attributable to a person and a date.
--
-- THE CONSTRAINT THAT MATTERS
--
-- A duration must state where it came from and how it was arrived at. A number
-- with no basis cannot be checked, and a number nobody can check is not
-- evidence of a saving — it is a marketing figure with a decimal point. The
-- database refuses it rather than trusting the service to.
-- =============================================================================

CREATE TABLE msp_task_efforts (
  msp_id        uuid NOT NULL REFERENCES msps (id) ON DELETE CASCADE,
  -- A key from ASSURANCE_TASKS. Not a foreign key: the catalogue is code, and
  -- a row naming a task that no longer exists is ignored rather than blocking
  -- a deployment.
  task_key      text NOT NULL,
  minutes       numeric(6,2),
  source        text NOT NULL
                  CHECK (source IN ('MSP_MEASURED', 'MSP_ESTIMATED', 'INDUSTRY_REFERENCE', 'UNKNOWN')),
  -- How the MSP arrived at it. Required for anything but UNKNOWN.
  basis         text,
  recorded_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (msp_id, task_key),

  -- A source other than UNKNOWN must carry both a number and its reasoning.
  CONSTRAINT msp_task_efforts_sourced CHECK (
    source = 'UNKNOWN'
    OR (minutes IS NOT NULL AND basis IS NOT NULL AND length(btrim(basis)) >= 3)
  ),
  -- An UNKNOWN carries no number, so it cannot contribute to a total by
  -- accident.
  CONSTRAINT msp_task_efforts_unknown_is_empty CHECK (
    source <> 'UNKNOWN' OR minutes IS NULL
  ),
  -- Ten hours for one instance of one task is not a duration, it is a typo or
  -- an attempt to manufacture a saving.
  CONSTRAINT msp_task_efforts_plausible CHECK (
    minutes IS NULL OR (minutes >= 0 AND minutes <= 600)
  )
);

CREATE INDEX msp_task_efforts_msp_idx ON msp_task_efforts (msp_id);

ALTER TABLE msp_task_efforts ENABLE ROW LEVEL SECURITY;
ALTER TABLE msp_task_efforts FORCE ROW LEVEL SECURITY;
-- An MSP's own commercial model. It belongs to the MSP control room, and a
-- client organisation must never see what its MSP believes the work costs.
CREATE POLICY platform_only ON msp_task_efforts
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- =============================================================================
-- Proof-of-value reports, kept.
--
-- A report is a statement about a period, and a period does not change. Keeping
-- each one means an MSP can show a trend rather than only a snapshot, and means
-- a figure quoted in a proposal three months ago can still be produced.
--
-- The content hash covers the figures, so a report somebody has been sent can
-- be checked against the one Adericel produced — the same discipline as the
-- Assurance Passport, for the same reason.
-- =============================================================================

CREATE TABLE value_reports (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_id               uuid NOT NULL REFERENCES msps (id) ON DELETE CASCADE,
  period_from          timestamptz NOT NULL,
  period_to            timestamptz NOT NULL,
  organisation_count   integer NOT NULL,
  -- The figures, exactly as reported.
  content              jsonb NOT NULL,
  content_hash         text NOT NULL,
  -- Carried out of the report so a query can find the incomplete ones without
  -- unpacking the JSON.
  hours_displaced      numeric(10,2) NOT NULL,
  hours_still_spent    numeric(10,2) NOT NULL,
  model_completeness   numeric(4,3) NOT NULL,
  caveat_count         integer NOT NULL,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  generated_by         uuid REFERENCES users (id) ON DELETE SET NULL,

  CONSTRAINT value_reports_period CHECK (period_to > period_from),
  CONSTRAINT value_reports_completeness CHECK (model_completeness BETWEEN 0 AND 1)
);

CREATE INDEX value_reports_msp_idx ON value_reports (msp_id, period_to DESC);
CREATE INDEX value_reports_hash_idx ON value_reports (content_hash);

ALTER TABLE value_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE value_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON value_reports
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- migrate:down
DROP TABLE IF EXISTS value_reports;
DROP TABLE IF EXISTS msp_task_efforts;
