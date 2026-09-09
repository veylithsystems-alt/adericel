-- migrate:up
-- =============================================================================
-- Per-organisation data keys.
--
-- Credentials were sealed directly with one configured key. That works, and it
-- has two problems that only appear once there is more than one customer:
-- rotation means re-sealing every credential in the deployment in one window,
-- and one key opens every tenant's credentials, so there is no such thing as
-- compromising a single organisation.
--
-- Each organisation now gets a data key. The data key encrypts that
-- organisation's credentials; the root key encrypts data keys and nothing else.
--
-- The honest limit, recorded here so nobody reads more into it than is there:
-- the root key still opens every data key, so disclosing it discloses
-- everything. What changes is that the root key is used rarely, on small
-- inputs, and can move to a KMS the application cannot read from — which is the
-- guarantee this makes possible rather than the guarantee itself.
--
-- The table carries organisation_id, so it is under row level security like
-- every other table that does. It would have been defensible to exempt it — the
-- cipher already binds each key to its organisation through the wrapping AAD
-- and refuses a mismatch — but an exemption for the table holding key material
-- is exactly the exemption that is hardest to justify later.
-- =============================================================================

CREATE TABLE organisation_data_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  -- The data key, encrypted under the root key with the organisation id as
  -- additional authenticated data. Never plaintext, at any point, in any column.
  wrapped_key      text NOT NULL,
  -- Which root key wrapped it. Rotating the root key is then detectable rather
  -- than a mystery discovered when something fails to open.
  root_key_id      text NOT NULL,
  -- Set when superseded. The row stays: values sealed under it must still open
  -- until they have been re-sealed, and deleting it would destroy them.
  retired_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One live key per organisation. A second live key is not a richer model, it is
-- an ambiguity about which one new values should use.
CREATE UNIQUE INDEX organisation_data_keys_live
  ON organisation_data_keys (organisation_id)
  WHERE retired_at IS NULL;
CREATE INDEX organisation_data_keys_org_idx ON organisation_data_keys (organisation_id);

ALTER TABLE organisation_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisation_data_keys
  USING (adericel.tenant_visible(organisation_id))
  WITH CHECK (adericel.tenant_visible(organisation_id));

COMMENT ON TABLE organisation_data_keys IS
  'Wrapped per-organisation data keys. Never plaintext. See ADR-0019.';

-- migrate:down
DROP TABLE IF EXISTS organisation_data_keys;
