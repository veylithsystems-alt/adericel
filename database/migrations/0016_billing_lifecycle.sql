-- migrate:up
-- =============================================================================
-- Billing lifecycle.
--
-- Two things happen here. One is ordinary plumbing: a ledger of provider events
-- so a webhook delivered three times has effect once. The other is a product
-- decision, and it is the more important of the two.
--
-- WHAT ADERICEL DOES WHEN THE MONEY STOPS
--
-- An organisation's subscription lapses. Its assessments were still running,
-- its assurance state still read as current, and — worst — an Assurance
-- Passport shared with an insurer went on saying "satisfied" about an estate
-- Adericel had stopped observing.
--
-- That is the exact failure this company exists to refuse. A passport's whole
-- value to a third party is that it is CURRENTLY MAINTAINED; one that keeps
-- asserting currency after collection has stopped is manufacturing certainty,
-- which §8 forbids in the product and cannot be excused in the billing system.
--
-- The opposite error is just as bad. Deleting a customer's evidence because
-- their card expired destroys the record they may need most — for an audit, an
-- insurance claim, or a dispute — and a company that does that is not a system
-- of record.
--
-- So: when billing lapses Adericel STOPS ASSERTING CURRENCY and KEEPS THE
-- RECORD. Collection and assessment stop. Nothing is deleted. Existing
-- determinations stand as statements about the instants they were made. Anyone
-- holding a shared passport is told the record is no longer being maintained,
-- because that is the fact that changes what they should do with it.
--
-- A grace period comes first, because a failed payment is usually an expired
-- card and suspending an estate over one is a disproportionate response to the
-- most common billing event there is.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Provider events, processed exactly once.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_events (
  -- The provider's own event id. Primary key, so a redelivery is a conflict
  -- rather than a second effect.
  id                 text PRIMARY KEY,
  provider           text NOT NULL,
  event_type         text NOT NULL,
  raw_type           text NOT NULL,
  subscription_id    uuid REFERENCES subscriptions (id) ON DELETE SET NULL,
  msp_id             uuid REFERENCES msps (id) ON DELETE SET NULL,
  organisation_id    uuid REFERENCES organisations (id) ON DELETE SET NULL,
  -- When the PROVIDER says it happened, not when we received it. Webhooks
  -- arrive out of order — a cancellation queued behind a renewal is ordinary —
  -- and applying the older one last would resurrect a cancelled subscription.
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  applied            boolean NOT NULL DEFAULT false,
  -- Why an event changed nothing: ignored type, superseded by a newer event,
  -- or no subscription matched. An unexplained no-op is indistinguishable from
  -- a bug.
  outcome            text NOT NULL,
  correlation_id     uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_events_subscription_idx
  ON billing_events (subscription_id, occurred_at DESC);
CREATE INDEX billing_events_received_idx ON billing_events (received_at DESC);

-- The nullable pattern from migration 0006. An MSP-level event carries no
-- organisation_id and is visible only under platform scope, which is where
-- webhook processing runs; an organisation-level one belongs to that tenant.
-- Adding it without a policy is caught by the structural tenancy test and then
-- by the start-up guard, which is how it should be.
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_events
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- ---------------------------------------------------------------------------
-- Subscription lifecycle state.
-- ---------------------------------------------------------------------------
ALTER TABLE subscriptions
  -- The provider's own reference for the subscription.
  --
  -- Its absence made every event that did not carry Adericel's metadata
  -- permanently unmatchable: the translated event supplies this reference, and
  -- there was no column to match it against. Events created before checkout
  -- metadata is set — and any event from a subscription created directly in the
  -- provider's dashboard — fall into exactly that case.
  ADD COLUMN external_subscription_ref text,
  -- The provider event that last moved this subscription. Comparing an
  -- incoming event's timestamp against this is what makes ordering safe: an
  -- event older than the last applied one is recorded and discarded.
  ADD COLUMN last_event_at timestamptz,
  ADD COLUMN last_event_id text,
  -- When a failed payment stops being a grace period and starts being a lapse.
  ADD COLUMN grace_ends_at timestamptz,
  -- Set when collection and assessment stopped. Null means still maintained.
  ADD COLUMN lapsed_at timestamptz,
  ADD COLUMN lapse_reason text;

-- One Adericel subscription per provider subscription. Two rows claiming the
-- same external reference would make event matching ambiguous, and the wrong
-- one would be chosen silently.
CREATE UNIQUE INDEX subscriptions_external_ref
  ON subscriptions (external_subscription_ref) WHERE external_subscription_ref IS NOT NULL;

COMMENT ON COLUMN subscriptions.lapsed_at IS
  'When Adericel stopped maintaining this subscriber''s assurance record. '
  'Nothing is deleted; determinations already made stand as statements about '
  'their instants, and shared passports report that the record is no longer '
  'maintained.';

-- ---------------------------------------------------------------------------
-- Whether an organisation''s assurance record is being maintained.
--
-- Denormalised onto the organisation because it is read on the hot path — the
-- assurance view, every passport, every scheduled collection — and resolving it
-- through the MSP''s subscription on each read is a join the busiest queries do
-- not need.
--
-- Maintained by the billing service and by the reconciliation job, never set by
-- hand. `assurance_maintained` false means Adericel has STOPPED OBSERVING; it
-- does not mean the organisation is failing, and nothing in the product may
-- present it as such.
-- ---------------------------------------------------------------------------
ALTER TABLE organisations
  ADD COLUMN assurance_maintained boolean NOT NULL DEFAULT true,
  ADD COLUMN maintenance_stopped_at timestamptz,
  ADD COLUMN maintenance_stopped_reason text;

CREATE INDEX organisations_unmaintained_idx
  ON organisations (msp_id) WHERE NOT assurance_maintained;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adericel_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON adericel.billing_events TO adericel_app';
  END IF;
END;
$$;

-- migrate:down
DROP POLICY IF EXISTS tenant_isolation ON billing_events;
DROP TABLE IF EXISTS billing_events;
ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS last_event_at,
  DROP COLUMN IF EXISTS last_event_id,
  DROP COLUMN IF EXISTS grace_ends_at,
  DROP COLUMN IF EXISTS lapsed_at,
  DROP COLUMN IF EXISTS lapse_reason,
  DROP COLUMN IF EXISTS external_subscription_ref;
ALTER TABLE organisations
  DROP COLUMN IF EXISTS assurance_maintained,
  DROP COLUMN IF EXISTS maintenance_stopped_at,
  DROP COLUMN IF EXISTS maintenance_stopped_reason;
