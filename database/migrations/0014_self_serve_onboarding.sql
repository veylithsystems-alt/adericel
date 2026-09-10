-- migrate:up
-- =============================================================================
-- Self-serve onboarding.
--
-- Until now Adericel had no way to acquire a customer. Every route required an
-- authenticated principal, there was no route that created a user, and no table
-- recorded an intention to sign up. Every tenant that had ever existed was
-- created by a test fixture or a seed script. The product could assess, decide,
-- act and verify — and could not be bought.
--
-- Three tables:
--
--   signups       An intention to create an account, before any tenant exists.
--                 Deliberately outside the tenancy model, because at this point
--                 there is no tenant to be inside. Holds only a keyed digest of
--                 the verification token, never the token.
--
--   invitations   An offer of a named authority within an existing scope.
--                 Bound to one email address, one scope, and a fixed set of
--                 roles decided by the inviter — an invitation is not a
--                 negotiation, and the recipient cannot choose their own roles.
--
--   onboarding_tasks
--                 The state of getting a tenant to its first evidence-backed
--                 answer. Onboarding that a customer cannot see the shape of is
--                 onboarding they abandon.
-- =============================================================================

CREATE TABLE signups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  contact_name       text NOT NULL,
  -- MSP: an operator onboarding customers of their own. DIRECT: one business
  -- assuring itself. The shapes differ only in what provisioning creates.
  account_kind       text NOT NULL CHECK (account_kind IN ('MSP', 'DIRECT')),
  organisation_name  text NOT NULL,
  country_code       text,
  -- Keyed digest of the verification token. The token is shown once, to the
  -- address that claimed it, and never stored.
  token_hash         text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'SUPERSEDED')),
  attempts           integer NOT NULL DEFAULT 0,
  requested_ip       inet,
  expires_at         timestamptz NOT NULL,
  completed_at       timestamptz,
  msp_id             uuid REFERENCES msps (id) ON DELETE SET NULL,
  organisation_id    uuid REFERENCES organisations (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- One live signup per address: a second request supersedes the first rather
-- than leaving two valid tokens outstanding.
CREATE UNIQUE INDEX signups_live_email ON signups (lower(email)) WHERE status = 'PENDING';
CREATE INDEX signups_expiry_idx ON signups (expires_at) WHERE status = 'PENDING';

CREATE TABLE invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  scope_type        text NOT NULL CHECK (scope_type IN ('MSP', 'ORGANISATION')),
  scope_id          uuid NOT NULL,
  msp_id            uuid REFERENCES msps (id) ON DELETE CASCADE,
  organisation_id   uuid REFERENCES organisations (id) ON DELETE CASCADE,
  roles             text[] NOT NULL CHECK (cardinality(roles) > 0),
  token_hash        text NOT NULL,
  invited_by        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message           text,
  status            text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  accepted_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_scope_target CHECK (
    (scope_type = 'MSP' AND msp_id IS NOT NULL AND organisation_id IS NULL)
    OR (scope_type = 'ORGANISATION' AND organisation_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX invitations_live_email_scope
  ON invitations (lower(email), scope_type, scope_id) WHERE status = 'PENDING';
CREATE INDEX invitations_scope_idx ON invitations (scope_type, scope_id);
CREATE INDEX invitations_org_idx ON invitations (organisation_id) WHERE organisation_id IS NOT NULL;

-- Row level security for the organisation-scoped rows. MSP-scoped invitations
-- carry no organisation_id and are administered under platform scope, matching
-- the pattern migration 0008 records for subscriptions.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

CREATE TABLE onboarding_tasks (
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  key              text NOT NULL,
  title            text NOT NULL,
  description      text NOT NULL,
  -- BLOCKED means a prerequisite task is incomplete; the customer is not asked
  -- to do something they cannot yet do.
  state            text NOT NULL DEFAULT 'PENDING'
                     CHECK (state IN ('PENDING', 'BLOCKED', 'COMPLETED', 'SKIPPED')),
  -- Whether the tenant can reach an evidence-backed answer without it.
  required         boolean NOT NULL DEFAULT true,
  position         integer NOT NULL,
  completed_at     timestamptz,
  detail           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, key)
);
CREATE INDEX onboarding_tasks_open_idx
  ON onboarding_tasks (organisation_id, position) WHERE state <> 'COMPLETED';

ALTER TABLE onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onboarding_tasks
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

CREATE TRIGGER onboarding_tasks_touch BEFORE UPDATE ON onboarding_tasks
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

-- `signups` follows the nullable pattern from migration 0006. A pending signup
-- has no organisation_id, because no tenant exists yet, and is therefore visible
-- only under platform scope — which is where the unauthenticated signup path
-- runs. Once it completes it names the organisation it created and becomes
-- visible to that tenant as part of its own history.
--
-- Exempting it instead was the obvious move and the wrong one: the structural
-- test refuses to accept a table carrying an organisation_id without a forced
-- policy, and the start-up guard refuses to boot. Both did exactly that when
-- this table was first added without one.
ALTER TABLE signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE signups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON signups
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adericel_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.signups TO adericel_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.invitations TO adericel_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.onboarding_tasks TO adericel_app';
  END IF;
END;
$$;

-- migrate:down
DROP POLICY IF EXISTS tenant_isolation ON signups;
DROP TABLE IF EXISTS onboarding_tasks;
DROP POLICY IF EXISTS tenant_isolation ON invitations;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS signups;
