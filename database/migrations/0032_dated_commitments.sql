-- migrate:up
-- =============================================================================
-- 0032 — Dated commitments
--
-- A certification assessment on the 14th. An insurer's renewal at the end of
-- the month. A customer questionnaire due Friday. These are the dates that
-- decide what an MSP works on, and Adericel knew none of them.
--
-- WHY THIS MAKES THE RESOLUTION QUEUE WORK
--
-- Without a date, every unknown ranks on severity and fan-out alone — which is
-- better than nothing and still wrong in the way that matters most. A MEDIUM
-- control blocking a certification nine days away is more urgent, today, than a
-- CRITICAL one nobody is being asked about this quarter.
--
-- The queue deliberately does not invent a deadline. A ranking that assumed one
-- would mark everything blocking, and an operator would learn to ignore the
-- ranking — which is worse than no ranking, because it looks like one.
-- =============================================================================

CREATE TABLE organisation_commitments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,

  kind                text NOT NULL CHECK (kind IN (
                        'CERTIFICATION_ASSESSMENT',
                        'INSURER_RENEWAL',
                        'CUSTOMER_QUESTIONNAIRE',
                        'AUDIT',
                        'CONTRACTUAL_DEADLINE',
                        'INTERNAL_TARGET')),

  -- What an operator sees in the queue. Read under time pressure, so it is
  -- required to be a sentence rather than a code.
  label               text NOT NULL CHECK (length(trim(label)) >= 5),
  due_at              timestamptz NOT NULL,

  -- Which framework it concerns, where it concerns one. A Cyber Essentials
  -- assessment does not make an ISO 27001 unknown urgent, and ranking every
  -- unknown against every date would be the same mistake as inventing one.
  framework_key       text,

  -- Recorded by a person, and it matters who: a date somebody typed is a
  -- commitment the MSP is making, and the queue treats it as one.
  recorded_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  recorded_by_label   text NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),

  -- Cancelled rather than deleted. A commitment that was dropped is a fact
  -- about how the quarter went, and the queue that ranked work against it is
  -- easier to explain afterwards if the date is still on record.
  cancelled_at        timestamptz,
  cancelled_reason    text,

  met_at              timestamptz,
  correlation_id      text,

  CONSTRAINT commitment_cancellation_is_explained CHECK (
    cancelled_at IS NULL OR (cancelled_reason IS NOT NULL AND length(trim(cancelled_reason)) >= 10)
  )
);

CREATE INDEX organisation_commitments_due_idx
  ON organisation_commitments (organisation_id, due_at)
  WHERE cancelled_at IS NULL AND met_at IS NULL;

ALTER TABLE organisation_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_commitments FORCE ROW LEVEL SECURITY;

-- The organisation sees its own commitments. They are dates about their
-- business, recorded on their behalf.
CREATE POLICY organisation_commitments_tenant ON organisation_commitments
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

COMMENT ON TABLE organisation_commitments IS
  'Dated obligations that decide what gets worked on: certification assessments, insurer '
  'renewals, questionnaire deadlines. Adericel never invents one — a ranking that assumed a '
  'deadline would mark everything urgent, and an operator would stop trusting the ranking.';

-- migrate:down
DROP POLICY IF EXISTS organisation_commitments_tenant ON organisation_commitments;
DROP TABLE IF EXISTS organisation_commitments;
