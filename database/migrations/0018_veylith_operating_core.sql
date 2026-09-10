-- migrate:up
-- =============================================================================
-- The Veylith Autonomous Operations Layer: operating core.
--
-- Adericel is the product. This is the machinery of the company that sells it.
--
-- The order of this migration is deliberate and is the argument for the whole
-- design: the authority boundary and the escalation path are created BEFORE any
-- automation that could need them. Building a workflow first and adding its
-- limits afterwards is how an autonomous system ends up doing something nobody
-- authorised, and then having nowhere to put the fact that it did.
--
-- WHY A SEPARATE SCHEMA
--
-- Every table in `adericel` carries organisation_id and forced row level
-- security. That is right for customer data and wrong for the company's own
-- operating state. A prospect that is not yet a customer has no organisation;
-- an internal exception belongs to Veylith, not to a tenant. Given a nullable
-- organisation_id, the tenant predicate would evaluate permissively for exactly
-- those rows, and internal commercial data would become reachable from a tenant
-- connection.
--
-- So: a separate schema, every table platform-scope only. A tenant-scoped
-- transaction sees zero rows here, and a test asserts it.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS veylith;

-- ---------------------------------------------------------------------------
-- The company's processes, and how autonomous each one actually is.
-- ---------------------------------------------------------------------------
--
-- The maturity model is data, not documentation. A process whose current level
-- is recorded here can be measured against its target; one described only in a
-- document drifts from reality the week after it is written.
CREATE TABLE veylith.company_processes (
  key                 text PRIMARY KEY
                        CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  domain              text NOT NULL
                        CHECK (domain IN ('MARKET', 'MARKETING', 'SALES', 'ONBOARDING',
                                          'CUSTOMER_OPS', 'SUPPORT', 'BILLING', 'FINANCE',
                                          'LEGAL', 'SECURITY', 'ENGINEERING', 'PRODUCT',
                                          'KNOWLEDGE', 'STRATEGY')),
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  -- L0 manual … L5 optimising. Measured from what the system actually does, not
  -- aspired to: a process claiming L3 while every execution raises an exception
  -- is at L1 and the metrics will say so.
  current_maturity    smallint NOT NULL DEFAULT 0 CHECK (current_maturity BETWEEN 0 AND 5),
  target_maturity     smallint NOT NULL DEFAULT 0 CHECK (target_maturity BETWEEN 0 AND 5),
  -- What a human must always decide here, in plain words. Never empty for a
  -- process with a target above L2: an automation with no stated human boundary
  -- has not been thought about.
  human_boundary      text NOT NULL DEFAULT '',
  risk                text NOT NULL DEFAULT 'MEDIUM'
                        CHECK (risk IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  -- False for processes that must not be automated at all — strategy, legal
  -- judgement, banking authority. Recorded so the backlog cannot quietly grow
  -- to include them.
  automation_candidate boolean NOT NULL DEFAULT true,
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_processes_boundary_stated CHECK (
    target_maturity <= 2 OR length(human_boundary) > 0
  )
);
CREATE INDEX company_processes_domain_idx ON veylith.company_processes (domain, key);

-- ---------------------------------------------------------------------------
-- Autonomy policy: what the company is permitted to do without a human.
-- ---------------------------------------------------------------------------
--
-- Rules are data so that changing what automation may do is a reviewable
-- configuration change rather than a deployment, and so a decision can be
-- replayed against the exact policy that produced it.
CREATE TABLE veylith.autonomy_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL,
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Content hash over the canonical rule set. A decision records this, so
  -- "under what rules was this permitted?" is answerable years later even if
  -- the policy has since been rewritten.
  policy_hash       text NOT NULL CHECK (policy_hash LIKE 'sha256:%'),
  definition        jsonb NOT NULL,
  active            boolean NOT NULL DEFAULT false,
  created_by_actor  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz
);
CREATE UNIQUE INDEX autonomy_policies_version_unique ON veylith.autonomy_policies (key, version);
-- Exactly one active version per policy key. Two active versions would mean the
-- answer to "may we do this?" depends on which row a query happened to read.
CREATE UNIQUE INDEX autonomy_policies_active_unique
  ON veylith.autonomy_policies (key) WHERE active;

