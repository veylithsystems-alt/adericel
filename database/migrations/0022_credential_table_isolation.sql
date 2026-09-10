-- migrate:up
-- =============================================================================
-- Lock the credential tables to platform scope.
--
-- Row level security was applied to every table carrying an organisation_id,
-- and a structural test proves that holds. The tables WITHOUT an
-- organisation_id were never considered, and thirteen of them had no policy at
-- all — including every table that stores a secret.
--
-- Today nothing under a tenant transaction queries them, so this is not an
-- active vulnerability. It is the shape of one: the isolation of password
-- hashes, session tokens, recovery codes and API secrets rested entirely on
-- nobody ever writing `SELECT ... FROM user_credentials` inside a `withTenant`
-- block. That is a convention, and conventions are what this codebase uses row
-- level security instead of.
--
-- WHY ONLY THESE FIVE
--
-- `users`, `grants` and `user_mfa_factors` ARE legitimately read under tenant
-- scope — "who can approve an action here", "who approved this one" — so a
-- platform-only policy would break real functionality. They hold identity, not
-- secrets, and are left for a narrower per-row policy later. That gap is
-- deliberate and recorded rather than quietly closed by breaking the product.
--
-- These five hold nothing but credential material and are read only by the
-- authentication layer, which runs at platform scope.
-- =============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_credentials',   -- password hashes
    'user_recovery_codes',-- MFA recovery codes
    'mfa_challenges',     -- in-flight second-factor challenges
    'sessions',           -- refresh token digests
    'api_keys'            -- API secret digests
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY platform_only ON %I '
      'USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope())', t);
  END LOOP;
END;
$$;

-- migrate:down
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_credentials', 'user_recovery_codes', 'mfa_challenges', 'sessions', 'api_keys'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS platform_only ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;
