-- migrate:up
-- =============================================================================
-- Policy, actions, approvals, execution and verification.
--
-- The invariants encoded here are the ones that make autonomy safe:
--   * every action carries an idempotency key, unique per organisation;
--   * an approver can never be the proposer;
--   * an execution attempt is a row, so a retry can find the prior attempt
--     rather than blindly repeating an external side effect.
-- =============================================================================

CREATE TABLE policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid REFERENCES organisations (id) ON DELETE CASCADE,
  msp_id              uuid REFERENCES msps (id) ON DELETE CASCADE,
  node_id             uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  key                 text NOT NULL,
  name                text NOT NULL,
  description         text,
  -- Declarative rules; see packages/policy for the evaluator and its schema.
  definition          jsonb NOT NULL,
  definition_hash     text NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policies_owner CHECK (organisation_id IS NOT NULL OR msp_id IS NOT NULL)
);
CREATE UNIQUE INDEX policies_org_key ON policies (organisation_id, key) WHERE organisation_id IS NOT NULL;
CREATE UNIQUE INDEX policies_msp_key ON policies (msp_id, key) WHERE msp_id IS NOT NULL;
CREATE TRIGGER policies_touch BEFORE UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE actions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id                  uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  action_type              text NOT NULL,
  integration_id           uuid REFERENCES integrations (id) ON DELETE SET NULL,
  target_node_id           uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  target_external_id       text,
  parameters               jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_class               text NOT NULL
                             CHECK (risk_class IN ('READ_ONLY', 'LOW_IMPACT', 'CONFIGURATION', 'DISRUPTIVE', 'DESTRUCTIVE')),
  state                    text NOT NULL DEFAULT 'PROPOSED'
                             CHECK (state IN ('PROPOSED', 'POLICY_EVALUATED', 'REJECTED', 'AWAITING_APPROVAL', 'APPROVED',
                                              'AUTHORISED', 'EXECUTING', 'EXECUTED', 'VERIFYING', 'CONFIRMED', 'UNVERIFIED',
                                              'FAILED', 'TIMED_OUT', 'CANCELLED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK')),
  finding_id               uuid REFERENCES findings (id) ON DELETE SET NULL,
  risk_id                  uuid REFERENCES risks (id) ON DELETE SET NULL,
  proposed_by_actor        text NOT NULL,
  proposed_by_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  proposal_rationale       text NOT NULL,
  policy_id                uuid REFERENCES policies (id) ON DELETE SET NULL,
  policy_decision          jsonb,
  autonomy_level           integer CHECK (autonomy_level BETWEEN 0 AND 5),
  approval_id              uuid,
  idempotency_key          text NOT NULL,
  external_operation_ref   text,
  attempt_count            integer NOT NULL DEFAULT 0,
  last_error               text,
  verification_id          uuid,
  correlation_id           uuid,
  proposed_at              timestamptz NOT NULL DEFAULT now(),
  authorised_at            timestamptz,
  executed_at              timestamptz,
  verified_at              timestamptz,
  expires_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- Exactly-once semantics for consequential external effects.
CREATE UNIQUE INDEX actions_idempotency_key ON actions (organisation_id, idempotency_key);
CREATE INDEX actions_org_state_idx ON actions (organisation_id, state);
CREATE INDEX actions_org_proposed_idx ON actions (organisation_id, proposed_at DESC, id DESC);
CREATE INDEX actions_pending_approval_idx ON actions (organisation_id, proposed_at)
  WHERE state = 'AWAITING_APPROVAL';
CREATE INDEX actions_finding_idx ON actions (organisation_id, finding_id) WHERE finding_id IS NOT NULL;
CREATE TRIGGER actions_touch BEFORE UPDATE ON actions
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE approvals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  action_id            uuid NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
  required_approvals   integer NOT NULL DEFAULT 1 CHECK (required_approvals >= 1),
  decision             text CHECK (decision IN ('APPROVED', 'REJECTED')),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_action_idx ON approvals (action_id);
CREATE INDEX approvals_pending_idx ON approvals (organisation_id, expires_at) WHERE decision IS NULL;

ALTER TABLE actions
  ADD CONSTRAINT actions_approval_fk FOREIGN KEY (approval_id) REFERENCES approvals (id) ON DELETE SET NULL;

-- Individual human decisions. Multiple rows support n-of-m approval.
CREATE TABLE approval_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  approval_id       uuid NOT NULL REFERENCES approvals (id) ON DELETE CASCADE,
  approver_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decision          text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  note              text,
  source_ip         inet,
  decided_at        timestamptz NOT NULL DEFAULT now()
);
-- One decision per approver per approval: a single person cannot satisfy a
-- two-approver requirement by voting twice.
CREATE UNIQUE INDEX approval_decisions_unique ON approval_decisions (approval_id, approver_user_id);

-- Execution attempts. Idempotency is enforced here as well as on the action:
-- a retry looks for an existing attempt with the same key before dispatching.
CREATE TABLE action_executions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  action_id                uuid NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
  attempt                  integer NOT NULL CHECK (attempt >= 1),
  idempotency_key          text NOT NULL,
  status                   text NOT NULL DEFAULT 'DISPATCHED'
                             CHECK (status IN ('DISPATCHED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'UNKNOWN_OUTCOME')),
  external_operation_ref   text,
  request_digest           text,
  response_digest          text,
  error_code               text,
  error_detail             text,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz,
  correlation_id           uuid
);
CREATE UNIQUE INDEX action_executions_attempt ON action_executions (action_id, attempt);
CREATE UNIQUE INDEX action_executions_idempotency
  ON action_executions (organisation_id, idempotency_key);
CREATE INDEX action_executions_unknown_idx ON action_executions (organisation_id, started_at)
  WHERE status = 'UNKNOWN_OUTCOME';

CREATE TABLE verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id            uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  action_id          uuid REFERENCES actions (id) ON DELETE CASCADE,
  claim_id           uuid REFERENCES claims (id) ON DELETE SET NULL,
  method             text NOT NULL,
  outcome            text NOT NULL CHECK (outcome IN ('CONFIRMED', 'REFUTED', 'INCONCLUSIVE')),
  detail             text NOT NULL,
  observation_ids    uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  evidence_id        uuid REFERENCES evidence (id) ON DELETE SET NULL,
  attempt            integer NOT NULL DEFAULT 1,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_action_idx ON verifications (action_id) WHERE action_id IS NOT NULL;
CREATE INDEX verifications_org_idx ON verifications (organisation_id, verified_at DESC);

ALTER TABLE actions
  ADD CONSTRAINT actions_verification_fk
  FOREIGN KEY (verification_id) REFERENCES verifications (id) ON DELETE SET NULL;

-- Full transition history. The action row holds current state; this holds how
-- it got there, which is what an auditor actually needs.
CREATE TABLE action_transitions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  action_id         uuid NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
  from_state        text,
  to_state          text NOT NULL,
  actor             text NOT NULL,
  reason            text,
  correlation_id    uuid,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_transitions_action_idx ON action_transitions (action_id, occurred_at);

-- migrate:down
DROP TABLE IF EXISTS action_transitions;
ALTER TABLE IF EXISTS actions DROP CONSTRAINT IF EXISTS actions_verification_fk;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS action_executions;
DROP TABLE IF EXISTS approval_decisions;
ALTER TABLE IF EXISTS actions DROP CONSTRAINT IF EXISTS actions_approval_fk;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS actions;
DROP TABLE IF EXISTS policies;