-- Every decision, permitted or not.
--
-- Refusals are the more valuable half of this table. A system that records only
-- what it did cannot answer "what did it decline to do, and why", which is the
-- question an auditor and an operator both ask first.
CREATE TABLE veylith.policy_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deliberately NOT a foreign key.
  --
  -- The decision most worth recording is the one refusing to act on a process
  -- nobody registered — and a foreign key would make recording it impossible,
  -- so the system would throw instead of refusing, and the refusal would leave
  -- no trace. The registry is a description of what the company does, not a
  -- constraint on what it may be asked to do.
  process_key       text NOT NULL,
  operation         text NOT NULL,
  outcome           text NOT NULL
                      CHECK (outcome IN ('PERMIT', 'REQUIRE_APPROVAL', 'ESCALATE',
                                         'DENY', 'UNKNOWN')),
  reason            text NOT NULL,
  matched_rule_id   text,
  policy_key        text NOT NULL,
  policy_hash       text NOT NULL,
  -- The full question as asked, so the decision is reproducible. Without it a
  -- recorded outcome is an assertion rather than evidence.
  question          jsonb NOT NULL,
  -- Every check that ran and how it fell out.
  evaluation        jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject_kind      text,
  subject_id        text,
  correlation_id    uuid,
  decided_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decisions_process_idx
  ON veylith.policy_decisions (process_key, decided_at DESC);
CREATE INDEX policy_decisions_outcome_idx
  ON veylith.policy_decisions (outcome, decided_at DESC) WHERE outcome <> 'PERMIT';
CREATE INDEX policy_decisions_correlation_idx
  ON veylith.policy_decisions (correlation_id) WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The canonical business event ledger.
-- ---------------------------------------------------------------------------
--
-- Adericel's event log is assurance vocabulary about a tenant's estate. This is
-- commercial and operational vocabulary about the company. Mixing them would
-- put pipeline data into a customer's event stream.
CREATE TABLE veylith.business_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence          bigserial NOT NULL,
  event_type        text NOT NULL,
  process_key       text,
  subject_kind      text NOT NULL,
  subject_id        text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- WHO acted, and under what authority.
  --
  -- actor_kind is the field that makes autonomy measurable. Without it, "what
  -- proportion of our operations happen without a human?" is a guess.
  actor_kind        text NOT NULL CHECK (actor_kind IN ('SYSTEM', 'HUMAN', 'AI', 'EXTERNAL')),
  actor             text NOT NULL,
  -- True when a person made or confirmed the decision. An AI actor with
  -- human_in_loop true is a human decision the AI drafted; an AI actor with it
  -- false is an autonomous one. The distinction is the whole autonomy metric.
  human_in_loop     boolean NOT NULL,
  policy_decision_id uuid REFERENCES veylith.policy_decisions (id) ON DELETE SET NULL,
  authority         text NOT NULL DEFAULT '',
  reason            text NOT NULL DEFAULT '',

  correlation_id    uuid,
  -- Set for events that represent an effect on the world. A redelivered webhook
  -- or a retried job must not produce a second effect.
  idempotency_key   text,
  result            text NOT NULL DEFAULT 'RECORDED'
                      CHECK (result IN ('RECORDED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME')),
  -- Whether the effect was confirmed by re-observation. UNVERIFIED is the
  -- honest default: an operation that returned 200 has not been verified.
  verification      text NOT NULL DEFAULT 'NOT_REQUIRED'
                      CHECK (verification IN ('NOT_REQUIRED', 'PENDING', 'CONFIRMED',
                                              'REFUTED', 'INCONCLUSIVE')),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX business_events_idempotency_unique
  ON veylith.business_events (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX business_events_type_idx ON veylith.business_events (event_type, occurred_at DESC);
CREATE INDEX business_events_subject_idx ON veylith.business_events (subject_kind, subject_id, occurred_at DESC);
CREATE INDEX business_events_process_idx ON veylith.business_events (process_key, occurred_at DESC);
CREATE INDEX business_events_sequence_idx ON veylith.business_events (sequence);
-- Powers the automation-ratio metric without scanning the whole ledger.
CREATE INDEX business_events_autonomy_idx
  ON veylith.business_events (occurred_at DESC, actor_kind, human_in_loop);

-- ---------------------------------------------------------------------------
-- The exception queue.
-- ---------------------------------------------------------------------------
--
-- The most important table here. The company's steady state is that humans deal
-- with exceptions rather than workflows, and that is only possible if an
-- automation which cannot proceed has somewhere safe to stop.
--
-- Distinct from adericel.exceptions, which is a control deliberately waived on a
-- customer estate. Same word, unrelated concept.
CREATE TABLE veylith.operational_exceptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Not a foreign key, for the same reason as policy_decisions: an exception
  -- about an unregistered process is exactly the one that must be raisable.
  process_key         text NOT NULL,
  category            text NOT NULL
                        CHECK (category IN ('AUTHORITY_REQUIRED', 'POLICY_DENIED',
                                            'AMBIGUOUS', 'AUTOMATION_FAILED',
                                            'EXTERNAL_DEPENDENCY', 'DATA_MISSING',
                                            'CONFLICT', 'SECURITY', 'FINANCIAL',
                                            'LEGAL', 'CUSTOMER_IMPACT')),
  severity            text NOT NULL DEFAULT 'MEDIUM'
                        CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  title               text NOT NULL,
  -- What the automation tried, and why it stopped. Both required: an exception
  -- that does not say what was attempted forces a human to re-derive it.
  attempted           text NOT NULL,
  failure_reason      text NOT NULL,
  -- What the system believes should happen next. A recommendation, never an
  -- instruction: the human decides.
  recommended_action  text NOT NULL DEFAULT '',
  -- The authority a person needs to resolve this. Naming it means the exception
  -- can be routed rather than read by everyone.
  required_authority  text NOT NULL DEFAULT '',
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optional links out. An exception about a customer names them; one about the
  -- pipeline does not.
  organisation_id     uuid REFERENCES adericel.organisations (id) ON DELETE SET NULL,
  subject_kind        text,
  subject_id          text,
  correlation_id      uuid,

  status              text NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS',
                                          'RESOLVED_AUTOMATICALLY', 'RESOLVED_BY_HUMAN',
                                          'ESCALATED', 'WONT_FIX')),
  owner               text,
  -- When a human must have looked at this. Derived from severity on creation.
  due_at              timestamptz NOT NULL,
  escalation_path     text NOT NULL DEFAULT '',
  escalated_at        timestamptz,

  resolution          text,
  -- Whether the resolution was confirmed to have worked. A resolved exception
  -- that was never verified is a claim, not a fact.
  verification        text NOT NULL DEFAULT 'NOT_REQUIRED'
                        CHECK (verification IN ('NOT_REQUIRED', 'PENDING', 'CONFIRMED',
                                                'REFUTED', 'INCONCLUSIVE')),
  resolved_at         timestamptz,
  resolved_by         text,

  -- Recurrence, not duplication. The same condition arising ten times is one
  -- exception seen ten times, and the count is itself the signal that a process
  -- needs automating.
  occurrences         integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  -- Stable identity of the condition, so a repeat is recognised as one.
  dedupe_key          text NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT operational_exceptions_resolution_complete CHECK (
    status NOT IN ('RESOLVED_AUTOMATICALLY', 'RESOLVED_BY_HUMAN', 'WONT_FIX')
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL)
  )
);
-- One open exception per condition.
CREATE UNIQUE INDEX operational_exceptions_open_unique
  ON veylith.operational_exceptions (dedupe_key)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED');
