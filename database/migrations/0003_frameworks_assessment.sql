-- migrate:up
-- =============================================================================
-- Frameworks, requirements, controls, rulesets, assessments and assurance state.
-- =============================================================================

CREATE TABLE frameworks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid REFERENCES organisations (id) ON DELETE CASCADE,
  msp_id           uuid REFERENCES msps (id) ON DELETE CASCADE,
  key              text NOT NULL,
  name             text NOT NULL,
  version          text NOT NULL DEFAULT '1',
  publisher        text,
  description      text,
  is_system        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT frameworks_owner CHECK (
    (is_system AND organisation_id IS NULL AND msp_id IS NULL)
    OR (NOT is_system AND (organisation_id IS NOT NULL OR msp_id IS NOT NULL))
  )
);
CREATE UNIQUE INDEX frameworks_system_key ON frameworks (key, version) WHERE is_system;
CREATE UNIQUE INDEX frameworks_org_key ON frameworks (organisation_id, key, version) WHERE organisation_id IS NOT NULL;
CREATE UNIQUE INDEX frameworks_msp_key ON frameworks (msp_id, key, version) WHERE msp_id IS NOT NULL;

CREATE TABLE requirements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  framework_id            uuid NOT NULL REFERENCES frameworks (id) ON DELETE CASCADE,
  organisation_id         uuid REFERENCES organisations (id) ON DELETE CASCADE,
  node_id                 uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  key                     text NOT NULL,
  title                   text NOT NULL,
  description             text,
  parent_requirement_id   uuid REFERENCES requirements (id) ON DELETE CASCADE,
  weight                  numeric(5,2) NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX requirements_framework_key ON requirements (framework_id, key);
CREATE INDEX requirements_org_idx ON requirements (organisation_id) WHERE organisation_id IS NOT NULL;

-- Which frameworks an organisation has adopted. Requirements are shared
-- definitions; adoption is what brings them into an organisation's scope.
CREATE TABLE organisation_frameworks (
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  framework_id     uuid NOT NULL REFERENCES frameworks (id) ON DELETE CASCADE,
  node_id          uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  adopted_at       timestamptz NOT NULL DEFAULT now(),
  target_date      timestamptz,
  PRIMARY KEY (organisation_id, framework_id)
);

