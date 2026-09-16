-- migrate:up
-- =============================================================================
-- 0031 — The support domain
--
-- Contract v3.1 §20-26. Support is not a bolt-on to assurance infrastructure;
-- §20 says it is part of it. A customer who cannot get an answer about why a
-- control reads UNKNOWN has an assurance problem, not a service problem, and
-- both are answered from the same evidence.
--
-- TWO THINGS SHAPE EVERY TABLE HERE
--
-- 1. The §2 distribution boundary, expressed in support. Adericel is sold to
--    MSPs. An end customer's request goes to their MSP unless a signed
--    agreement says otherwise, and that agreement is a row (below) rather than
--    a policy somebody remembers.
--
-- 2. Support is a disclosure surface. Every answer given in a case says
--    something about somebody's estate, so §22 requires identity and
--    entitlement to be established before disclosure — not before closure.
--    The failure this prevents is somebody plausible ringing up and being told
--    which controls an organisation is failing. Row-level security does not
--    prevent that, because the person disclosing is authorised. A record of
--    what was disclosed, to whom, and on what basis, does.
--
-- WHAT THIS MIGRATION DOES NOT BUILD, stated rather than implied: §25 versioned
-- knowledge and known issues, and AI drafting boundaries, are not here. They
-- are P2 in the gap report and are tracked as RR-065.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Direct support entitlement (§20, decision D2)
--
-- Built, and granted to nobody. The gate exists because §22 requires it
-- regardless, and shipping it closed means an MSP sees a system that
-- structurally cannot talk to their customer behind their back.
--
-- Retrofitting an entitlement gate is where tenant-isolation bugs come from, so
-- it is here from the first line of the support domain rather than added when
-- the first MSP asks for escalation.
-- ---------------------------------------------------------------------------
CREATE TABLE direct_support_entitlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  -- The MSP that agreed to it. A direct-support agreement Veylith made with a
  -- customer over their MSP's head is the thing this column prevents.
  msp_id              uuid NOT NULL REFERENCES msps (id) ON DELETE RESTRICT,

  -- What was signed, and by whom. Not a boolean: somebody will be asked to
  -- produce this.
  agreement_reference text NOT NULL CHECK (length(trim(agreement_reference)) >= 3),
  agreed_by_msp       text NOT NULL,
  agreed_at           timestamptz NOT NULL,
  effective_from      timestamptz NOT NULL,
  effective_until     timestamptz,
  revoked_at          timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_support_window CHECK (
    effective_until IS NULL OR effective_until > effective_from
  )
);

CREATE UNIQUE INDEX direct_support_live_idx ON direct_support_entitlements (organisation_id)
  WHERE revoked_at IS NULL;

ALTER TABLE direct_support_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_support_entitlements FORCE ROW LEVEL SECURITY;

-- An organisation is entitled to know whether its MSP has agreed that Veylith
-- may support it directly. It is an agreement about them.
--
-- This policy exists because `tests/security/tenant-isolation-enforcement`
-- swept every table carrying an organisation_id and found this one unprotected,
-- and `inspectTenantIsolation` then refused to let the application start. The
-- invariant is enforced by a sweep rather than by remembering, which is the
-- only version of it that survives a new table.
CREATE POLICY direct_support_tenant ON direct_support_entitlements
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

COMMENT ON TABLE direct_support_entitlements IS
  'Signed agreements letting Veylith support an organisation directly. Empty by design: the '
  'gate is built because §22 needs it, and ships closed (ADR-0048, decision D2).';

