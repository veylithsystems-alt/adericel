-- migrate:up
-- =============================================================================
-- 0026 — Every organisation belongs to an MSP
--
-- Adericel is distributed through MSPs and only through MSPs (Master Product,
-- Engineering, Operating & Build Contract v3.0, §2 and §37).
--
-- Two paths previously produced an organisation with no MSP in the chain:
--
--   1. A public, unauthenticated signup carrying `account_kind = 'DIRECT'`,
--      which provisioned an organisation and a user with `msp_id` null.
--   2. `POST /v1/organisations`, which passed `mspId: null` and described
--      itself as creating a "direct (non-MSP) organisation".
--
-- Both were correct under the previous product brief. Neither is correct now.
-- They are removed in application code; this migration makes the rule
-- structural, so the constraint survives a future refactor that forgets it.
--
-- WHY NOT A FLAG
--
-- Leaving the capability behind configuration would mean an MSP evaluating
-- Adericel could still find a code path by which their supplier sells directly
-- to their customer. "We are able to, and promise not to" is a weaker answer
-- than "we cannot", and the MSP's technical reviewer is the person who decides
-- which answer they got.
--
-- ON EXISTING DATA
--
-- This migration REFUSES to run if any organisation has no MSP, rather than
-- deleting the row, inventing an MSP for it, or silently skipping the
-- constraint. An MSP-less organisation is a real customer relationship that
-- somebody has to decide what to do with; a migration is not the place that
-- decision gets made.
-- =============================================================================

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM organisations WHERE msp_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to migrate: % organisation(s) have no MSP. Adericel is MSP-only '
      '(contract v3.0 §2), but this deployment holds organisations created through the '
      'former direct path. Assign each to an MSP, or close it, then run the migration '
      'again. Find them with: SELECT id, name, slug FROM organisations WHERE msp_id IS NULL;',
      orphan_count;
  END IF;
END $$;

ALTER TABLE organisations ALTER COLUMN msp_id SET NOT NULL;

COMMENT ON COLUMN organisations.msp_id IS
  'The MSP that holds this customer relationship. NOT NULL: Adericel is distributed through '
  'MSPs only (contract v3.0 §2), and Veylith holds no direct customer relationships.';

-- The index was partial on `msp_id IS NOT NULL`, which is now every row.
DROP INDEX IF EXISTS organisations_msp_idx;
CREATE INDEX organisations_msp_idx ON organisations (msp_id);

-- -----------------------------------------------------------------------------
-- Signups create MSPs. There is no other shape.
--
-- The column is kept rather than dropped so that historical rows remain
-- readable — a completed signup is part of the audit record, and rewriting
-- history to match a later policy is the habit this product exists to refuse.
-- New rows may only be MSP.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  direct_count integer;
BEGIN
  SELECT count(*) INTO direct_count FROM signups WHERE account_kind <> 'MSP';
  IF direct_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to migrate: % signup(s) record a non-MSP account kind. These are historical '
      'records of a path that no longer exists. Resolve them deliberately before migrating.',
      direct_count;
  END IF;
END $$;

ALTER TABLE signups ALTER COLUMN account_kind SET DEFAULT 'MSP';
ALTER TABLE signups DROP CONSTRAINT IF EXISTS signups_account_kind_check;
ALTER TABLE signups ADD CONSTRAINT signups_account_kind_check CHECK (account_kind = 'MSP');

COMMENT ON COLUMN signups.account_kind IS
  'Always MSP. Retained for historical rows; new signups have no other shape (contract v3.0 §2).';

-- migrate:down
-- Reversing this re-opens a direct-to-SME path. The schema allows it again; the
-- application code does not, and restoring that is a deliberate product
-- decision rather than a rollback.
ALTER TABLE signups DROP CONSTRAINT IF EXISTS signups_account_kind_check;
ALTER TABLE signups ADD CONSTRAINT signups_account_kind_check
  CHECK (account_kind IN ('MSP', 'DIRECT'));
ALTER TABLE signups ALTER COLUMN account_kind DROP DEFAULT;
ALTER TABLE organisations ALTER COLUMN msp_id DROP NOT NULL;
DROP INDEX IF EXISTS organisations_msp_idx;
CREATE INDEX organisations_msp_idx ON organisations (msp_id) WHERE msp_id IS NOT NULL;
