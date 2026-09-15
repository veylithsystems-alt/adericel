-- migrate:up
-- =============================================================================
-- 0027 — DEGRADED and BLOCKED become assurance states
--
-- Contract v3.1 §6 requires Adericel to distinguish DEGRADED and BLOCKED from
-- UNKNOWN, and states that these semantic distinctions must not be collapsed
-- for convenience.
--
-- Until now they were collapsed. A connector that had started failing produced
-- UNKNOWN with reason COLLECTION_FAILED — honest, and indistinguishable on a
-- portfolio view from a control nobody had ever assessed.
--
-- The difference matters operationally, which is the whole reason the contract
-- names it:
--
--   UNKNOWN   Adericel does not hold enough evidence.
--             The MSP connects a source, or talks to their customer.
--   DEGRADED  The mechanism that supplied the evidence has broken.
--             The MSP fixes a connector. Nobody needs to call the customer.
--   BLOCKED   Adericel is not permitted, or is waiting on somebody who is.
--             Neither a repair nor a source will help; a person must act.
--
-- The reason columns are additive and nullable. Historical rows keep their
-- UNKNOWN state and their existing reason untouched: a past assessment recorded
-- what Adericel believed at the time, and rewriting it to match a later
-- vocabulary would falsify the historical record this product exists to keep.
-- =============================================================================

ALTER TABLE assurance_states DROP CONSTRAINT IF EXISTS assurance_states_state_check;
ALTER TABLE assurance_states ADD CONSTRAINT assurance_states_state_check
  CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED',
                   'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN', 'DEGRADED', 'BLOCKED'));

ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_state_check;
ALTER TABLE assessments ADD CONSTRAINT assessments_state_check
  CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED',
                   'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN', 'DEGRADED', 'BLOCKED'));

-- Why a control is degraded: names a repair.
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS degraded_reason text
  CHECK (degraded_reason IS NULL OR degraded_reason IN
    ('COLLECTION_FAILING', 'CREDENTIAL_EXPIRED', 'CONSENT_WITHDRAWN', 'SOURCE_UNAVAILABLE',
     'PARTIAL_COLLECTION', 'SCHEMA_DRIFT', 'RATE_LIMITED'));

-- Why a control is blocked: names a person.
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS blocked_reason text
  CHECK (blocked_reason IS NULL OR blocked_reason IN
    ('AUTHORITY_MISSING', 'APPROVAL_PENDING', 'CONSENT_REQUIRED', 'DEPENDENCY_BLOCKED',
     'SAFETY_CONDITION_UNMET', 'CONTAINED'));

ALTER TABLE assurance_states ADD COLUMN IF NOT EXISTS degraded_reason text;
ALTER TABLE assurance_states ADD COLUMN IF NOT EXISTS blocked_reason text;

-- A reason may only accompany its own state. Without this a row could claim to
-- be SATISFIED while carrying a degradation reason, and whichever of the two a
-- reader trusted would be a coin toss.
ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_reason_matches_state;
ALTER TABLE assessments ADD CONSTRAINT assessments_reason_matches_state CHECK (
  (degraded_reason IS NULL OR state = 'DEGRADED') AND
  (blocked_reason  IS NULL OR state = 'BLOCKED')
);

COMMENT ON COLUMN assessments.degraded_reason IS
  'Why the evidence path is impaired. Set only when state = DEGRADED. Names a repair.';
COMMENT ON COLUMN assessments.blocked_reason IS
  'Why Adericel may not proceed. Set only when state = BLOCKED. Names a person, not a repair.';

-- migrate:down
ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_reason_matches_state;
ALTER TABLE assessments DROP COLUMN IF EXISTS degraded_reason;
ALTER TABLE assessments DROP COLUMN IF EXISTS blocked_reason;
ALTER TABLE assurance_states DROP COLUMN IF EXISTS degraded_reason;
ALTER TABLE assurance_states DROP COLUMN IF EXISTS blocked_reason;
-- Reverting the CHECK would fail while any row holds the new states, which is
-- correct: those rows are real assessments and must not be silently discarded.
ALTER TABLE assurance_states DROP CONSTRAINT IF EXISTS assurance_states_state_check;
ALTER TABLE assurance_states ADD CONSTRAINT assurance_states_state_check
  CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED',
                   'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN'));
ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_state_check;
ALTER TABLE assessments ADD CONSTRAINT assessments_state_check
  CHECK (state IN ('SATISFIED', 'PARTIALLY_SATISFIED', 'NOT_SATISFIED',
                   'EXCEPTED', 'NOT_APPLICABLE', 'UNKNOWN'));