-- ---------------------------------------------------------------------------
-- The case
-- ---------------------------------------------------------------------------
CREATE TABLE support_cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE,

  organisation_id     uuid REFERENCES organisations (id) ON DELETE RESTRICT,
  msp_id              uuid REFERENCES msps (id) ON DELETE RESTRICT,

  requester_kind      text NOT NULL CHECK (requester_kind IN
                        ('END_CUSTOMER', 'MSP', 'VEYLITH', 'SYSTEM')),
  -- Null for SYSTEM: Adericel raising a case about what it observed is not a
  -- person, and inventing one would make the record a lie.
  requester_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  requester_label     text NOT NULL,

  category            text NOT NULL CHECK (category IN (
                        'INTEGRATION_FAILURE', 'CREDENTIAL_PROBLEM', 'ASSURANCE_EXPLANATION',
                        'ASSURANCE_DISPUTE', 'EVIDENCE_QUERY', 'ACTION_FAILURE', 'ONBOARDING',
                        'EXPORT_REQUEST', 'PRODUCT_DEFECT', 'FEATURE_REQUEST',
                        'SERVICE_AVAILABILITY', 'SECURITY_CONCERN', 'PRIVACY_REQUEST',
                        'COMMERCIAL_QUERY')),
  severity            text NOT NULL CHECK (severity IN ('S1', 'S2', 'S3', 'S4')),
  queue               text NOT NULL CHECK (queue IN (
                        'MSP_FRONTLINE', 'MSP_ASSURANCE', 'MSP_COMMERCIAL', 'VEYLITH_TRIAGE',
                        'VEYLITH_INTEGRATIONS', 'VEYLITH_ASSURANCE', 'VEYLITH_PLATFORM',
                        'VEYLITH_ENGINEERING', 'VEYLITH_SECURITY', 'VEYLITH_PRIVACY',
                        'VEYLITH_COMMERCIAL', 'EXTERNAL_DEPENDENCY')),
  routing_reason      text NOT NULL,

  state               text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN (
                        'RECEIVED', 'IDENTITY_PENDING', 'ENTITLEMENT_PENDING', 'TRIAGING',
                        'ROUTED_TO_MSP', 'QUEUED', 'IN_PROGRESS', 'AWAITING_CUSTOMER',
                        'AWAITING_MSP', 'AWAITING_VENDOR', 'AWAITING_CHANGE', 'SECURITY_REVIEW',
                        'PRIVACY_REVIEW', 'COMMERCIAL_REVIEW', 'RESOLUTION_PROPOSED',
                        'AWAITING_VERIFICATION', 'RESOLVED', 'CLOSED', 'WITHDRAWN', 'REJECTED')),

  subject             text NOT NULL CHECK (length(trim(subject)) >= 5),
  -- What the requester said. Never trusted as a statement of who they are.
  description         text NOT NULL,

  -- §22. Established, not asserted. Null until somebody has actually done it.
  identified_by       text CHECK (identified_by IS NULL OR identified_by IN
                        ('AUTHENTICATED_SESSION', 'VERIFIED_EMAIL_CHALLENGE', 'MSP_VOUCHED')),
  identified_at       timestamptz,
  -- The entitlement in force when this case was routed, captured at the time.
  -- A case routed under an agreement that has since lapsed must still read as
  -- having been routed correctly.
  direct_support_entitled boolean NOT NULL DEFAULT false,

  -- Only ever set when the customer says so, for S1 and S2.
  customer_verified   boolean NOT NULL DEFAULT false,

  opened_at           timestamptz NOT NULL DEFAULT now(),
  acknowledged_at     timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A case raised by Adericel about something it observed (§24).
  raised_by_signal    text,
  correlation_id      text,

  CONSTRAINT support_case_subject CHECK (
    -- A case about an estate names one. A product defect or feature request
    -- need not, and forcing a tenant onto it would be a lie about scope.
    category IN ('PRODUCT_DEFECT', 'FEATURE_REQUEST', 'SERVICE_AVAILABILITY')
    OR organisation_id IS NOT NULL
  ),
  CONSTRAINT support_case_system_has_no_person CHECK (
    requester_kind <> 'SYSTEM' OR requester_user_id IS NULL
  ),
  CONSTRAINT support_case_identification_is_complete CHECK (
    (identified_by IS NULL) = (identified_at IS NULL)
  )
);

CREATE INDEX support_cases_queue_idx ON support_cases (queue, severity, opened_at)
  WHERE state NOT IN ('CLOSED', 'WITHDRAWN', 'REJECTED');
CREATE INDEX support_cases_org_idx ON support_cases (organisation_id, opened_at DESC);
CREATE INDEX support_cases_msp_idx ON support_cases (msp_id, opened_at DESC);
CREATE INDEX support_cases_unacknowledged_idx ON support_cases (severity, opened_at)
  WHERE acknowledged_at IS NULL;

CREATE TRIGGER support_cases_touch BEFORE UPDATE ON support_cases
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

ALTER TABLE support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_cases FORCE ROW LEVEL SECURITY;

-- An organisation sees cases about itself. It cannot see the MSP's other
-- customers' cases, and a case with no organisation (a product defect) is not
-- a tenant's to read.
CREATE POLICY support_cases_tenant ON support_cases
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

-- ---------------------------------------------------------------------------
-- What happened to the case
--
-- Append-only. A support history that can be rewritten is worth nothing in the
-- conversation it exists for: the one where somebody asks what was done, when,
-- and who decided.
-- ---------------------------------------------------------------------------
CREATE TABLE support_case_transitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES support_cases (id) ON DELETE RESTRICT,
  organisation_id     uuid REFERENCES organisations (id) ON DELETE SET NULL,

  from_state          text NOT NULL,
  to_state            text NOT NULL,
  CONSTRAINT support_transition_moves CHECK (from_state <> to_state),

  reason              text NOT NULL CHECK (length(trim(reason)) >= 15),
  actor_kind          text NOT NULL CHECK (actor_kind IN ('USER', 'SYSTEM')),
  actor_user_id       uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_label         text NOT NULL,

  occurred_at         timestamptz NOT NULL DEFAULT now(),
  correlation_id      text,

  CONSTRAINT support_transition_user_is_named CHECK (
    actor_kind <> 'USER' OR actor_user_id IS NOT NULL
  )
);

CREATE INDEX support_case_transitions_case_idx
  ON support_case_transitions (case_id, occurred_at);

