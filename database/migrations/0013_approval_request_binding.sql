-- migrate:up
-- =============================================================================
-- Bind an approval to what was actually approved.
--
-- Four-eyes means a person authorised THIS change. Until now the approval
-- referenced the action row and nothing else, and the action row is mutable.
-- Nothing in the current code path edits an action's parameters after
-- proposal, so this was not exploitable today — but the guarantee rested on the
-- absence of a feature rather than on a control, and "let the approver adjust
-- the parameters before approving" is an obvious and reasonable thing for
-- somebody to build next. The moment it exists, an approval becomes a signature
-- on a blank cheque, and nothing would notice.
--
-- So the request is digested at proposal, the digest is copied onto the
-- approval, and execution recomputes it from the live row and refuses to
-- dispatch unless all three agree. Altering what will be done to whom now
-- requires forging a SHA-256 preimage or rewriting three rows consistently,
-- rather than a single UPDATE.
--
-- Rows that predate this migration carry the sentinel below. They are executed
-- as before and recorded as unbound, because refusing them would strand
-- in-flight approvals across an upgrade. Everything proposed from here on is
-- bound: the column is NOT NULL and the default is dropped, so an INSERT that
-- forgets the digest fails loudly.
-- =============================================================================

ALTER TABLE actions
  ADD COLUMN request_digest text NOT NULL DEFAULT 'unbound:pre-0013';
ALTER TABLE actions ALTER COLUMN request_digest DROP DEFAULT;

ALTER TABLE approvals
  ADD COLUMN request_digest text NOT NULL DEFAULT 'unbound:pre-0013';
ALTER TABLE approvals ALTER COLUMN request_digest DROP DEFAULT;

COMMENT ON COLUMN actions.request_digest IS
  'sha256 over action type, target, integration, parameters and risk class, taken at proposal. '
  'Immutable. Execution refuses to dispatch when the live row no longer hashes to it.';
COMMENT ON COLUMN approvals.request_digest IS
  'The action request digest as it stood when approval was requested. An approval authorises this '
  'exact request and no other.';

-- migrate:down
ALTER TABLE approvals DROP COLUMN IF EXISTS request_digest;
ALTER TABLE actions DROP COLUMN IF EXISTS request_digest;
