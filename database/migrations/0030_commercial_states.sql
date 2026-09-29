-- migrate:up
-- =============================================================================
-- 0030 — The commercial position, as its own model
--
-- Contract v3.1 §16. Ten states, and one rule that matters more than the count:
-- a commercial state is not a security state. They produce similar-looking
-- outcomes — something stops working — and conflating them is expensive both
-- ways. An unpaid invoice treated as a security event contains an estate that
-- is not compromised; a compromised credential treated as a commercial event
-- leaves collection running against an integration nobody trusts.
--
-- Migration 0028 already noted the hazard: `organisations.status = 'SUSPENDED'`
-- carries both meanings today. Containment now lives on its own column, and
-- after this the commercial position does too, with a vocabulary that cannot be
-- mistaken for a security one. COMMERCIAL_SUSPENSION says which kind it is in
-- its name.
--
-- The rename is the point, not an accident of tidying:
--   SUSPENDED  -> COMMERCIAL_SUSPENSION
--   CANCELLED  -> TERMINATED
-- =============================================================================

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;

-- The unique indexes name the old value, so they are rebuilt around the rename.
DROP INDEX IF EXISTS subscriptions_msp_live;
DROP INDEX IF EXISTS subscriptions_org_live;

UPDATE subscriptions SET status = 'COMMERCIAL_SUSPENSION' WHERE status = 'SUSPENDED';
UPDATE subscriptions SET status = 'TERMINATED' WHERE status = 'CANCELLED';

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN (
  'DRAFT',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'PAYMENT_PLAN',
  'COMMERCIAL_RESTRICTION',
  'COMMERCIAL_SUSPENSION',
  'TERMINATED',
  'ARCHIVED',
  'UNKNOWN'
));

-- "Live" now means "not finished with". A terminated subscription is in its
-- retention window and an archived one is closed; neither should block a new
-- agreement with the same MSP.
CREATE UNIQUE INDEX subscriptions_msp_live ON subscriptions (msp_id)
  WHERE msp_id IS NOT NULL AND status NOT IN ('TERMINATED', 'ARCHIVED');
CREATE UNIQUE INDEX subscriptions_org_live ON subscriptions (organisation_id)
  WHERE organisation_id IS NOT NULL AND status NOT IN ('TERMINATED', 'ARCHIVED');

-- ---------------------------------------------------------------------------
-- Why the account is where it is
--
-- A commercial state change is a decision about somebody's business, and the
-- person who has to explain it six months later is rarely the person who made
-- it. Append-only, for the same reason the containment and break-glass records
-- are: a history that can be rewritten answers no question worth asking.
-- ---------------------------------------------------------------------------
CREATE TABLE commercial_transitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id     uuid NOT NULL REFERENCES subscriptions (id) ON DELETE RESTRICT,
  msp_id              uuid REFERENCES msps (id) ON DELETE SET NULL,
  organisation_id     uuid REFERENCES organisations (id) ON DELETE SET NULL,

  from_state          text NOT NULL,
  to_state            text NOT NULL,
  CONSTRAINT commercial_transition_moves CHECK (from_state <> to_state),

  -- Read while a customer is on the phone. Long enough to be a reason.
  reason              text NOT NULL CHECK (length(trim(reason)) >= 20),
  -- Required before anything that stops assurance being maintained.
  customer_notified   boolean NOT NULL DEFAULT false,

  -- 'PROVIDER' for a webhook, 'OPERATOR' for a person, 'SYSTEM' for a dunning
  -- timer. Never 'SECURITY': containment does not reach this table.
  decided_by_kind     text NOT NULL CHECK (decided_by_kind IN ('PROVIDER', 'OPERATOR', 'SYSTEM')),
  decided_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_by_label    text NOT NULL,

  occurred_at         timestamptz NOT NULL DEFAULT now(),
  correlation_id      text,

  -- An operator decision names a person. A provider or timer does not have one,
  -- and inventing a name for it would make the record a lie.
  CONSTRAINT commercial_operator_is_named CHECK (
    decided_by_kind <> 'OPERATOR' OR decided_by IS NOT NULL
  )
);

CREATE INDEX commercial_transitions_subscription_idx
  ON commercial_transitions (subscription_id, occurred_at DESC);
CREATE INDEX commercial_transitions_msp_idx
  ON commercial_transitions (msp_id, occurred_at DESC) WHERE msp_id IS NOT NULL;

CREATE OR REPLACE FUNCTION commercial_transitions_are_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial_transitions rows are never deleted';
  END IF;
  RAISE EXCEPTION 'commercial_transitions is append-only; a commercial history is not editable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commercial_transitions_append_only
  BEFORE UPDATE OR DELETE ON commercial_transitions
  FOR EACH ROW EXECUTE FUNCTION commercial_transitions_are_append_only();

ALTER TABLE commercial_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_transitions FORCE ROW LEVEL SECURITY;

-- An organisation may see why its own service changed. It is their business
-- being restricted, and "you will have to ask your MSP" is not an answer when
-- the record exists and names them.
CREATE POLICY commercial_transitions_tenant ON commercial_transitions
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

COMMENT ON TABLE commercial_transitions IS
  'Why an account is where it is commercially. Append-only. Carries no security meaning: '
  'containment (0028) is a separate concern and there is no path between them.';

-- migrate:down
DROP POLICY IF EXISTS commercial_transitions_tenant ON commercial_transitions;
DROP TRIGGER IF EXISTS commercial_transitions_append_only ON commercial_transitions;
DROP FUNCTION IF EXISTS commercial_transitions_are_append_only();
DROP TABLE IF EXISTS commercial_transitions;

DROP INDEX IF EXISTS subscriptions_msp_live;
DROP INDEX IF EXISTS subscriptions_org_live;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;

UPDATE subscriptions SET status = 'SUSPENDED' WHERE status = 'COMMERCIAL_SUSPENSION';
UPDATE subscriptions SET status = 'CANCELLED' WHERE status IN ('TERMINATED', 'ARCHIVED');
-- States with no pre-0030 equivalent fall back to the nearest honest one.
UPDATE subscriptions SET status = 'TRIAL' WHERE status = 'DRAFT';
UPDATE subscriptions SET status = 'PAST_DUE'
  WHERE status IN ('PAYMENT_PLAN', 'COMMERCIAL_RESTRICTION', 'UNKNOWN');

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'));
CREATE UNIQUE INDEX subscriptions_msp_live ON subscriptions (msp_id)
  WHERE msp_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX subscriptions_org_live ON subscriptions (organisation_id)
  WHERE organisation_id IS NOT NULL AND status <> 'CANCELLED';
