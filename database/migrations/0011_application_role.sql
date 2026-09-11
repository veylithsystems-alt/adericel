-- migrate:up
-- =============================================================================
-- The application role.
--
-- ADR-0007 claims three independent layers of tenant isolation, the second being
-- PostgreSQL row level security. That claim was conditionally false, and the
-- condition was invisible.
--
-- Row level security is bypassed unconditionally by a superuser. FORCE ROW LEVEL
-- SECURITY closes the table-owner hole; it does nothing about a superuser. So
-- whether layer 2 existed at all depended entirely on how the operator happened
-- to provision the role in DATABASE_URL — and a deployment that got it wrong
-- passed every test, because the application layer was intact.
--
-- CI proved it: the postgres image creates POSTGRES_USER as a superuser, and six
-- tenant isolation tests that pass on a developer machine fail there. They were
-- right to fail. The tests were correct and the schema was not.
--
-- `DATABASE_APPLICATION_ROLE` already existed in configuration and defaulted to
-- `adericel_app`. No migration created that role and no query ever assumed it.
-- It was dead configuration describing a control that did not exist.
--
-- This migration creates the role. `withTenant` and `withPlatform` now begin
-- with `SET LOCAL ROLE`, so row level security is evaluated against a role that
-- provably cannot bypass it, whatever the connection was opened as. The check in
-- packages/graph/src/rls-guard.ts refuses to start if that is not true.
-- =============================================================================

-- Creating a role needs CREATEROLE or superuser, which the migration runner has
-- in a compose deployment and on most managed PostgreSQL, and deliberately does
-- not have in a locked-down enterprise cluster. Rather than assume, this fails
-- with the exact statement a DBA needs to run.
DO $$
DECLARE
  app_role text := 'adericel_app';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    IF NOT (SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = CURRENT_USER) THEN
      RAISE EXCEPTION
        'Cannot create the % role: this connection has neither CREATEROLE nor SUPERUSER.', app_role
        USING HINT =
          'Ask a database administrator to run: CREATE ROLE adericel_app NOLOGIN NOSUPERUSER '
          'NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT; GRANT adericel_app TO ' ||
          quote_ident(CURRENT_USER) || '; then re-run migrations. Tenant isolation depends on '
          'this role: the application refuses to start without it.';
    END IF;
    -- NOLOGIN: it is reached only through SET ROLE, never connected to directly.
    -- NOBYPASSRLS and NOSUPERUSER are the entire point and are asserted at
    -- startup rather than trusted.
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      app_role
    );
  ELSE
    -- An existing role might carry the wrong attributes. Changing them requires
    -- SUPERUSER even to assert the safe values, which a CREATEROLE-only
    -- migration runner does not have — so this verifies and refuses rather than
    -- attempting a change that would fail on exactly the clusters where the
    -- check matters most.
    IF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = app_role AND (rolsuper OR rolbypassrls)
    ) THEN
      RAISE EXCEPTION
        'Role % can bypass row level security, so tenant isolation would not be enforced.', app_role
        USING HINT =
          'Run: ALTER ROLE adericel_app NOSUPERUSER NOBYPASSRLS; as a superuser.';
    END IF;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA adericel TO %I', app_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA adericel TO %I', app_role
  );
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA adericel TO %I', app_role);

  -- Tables created by later migrations must be reachable without anybody
  -- remembering to add a grant. A missing grant would fail loudly rather than
  -- silently, but it would fail in production.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA adericel
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA adericel GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role
  );

  -- The connecting role must be able to SET ROLE to it. Granting membership to
  -- the current user covers both the owner-connects case and a dedicated login
  -- role, without the migration needing to know which one this deployment uses.
  EXECUTE format('GRANT %I TO CURRENT_USER', app_role);
END;
$$;

-- migrate:down
-- The role is not dropped: other databases in the cluster may share it, and
-- dropping a role that still owns privileges fails in a way that is confusing
-- at exactly the wrong moment. Revoking is enough to reverse this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adericel_app') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA adericel
               REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM adericel_app';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA adericel FROM adericel_app';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA adericel FROM adericel_app';
    EXECUTE 'REVOKE USAGE ON SCHEMA adericel FROM adericel_app';
  END IF;
END;
$$;
