-- migrate:up
-- =============================================================================
-- The Organisational Assurance Graph.
--
-- Nodes and edges are the canonical representation of organisational reality
-- and of the assurance artefacts derived from it. Every domain table below that
-- represents a graph-visible concept carries a node_id, so the specialised
-- table holds the attributes and the graph holds the relationships. Neither is
-- a copy of the other.
-- =============================================================================

CREATE TABLE graph_nodes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  kind                   text NOT NULL,
  external_id            text,
  label                  text NOT NULL,
  attributes             jsonb NOT NULL DEFAULT '{}'::jsonb,
  lifecycle_state        text NOT NULL DEFAULT 'ACTIVE'
                           CHECK (lifecycle_state IN ('ACTIVE', 'INACTIVE', 'ARCHIVED', 'DELETED')),
  source_integration_id  uuid,
  first_observed_at      timestamptz,
  last_observed_at       timestamptz,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- A source system's own identifier is unique per organisation and kind, which
-- is what makes repeated collection idempotent rather than duplicative.
CREATE UNIQUE INDEX graph_nodes_external_key
  ON graph_nodes (organisation_id, kind, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX graph_nodes_org_kind_idx ON graph_nodes (organisation_id, kind);
CREATE INDEX graph_nodes_org_updated_idx ON graph_nodes (organisation_id, updated_at DESC, id DESC);
CREATE INDEX graph_nodes_label_idx ON graph_nodes (organisation_id, lower(label));
CREATE INDEX graph_nodes_attributes_idx ON graph_nodes USING gin (attributes jsonb_path_ops);
CREATE TRIGGER graph_nodes_touch BEFORE UPDATE ON graph_nodes
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

CREATE TABLE graph_edges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  kind             text NOT NULL,
  from_node_id     uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  to_node_id       uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_until      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_edges_no_self_loop CHECK (from_node_id <> to_node_id)
);
CREATE UNIQUE INDEX graph_edges_unique_live
  ON graph_edges (organisation_id, kind, from_node_id, to_node_id)
  WHERE valid_until IS NULL;
CREATE INDEX graph_edges_from_idx ON graph_edges (organisation_id, from_node_id, kind) WHERE valid_until IS NULL;
CREATE INDEX graph_edges_to_idx ON graph_edges (organisation_id, to_node_id, kind) WHERE valid_until IS NULL;

-- ---------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------
CREATE TABLE integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id               uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  connector_key         text NOT NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'CONFIGURED'
                          CHECK (status IN ('CONFIGURED', 'CONNECTED', 'DEGRADED', 'FAILED', 'DISABLED')),
  configuration         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Credentials are sealed with AES-256-GCM before they reach this column.
  -- The plaintext never exists outside the credential service.
  sealed_credentials    text,
  credential_updated_at timestamptz,
  schedule_cron         text,
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integrations_org_name_key ON integrations (organisation_id, lower(name));
CREATE INDEX integrations_org_status_idx ON integrations (organisation_id, status);
CREATE TRIGGER integrations_touch BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION adericel.touch_updated_at();

ALTER TABLE graph_nodes
  ADD CONSTRAINT graph_nodes_source_integration_fk
  FOREIGN KEY (source_integration_id) REFERENCES integrations (id) ON DELETE SET NULL;

CREATE TABLE integration_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  integration_id      uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  trigger             text NOT NULL CHECK (trigger IN ('SCHEDULED', 'MANUAL', 'WEBHOOK', 'ONBOARDING', 'VERIFICATION')),
  status              text NOT NULL DEFAULT 'RUNNING'
                        CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'TIMED_OUT')),
  observations_count  integer NOT NULL DEFAULT 0,
  evidence_count      integer NOT NULL DEFAULT 0,
  error_code          text,
  error_detail        text,
  correlation_id      uuid,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX integration_runs_integration_idx
  ON integration_runs (integration_id, started_at DESC);
