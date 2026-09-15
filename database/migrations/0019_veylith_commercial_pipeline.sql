-- migrate:up
-- =============================================================================
-- The commercial pipeline.
--
-- Prospects, opportunities and outreach. All of it internal company state, so
-- all of it in `veylith` and platform scope only — a prospect is not a tenant,
-- and a competitor's name sitting in a customer-readable table would be a
-- disclosure with no upside.
--
-- CONSENT IS A FIRST-CLASS COLUMN, NOT A FLAG SOMEWHERE
--
-- The autonomy policy refuses outbound contact unless a lawful basis has been
-- recorded, and refuses with UNKNOWN rather than DENY when nothing has
-- established one. That only works if there is somewhere for the basis to be
-- recorded and somewhere for a suppression to live. Both are here, and both are
-- read directly by the facts the policy is asked about.
-- =============================================================================

CREATE TABLE veylith.prospects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable natural key, so the same company discovered twice is one prospect.
  -- Domain rather than name: names are typed differently every time.
  domain              text NOT NULL,
  name                text NOT NULL,
  country             text NOT NULL DEFAULT 'GB',
  -- What we believe about them. Every field nullable: a discovered prospect is
  -- mostly unknown, and defaulting `managed_organisations` to zero would score
  -- an unenriched record as a bad fit rather than an unknown one.
  managed_organisations integer CHECK (managed_organisations IS NULL OR managed_organisations >= 0),
  microsoft_heavy     boolean,
  compliance_workload boolean,
  api_capable         boolean,
  automation_maturity smallint CHECK (automation_maturity IS NULL OR automation_maturity BETWEEN 0 AND 5),
  executive_sponsor   boolean,

  -- The qualification model's output. Null until scored — never 0, which would
  -- be indistinguishable from a scored-and-rejected prospect.
  fit_score           smallint CHECK (fit_score IS NULL OR fit_score BETWEEN 0 AND 100),
  fit_reason          text NOT NULL DEFAULT '',
  scored_at           timestamptz,

  stage               text NOT NULL DEFAULT 'DISCOVERED'
                        CHECK (stage IN ('DISCOVERED', 'ENRICHED', 'QUALIFIED',
                                         'DISQUALIFIED', 'CONTACTED', 'ENGAGED',
                                         'CONVERTED', 'DORMANT')),
  disqualified_reason text,

  -- Contact and lawful basis.
  contact_email       text,
  contact_name        text,
  -- The basis for contacting them, in the words a regulator would expect.
  -- Empty means none recorded, which the policy reads as UNKNOWN rather than
  -- as permission.
  lawful_basis        text NOT NULL DEFAULT '',
  lawful_basis_recorded_at timestamptz,
  -- Suppression is absolute and permanent. A suppressed prospect is never
  -- contacted again, whatever a later campaign thinks.
  suppressed          boolean NOT NULL DEFAULT false,
  suppressed_reason   text,
  suppressed_at       timestamptz,

  -- Set when this prospect becomes a paying customer.
  msp_id              uuid REFERENCES adericel.msps (id) ON DELETE SET NULL,
  organisation_id     uuid REFERENCES adericel.organisations (id) ON DELETE SET NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prospects_basis_dated CHECK (
    (lawful_basis = '' AND lawful_basis_recorded_at IS NULL)
    OR (lawful_basis <> '' AND lawful_basis_recorded_at IS NOT NULL)
  ),
  CONSTRAINT prospects_suppression_explained CHECK (
    suppressed IS false OR (suppressed_reason IS NOT NULL AND suppressed_at IS NOT NULL)
  ),
  CONSTRAINT prospects_disqualification_explained CHECK (
    stage <> 'DISQUALIFIED' OR disqualified_reason IS NOT NULL
  )
);
CREATE UNIQUE INDEX prospects_domain_unique ON veylith.prospects (lower(domain));
CREATE INDEX prospects_stage_idx ON veylith.prospects (stage, fit_score DESC NULLS LAST);
-- The working queue: qualified, contactable, not yet contacted.
CREATE INDEX prospects_actionable_idx
  ON veylith.prospects (fit_score DESC)
  WHERE stage = 'QUALIFIED' AND suppressed IS false;

CREATE TABLE veylith.outreach (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       uuid NOT NULL REFERENCES veylith.prospects (id) ON DELETE CASCADE,
  channel           text NOT NULL DEFAULT 'EMAIL' CHECK (channel IN ('EMAIL', 'LINKEDIN', 'PHONE', 'OTHER')),
  template_key      text NOT NULL,
  subject           text NOT NULL DEFAULT '',
  body              text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'PREPARED'
                      CHECK (status IN ('PREPARED', 'APPROVED', 'SENT', 'BOUNCED',
                                        'RESPONDED', 'REFUSED', 'CANCELLED')),
  -- The decision that permitted this to be sent. Null while prepared.
  policy_decision_id uuid REFERENCES veylith.policy_decisions (id) ON DELETE SET NULL,
  prepared_at       timestamptz NOT NULL DEFAULT now(),
  approved_by       text,
  sent_at           timestamptz,
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_sent_has_time CHECK (status <> 'SENT' OR sent_at IS NOT NULL)
);
CREATE INDEX outreach_prospect_idx ON veylith.outreach (prospect_id, created_at DESC);
CREATE INDEX outreach_status_idx ON veylith.outreach (status, prepared_at DESC);

CREATE TABLE veylith.opportunities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       uuid NOT NULL REFERENCES veylith.prospects (id) ON DELETE CASCADE,
  stage             text NOT NULL DEFAULT 'DISCOVERY'
                      CHECK (stage IN ('DISCOVERY', 'TECHNICAL_ASSESSMENT', 'DEMONSTRATION',
                                       'FOUNDING_PROGRAMME', 'PROPOSAL', 'CONTRACT',
                                       'WON', 'LOST')),
  -- The commercial shape being discussed. Nullable throughout: an opportunity
  -- in discovery has no agreed price, and a default would become a quoted one.
  plan_key          text,
  organisations     integer CHECK (organisations IS NULL OR organisations > 0),
  monthly_pence     integer CHECK (monthly_pence IS NULL OR monthly_pence >= 0),
  -- Deliberately not a probability-weighted forecast. A number the system
  -- invented and a person then reported upward is how a pipeline becomes
  -- fiction.
  next_action       text NOT NULL DEFAULT '',
  next_action_due   timestamptz,
  lost_reason       text,
  won_at            timestamptz,
  lost_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_loss_explained CHECK (stage <> 'LOST' OR lost_reason IS NOT NULL)
);
-- One live opportunity per prospect. Two would make "what is this deal worth?"
-- ambiguous, which is the question the pipeline exists to answer.
CREATE UNIQUE INDEX opportunities_live_unique
  ON veylith.opportunities (prospect_id) WHERE stage NOT IN ('WON', 'LOST');
CREATE INDEX opportunities_stage_idx ON veylith.opportunities (stage, next_action_due);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prospects', 'outreach', 'opportunities'] LOOP
    EXECUTE format('ALTER TABLE veylith.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE veylith.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY platform_only ON veylith.%I '
      'USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope())', t);
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adericel_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA veylith TO adericel_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA veylith TO adericel_app';
  END IF;
END;
$$;

-- migrate:down
DROP TABLE IF EXISTS veylith.opportunities;
DROP TABLE IF EXISTS veylith.outreach;
DROP TABLE IF EXISTS veylith.prospects;
