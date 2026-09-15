-- migrate:up
-- =============================================================================
-- Multi-factor authentication.
--
-- Adericel assesses other organisations' multi-factor coverage. Not having it
-- was the most conspicuous gap in its own threat model, and the first thing a
-- competent MSP would find when assessing their supplier.
--
-- Two tables and three columns on sessions. The design points worth recording:
--
--  * The TOTP secret is sealed with the credential cipher (AES-256-GCM) using
--    the user id as additional authenticated data, exactly like an integration
--    credential. A sealed secret moved to another user's row does not decrypt.
--
--  * last_used_step is what makes a code single-use. Without it a code observed
--    over someone's shoulder — or sitting in a proxy log — is valid for the
--    remainder of its thirty-second window and one step either side.
--
--  * Recovery codes are hashed like any other credential and marked used rather
--    than deleted, so "a recovery code was used" stays visible in the record.
--
--  * Sessions carry whether MFA was satisfied and by which factor. Authority is
--    resolved per request (ADR-0008), so this travels with the session rather
--    than with the token, and revoking a factor takes effect immediately.
-- =============================================================================

CREATE TABLE user_mfa_factors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  factor_type     text NOT NULL CHECK (factor_type IN ('TOTP')),
  label           text NOT NULL,
  -- Sealed, never plaintext. AAD is the user id.
  secret_sealed   text NOT NULL,
  -- NULL until the user has proved they can generate a code. An unconfirmed
  -- factor must never be able to satisfy a challenge, or enrolment itself
  -- becomes the bypass.
  confirmed_at    timestamptz,
  last_used_at    timestamptz,
  last_used_step  bigint,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX user_mfa_factors_user_idx ON user_mfa_factors (user_id) WHERE revoked_at IS NULL;
-- One live confirmed TOTP factor per user. Enrolling a replacement revokes the
-- previous one rather than silently leaving two secrets that both work.
CREATE UNIQUE INDEX user_mfa_factors_one_live_totp
  ON user_mfa_factors (user_id)
  WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL AND factor_type = 'TOTP';

CREATE TABLE user_recovery_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX user_recovery_codes_hash_key ON user_recovery_codes (code_hash);
CREATE INDEX user_recovery_codes_user_idx ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- Sessions record whether the second factor was actually presented, and how.
-- 'NONE' means the user has no factor enrolled; a session that merely skipped
-- the challenge cannot exist, because login refuses to mint one.
ALTER TABLE sessions
  ADD COLUMN mfa_satisfied_at timestamptz,
  ADD COLUMN mfa_method       text CHECK (mfa_method IN ('NONE', 'TOTP', 'RECOVERY_CODE'));

-- Pending MFA challenges. A challenge is what login returns instead of tokens
-- when a factor is enrolled: proof that the password was correct, and nothing
-- more. It is stored hashed and is single use.
CREATE TABLE mfa_challenges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  consumed_at     timestamptz,
  source_ip       inet,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX mfa_challenges_token_key ON mfa_challenges (token_hash);
CREATE INDEX mfa_challenges_expiry_idx ON mfa_challenges (expires_at) WHERE consumed_at IS NULL;

-- A password check that succeeded while the second factor is still outstanding
-- is neither a success nor a failure, and recording it as either misleads the
-- audit trail: as SUCCESS it overcounts completed logins, as FAILURE it makes a
-- normal MFA sign-in look like an attack. PENDING says what happened.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_outcome_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_outcome_check
  CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE', 'PENDING'));

-- Identity tables sit outside row level security by design (see migration 0008):
-- they are read to establish who the caller is, which happens before any tenant
-- context exists. These three are identity tables and follow that rule. None of
-- them carries an organisation_id, so the structural tenancy test agrees.

-- migrate:down
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_outcome_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_outcome_check
  CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE'));
DROP TABLE IF EXISTS mfa_challenges;
DROP TABLE IF EXISTS user_recovery_codes;
DROP TABLE IF EXISTS user_mfa_factors;
ALTER TABLE sessions DROP COLUMN IF EXISTS mfa_satisfied_at;
ALTER TABLE sessions DROP COLUMN IF EXISTS mfa_method;