CREATE INDEX integration_runs_org_idx ON integration_runs (organisation_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Observations: what a connector saw, normalised but not yet given evidential
-- standing.
-- ---------------------------------------------------------------------------
CREATE TABLE observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  integration_id        uuid REFERENCES integrations (id) ON DELETE SET NULL,
  integration_run_id    uuid REFERENCES integration_runs (id) ON DELETE SET NULL,
  kind                  text NOT NULL,
  source_system         text NOT NULL,
  subject_external_id   text,
  subject_node_id       uuid REFERENCES graph_nodes (id) ON DELETE SET NULL,
  payload               jsonb NOT NULL,
  payload_hash          text NOT NULL,
  observed_at           timestamptz,
  collected_at          timestamptz NOT NULL DEFAULT now(),
  evidence_id           uuid,
  correlation_id        uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- Re-collecting an unchanged fact must not create a second observation.
CREATE UNIQUE INDEX observations_dedupe
  ON observations (organisation_id, kind, COALESCE(subject_external_id, ''), payload_hash);
CREATE INDEX observations_org_collected_idx
  ON observations (organisation_id, collected_at DESC, id DESC);
CREATE INDEX observations_subject_idx
  ON observations (organisation_id, subject_node_id) WHERE subject_node_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Evidence: an observation (or an upload, or an attestation) with provenance,
-- integrity and a validity period. Never updated in place.
-- ---------------------------------------------------------------------------
CREATE TABLE evidence (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id                  uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  source_type              text NOT NULL,
  collection_method        text NOT NULL,
  integration_id           uuid REFERENCES integrations (id) ON DELETE SET NULL,
  source_system            text NOT NULL,
  source_reference         text,
  title                    text NOT NULL,
  content_hash             text NOT NULL,
  content_type             text NOT NULL DEFAULT 'application/json',
  content_size_bytes       bigint,
  storage_key              text,
  payload                  jsonb,
  integrity_level          text NOT NULL DEFAULT 'UNVERIFIED'
                             CHECK (integrity_level IN ('UNVERIFIED', 'HASH_VERIFIED', 'SOURCE_AUTHENTICATED', 'CRYPTOGRAPHICALLY_SIGNED')),
  status                   text NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED')),
  supersedes_evidence_id   uuid REFERENCES evidence (id) ON DELETE SET NULL,
  revocation_reason        text,
  observed_at              timestamptz,
  collected_at             timestamptz NOT NULL DEFAULT now(),
  valid_from               timestamptz NOT NULL DEFAULT now(),
  valid_until              timestamptz,
  revoked_at               timestamptz,
  superseded_at            timestamptz,
  collected_by_actor       text NOT NULL,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_has_content CHECK (payload IS NOT NULL OR storage_key IS NOT NULL),
  CONSTRAINT evidence_validity_order CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX evidence_org_collected_idx ON evidence (organisation_id, collected_at DESC, id DESC);
CREATE INDEX evidence_org_status_idx ON evidence (organisation_id, status);
CREATE INDEX evidence_content_hash_idx ON evidence (organisation_id, content_hash);
CREATE INDEX evidence_expiry_idx ON evidence (organisation_id, valid_until)
  WHERE status = 'ACTIVE' AND valid_until IS NOT NULL;
CREATE INDEX evidence_integration_idx ON evidence (integration_id) WHERE integration_id IS NOT NULL;

ALTER TABLE observations
  ADD CONSTRAINT observations_evidence_fk
  FOREIGN KEY (evidence_id) REFERENCES evidence (id) ON DELETE SET NULL;

-- Which parts of the organisation a piece of evidence speaks about.
CREATE TABLE evidence_subjects (
  evidence_id      uuid NOT NULL REFERENCES evidence (id) ON DELETE CASCADE,
  node_id          uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, node_id)
);
CREATE INDEX evidence_subjects_node_idx ON evidence_subjects (organisation_id, node_id);

CREATE TABLE evidence_observations (
  evidence_id      uuid NOT NULL REFERENCES evidence (id) ON DELETE CASCADE,
  observation_id   uuid NOT NULL REFERENCES observations (id) ON DELETE CASCADE,
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, observation_id)
);

-- ---------------------------------------------------------------------------
-- Claims: structured propositions the Truth Engine can reason about.
-- ---------------------------------------------------------------------------
CREATE TABLE claims (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id         uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  node_id                 uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  predicate               text NOT NULL,
  subject_node_id         uuid REFERENCES graph_nodes (id) ON DELETE CASCADE,
  subject_external_id     text,
  value                   jsonb NOT NULL,
  origin                  text NOT NULL
                            CHECK (origin IN ('DETERMINISTIC_NORMALISATION', 'INTEGRATION_ASSERTED', 'HUMAN_ASSERTED', 'AI_SUGGESTED', 'VERIFICATION_DERIVED')),
  status                  text NOT NULL DEFAULT 'CANDIDATE'
                            CHECK (status IN ('CANDIDATE', 'CONFIRMED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN')),
  extraction_confidence   numeric(4,3) CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  supersedes_claim_id     uuid REFERENCES claims (id) ON DELETE SET NULL,
  observed_at             timestamptz,
  asserted_at             timestamptz NOT NULL DEFAULT now(),
  valid_until             timestamptz,
  created_by_actor        text NOT NULL,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);
-- One live claim per (subject, predicate): a newer assertion supersedes rather
-- than accumulates, so rules never have to guess which value is current.
CREATE UNIQUE INDEX claims_live_unique
  ON claims (organisation_id, predicate, COALESCE(subject_node_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status IN ('CANDIDATE', 'CONFIRMED');
CREATE INDEX claims_org_predicate_idx ON claims (organisation_id, predicate);
CREATE INDEX claims_subject_idx ON claims (organisation_id, subject_node_id) WHERE subject_node_id IS NOT NULL;
CREATE INDEX claims_asserted_idx ON claims (organisation_id, asserted_at DESC, id DESC);

CREATE TABLE claim_evidence (
  claim_id         uuid NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  evidence_id      uuid NOT NULL REFERENCES evidence (id) ON DELETE CASCADE,
  organisation_id  uuid NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, evidence_id)
);
CREATE INDEX claim_evidence_evidence_idx ON claim_evidence (organisation_id, evidence_id);

-- migrate:down
DROP TABLE IF EXISTS claim_evidence;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS evidence_observations;
DROP TABLE IF EXISTS evidence_subjects;
ALTER TABLE IF EXISTS observations DROP CONSTRAINT IF EXISTS observations_evidence_fk;
DROP TABLE IF EXISTS evidence;
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS integration_runs;
ALTER TABLE IF EXISTS graph_nodes DROP CONSTRAINT IF EXISTS graph_nodes_source_integration_fk;
DROP TABLE IF EXISTS integrations;
DROP TABLE IF EXISTS graph_edges;
DROP TABLE IF EXISTS graph_nodes;