CREATE INDEX operational_exceptions_queue_idx
  ON veylith.operational_exceptions (status, severity, due_at)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED');
CREATE INDEX operational_exceptions_process_idx
  ON veylith.operational_exceptions (process_key, created_at DESC);
CREATE INDEX operational_exceptions_org_idx
  ON veylith.operational_exceptions (organisation_id, created_at DESC)
  WHERE organisation_id IS NOT NULL;
-- Overdue work, which is the queue a person actually opens.
CREATE INDEX operational_exceptions_overdue_idx
  ON veylith.operational_exceptions (due_at)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS');

-- Every state change, so the handling of an exception is itself auditable.
CREATE TABLE veylith.exception_transitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordering is by sequence, never by timestamp. Several transitions can share
  -- an instant — an automation acknowledging and resolving in one pass, or any
  -- caller using an injected clock — and a trail that comes back in the wrong
  -- order is worse than no trail, because it reads as authoritative.
  sequence        bigserial NOT NULL,
  exception_id    uuid NOT NULL REFERENCES veylith.operational_exceptions (id) ON DELETE CASCADE,
  from_status     text,
  to_status       text NOT NULL,
  actor_kind      text NOT NULL CHECK (actor_kind IN ('SYSTEM', 'HUMAN', 'AI', 'EXTERNAL')),
  actor           text NOT NULL,
  note            text NOT NULL DEFAULT '',
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exception_transitions_exception_idx
  ON veylith.exception_transitions (exception_id, sequence);