CREATE TABLE controls (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id               uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  key                   text NOT NULL,
  title                 text NOT NULL,
  description           text,
  implementation_type   text NOT NULL DEFAULT 'TECHNICAL'
                          CHECK (implementation_type IN ('TECHNICAL', 'ADMINISTRATIVE', 'PHYSICAL', 'CONTRACTUAL')),
  ruleset_key           text NOT NULL,
  rule_key              text NOT NULL,
  parameters            jsonb NOT NULL DEFAULT '{}'::jsonb,
  source                text NOT NULL DEFAULT 'LOCAL' CHECK (source IN ('INHERITED', 'LOCAL', 'OVERRIDDEN')),
  baseline_control_id   uuid REFERENCES msp_baseline_controls (id) ON DELETE SET NULL,
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX controls_org_key ON controls (organisation_id, key);
CREATE INDEX controls_org_enabled_idx ON controls (organisation_id, enabled);
CREATE INDEX controls_ruleset_idx ON controls (ruleset_key, rule_key);
CREATE TRIGGER controls_touch BEFORE UPDATE ON controls
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE control_requirements (
  control_id       uuid NOT NULL REFERENCES controls (id) ON DELETE CASCADE,
  requirement_id   uuid NOT NULL REFERENCES requirements (id) ON DELETE CASCADE,
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  coverage         numeric(4,3) NOT NULL DEFAULT 1.0 CHECK (coverage > 0 AND coverage <= 1),
  PRIMARY KEY (control_id, requirement_id)
);
CREATE INDEX control_requirements_requirement_idx
  ON control_requirements (organisation_id, requirement_id);

-- ---------------------------------------------------------------------------
-- Rulesets.
--
-- A ruleset version is immutable once published: `ruleset_hash` pins the exact
-- rule definitions an assessment ran under. Changing rules therefore publishes
-- a new version and never rewrites history.
-- ---------------------------------------------------------------------------
CREATE TABLE rulesets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL,
  version         text NOT NULL,
  ruleset_hash    text NOT NULL,
  engine_version  text NOT NULL,
  name            text NOT NULL,
  description     text,
  definition      jsonb NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  deprecated_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rulesets_key_version ON rulesets (key, version);
CREATE INDEX rulesets_hash_idx ON rulesets (ruleset_hash);

-- ---------------------------------------------------------------------------
-- Assessments: reproducible determinations.
-- ---------------------------------------------------------------------------
CREATE TABLE assessments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id                  uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  subject_kind             text NOT NULL CHECK (subject_kind IN ('CONTROL', 'REQUIREMENT', 'FRAMEWORK', 'ORGANISATION')),
  subject_id               uuid NOT NULL,
  state                    text NOT NULL
                             CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED', 'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN')),
  unknown_reason           text,
  rationale                text NOT NULL,
  reasoning                jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger                  text NOT NULL,
  engine_version           text NOT NULL,
  ruleset_key              text NOT NULL,
  ruleset_version          text NOT NULL,
  ruleset_hash             text NOT NULL,
  rule_key                 text NOT NULL,
  input_digest             text NOT NULL,
  evidence_ids             uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  claim_ids                uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  previous_assessment_id   uuid REFERENCES assessments (id) ON DELETE SET NULL,
  state_changed            boolean NOT NULL DEFAULT false,
  assessed_at              timestamptz NOT NULL,
  correlation_id           uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessments_unknown_reason CHECK (
    (state = 'UNKNOWN' AND unknown_reason IS NOT NULL)
    OR (state <> 'UNKNOWN' AND unknown_reason IS NULL)
  )
);
CREATE INDEX assessments_subject_idx
  ON assessments (organisation_id, subject_kind, subject_id, assessed_at DESC);
CREATE INDEX assessments_org_assessed_idx ON assessments (organisation_id, assessed_at DESC, id DESC);
CREATE INDEX assessments_changed_idx ON assessments (organisation_id, assessed_at DESC) WHERE state_changed;

-- Current-state projection, so portfolio reads never scan assessment history.
CREATE TABLE assurance_states (
  organisation_id    uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  subject_kind       text NOT NULL CHECK (subject_kind IN ('CONTROL', 'REQUIREMENT', 'FRAMEWORK', 'ORGANISATION')),
  subject_id         uuid NOT NULL,
  state              text NOT NULL
                       CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED', 'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN')),
  unknown_reason     text,
  assessment_id      uuid NOT NULL REFERENCES assessments (id) ON DELETE CASCADE,
  previous_state     text,
  since              timestamptz NOT NULL,
  last_assessed_at   timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, subject_kind, subject_id)
);
CREATE INDEX assurance_states_org_state_idx ON assurance_states (organisation_id, state);
CREATE INDEX assurance_states_stale_idx ON assurance_states (last_assessed_at);

-- ---------------------------------------------------------------------------
-- Findings, risks, exceptions
-- ---------------------------------------------------------------------------
CREATE TABLE findings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id             uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  control_id          uuid REFERENCES controls (id) ON DELETE SET NULL,
  requirement_id      uuid REFERENCES requirements (id) ON DELETE SET NULL,
  subject_node_id     uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  assessment_id       uuid REFERENCES assessments (id) ON DELETE SET NULL,
  fingerprint         text NOT NULL,
  title               text NOT NULL,
  description         text NOT NULL,
  severity            text NOT NULL CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status              text NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION', 'RESOLVED', 'ACCEPTED_RISK', 'FALSE_POSITIVE', 'SUPERSEDED')),
  evidence_ids        uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  first_detected_at   timestamptz NOT NULL DEFAULT now(),
  last_detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolution_reason   text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- The fingerprint keeps one durable finding across reassessments, so ageing is
