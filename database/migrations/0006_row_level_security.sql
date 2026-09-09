-- migrate:up
-- =============================================================================
-- Row Level Security.
--
-- This is ONE layer of tenant isolation, not the whole strategy. The
-- application also scopes every query explicitly and authorises every request
-- against the principal's grants (see packages/graph and apps/api). RLS exists
-- so that a bug in either of those layers fails closed at the database rather
-- than returning another customer's data.
--
-- FORCE ROW LEVEL SECURITY is used deliberately: without it the table owner —
-- which is the account the application usually connects as — bypasses every
-- policy, and the protection would be theatre.
--
-- Policies read two transaction-local settings:
--   adericel.organisation_id  the single organisation this transaction may touch
--   adericel.scope            'platform' for control-plane work
-- When neither is set, nothing is visible. A forgotten context is a failed
-- query, never a cross-tenant read.
-- =============================================================================

DO $$
DECLARE
  -- Tables whose organisation_id is NOT NULL: strictly tenant-owned rows.
  strict_tables text[] := ARRAY[
    'graph_nodes', 'graph_edges', 'integrations', 'integration_runs',
    'observations', 'evidence', 'evidence_subjects', 'evidence_observations',
    'claims', 'claim_evidence', 'controls', 'control_requirements',
    'organisation_frameworks', 'assessments', 'assurance_states',
    'findings', 'risks', 'risk_findings', 'exceptions',
    'actions', 'approvals', 'approval_decisions', 'action_executions',
    'verifications', 'action_transitions'
  ];
  -- Tables where organisation_id may be NULL for platform-level rows. Those
  -- rows are visible only under platform scope.
  nullable_tables text[] := ARRAY[
    'requirements', 'policies', 'outbox_events', 'event_log', 'audit_log',
    'idempotency_keys', 'scheduled_jobs', 'reports'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY strict_tables || nullable_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (adericel.tenant_visible(organisation_id)) '
      'WITH CHECK (adericel.tenant_visible(organisation_id))', t);
  END LOOP;
END;
$$;

-- The organisations table itself: a tenant-scoped transaction sees exactly one
-- row, its own.
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisations
  USING (adericel.is_platform_scope() OR id = adericel.current_organisation_id())
  WITH CHECK (adericel.is_platform_scope());

-- Frameworks are shared definitions. System frameworks are readable by every
-- tenant; organisation-owned frameworks are not.
ALTER TABLE frameworks ENABLE ROW LEVEL SECURITY;
ALTER TABLE frameworks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON frameworks
  USING (
    adericel.is_platform_scope()
    OR is_system
    OR organisation_id = adericel.current_organisation_id()
  )
  WITH CHECK (
    adericel.is_platform_scope()
    OR organisation_id = adericel.current_organisation_id()
  );

-- Rulesets are global, immutable, versioned definitions: readable by all,
-- writable only under platform scope.
ALTER TABLE rulesets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rulesets FORCE ROW LEVEL SECURITY;
CREATE POLICY ruleset_read ON rulesets FOR SELECT USING (true);
CREATE POLICY ruleset_write ON rulesets FOR INSERT WITH CHECK (adericel.is_platform_scope());
CREATE POLICY ruleset_update ON rulesets FOR UPDATE
  USING (adericel.is_platform_scope()) WITH CHECK (adericel.is_platform_scope());

-- migrate:down
DO $$
DECLARE
  all_tables text[] := ARRAY[
    'graph_nodes', 'graph_edges', 'integrations', 'integration_runs',
    'observations', 'evidence', 'evidence_subjects', 'evidence_observations',
    'claims', 'claim_evidence', 'controls', 'control_requirements',
    'organisation_frameworks', 'assessments', 'assurance_states',
    'findings', 'risks', 'risk_findings', 'exceptions',
    'actions', 'approvals', 'approval_decisions', 'action_executions',
    'verifications', 'action_transitions',
    'requirements', 'policies', 'outbox_events', 'event_log', 'audit_log',
    'idempotency_keys', 'scheduled_jobs', 'reports', 'organisations', 'frameworks'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY all_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;
DROP POLICY IF EXISTS ruleset_read ON rulesets;
DROP POLICY IF EXISTS ruleset_write ON rulesets;
DROP POLICY IF EXISTS ruleset_update ON rulesets;
ALTER TABLE rulesets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE rulesets DISABLE ROW LEVEL SECURITY;
