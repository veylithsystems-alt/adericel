-- migrate:up
-- =============================================================================
-- 0033 — Framework crosswalks
--
-- Contract v3.2 requires a framework-independent control and requirement layer
-- with crosswalks preserving source framework, destination framework, mapping
-- rationale, confidence, applicability, version and provenance — and then
-- constrains the whole thing in one sentence:
--
--   "One observation may satisfy multiple controls, but the system must never
--    imply equivalence where the underlying requirements differ."
--
-- WHY THIS TABLE IS DIRECTED
--
-- The obvious shape is a join table of requirement pairs. A pair is symmetric,
-- and symmetry IS an equivalence claim: pair Cyber Essentials
-- `access.mfa_on_cloud_services` with ISO 27001 `A.5.17` and the table says each
-- satisfies the other. It does not. Meeting the Cyber Essentials requirement
-- goes part of the way towards A.5.17 and nowhere near all of it.
--
-- So every row is a directed statement from a source requirement to a
-- destination requirement, and `relation` says what the direction means. Only
-- EQUIVALENT, CONFLICTS and UNRELATED read the same both ways.
--
-- WHY IT IS NOT TENANT DATA
--
-- A crosswalk is a statement about two published frameworks. It contains
-- nothing about any organisation and is the same for every customer, so it sits
-- alongside `frameworks` and `requirements` as reference data. Writing one is a
-- platform action; reading one is available to everybody, because a customer is
-- entitled to see the reasoning behind any mapping that informs their evidence.
--
-- WHAT IT CANNOT DO
--
-- Nothing in this schema can produce an assurance state, and that is deliberate
-- rather than an omission. `packages/crosswalk/src/coverage.ts` holds the
-- refusal in code, with a function that always returns UNKNOWN so the boundary
-- is a thing somebody finds rather than an absence they have to notice.
-- =============================================================================

CREATE TABLE framework_crosswalks (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Citable in a report, so a mapping an assessor questions can be found again.
  key                            text NOT NULL,

  -- Source and destination are recorded by key AND version. A scheme revision
  -- can change a requirement's substance, so a mapping to ISO 27001:2013 must
  -- never silently answer the 2022 edition.
  source_framework_key           text NOT NULL,
  source_framework_version       text NOT NULL,
  source_requirement_key         text NOT NULL,

  destination_framework_key      text NOT NULL,
  destination_framework_version  text NOT NULL,
  destination_requirement_key    text NOT NULL,

  relation                       text NOT NULL CHECK (relation IN (
                                   'EQUIVALENT',
                                   'SATISFIES',
                                   'PARTIALLY_SATISFIES',
                                   'SUPPORTS',
                                   'CONFLICTS',
                                   -- Considered and deliberately not mapped.
                                   -- Without this value, "no crosswalk exists"
                                   -- and "somebody looked and found nothing"
                                   -- are the same empty result, and they lead
                                   -- to completely different work.
                                   'UNRELATED')),

  -- Long enough to defend. A crosswalk whose rationale is "similar" is the
  -- mapping table this design exists to replace.
  rationale                      text NOT NULL CHECK (length(trim(rationale)) >= 40),

  -- Banded, never numeric. "Confidence: 0.85" would be quoted as though
  -- somebody could say what distinguishes it from 0.8 (ADR-0017, and v3.2's own
  -- refusal of opaque scoring).
  confidence                     text NOT NULL
                                   CHECK (confidence IN ('HIGH', 'MODERATE', 'LOW', 'UNKNOWN')),
  confidence_because             text NOT NULL CHECK (length(trim(confidence_because)) >= 20),

  -- "Always" is a legitimate answer and must be stated rather than assumed: many
  -- real crosswalks hold only for part of an estate.
  applies_when                   text NOT NULL CHECK (length(trim(applies_when)) >= 6),

  provenance                     text NOT NULL CHECK (provenance IN (
                                   'SCHEME_PUBLISHED',
                                   'NAMED_PERSON',
                                   'DERIVED_FROM_PUBLISHED',
                                   'AI_SUGGESTED')),
  provenance_detail              text NOT NULL CHECK (length(trim(provenance_detail)) >= 6),

  asserted_at                    timestamptz NOT NULL DEFAULT now(),
  asserted_by                    uuid REFERENCES users (id) ON DELETE SET NULL,

  -- A model may propose a crosswalk and may not act on one, exactly as
  -- everywhere else in Adericel. Enforced here as well as in code, because a
  -- row inserted by a future job would otherwise bypass the check.
  confirmed_by_label             text,
  confirmed_at                   timestamptz,

  retired_at                     timestamptz,
  retired_reason                 text,

  CONSTRAINT crosswalk_not_within_one_framework_version CHECK (
    source_framework_key <> destination_framework_key
    OR source_framework_version <> destination_framework_version
  ),

  CONSTRAINT crosswalk_ai_must_be_confirmed CHECK (
    provenance <> 'AI_SUGGESTED'
    OR (confirmed_by_label IS NOT NULL AND confirmed_at IS NOT NULL)
  ),

  -- EQUIVALENT is the one relation read in both directions, so a tentative one
  -- is a contradiction: it would assert in two directions something nobody was
  -- confident about in either.
  CONSTRAINT crosswalk_equivalent_is_not_tentative CHECK (
    relation <> 'EQUIVALENT' OR confidence = 'HIGH'
  ),

  -- An unassessed mapping may not contribute evidence.
  CONSTRAINT crosswalk_unknown_confidence_bears_no_evidence CHECK (
    confidence <> 'UNKNOWN'
    OR relation NOT IN ('EQUIVALENT', 'SATISFIES', 'PARTIALLY_SATISFIES', 'SUPPORTS')
  ),

  CONSTRAINT crosswalk_retirement_is_explained CHECK (
    retired_at IS NULL OR (retired_reason IS NOT NULL AND length(trim(retired_reason)) >= 10)
  )
);

