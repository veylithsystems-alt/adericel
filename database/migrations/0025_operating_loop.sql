-- migrate:up
-- =============================================================================
-- The loop, as a thing rather than as a side effect.
--
-- Adericel already collects, determines, triages, remediates and verifies. It
-- does them as separate scheduled jobs and separate routes, which means the
-- loop an MSP is actually buying -- connect, discover, collect, establish
-- truth, find exceptions, prioritise, fix what is safe, verify, prove, repeat
-- -- exists only as emergent behaviour.
--
-- Emergent behaviour cannot be measured, and "how much work does this take off
-- my desk" is the question the product lives or dies on.
--
-- So a cycle becomes a recorded object: one pass of the loop over a portfolio,
-- with what each stage did and how long it took. That turns the commercial
-- claim into arithmetic over rows rather than an assertion.
-- =============================================================================

CREATE TABLE loop_cycles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_id                  uuid REFERENCES msps (id) ON DELETE CASCADE,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  -- How the cycle was started, because a cycle a person had to trigger is a
  -- different commercial fact from one that ran on its own.
  trigger                 text NOT NULL
                            CHECK (trigger IN ('SCHEDULED', 'MANUAL', 'EVENT', 'PROOF')),
  organisations_in_scope  integer NOT NULL DEFAULT 0,

  -- What each stage of the loop actually did. Counts, not estimates.
  observations_collected  integer NOT NULL DEFAULT 0,
  evidence_created        integer NOT NULL DEFAULT 0,
  claims_asserted         integer NOT NULL DEFAULT 0,
  changes_detected        integer NOT NULL DEFAULT 0,
  determinations_made     integer NOT NULL DEFAULT 0,
  determinations_unknown  integer NOT NULL DEFAULT 0,
  exceptions_open         integer NOT NULL DEFAULT 0,
  exceptions_needing_human integer NOT NULL DEFAULT 0,
  remediations_proposed   integer NOT NULL DEFAULT 0,
  remediations_autonomous integer NOT NULL DEFAULT 0,
  remediations_approved   integer NOT NULL DEFAULT 0,
  verifications_confirmed integer NOT NULL DEFAULT 0,
  verifications_refuted   integer NOT NULL DEFAULT 0,

  -- Per-stage wall-clock, so a scaling problem shows up as a stage rather than
  -- as a vague feeling that the product got slower.
  stage_timings           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Organisations the cycle could not complete, and why. A cycle that silently
  -- skipped a customer would overstate coverage on every metric downstream.
  organisations_skipped   jsonb NOT NULL DEFAULT '[]'::jsonb,

  CONSTRAINT loop_cycles_finished CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX loop_cycles_msp_idx ON loop_cycles (msp_id, started_at DESC);

ALTER TABLE loop_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE loop_cycles FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON loop_cycles
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- =============================================================================
-- What an exception costs this MSP to answer.
--
-- The same discipline as msp_task_efforts (ADR-0033): Adericel measures how
-- many exceptions of each kind it raised; only the MSP can say what answering
-- one costs them. There is no default, and an unpriced response type
-- contributes nothing to any capacity figure.
--
-- Priced by RESPONSE TYPE rather than by exception kind, because that is how
-- the work actually divides: a morning of fifteen decisions is a different day
-- from a morning of three investigations, and an MSP can time those four
-- categories far more easily than fifteen kinds.
-- =============================================================================

CREATE TABLE msp_response_efforts (
  msp_id        uuid NOT NULL REFERENCES msps (id) ON DELETE CASCADE,
  response_type text NOT NULL
                  CHECK (response_type IN ('DECIDE', 'CONFIGURE', 'INVESTIGATE', 'ASK_CUSTOMER')),
  minutes       numeric(6,2),
  source        text NOT NULL
                  CHECK (source IN ('MSP_MEASURED', 'MSP_ESTIMATED', 'INDUSTRY_REFERENCE', 'UNKNOWN')),
  basis         text,
  recorded_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (msp_id, response_type),

  CONSTRAINT msp_response_efforts_sourced CHECK (
    source = 'UNKNOWN'
    OR (minutes IS NOT NULL AND basis IS NOT NULL AND length(btrim(basis)) >= 3)
  ),
  CONSTRAINT msp_response_efforts_unknown_is_empty CHECK (
    source <> 'UNKNOWN' OR minutes IS NULL
  ),
  CONSTRAINT msp_response_efforts_plausible CHECK (
    minutes IS NULL OR (minutes >= 0 AND minutes <= 600)
  )
);

ALTER TABLE msp_response_efforts ENABLE ROW LEVEL SECURITY;
ALTER TABLE msp_response_efforts FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON msp_response_efforts
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- How many hours one engineer has for assurance work in a month. Supplied by
-- the MSP; there is no default, because a default here would silently decide
-- the headline capacity figure.
ALTER TABLE msps
  ADD COLUMN IF NOT EXISTS engineer_hours_per_month numeric(6,2),
  ADD COLUMN IF NOT EXISTS engineer_hours_basis text;

ALTER TABLE msps DROP CONSTRAINT IF EXISTS msps_engineer_hours_explained;
ALTER TABLE msps ADD CONSTRAINT msps_engineer_hours_explained CHECK (
  engineer_hours_per_month IS NULL
  OR (engineer_hours_basis IS NOT NULL AND length(btrim(engineer_hours_basis)) >= 3)
);

-- migrate:down
ALTER TABLE msps DROP CONSTRAINT IF EXISTS msps_engineer_hours_explained;
ALTER TABLE msps
  DROP COLUMN IF EXISTS engineer_hours_per_month,
  DROP COLUMN IF EXISTS engineer_hours_basis;
DROP TABLE IF EXISTS msp_response_efforts;
DROP TABLE IF EXISTS loop_cycles;
