-- migrate:up
-- =============================================================================
-- 0028 — Governed containment
--
-- Contract v3.1 §15. Containment is a controlled security state transition that
-- limits harm while preserving evidence, attribution and a route back. It is
-- not a "suspend customer" button, and the schema is shaped to keep it from
-- becoming one.
--
-- THREE AXES, DELIBERATELY SEPARATE COLUMNS
--
--   subscriptions.status      Has the MSP paid?          (commercial)
--   *.containment_level       Is it safe to operate?     (security)
--   assurance_states.state    Is the control met?        (assurance)
--
-- §16 forbids these cascading into one another. Non-payment is not a security
-- event; a security containment is not a commercial termination. They are
-- separate columns on separate tables precisely so that a future query cannot
-- casually conflate them — `organisations.status = 'SUSPENDED'` already carries
-- commercial meaning, which is why containment does NOT reuse it.
--
-- EVIDENCE IS NEVER WITHHELD
--
-- No level denies an organisation its own assurance record, at any severity.
-- Containment stops Adericel doing things; it does not stop customers knowing
-- things, and an organisation locked out of its record during an incident
-- cannot respond to it. There is deliberately no column here that could switch
-- that off.
-- =============================================================================

-- Append-only. A containment history that can be edited is not a history.
CREATE TABLE containment_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one target. A containment that names none, or two, is not a
  -- containment anybody can reason about or lift.
  msp_id              uuid REFERENCES msps (id) ON DELETE RESTRICT,
  organisation_id     uuid REFERENCES organisations (id) ON DELETE RESTRICT,
  integration_id      uuid REFERENCES integrations (id) ON DELETE RESTRICT,
  scope               text NOT NULL CHECK (scope IN ('INTEGRATION', 'ORGANISATION', 'PLATFORM')),

  transition          text NOT NULL CHECK (transition IN ('CONTAIN', 'RECOVER')),
  from_level          text NOT NULL CHECK (from_level IN ('C0','C1','C2','C3','C4','C5')),
  to_level            text NOT NULL CHECK (to_level   IN ('C0','C1','C2','C3','C4','C5')),

  trigger             text CHECK (trigger IN (
                        'CREDENTIAL_COMPROMISE','PRIVILEGE_ESCALATION',
                        'SUSPECTED_TENANT_ISOLATION_FAILURE','CROSS_TENANT_EXPOSURE',
                        'INTEGRATION_SCOPE_ANOMALY','OAUTH_PERMISSION_ANOMALY',
                        'EVIDENCE_INTEGRITY_FAILURE','UNSAFE_OR_UNAUTHORISED_ACTION',
                        'RULESET_INTEGRITY_MISMATCH','SECRET_EXPOSURE','PRODUCTION_COMPROMISE',
                        'SUPPLY_CHAIN_COMPROMISE','CRITICAL_VULNERABILITY','BACKUP_COMPROMISE',
                        'UNAUTHORISED_EXPORT','LEGAL_RESTRICTION_REQUIRED')),

  actor_kind          text NOT NULL CHECK (actor_kind IN ('AUTOMATIC', 'MSP', 'VEYLITH')),
  -- Null for AUTOMATIC, and only for AUTOMATIC: every human decision has a name
  -- against it. Enforced below rather than left to the application.
  actor_user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_label         text NOT NULL,

  -- Why. A containment with no stated reason cannot be reviewed, and review is
  -- the whole point of recording it.
  justification       text NOT NULL CHECK (length(trim(justification)) >= 20),

  -- Recovery only.
  resolution          text CHECK (resolution IN
                        ('RESOLVED','MITIGATED','NOT_SUBSTANTIATED','RISK_ACCEPTED')),
  findings            text,
  re_observed         boolean,
  evidence_preserved  boolean,
  risk_accepted_by    text,

  -- Whether a person has since looked at an automatic decision.
  review_required     boolean NOT NULL DEFAULT false,
  reviewed_at         timestamptz,
  reviewed_by         uuid REFERENCES users (id) ON DELETE SET NULL,

  correlation_id      text,
  occurred_at         timestamptz NOT NULL DEFAULT now(),

  -- Exactly one target, matching the declared scope.
  CONSTRAINT containment_target_matches_scope CHECK (
    (scope = 'INTEGRATION'  AND integration_id IS NOT NULL AND organisation_id IS NOT NULL) OR
    (scope = 'ORGANISATION' AND integration_id IS NULL     AND organisation_id IS NOT NULL) OR
    (scope = 'PLATFORM'     AND integration_id IS NULL     AND organisation_id IS NULL)
  ),

  -- A human decision carries a human. Automation carries none.
  CONSTRAINT containment_human_decisions_are_attributed CHECK (
    (actor_kind = 'AUTOMATIC' AND actor_user_id IS NULL) OR
    (actor_kind <> 'AUTOMATIC' AND actor_user_id IS NOT NULL)
  ),

  -- Recovery states what was found; containment does not pretend to.
  CONSTRAINT containment_recovery_is_evidenced CHECK (
    transition = 'CONTAIN' OR (
      resolution IS NOT NULL AND
      findings IS NOT NULL AND length(trim(findings)) >= 30 AND
      re_observed IS TRUE AND
      evidence_preserved IS TRUE AND
      (resolution <> 'RISK_ACCEPTED' OR risk_accepted_by IS NOT NULL)
    )
  ),

  -- CONTAIN raises, RECOVER lowers. Neither may be a no-op: an event that
  -- changed nothing is noise in the record somebody will have to read.
  CONSTRAINT containment_transition_moves CHECK (
    (transition = 'CONTAIN' AND to_level > from_level) OR
    (transition = 'RECOVER' AND to_level < from_level)
  )
);

