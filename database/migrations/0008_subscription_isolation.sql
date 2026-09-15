-- migrate:up
-- =============================================================================
-- Row level security for subscriptions.
--
-- Found by the structural test in tests/tenancy/isolation.test.ts, which
-- asserts that every table carrying an organisation_id is protected by a forced
-- policy rather than relying on a hand-maintained list. `subscriptions` was
-- omitted from migration 0006's list, so an organisation's commercial terms —
-- what its MSP is charged for it, and whether that account is past due — sat
-- outside the database layer of tenant isolation.
--
-- The application layer was still enforcing access, so this was not an
-- exploitable disclosure. It was the loss of the second layer, which is exactly
-- the failure mode defence in depth exists to survive, and precisely the kind
-- that goes unnoticed because everything still works.
--
-- The table follows the nullable pattern: a subscription belongs either to an
-- MSP (msp_id set, organisation_id NULL) or to a single organisation. MSP-level
-- rows have no organisation_id and are therefore visible only under platform
-- scope, which is where subscription administration runs.
-- =============================================================================

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriptions
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- The remaining tables without row level security are deliberate and are listed
-- here so that the absence is a decision on the record rather than an oversight
-- somebody has to rediscover:
--
--   users, user_credentials, sessions, api_keys, grants
--     Identity. These are read to establish who the caller is, which by
--     definition happens before any tenant context exists. Protecting them with
--     a tenant policy would make authentication impossible. They carry no
--     organisation_id; `grants` is the table that maps a principal to the
--     organisations they may reach, and it is the input to isolation rather
--     than a subject of it.
--
--   msps, plans, health_checks
--     Control plane. No organisation-owned data.
--
--   msp_baselines, msp_baseline_controls
--     MSP-owned policy templates, inherited by organisations. Scoped by msp_id,
--     administered under platform scope, and containing no organisation data.
--
-- If any of these ever gains an organisation_id column, the structural test
-- fails until a policy is written for it. That is the intended behaviour.

-- migrate:down
DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
ALTER TABLE subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;