-- One live statement per directed pair. Two contradictory rows would mean
-- whichever a reader reached first decided what Adericel claims.
CREATE UNIQUE INDEX framework_crosswalks_directed_pair
  ON framework_crosswalks (
    source_framework_key, source_framework_version, source_requirement_key,
    destination_framework_key, destination_framework_version, destination_requirement_key
  )
  WHERE retired_at IS NULL;

CREATE UNIQUE INDEX framework_crosswalks_key ON framework_crosswalks (key) WHERE retired_at IS NULL;

CREATE INDEX framework_crosswalks_destination_idx
  ON framework_crosswalks (destination_framework_key, destination_framework_version,
                           destination_requirement_key)
  WHERE retired_at IS NULL;

ALTER TABLE framework_crosswalks ENABLE ROW LEVEL SECURITY;
ALTER TABLE framework_crosswalks FORCE ROW LEVEL SECURITY;

-- Readable by everybody. A crosswalk contains nothing about any organisation,
-- and a customer whose evidence is being pointed at by one is entitled to read
-- the reasoning. Writes are a platform action.
CREATE POLICY framework_crosswalks_read ON framework_crosswalks
  FOR SELECT USING (true);

CREATE POLICY framework_crosswalks_write ON framework_crosswalks
  FOR ALL USING (is_platform_scope()) WITH CHECK (is_platform_scope());

COMMENT ON TABLE framework_crosswalks IS
  'Directed statements relating a requirement in one framework to a requirement in another. '
  'Never symmetric except for EQUIVALENT, CONFLICTS and UNRELATED, because a symmetric pair is '
  'an equivalence claim and almost no two requirements in two real schemes are equivalent. '
  'A crosswalk informs where evidence may already exist; it never establishes an assurance '
  'state.';

COMMENT ON COLUMN framework_crosswalks.relation IS
  'What the direction means. UNRELATED records that somebody looked and found no relationship, '
  'which is a finding rather than a gap in the data.';

-- migrate:down
DROP POLICY IF EXISTS framework_crosswalks_write ON framework_crosswalks;
DROP POLICY IF EXISTS framework_crosswalks_read ON framework_crosswalks;
DROP TABLE IF EXISTS framework_crosswalks;
