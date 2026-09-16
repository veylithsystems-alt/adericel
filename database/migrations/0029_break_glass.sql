-- migrate:up
-- =============================================================================
-- 0029 — Break-glass emergency access
--
-- Contract v3.1 §28 and §30. Veylith holds no standing authority over a
-- customer organisation, which is correct and leaves a gap: when something is
-- genuinely on fire, an operator needs in. With no route in the product they
-- use the database — unattributed, unscoped, untimed and invisible.
--
-- This is that route, built so it cannot be used quietly.
--
-- IT REUSES `grants`, IT DOES NOT REPLACE THEM
--
-- A break-glass grant IS a grant: same table, same expiry, same resolution path,
-- same row-level security. A parallel authority mechanism would be a second
-- place where access is decided, and the second place is the one that gets
-- forgotten in a review. The row below records WHY a grant exists and what must
-- happen afterwards; the grant itself does the work.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grant attenuation
--
-- A grant carries roles, and a role carries every permission it was defined
-- with. Break-glass asks for a specific, minimal set — "org:read and
-- org:assessment:read, that is all" — and recording that set beside a grant
-- that ignored it would make the narrowing decorative. An operator who asked
-- for read access would silently receive the ability to write claims.
--
-- So the narrowing lives on the grant itself, where the authority decision is
-- actually made. NULL means the roles convey everything they carry, which is
-- every grant written before now and almost every grant written after.
-- -----------------------------------------------------------------------------
ALTER TABLE grants ADD COLUMN attenuated_to text[];

COMMENT ON COLUMN grants.attenuated_to IS
  'Optional narrowing: when set, this grant conveys only the intersection of its roles'' '
  'permissions with this list. It can only ever subtract. NULL means no narrowing.';

-- An attenuation that can be widened afterwards is not an attenuation. Once a
-- grant is narrowed it may be narrowed further or revoked; it may never be
-- broadened, and it may never be released back to the full role.
CREATE OR REPLACE FUNCTION grant_attenuation_only_narrows() RETURNS trigger AS $$
BEGIN
  IF OLD.attenuated_to IS NOT NULL THEN
    IF NEW.attenuated_to IS NULL THEN
      RAISE EXCEPTION 'a narrowed grant cannot be released back to its full role';
    END IF;
    IF NOT (NEW.attenuated_to <@ OLD.attenuated_to) THEN
      RAISE EXCEPTION 'grant attenuation can only narrow, never widen';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER grant_attenuation_narrows_only
  BEFORE UPDATE ON grants
  FOR EACH ROW EXECUTE FUNCTION grant_attenuation_only_narrows();

CREATE TABLE break_glass_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The grant that actually confers authority. Deleting it revokes access;
  -- this row survives as the record that it happened.
  grant_id            uuid REFERENCES grants (id) ON DELETE SET NULL,

  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE RESTRICT,
  msp_id              uuid REFERENCES msps (id) ON DELETE SET NULL,
  opened_by           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  opened_by_label     text NOT NULL,

  reason              text NOT NULL CHECK (reason IN
                        ('SECURITY_INCIDENT','SERVICE_FAILURE','LEGAL_OBLIGATION',
                         'RECOVERY','CUSTOMER_REQUEST')),
  -- Recorded verbatim, sent to the MSP, and read again in the review.
  justification       text NOT NULL CHECK (length(trim(justification)) >= 30),
  permissions         text[] NOT NULL CHECK (array_length(permissions, 1) >= 1),

  opened_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  -- Closing early is encouraged and recorded. Nothing here can extend.
  closed_at           timestamptz,
  closed_by           uuid REFERENCES users (id) ON DELETE SET NULL,

  -- The MSP whose customer this is finds out at the time, not from an audit log
  -- later. Recorded so a failure to notify is visible rather than assumed.
  msp_notified_at     timestamptz,

  -- Mandatory afterwards, whether or not it turned out to be warranted.
  review_required     boolean NOT NULL DEFAULT true,
  reviewed_at         timestamptz,
  reviewed_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  review_outcome      text CHECK (review_outcome IS NULL OR review_outcome IN
                        ('WARRANTED','UNWARRANTED','INCONCLUSIVE')),
  review_notes        text,

  correlation_id      text,

  -- Four hours, and never more. Long enough to work an incident, short enough
  -- that nobody mistakes it for access. Enforced here as well as in code: this
  -- is the constraint most likely to be argued with at 3am.
  CONSTRAINT break_glass_is_short CHECK (expires_at <= opened_at + interval '4 hours'),
  CONSTRAINT break_glass_expires_after_opening CHECK (expires_at > opened_at)
);

CREATE INDEX break_glass_open_idx ON break_glass_grants (expires_at)
  WHERE closed_at IS NULL;
CREATE INDEX break_glass_unreviewed_idx ON break_glass_grants (opened_at DESC)
  WHERE review_required AND reviewed_at IS NULL;
CREATE INDEX break_glass_org_idx ON break_glass_grants (organisation_id, opened_at DESC);

-- A grant may be closed and reviewed. Nothing else about it may change, and it
-- is never deleted: this is the record that somebody went in.
CREATE OR REPLACE FUNCTION break_glass_is_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'break_glass_grants rows are never deleted';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR NEW.msp_id IS DISTINCT FROM OLD.msp_id
     OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_by_label IS DISTINCT FROM OLD.opened_by_label
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.justification IS DISTINCT FROM OLD.justification
     OR NEW.permissions IS DISTINCT FROM OLD.permissions
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'break_glass_grants is append-only; the reason it was opened cannot change';
  END IF;

  -- Never extendable, at any layer. An incident that outlives the window opens
  -- a second grant, which is another decision and another notification.
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'break-glass cannot be extended; open a new grant';
  END IF;

  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'a closed break-glass grant cannot be reopened';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER break_glass_append_only
  BEFORE UPDATE OR DELETE ON break_glass_grants
  FOR EACH ROW EXECUTE FUNCTION break_glass_is_append_only();

ALTER TABLE break_glass_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_grants FORCE ROW LEVEL SECURITY;

-- An organisation may see every time somebody used emergency access on it.
-- Break-glass that the subject cannot see is indistinguishable from a back door.
CREATE POLICY break_glass_tenant ON break_glass_grants
  USING (is_platform_scope() OR organisation_id = current_organisation_id());

COMMENT ON TABLE break_glass_grants IS
  'Emergency access, recorded so it cannot be used quietly. Self-service by design: a control '
  'that is hard to use in an emergency gets bypassed, and the bypass has no controls at all.';

-- migrate:down
DROP TRIGGER IF EXISTS grant_attenuation_narrows_only ON grants;
DROP FUNCTION IF EXISTS grant_attenuation_only_narrows();
ALTER TABLE grants DROP COLUMN IF EXISTS attenuated_to;
DROP POLICY IF EXISTS break_glass_tenant ON break_glass_grants;
DROP TRIGGER IF EXISTS break_glass_append_only ON break_glass_grants;
DROP FUNCTION IF EXISTS break_glass_is_append_only();
DROP TABLE IF EXISTS break_glass_grants;
