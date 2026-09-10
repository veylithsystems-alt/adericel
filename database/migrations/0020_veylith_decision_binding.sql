-- migrate:up
-- =============================================================================
-- Bind a policy decision to the operation it authorised.
--
-- The decision record named the process, the operation and the subject, and
-- nothing else. So a decision permitting
--
--   send template A to prospect P
--
-- was indistinguishable in the record from one permitting
--
--   send template B to prospect P
--
-- and an audit asking "what exactly was this decision for?" could not be
-- answered from the record — only from the code that happened to run next.
--
-- Adericel solved the same problem for customer-facing actions in ADR-0024 by
-- hashing the request an approval authorises, so an approval cannot be
-- transplanted onto a different request. This is that pattern applied to the
-- company's own operations.
--
-- The digest covers the operation's full identity including its payload. Two
-- decisions that look alike in every column are now distinguishable, and an
-- event can be checked against the decision that permitted it.
-- =============================================================================

ALTER TABLE veylith.policy_decisions
  ADD COLUMN IF NOT EXISTS operation_digest text NOT NULL DEFAULT 'unbound:pre-0020';

ALTER TABLE veylith.business_events
  ADD COLUMN IF NOT EXISTS operation_digest text NOT NULL DEFAULT 'unbound:pre-0020';

-- Answers "show me every decision for this exact operation", which is the
-- question an investigation actually asks.
CREATE INDEX IF NOT EXISTS policy_decisions_digest_idx
  ON veylith.policy_decisions (operation_digest, decided_at DESC);
CREATE INDEX IF NOT EXISTS business_events_digest_idx
  ON veylith.business_events (operation_digest)
  WHERE operation_digest <> 'unbound:pre-0020';

-- migrate:down
DROP INDEX IF EXISTS veylith.business_events_digest_idx;
DROP INDEX IF EXISTS veylith.policy_decisions_digest_idx;
ALTER TABLE veylith.business_events DROP COLUMN IF EXISTS operation_digest;
ALTER TABLE veylith.policy_decisions DROP COLUMN IF EXISTS operation_digest;