-- ---------------------------------------------------------------------------
-- Platform scope only.
-- ---------------------------------------------------------------------------
--
-- Reusing the mechanism the tenant tables already rely on: the policy grants
-- access through the scope GUC, not because the role is privileged. A bug in
-- scope handling therefore still meets a policy rather than a superuser.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_processes', 'autonomy_policies', 'policy_decisions',
    'business_events', 'operational_exceptions', 'exception_transitions'
  ] LOOP
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
    EXECUTE 'GRANT USAGE ON SCHEMA veylith TO adericel_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA veylith TO adericel_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA veylith TO adericel_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA veylith
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adericel_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA veylith
             GRANT USAGE, SELECT ON SEQUENCES TO adericel_app';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- The initial process registry.
-- ---------------------------------------------------------------------------
--
-- Current maturity is 0 for every process because nothing is automated yet.
-- Seeding optimistic values would make the first autonomy report a fiction, and
-- the point of measuring is to find out.
INSERT INTO veylith.company_processes
  (key, domain, title, current_maturity, target_maturity, human_boundary, risk, automation_candidate)
VALUES
  ('market.prospect_discovery', 'MARKET', 'Identify candidate MSPs', 0, 4,
   'Strategic positioning and which markets to enter', 'MEDIUM', true),
  ('sales.qualification', 'SALES', 'Score and qualify a prospect', 0, 4,
   'Strategic accounts and any exception to the qualification model', 'MEDIUM', true),
  ('sales.outreach', 'SALES', 'Contact a qualified prospect', 0, 3,
   'Anything reputationally sensitive, and all first contact wording', 'MEDIUM', true),
  ('sales.proposal', 'SALES', 'Generate a proposal', 0, 3,
   'Pricing outside the published model, and every commercial commitment', 'HIGH', true),
  ('legal.contract', 'LEGAL', 'Issue and track a contract', 0, 2,
   'Acceptance of any non-standard liability; all legal judgement', 'CRITICAL', false),
  ('onboarding.tenant', 'ONBOARDING', 'Create and prepare a customer tenant', 0, 5,
   'Exceptions only', 'MEDIUM', true),
  ('onboarding.integrations', 'ONBOARDING', 'Connect a customer''s systems', 0, 4,
   'Consent to access a customer environment', 'HIGH', true),
  ('customer_ops.health', 'CUSTOMER_OPS', 'Monitor customer operational health', 0, 5,
   'Exceptions only', 'MEDIUM', true),
  ('customer_ops.reporting', 'CUSTOMER_OPS', 'Produce customer-facing reports', 0, 4,
   'Any report making a claim the evidence does not support', 'MEDIUM', true),
  ('support.triage', 'SUPPORT', 'Classify and route an incoming issue', 0, 5,
   'Exceptions only', 'MEDIUM', true),
  ('support.resolution', 'SUPPORT', 'Resolve a support issue', 0, 4,
   'Anything touching a customer environment beyond read access', 'HIGH', true),
  ('billing.subscription', 'BILLING', 'Create and maintain a subscription', 0, 4,
   'Material disputes, refunds and credit decisions', 'HIGH', true),
  ('billing.dunning', 'BILLING', 'Handle a failed payment', 0, 4,
   'Suspension of a paying customer, and any write-off', 'HIGH', true),
  ('finance.payments', 'FINANCE', 'Move money', 0, 0,
   'All of it. No autonomous system holds banking authority.', 'CRITICAL', false),
  ('security.monitoring', 'SECURITY', 'Monitor Veylith''s own security posture', 0, 4,
   'Any critical security event, and every control exception', 'CRITICAL', true),
  ('security.response', 'SECURITY', 'Respond to a security event', 0, 3,
   'Containment decisions and anything with customer impact', 'CRITICAL', true),
  ('engineering.ci', 'ENGINEERING', 'Monitor builds and tests', 0, 5,
   'Exceptions only', 'LOW', true),
  ('engineering.dependencies', 'ENGINEERING', 'Keep dependencies current', 0, 4,
   'Major version upgrades and anything touching the authority path', 'MEDIUM', true),
  ('engineering.deployment', 'ENGINEERING', 'Deploy a change to production', 0, 2,
   'All production deployment authority', 'CRITICAL', true),
  ('product.feedback', 'PRODUCT', 'Turn operational signal into product work', 0, 4,
   'Product strategy and prioritisation', 'LOW', true),
  ('strategy.direction', 'STRATEGY', 'Decide what the company does', 0, 1,
   'All of it.', 'CRITICAL', false);

-- migrate:down
DROP SCHEMA IF EXISTS veylith CASCADE;