-- measured from first detection rather than reset on every scheduled run.
CREATE UNIQUE INDEX findings_open_fingerprint
  ON findings (organisation_id, fingerprint)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION');
CREATE INDEX findings_org_status_idx ON findings (organisation_id, status, severity);
CREATE INDEX findings_org_detected_idx ON findings (organisation_id, last_detected_at DESC, id DESC);
CREATE INDEX findings_control_idx ON findings (organisation_id, control_id) WHERE control_id IS NOT NULL;
CREATE TRIGGER findings_touch BEFORE UPDATE ON findings
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE risks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id             uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  title               text NOT NULL,
  description         text,
  likelihood          text CHECK (likelihood IN ('RARE', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'ALMOST_CERTAIN')),
  impact              text CHECK (impact IN ('NEGLIGIBLE', 'MINOR', 'MODERATE', 'MAJOR', 'SEVERE')),
  inherent_severity   text NOT NULL CHECK (inherent_severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  residual_severity   text CHECK (residual_severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status              text NOT NULL DEFAULT 'IDENTIFIED'
                        CHECK (status IN ('IDENTIFIED', 'ASSESSED', 'TREATED', 'ACCEPTED', 'CLOSED')),
  treatment           text CHECK (treatment IN ('MITIGATE', 'ACCEPT', 'TRANSFER', 'AVOID')),
  owner_user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  review_due_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risks_org_status_idx ON risks (organisation_id, status, inherent_severity);
CREATE TRIGGER risks_touch BEFORE UPDATE ON risks
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE risk_findings (
  risk_id          uuid NOT NULL REFERENCES risks (id) ON DELETE CASCADE,
  finding_id       uuid NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  PRIMARY KEY (risk_id, finding_id)
);

CREATE TABLE exceptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id                  uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  control_id               uuid REFERENCES controls (id) ON DELETE CASCADE,
  requirement_id           uuid REFERENCES requirements (id) ON DELETE CASCADE,
  finding_id               uuid REFERENCES findings (id) ON DELETE CASCADE,
  subject_node_id          uuid REFERENCES graph_nodes (id) ON DELETE CASCADE,
  justification            text NOT NULL,
  compensating_controls    text,
  status                   text NOT NULL DEFAULT 'REQUESTED'
                             CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
  requested_by_user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  approved_by_user_id      uuid REFERENCES users (id) ON DELETE RESTRICT,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  approved_at              timestamptz,
  effective_from           timestamptz NOT NULL DEFAULT now(),
  -- Exceptions always expire. An open-ended exception is indistinguishable from
  -- ignoring the control, so the column is NOT NULL by design.
  expires_at               timestamptz NOT NULL,
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exceptions_target CHECK (
    control_id IS NOT NULL OR requirement_id IS NOT NULL OR finding_id IS NOT NULL
  ),
  CONSTRAINT exceptions_window CHECK (expires_at > effective_from),
  -- Four-eyes: whoever requests an exception cannot be the one who approves it.
  CONSTRAINT exceptions_four_eyes CHECK (
    approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id
  )
);
CREATE INDEX exceptions_org_status_idx ON exceptions (organisation_id, status);
CREATE INDEX exceptions_expiry_idx ON exceptions (organisation_id, expires_at) WHERE status = 'APPROVED';
CREATE INDEX exceptions_control_idx ON exceptions (organisation_id, control_id) WHERE control_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS exceptions;
DROP TABLE IF EXISTS risk_findings;
DROP TABLE IF EXISTS risks;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS assurance_states;
DROP TABLE IF EXISTS assessments;
DROP TABLE IF EXISTS rulesets;
DROP TABLE IF EXISTS control_requirements;
DROP TABLE IF EXISTS controls;
DROP TABLE IF EXISTS organisation_frameworks;
DROP TABLE IF EXISTS requirements;
DROP TABLE IF EXISTS frameworks;
