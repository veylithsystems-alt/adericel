-- migrate:up
-- =============================================================================
-- The observation fabric.
--
-- Three things Adericel could not previously represent, each of which let it
-- state something with more confidence than it had.
--
-- 1. WHICH SOURCE SAID SO.
--
--    A claim recorded its evidence but not which integration produced it.
--    Provenance was reachable by joining through evidence; source COMPARISON
--    was not possible at all, and comparison is what conflict detection needs.
--
-- 2. TWO SOURCES DISAGREEING.
--
--    One live claim exists per (subject, predicate), and a newer assertion
--    supersedes the older one. That is correct when a single source re-observes
--    a fact. It is a silent falsification when two sources disagree:
--
--      Intune says   laptop-17  encrypted = true
--      The RMM says  laptop-17  encrypted = false
--
--    Whichever ran last won, nothing recorded that the question was contested,
--    and Adericel would have told a customer — and, through an Assurance
--    Passport, their insurer — that the device was encrypted on the strength of
--    a scheduling coincidence.
--
--    A system of record does not get to pick. An unresolved disagreement makes
--    the claim DISPUTED, which no rule reads, so every control resting on it
--    reports UNKNOWN with the disagreement as its reason. That is the honest
--    answer and it is exactly what UNKNOWN is for.
--
-- 3. WHICH PART OF A COLLECTION FAILED.
--
--    A run was SUCCEEDED, PARTIAL or FAILED, and an integration was CONNECTED
--    or DEGRADED. "Degraded" is not actionable. "Device compliance returned
--    PERMISSION_DENIED because DeviceManagementConfiguration.Read.All has not
--    been granted, so these four controls are UNKNOWN" is a thing an
--    administrator can fix before lunch.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Which source produced a claim.
-- ---------------------------------------------------------------------------
-- Nullable: claims asserted by a human, or derived from verification, have no
-- source integration, and inventing one would misattribute them.
ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS source_integration_id uuid
    REFERENCES integrations (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS claims_source_integration_idx
  ON claims (organisation_id, source_integration_id)
  WHERE source_integration_id IS NOT NULL;

-- DISPUTED joins the claim lifecycle. It is deliberately NOT in the live set
-- used by claims_live_unique or by any rule query: a disputed claim is one
-- Adericel refuses to read, not one it reads cautiously.
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_check;
ALTER TABLE claims ADD CONSTRAINT claims_status_check
  CHECK (status IN ('CANDIDATE', 'CONFIRMED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN', 'DISPUTED'));

-- ---------------------------------------------------------------------------
-- Recorded disagreements between sources.
-- ---------------------------------------------------------------------------
CREATE TABLE claim_conflicts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  predicate             text NOT NULL,
  subject_node_id       uuid REFERENCES graph_nodes (id) ON DELETE CASCADE,
  subject_external_id   text,
  resolution            text NOT NULL
                          CHECK (resolution IN ('AGREED', 'RESOLVED_BY_AUTHORITY',
                                                'RESOLVED_BY_FRESHNESS', 'UNRESOLVED')),
  -- The value Adericel settled on, or null where it refused to choose. Stored
  -- as jsonb so a structured predicate compares as one value, not as a string.
  resolved_value        jsonb,
  -- Every source's position, as [{integrationId, displayName, value, observedAt}].
  -- Kept whole: the point of the record is that a person can see the
  -- disagreement, and a summary would defeat it.
  sources               jsonb NOT NULL,
  distinct_values       integer NOT NULL CHECK (distinct_values >= 0),
  detail                text NOT NULL,
  -- The claim withheld or superseded because of this, where one exists.
  claim_id              uuid REFERENCES claims (id) ON DELETE SET NULL,
  first_detected_at     timestamptz NOT NULL DEFAULT now(),
  last_detected_at      timestamptz NOT NULL DEFAULT now(),
  -- Set when the sources agree again. Kept, not deleted: that a control was
  -- contested last quarter is part of the record.
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- One open conflict per contested (subject, predicate). A disagreement that
-- persists across ten collection runs is one fact, not ten.
CREATE UNIQUE INDEX claim_conflicts_open_unique
  ON claim_conflicts (organisation_id, predicate,
                      COALESCE(subject_node_id, '00000000-0000-0000-0000-000000000000'))
  WHERE resolved_at IS NULL;
CREATE INDEX claim_conflicts_org_idx
  ON claim_conflicts (organisation_id, last_detected_at DESC);

ALTER TABLE claim_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON claim_conflicts
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- ---------------------------------------------------------------------------
-- Per-capability outcome of each collection run.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_capability_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  integration_id        uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  integration_run_id    uuid NOT NULL REFERENCES integration_runs (id) ON DELETE CASCADE,
  capability            text NOT NULL,
  outcome               text NOT NULL
                          CHECK (outcome IN ('AVAILABLE', 'PARTIAL', 'PERMISSION_DENIED',
                                             'AUTHENTICATION_FAILED', 'RATE_LIMITED',
                                             'UPSTREAM_UNAVAILABLE', 'SCHEMA_DRIFT',
                                             'NOT_CONFIGURED', 'EMPTY')),
  detail                text NOT NULL DEFAULT '',
  records_collected     integer NOT NULL DEFAULT 0,
  observations_produced integer NOT NULL DEFAULT 0,
  -- The vendor permission that would fix a PERMISSION_DENIED, so the message an
  -- administrator reads names what to grant.
  required_permission   text NOT NULL DEFAULT '',
  -- Canonical predicates this run therefore could not supply. Denormalised
  -- deliberately: it is read on the assurance explanation path, which must not
  -- depend on the connector code that produced it still declaring the same
  -- capability months later.
  unavailable_predicates text[] NOT NULL DEFAULT '{}',
  missing_fields        text[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX integration_capability_reports_run_unique
  ON integration_capability_reports (integration_run_id, capability);
CREATE INDEX integration_capability_reports_integration_idx
  ON integration_capability_reports (organisation_id, integration_id, created_at DESC);
-- Answers "which capabilities are currently broken?" without scanning history.
CREATE INDEX integration_capability_reports_outcome_idx
  ON integration_capability_reports (organisation_id, outcome, created_at DESC)
  WHERE outcome <> 'AVAILABLE';

ALTER TABLE integration_capability_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_capability_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_capability_reports
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- ---------------------------------------------------------------------------
-- Health on the integration itself, and the source-authority policy.
-- ---------------------------------------------------------------------------
ALTER TABLE integrations
  -- Finer than CONNECTED/DEGRADED, and derived deterministically from the
  -- capability reports of the last run, so "why is this amber?" has exactly one
  -- answer that can be shown.
  ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'HEALTHY'
    CHECK (health IN ('HEALTHY', 'PARTIAL', 'RATE_LIMITED', 'SCHEMA_DRIFT',
                      'AUTHORISED_BUT_RESTRICTED', 'UPSTREAM_UNAVAILABLE',
                      'AUTHENTICATION_FAILED', 'NEVER_RUN')),
  -- Whether this integration talks to a real external system. Persisted rather
  -- than read from code at render time so a demonstration tenant cannot be
  -- mistaken for a live one if a connector is later re-keyed.
  ADD COLUMN IF NOT EXISTS fidelity text NOT NULL DEFAULT 'LIVE'
    CHECK (fidelity IN ('LIVE', 'DEMONSTRATION'));

-- Which source wins for which predicate, per organisation.
--
-- Per-predicate, not global: the system that best knows endpoint patch state is
-- rarely the one that best knows identity state. This is configuration a
-- customer or MSP sets; no connector may assert its own authority, because a
-- connector that could would be deciding assurance truth.
CREATE TABLE source_authority_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  -- A predicate, or a dotted prefix ending in '.' such as 'device.' to cover a
  -- family. Longest match wins, so a specific rule beats a general one.
  predicate_pattern   text NOT NULL,
  -- Integration ids, most authoritative first.
  integration_ids     uuid[] NOT NULL DEFAULT '{}',
  -- Hours by which one source must be fresher before recency alone settles a
  -- disagreement. NULL means never: recency is not authority, and a customer
  -- would rightly object to a five-minute scheduling difference deciding what
  -- Adericel believed about their estate.
  freshness_window_hours integer CHECK (freshness_window_hours IS NULL OR freshness_window_hours > 0),
  set_by_actor        text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX source_authority_policies_unique
  ON source_authority_policies (organisation_id, predicate_pattern);

ALTER TABLE source_authority_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_authority_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_authority_policies
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- migrate:down
DROP POLICY IF EXISTS tenant_isolation ON source_authority_policies;
DROP TABLE IF EXISTS source_authority_policies;
DROP POLICY IF EXISTS tenant_isolation ON integration_capability_reports;
DROP TABLE IF EXISTS integration_capability_reports;
DROP POLICY IF EXISTS tenant_isolation ON claim_conflicts;
DROP TABLE IF EXISTS claim_conflicts;
ALTER TABLE integrations
  DROP COLUMN IF EXISTS health,
  DROP COLUMN IF EXISTS fidelity;
UPDATE claims SET status = 'SUPERSEDED' WHERE status = 'DISPUTED';
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_check;
ALTER TABLE claims ADD CONSTRAINT claims_status_check
  CHECK (status IN ('CANDIDATE', 'CONFIRMED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN'));
ALTER TABLE claims DROP COLUMN IF EXISTS source_integration_id;
