-- migrate:up
-- =============================================================================
-- Adericel core: tenancy, identity, authority.
--
-- An MSP is an operator boundary (who may act). An organisation is a data
-- boundary (what belongs together). Grants bind principals to roles within a
-- scope; nothing in this schema lets a request assert its own tenancy.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS adericel;

-- ---------------------------------------------------------------------------
-- Tenant context helpers.
--
-- Every tenant-scoped query runs inside a transaction that has set
-- `adericel.organisation_id`. Row level security reads these settings; when
-- they are absent the policies deny, so a forgotten context is a failed query
-- rather than a cross-tenant read.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adericel.current_organisation_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('adericel.organisation_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION adericel.is_platform_scope() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('adericel.scope', true), '') = 'platform';
$$;

CREATE OR REPLACE FUNCTION adericel.tenant_visible(row_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT adericel.is_platform_scope()
      OR (row_organisation_id IS NOT NULL
          AND row_organisation_id = adericel.current_organisation_id());
$$;

CREATE OR REPLACE FUNCTION adericel.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- MSPs
-- ---------------------------------------------------------------------------
CREATE TABLE msps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  slug           text NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  contact_email  text NOT NULL,
  country_code   char(2),
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX msps_slug_key ON msps (lower(slug));
CREATE TRIGGER msps_touch BEFORE UPDATE ON msps
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------
CREATE TABLE organisations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_id         uuid REFERENCES msps (id) ON DELETE RESTRICT,
  name           text NOT NULL,
  slug           text NOT NULL,
  status         text NOT NULL DEFAULT 'ONBOARDING'
                   CHECK (status IN ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED')),
  country_code   char(2),
  industry       text,
  size_band      text,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  onboarded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organisations_slug_key ON organisations (lower(slug));
CREATE INDEX organisations_msp_idx ON organisations (msp_id) WHERE msp_id IS NOT NULL;
CREATE INDEX organisations_status_idx ON organisations (status);
CREATE TRIGGER organisations_touch BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Users and credentials.
--
-- Credentials live in their own table so that reading a user record — which
-- happens on nearly every request — never pulls a password hash into memory.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  display_name   text NOT NULL,
  msp_id         uuid REFERENCES msps (id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  mfa_enrolled   boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_msp_idx ON users (msp_id) WHERE msp_id IS NOT NULL;
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE user_credentials (
  user_id            uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash      text NOT NULL,
  password_set_at    timestamptz NOT NULL DEFAULT now(),
  failed_attempts    integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  must_change        boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- Grants: the sole source of authority.
--
-- scope_type PLATFORM has a NULL scope_id; MSP and ORGANISATION grants name the
-- scope explicitly. expires_at supports time-bounded delegated access, which is
-- how an MSP engineer gets into a customer tenant without a standing key.
-- ---------------------------------------------------------------------------
CREATE TABLE grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type    text NOT NULL CHECK (principal_type IN ('USER', 'API_KEY', 'SERVICE')),
  principal_id      uuid NOT NULL,
  scope_type        text NOT NULL CHECK (scope_type IN ('PLATFORM', 'MSP', 'ORGANISATION')),
  scope_id          uuid,
  roles             text[] NOT NULL CHECK (array_length(roles, 1) >= 1),
  granted_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  grant_reason      text,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grants_scope_shape CHECK (
    (scope_type = 'PLATFORM' AND scope_id IS NULL)
    OR (scope_type <> 'PLATFORM' AND scope_id IS NOT NULL)
  )
);
CREATE INDEX grants_principal_idx ON grants (principal_type, principal_id) WHERE revoked_at IS NULL;
CREATE INDEX grants_scope_idx ON grants (scope_type, scope_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX grants_unique_live
  ON grants (principal_type, principal_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Sessions (refresh tokens). Access tokens are stateless JWTs; the refresh
-- token is stored hashed so a database disclosure cannot be replayed.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL,
  user_agent          text,
  source_ip           inet,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  last_used_at        timestamptz
);
CREATE UNIQUE INDEX sessions_refresh_hash_key ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- API keys for machine-to-machine access (n8n, MSP platforms, customer portals).
-- Only a hash of the secret is stored; key_id makes lookup a single index hit
-- without needing to compare against every row.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id           text NOT NULL,
  secret_hash      text NOT NULL,
  name             text NOT NULL,
  description      text,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  msp_id           uuid REFERENCES msps (id) ON DELETE CASCADE,
  last_used_at     timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_key_id_key ON api_keys (key_id);
CREATE INDEX api_keys_msp_idx ON api_keys (msp_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- MSP baselines: the assurance floor an MSP applies across its portfolio.
-- ---------------------------------------------------------------------------
CREATE TABLE msp_baselines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_id        uuid NOT NULL REFERENCES msps (id) ON DELETE CASCADE,
  key           text NOT NULL,
  name          text NOT NULL,
  description   text,
  version       integer NOT NULL DEFAULT 1,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX msp_baselines_key ON msp_baselines (msp_id, key);
CREATE UNIQUE INDEX msp_baselines_one_default ON msp_baselines (msp_id) WHERE is_default;
CREATE TRIGGER msp_baselines_touch BEFORE UPDATE ON msp_baselines
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE msp_baseline_controls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id       uuid NOT NULL REFERENCES msp_baselines (id) ON DELETE CASCADE,
  control_key       text NOT NULL,
  title             text NOT NULL,
  description       text,
  ruleset_key       text NOT NULL,
  rule_key          text NOT NULL,
  parameters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  requirement_keys  text[] NOT NULL DEFAULT ARRAY[]::text[],
  mandatory         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX msp_baseline_controls_key ON msp_baseline_controls (baseline_id, control_key);

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------
CREATE TABLE plans (
  key                             text PRIMARY KEY,
  tier                            text NOT NULL CHECK (tier IN ('PILOT', 'STANDARD', 'VOLUME', 'ENTERPRISE')),
  name                            text NOT NULL,
  price_per_organisation_minor    integer NOT NULL CHECK (price_per_organisation_minor >= 0),
  currency                        char(3) NOT NULL DEFAULT 'GBP',
  included_organisations          integer NOT NULL DEFAULT 0,
  volume_tiers                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  features                        text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msp_id                        uuid REFERENCES msps (id) ON DELETE CASCADE,
  organisation_id               uuid REFERENCES organisations (id) ON DELETE CASCADE,
  plan_key                      text NOT NULL REFERENCES plans (key),
  status                        text NOT NULL DEFAULT 'TRIAL'
                                  CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED')),
  currency                      char(3) NOT NULL DEFAULT 'GBP',
  price_per_organisation_minor  integer NOT NULL,
  organisation_limit            integer,
  trial_ends_at                 timestamptz,
  current_period_start          timestamptz NOT NULL DEFAULT now(),
  current_period_end            timestamptz NOT NULL,
  cancelled_at                  timestamptz,
  external_customer_ref         text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_subject CHECK (
    (msp_id IS NOT NULL AND organisation_id IS NULL)
    OR (msp_id IS NULL AND organisation_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX subscriptions_msp_live ON subscriptions (msp_id)
  WHERE msp_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX subscriptions_org_live ON subscriptions (organisation_id)
  WHERE organisation_id IS NOT NULL AND status <> 'CANCELLED';
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

-- migrate:down
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS msp_baseline_controls;
DROP TABLE IF EXISTS msp_baselines;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS grants;
DROP TABLE IF EXISTS user_credentials;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organisations;
DROP TABLE IF EXISTS msps;
DROP FUNCTION IF EXISTS adericel.touch_updated_at();
DROP FUNCTION IF EXISTS adericel.tenant_visible(uuid);
DROP FUNCTION IF EXISTS adericel.is_platform_scope();
DROP FUNCTION IF EXISTS adericel.current_organisation_id();
DROP SCHEMA IF EXISTS adericel;
