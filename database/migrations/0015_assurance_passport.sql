-- migrate:up
-- =============================================================================
-- The Assurance Passport.
--
-- Everything Adericel does terminates here. The graph, the evidence, the
-- determinations and the verification history exist so that an organisation can
-- answer, to somebody outside itself, "what is true about our security, and why
-- should you believe us?"
--
-- Two decisions shape this schema.
--
-- First, a passport is ISSUED, not generated on demand. Its content is frozen
-- and content-hashed at the moment of issue, because a shared assurance record
-- whose content changes after it was shared is not a record — the recipient and
-- the issuer would be looking at different things while both believing they
-- agreed. The live state is always available separately; a passport is what was
-- true at a stated instant, and says so.
--
-- Second, sharing is a scoped, revocable, expiring grant with its own secret,
-- never a guessable URL. Recipients are unauthenticated by necessity — an
-- insurer or a procurement team will not hold an Adericel account — so the
-- token is the whole control, and it is stored only as a keyed digest.
--
-- The differentiating property is what a passport is permitted to contain. It
-- carries UNKNOWN, evidence age, and the reason a control could not be
-- determined, with the same prominence as anything satisfied. A passport that
-- could only say "compliant" would be the artefact this company exists to
-- replace.
-- =============================================================================

CREATE TABLE assurance_passports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  -- Monotonic per organisation, so "passport 4" is unambiguous in an email.
  sequence            integer NOT NULL,
  -- The frozen record. Canonically encoded before hashing.
  content             jsonb NOT NULL,
  content_hash        text NOT NULL,
  -- The headline, denormalised so a portfolio view need not open every passport.
  state               text NOT NULL
                        CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED',
                                         'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN')),
  controls_total      integer NOT NULL,
  controls_unknown    integer NOT NULL,
  controls_satisfied  integer NOT NULL,
  controls_failing    integer NOT NULL,
  open_findings       integer NOT NULL,
  -- The instant the passport describes. Not the instant it was rendered.
  as_of               timestamptz NOT NULL,
  issued_by           text NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  -- A passport may be withdrawn — a control was found to have been wrongly
  -- assessed, or the organisation no longer wishes it relied upon. Withdrawal
  -- does not delete it: a recipient who checks an old passport must be told it
  -- was withdrawn rather than told it never existed.
  withdrawn_at        timestamptz,
  withdrawn_reason    text,
  correlation_id      uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, sequence)
);
CREATE INDEX assurance_passports_org_idx
  ON assurance_passports (organisation_id, issued_at DESC);
CREATE INDEX assurance_passports_hash_idx ON assurance_passports (content_hash);

ALTER TABLE assurance_passports ENABLE ROW LEVEL SECURITY;
ALTER TABLE assurance_passports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assurance_passports
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- ---------------------------------------------------------------------------
-- Shares.
--
-- One passport may be shared with several parties, each with its own secret,
-- expiry and audience label, so a share to an insurer can be revoked without
-- affecting the one sent to a client.
-- ---------------------------------------------------------------------------
CREATE TABLE passport_shares (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  passport_id      uuid NOT NULL REFERENCES assurance_passports (id) ON DELETE CASCADE,
  -- Who this was shared with, in the issuer's own words. Recorded so the
  -- organisation can answer "who have we sent our assurance record to?".
  audience         text NOT NULL,
  token_hash       text NOT NULL,
  -- REDACTED omits finding detail and subject names: enough to establish the
  -- assurance state and its basis, without handing over a map of the estate's
  -- weaknesses to a party that has not earned it.
  disclosure       text NOT NULL DEFAULT 'REDACTED'
                     CHECK (disclosure IN ('REDACTED', 'FULL')),
  created_by       text NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       text,
  view_count       integer NOT NULL DEFAULT 0,
  last_viewed_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX passport_shares_token ON passport_shares (token_hash);
CREATE INDEX passport_shares_passport_idx ON passport_shares (passport_id);
CREATE INDEX passport_shares_live_idx
  ON passport_shares (organisation_id, expires_at) WHERE revoked_at IS NULL;

ALTER TABLE passport_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE passport_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON passport_shares
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- Every view of a shared passport, so the issuer can see who looked and when.
CREATE TABLE passport_share_views (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  share_id         uuid NOT NULL REFERENCES passport_shares (id) ON DELETE CASCADE,
  viewed_at        timestamptz NOT NULL DEFAULT now(),
  source_ip        inet,
  user_agent       text
);
CREATE INDEX passport_share_views_share_idx
  ON passport_share_views (share_id, viewed_at DESC);

ALTER TABLE passport_share_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE passport_share_views FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON passport_share_views
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- ---------------------------------------------------------------------------
-- Commercial anchors.
--
-- The three plans represent increasing delegation — tell me, help me, do it —
-- rather than increasing dashboard features. Prices are the initial anchors and
-- are expected to move; what should not move is that the tiers are defined by
-- how much authority the customer delegates.
-- ---------------------------------------------------------------------------
INSERT INTO plans (key, tier, name, price_per_organisation_minor, currency,
                   included_organisations, features)
VALUES
  ('assure', 'PILOT', 'Assure', 29900, 'GBP', 1, ARRAY[
     'continuous-observation', 'assurance-graph', 'deterministic-assessment',
     'evidence-provenance', 'assurance-passport', 'change-history',
     'self-service-onboarding']),
  ('protect', 'STANDARD', 'Protect', 59900, 'GBP', 1, ARRAY[
     'continuous-observation', 'assurance-graph', 'deterministic-assessment',
     'evidence-provenance', 'assurance-passport', 'change-history',
     'self-service-onboarding', 'policy-controlled-actions',
     'action-verification', 'remediation-history', 'questionnaire-assistance']),
  ('autonomous', 'VOLUME', 'Autonomous', 99900, 'GBP', 1, ARRAY[
     'continuous-observation', 'assurance-graph', 'deterministic-assessment',
     'evidence-provenance', 'assurance-passport', 'change-history',
     'self-service-onboarding', 'policy-controlled-actions',
     'action-verification', 'remediation-history', 'questionnaire-assistance',
     'continuous-authorised-remediation', 'supplier-assurance',
     'customer-assurance', 'questionnaire-autopilot', 'assurance-sharing'])
ON CONFLICT (key) DO UPDATE SET
  tier = EXCLUDED.tier,
  name = EXCLUDED.name,
  price_per_organisation_minor = EXCLUDED.price_per_organisation_minor,
  features = EXCLUDED.features;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adericel_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.assurance_passports TO adericel_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.passport_shares TO adericel_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.passport_share_views TO adericel_app';
  END IF;
END;
$$;

-- migrate:down
DROP TABLE IF EXISTS passport_share_views;
DROP TABLE IF EXISTS passport_shares;
DROP TABLE IF EXISTS assurance_passports;
DELETE FROM plans WHERE key IN ('assure', 'protect', 'autonomous');