CREATE OR REPLACE FUNCTION support_history_is_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION '% is append-only; a support history is not editable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_case_transitions_append_only
  BEFORE UPDATE OR DELETE ON support_case_transitions
  FOR EACH ROW EXECUTE FUNCTION support_history_is_append_only();

ALTER TABLE support_case_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_case_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY support_case_transitions_tenant ON support_case_transitions
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

-- ---------------------------------------------------------------------------
-- What was actually disclosed (§22)
--
-- The table that makes the entitlement gate auditable rather than aspirational.
-- A refusal is recorded as well as a disclosure: a support surface where only
-- successes are logged cannot answer "did anyone try", which is the question
-- asked after an incident.
-- ---------------------------------------------------------------------------
CREATE TABLE support_disclosures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES support_cases (id) ON DELETE RESTRICT,
  organisation_id     uuid REFERENCES organisations (id) ON DELETE SET NULL,

  kind                text NOT NULL CHECK (kind IN (
                        'CASE_STATUS', 'ASSURANCE_STATE', 'ESTATE_DETAIL', 'EVIDENCE',
                        'DIAGNOSTIC_BUNDLE', 'PERSONAL_DATA', 'COMMERCIAL_POSITION')),
  permitted           boolean NOT NULL,
  -- Why it was allowed, or why it was not. Read in an investigation.
  decision_reason     text NOT NULL,

  to_requester_kind   text NOT NULL CHECK (to_requester_kind IN
                        ('END_CUSTOMER', 'MSP', 'VEYLITH', 'SYSTEM')),
  to_user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  identified_by       text,
  identified_at       timestamptz,

  disclosed_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  disclosed_by_label  text NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  correlation_id      text
);

CREATE INDEX support_disclosures_case_idx ON support_disclosures (case_id, occurred_at);
CREATE INDEX support_disclosures_refused_idx ON support_disclosures (occurred_at DESC)
  WHERE NOT permitted;

CREATE TRIGGER support_disclosures_append_only
  BEFORE UPDATE OR DELETE ON support_disclosures
  FOR EACH ROW EXECUTE FUNCTION support_history_is_append_only();

ALTER TABLE support_disclosures ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_disclosures FORCE ROW LEVEL SECURITY;

-- An organisation may see what was said about it, to whom. That is the point of
-- recording it: a disclosure log the subject cannot read is a log for the
-- discloser's benefit.
CREATE POLICY support_disclosures_tenant ON support_disclosures
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

-- ---------------------------------------------------------------------------
-- Diagnostic bundles (§23)
--
-- The artefact itself is not stored here; this is the record that one was
-- produced, for which tenant, and what its hash was. Storing the bundle would
-- make this table the largest concentration of estate detail in the platform,
-- for the convenience of not asking for it again.
-- ---------------------------------------------------------------------------
CREATE TABLE support_diagnostic_bundles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             uuid NOT NULL REFERENCES support_cases (id) ON DELETE RESTRICT,
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,

  sections            text[] NOT NULL CHECK (array_length(sections, 1) >= 1),
  content_hash        text NOT NULL CHECK (content_hash LIKE 'sha256:%'),

  requested_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  requested_by_label  text NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  correlation_id      text
);

CREATE INDEX support_bundles_case_idx ON support_diagnostic_bundles (case_id, requested_at DESC);

CREATE TRIGGER support_bundles_append_only
  BEFORE UPDATE OR DELETE ON support_diagnostic_bundles
  FOR EACH ROW EXECUTE FUNCTION support_history_is_append_only();

ALTER TABLE support_diagnostic_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_diagnostic_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY support_bundles_tenant ON support_diagnostic_bundles
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

COMMENT ON TABLE support_disclosures IS
  'Every disclosure decision made on a support case, permitted or refused. Readable by the '
  'organisation it concerns: a disclosure log the subject cannot read is a log for the '
  'discloser''s benefit.';

-- migrate:down
DROP POLICY IF EXISTS direct_support_tenant ON direct_support_entitlements;
DROP POLICY IF EXISTS support_bundles_tenant ON support_diagnostic_bundles;
DROP TRIGGER IF EXISTS support_bundles_append_only ON support_diagnostic_bundles;
DROP TABLE IF EXISTS support_diagnostic_bundles;

DROP POLICY IF EXISTS support_disclosures_tenant ON support_disclosures;
DROP TRIGGER IF EXISTS support_disclosures_append_only ON support_disclosures;
DROP TABLE IF EXISTS support_disclosures;

DROP POLICY IF EXISTS support_case_transitions_tenant ON support_case_transitions;
DROP TRIGGER IF EXISTS support_case_transitions_append_only ON support_case_transitions;
DROP TABLE IF EXISTS support_case_transitions;
DROP FUNCTION IF EXISTS support_history_is_append_only();

DROP POLICY IF EXISTS support_cases_tenant ON support_cases;
DROP TRIGGER IF EXISTS support_cases_touch ON support_cases;
DROP TABLE IF EXISTS support_cases;

DROP TABLE IF EXISTS direct_support_entitlements;