CREATE INDEX containment_events_org_idx
  ON containment_events (organisation_id, occurred_at DESC) WHERE organisation_id IS NOT NULL;
CREATE INDEX containment_events_integration_idx
  ON containment_events (integration_id, occurred_at DESC) WHERE integration_id IS NOT NULL;
CREATE INDEX containment_events_unreviewed_idx
  ON containment_events (occurred_at DESC) WHERE review_required AND reviewed_at IS NULL;

-- Append-only, enforced by the database rather than by convention.
--
-- Columns are compared explicitly rather than with a row-difference trick: the
-- first version of this used hstore, which is not installed, so the function
-- would have failed the moment it ran — and it never ran, because the trigger
-- was never attached. Two faults hiding each other. Explicit is slower to write
-- and impossible to be wrong about quietly.
CREATE OR REPLACE FUNCTION containment_events_are_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'containment_events rows are never deleted';
  END IF;

  -- Recording that a person reviewed an automatic decision is the one permitted
  -- update: it adds to the record rather than altering what happened. Every
  -- other column must be unchanged, and a review may not be un-recorded.
  IF OLD.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION 'this containment event has already been reviewed; record a new event';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.msp_id IS DISTINCT FROM OLD.msp_id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.transition IS DISTINCT FROM OLD.transition
     OR NEW.from_level IS DISTINCT FROM OLD.from_level
     OR NEW.to_level IS DISTINCT FROM OLD.to_level
     OR NEW.trigger IS DISTINCT FROM OLD.trigger
     OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.actor_label IS DISTINCT FROM OLD.actor_label
     OR NEW.justification IS DISTINCT FROM OLD.justification
     OR NEW.resolution IS DISTINCT FROM OLD.resolution
     OR NEW.findings IS DISTINCT FROM OLD.findings
     OR NEW.re_observed IS DISTINCT FROM OLD.re_observed
     OR NEW.evidence_preserved IS DISTINCT FROM OLD.evidence_preserved
     OR NEW.risk_accepted_by IS DISTINCT FROM OLD.risk_accepted_by
     OR NEW.review_required IS DISTINCT FROM OLD.review_required
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'containment_events is append-only; only a review may be recorded';
  END IF;

  IF NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'the only permitted update is recording a review';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER containment_events_append_only
  BEFORE UPDATE OR DELETE ON containment_events
  FOR EACH ROW EXECUTE FUNCTION containment_events_are_append_only();

-- The current level, denormalised so that every read path does not have to
-- replay history. The history remains the source of truth.
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS containment_level text
  NOT NULL DEFAULT 'C0' CHECK (containment_level IN ('C0','C1','C2','C3','C4','C5'));
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS contained_since timestamptz;

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS containment_level text
  NOT NULL DEFAULT 'C0' CHECK (containment_level IN ('C0','C1','C2','C3','C4','C5'));
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS contained_since timestamptz;

COMMENT ON COLUMN organisations.containment_level IS
  'Security containment (v3.1 §15). Separate from organisations.status, which carries commercial '
  'meaning. A commercial suspension is not a containment and must never set this.';
COMMENT ON COLUMN integrations.containment_level IS
  'Security containment of this connector. Separate from integrations.status, which describes '
  'whether collection is working, not whether it is permitted.';

ALTER TABLE containment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE containment_events FORCE ROW LEVEL SECURITY;

CREATE POLICY containment_events_tenant ON containment_events
  USING (
    is_platform_scope()
    OR (organisation_id IS NOT NULL AND organisation_id = current_organisation_id())
  );

-- migrate:down
DROP POLICY IF EXISTS containment_events_tenant ON containment_events;
DROP TRIGGER IF EXISTS containment_events_append_only ON containment_events;
DROP FUNCTION IF EXISTS containment_events_are_append_only();
DROP TABLE IF EXISTS containment_events;
ALTER TABLE organisations DROP COLUMN IF EXISTS containment_level;
ALTER TABLE organisations DROP COLUMN IF EXISTS contained_since;
ALTER TABLE integrations DROP COLUMN IF EXISTS containment_level;
ALTER TABLE integrations DROP COLUMN IF EXISTS contained_since;
