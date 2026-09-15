-- migrate:up
-- =============================================================================
-- Offboarding.
--
-- The lifecycle had a beginning and no end. `OFFBOARDING` and `CLOSED` existed
-- in the status enum, `CUSTOMER_OFFBOARDED` existed as an event type, and
-- nothing anywhere could put an organisation into either state. A customer
-- leaving was, in practice, a row that stayed ACTIVE forever.
--
-- That is a worse gap than it first appears. A system of record that cannot be
-- left is not a system of record; it is a hostage situation. And an
-- organisation nobody can close keeps its credentials sealed but present, keeps
-- its Assurance Passport answering to third parties, and keeps appearing in an
-- MSP's portfolio count.
--
-- THE THREE THINGS OFFBOARDING MUST GET RIGHT
--
-- 1. THE CUSTOMER LEAVES WITH THEIR RECORD. Their evidence, determinations and
--    history are theirs. Export happens before anything is revoked, and closure
--    is refused until an export has been taken — not because a regulator says
--    so, but because the alternative is destroying the record somebody may need
--    most, at the moment they are least able to argue about it.
--
-- 2. ADERICEL STOPS ASSERTING IMMEDIATELY. Collection stops, assessment stops,
--    and every shared passport stops answering. A passport that keeps saying
--    "satisfied" about an estate Adericel no longer observes is the same lie
--    that billing lapse (ADR-0027) exists to refuse, and offboarding is a
--    stronger case: the customer has actively left.
--
-- 3. CREDENTIALS ARE DESTROYED, NOT DISABLED. An offboarded customer's tenant
--    credentials sitting sealed in a table are a liability with no
--    corresponding benefit. Nothing will ever legitimately use them again.
--
-- WHAT IS KEPT, AND WHY
--
-- Closure does not delete. Determinations stand as statements about the
-- instants they were made; the audit trail and the event log are what an
-- investigation, an insurance claim or a dispute would need, and destroying
-- them to tidy up would be the second-worst thing this schema could do. Erasure
-- is a separate, explicit, later act with its own record — see
-- `erasure_requested_at`.
-- =============================================================================

ALTER TABLE organisations
  -- When offboarding began, so "how long has this been in progress" is
  -- answerable without reading the event log.
  ADD COLUMN IF NOT EXISTS offboarding_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS offboarding_reason text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  -- The hash of the export the customer received. Recorded so that, years
  -- later, a bundle somebody produces can be checked against what Adericel
  -- actually handed over.
  ADD COLUMN IF NOT EXISTS final_export_hash text,
  ADD COLUMN IF NOT EXISTS final_export_at timestamptz,
  -- Set when erasure is requested. Deliberately separate from closure: leaving
  -- and being erased are different decisions, and conflating them would destroy
  -- records on a customer who only meant to stop paying.
  ADD COLUMN IF NOT EXISTS erasure_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS erasure_completed_at timestamptz;

-- A closed organisation must have been exported first. The database refuses the
-- ordering rather than trusting the service to observe it, because this is the
-- constraint most likely to be skipped under pressure — a customer leaving
-- angrily on a Friday afternoon.
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_closure_exported;
ALTER TABLE organisations ADD CONSTRAINT organisations_closure_exported CHECK (
  status <> 'CLOSED' OR (final_export_hash IS NOT NULL AND closed_at IS NOT NULL)
);

ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_offboarding_reasoned;
ALTER TABLE organisations ADD CONSTRAINT organisations_offboarding_reasoned CHECK (
  status NOT IN ('OFFBOARDING', 'CLOSED')
  OR (offboarding_started_at IS NOT NULL AND offboarding_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS organisations_offboarding_idx
  ON organisations (offboarding_started_at)
  WHERE status = 'OFFBOARDING';

-- ---------------------------------------------------------------------------
-- The offboarding ledger.
-- ---------------------------------------------------------------------------
--
-- The mirror of onboarding_tasks, and for the same reason: a checklist held in
-- somebody's head is one that gets half done. Recomputed from real state rather
-- than ticked off, so a step cannot be marked complete because a person
-- believed it was.
CREATE TABLE offboarding_tasks (
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  key              text NOT NULL,
  title            text NOT NULL,
  description      text NOT NULL,
  state            text NOT NULL DEFAULT 'PENDING'
                     CHECK (state IN ('PENDING', 'BLOCKED', 'COMPLETED', 'SKIPPED')),
  -- Whether closure may proceed without it. False for the courtesy steps;
  -- true for export, credential destruction and passport revocation.
  required         boolean NOT NULL DEFAULT true,
  position         integer NOT NULL,
  completed_at     timestamptz,
  detail           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, key)
);
CREATE INDEX offboarding_tasks_open_idx
  ON offboarding_tasks (organisation_id, position)
  WHERE state IN ('PENDING', 'BLOCKED');

ALTER TABLE offboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE offboarding_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offboarding_tasks
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

-- ---------------------------------------------------------------------------
-- Passport revocation.
-- ---------------------------------------------------------------------------
--
-- A share that keeps resolving after the customer has left tells an insurer
-- that an estate Adericel stopped observing is still satisfied. The share is
-- revoked rather than deleted, so a third party who holds the link is told what
-- happened instead of receiving a 404 they will read as a technical fault.
ALTER TABLE passport_shares
  ADD COLUMN IF NOT EXISTS revoked_reason text;

-- migrate:down
ALTER TABLE passport_shares DROP COLUMN IF EXISTS revoked_reason;
DROP POLICY IF EXISTS tenant_isolation ON offboarding_tasks;
DROP TABLE IF EXISTS offboarding_tasks;
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_closure_exported;
ALTER TABLE organisations DROP CONSTRAINT IF EXISTS organisations_offboarding_reasoned;
ALTER TABLE organisations
  DROP COLUMN IF EXISTS offboarding_started_at,
  DROP COLUMN IF EXISTS offboarding_reason,
  DROP COLUMN IF EXISTS closed_at,
  DROP COLUMN IF EXISTS final_export_hash,
  DROP COLUMN IF EXISTS final_export_at,
  DROP COLUMN IF EXISTS erasure_requested_at,
  DROP COLUMN IF EXISTS erasure_completed_at;
