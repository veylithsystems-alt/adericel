import { contentHash } from '@adericel/shared';
import type { AppContext } from '../context.js';

/**
 * Organisation export.
 *
 * A complete, self-describing bundle of everything Adericel holds about one
 * organisation. Evidence *metadata* is included with content hashes and storage
 * references; the artefact bytes are fetched separately so an export stays a
 * reasonable size and the customer chooses what to download.
 *
 * The bundle carries its own content hash, so a customer or an auditor can
 * prove the export they hold is the one Adericel produced.
 *
 * COMPLETENESS IS STATED, NOT ASSUMED
 *
 * Each table is capped, because an unbounded export of a large estate would
 * exhaust memory and produce nothing at all. A cap that is reached and not
 * declared is worse than the failure it prevents: an MSP handing a customer
 * "everything Adericel holds" that silently omits thirty thousand evidence
 * artefacts has given them a document that lies about its own scope. So every
 * table reports its true row count alongside the number included, and the
 * bundle carries an explicit `complete` flag that goes false the moment any cap
 * bites.
 */

export interface ExportBundle {
  readonly format: string;
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly generatedBy: string;
  readonly organisation: Record<string, unknown>;
  readonly counts: Record<string, number>;
  readonly totals: Record<string, number>;
  readonly truncatedTables: readonly string[];
  /** False when any table hit the row cap. Read this before trusting the rest. */
  readonly complete: boolean;
  readonly rowLimitPerTable: number;
  readonly nodes: readonly Record<string, unknown>[];
  readonly edges: readonly Record<string, unknown>[];
  readonly controls: readonly Record<string, unknown>[];
  readonly frameworks: readonly Record<string, unknown>[];
  readonly requirements: readonly Record<string, unknown>[];
  readonly assuranceStates: readonly Record<string, unknown>[];
  readonly assessments: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly claims: readonly Record<string, unknown>[];
  readonly findings: readonly Record<string, unknown>[];
  readonly risks: readonly Record<string, unknown>[];
  readonly exceptions: readonly Record<string, unknown>[];
  readonly actions: readonly Record<string, unknown>[];
  readonly verifications: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly audit: readonly Record<string, unknown>[];
  readonly bundleHash: string;
}

const MAX_ROWS_PER_TABLE = 50_000;

/**
 * Convert database rows to the vocabulary the API uses everywhere else.
 *
 * An export is a document a customer reads and a competitor imports, so it
 * speaks the same language as the API rather than exposing column names, and
 * timestamps are ISO strings rather than driver Date objects.
 */
function toApiShape<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    out[camel] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function toApiShapes(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(toApiShape);
}

export async function exportOrganisation(
  app: AppContext,
  organisationId: string,
): Promise<ExportBundle> {
  const exportedAt = app.clock.nowIso();

  const organisationRow = await app.db.withPlatform(async (ctx) =>
    ctx.oneOrFail<Record<string, unknown>>(
      `SELECT id, msp_id, name, slug, status, country_code, industry, size_band, settings,
              onboarded_at, created_at
       FROM organisations WHERE id = $1`,
      [organisationId],
      'Organisation',
    ),
  );
  const organisation = toApiShape(organisationRow);

  // Filled as each table is read, so truncation is reported rather than hidden.
  const totals: Record<string, number> = {};
  const truncated: string[] = [];

  const data = await app.db.withTenant(organisationId, async (ctx) => {
    const q = async (name: string, sql: string) => {
      const rows = await ctx.many<Record<string, unknown>>(
        // One more than the cap, so hitting it is detectable without a second
        // COUNT query over the same predicate.
        `${sql} LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
        [organisationId],
      );
      if (rows.length > MAX_ROWS_PER_TABLE) {
        truncated.push(name);
        // The true total, so the bundle can say what it left out rather than
        // only that it left something out.
        const counted = await ctx.one<{ total: string }>(
          `SELECT count(*)::text AS total FROM (${sql}) AS counted`,
          [organisationId],
        );
        totals[name] = Number(counted?.total ?? rows.length);
        return toApiShapes(rows.slice(0, MAX_ROWS_PER_TABLE));
      }
      totals[name] = rows.length;
      return toApiShapes(rows);
    };

    return {
      nodes: await q(
        'nodes',
        `SELECT id, kind, external_id, label, attributes, lifecycle_state,
                first_observed_at, last_observed_at, created_at, updated_at
         FROM graph_nodes WHERE organisation_id = $1 ORDER BY created_at`,
      ),
      edges: await q(
        'edges',
        `SELECT id, kind, from_node_id, to_node_id, attributes, valid_from, valid_until, created_at
         FROM graph_edges WHERE organisation_id = $1 ORDER BY created_at`,
      ),
      controls: await q(
        'controls',
        `SELECT id, key, title, description, implementation_type, ruleset_key, rule_key,
                parameters, source, enabled, created_at
         FROM controls WHERE organisation_id = $1 ORDER BY key`,
      ),
      frameworks: await q(
        'frameworks',
        `SELECT f.id, f.key, f.name, f.version, f.publisher, f.description, orgf.adopted_at
         FROM organisation_frameworks orgf
         JOIN frameworks f ON f.id = orgf.framework_id
         WHERE orgf.organisation_id = $1`,
      ),
      requirements: await q(
        'requirements',
        `SELECT DISTINCT r.id, r.framework_id, r.key, r.title, r.description, r.weight
         FROM requirements r
         JOIN organisation_frameworks orgf ON orgf.framework_id = r.framework_id
         WHERE orgf.organisation_id = $1`,
      ),
      assuranceStates: await q(
        'assuranceStates',
        `SELECT subject_kind, subject_id, state, unknown_reason, assessment_id, previous_state,
                since, last_assessed_at
         FROM assurance_states WHERE organisation_id = $1`,
      ),
      assessments: await q(
        'assessments',
        `SELECT id, subject_kind, subject_id, state, unknown_reason, rationale, reasoning, trigger,
                engine_version, ruleset_key, ruleset_version, ruleset_hash, rule_key, input_digest,
                evidence_ids, claim_ids, previous_assessment_id, state_changed, assessed_at, correlation_id
         FROM assessments WHERE organisation_id = $1 ORDER BY assessed_at`,
      ),
      // Metadata and hashes, not bytes. The artefacts are downloaded
      // individually so the bundle stays portable.
      evidence: await q(
        'evidence',
        `SELECT id, source_type, collection_method, integration_id, source_system, source_reference,
                title, content_hash, content_type, content_size_bytes, storage_key, payload,
                integrity_level, status, supersedes_evidence_id, revocation_reason, observed_at,
                collected_at, valid_from, valid_until, revoked_at, superseded_at,
                collected_by_actor, metadata, created_at
         FROM evidence WHERE organisation_id = $1 ORDER BY collected_at`,
      ),
      claims: await q(
        'claims',
        `SELECT id, predicate, subject_node_id, subject_external_id, value, origin, status,
                extraction_confidence, supersedes_claim_id, observed_at, asserted_at, valid_until,
                created_by_actor, created_at
         FROM claims WHERE organisation_id = $1 ORDER BY asserted_at`,
      ),
      findings: await q(
        'findings',
        `SELECT id, control_id, requirement_id, subject_node_id, assessment_id, fingerprint,
                title, description, severity, status, evidence_ids, first_detected_at,
                last_detected_at, resolved_at, resolution_reason, created_at
         FROM findings WHERE organisation_id = $1 ORDER BY first_detected_at`,
      ),
      risks: await q(
        'risks',
        `SELECT id, title, description, likelihood, impact, inherent_severity, residual_severity,
                status, treatment, review_due_at, created_at
         FROM risks WHERE organisation_id = $1`,
      ),
      exceptions: await q(
        'exceptions',
        `SELECT id, control_id, requirement_id, finding_id, subject_node_id, justification,
                compensating_controls, status, requested_by_user_id, approved_by_user_id,
                requested_at, approved_at, effective_from, expires_at, revoked_at
         FROM exceptions WHERE organisation_id = $1`,
      ),
      actions: await q(
        'actions',
        `SELECT id, action_type, integration_id, target_node_id, target_external_id, parameters,
                risk_class, state, finding_id, proposed_by_actor, proposal_rationale,
                policy_decision, autonomy_level, idempotency_key, external_operation_ref,
                attempt_count, proposed_at, authorised_at, executed_at, verified_at, correlation_id
         FROM actions WHERE organisation_id = $1 ORDER BY proposed_at`,
      ),
      verifications: await q(
        'verifications',
        `SELECT id, action_id, claim_id, method, outcome, detail, observation_ids, evidence_id,
                attempt, verified_at
         FROM verifications WHERE organisation_id = $1 ORDER BY verified_at`,
      ),
      events: await q(
        'events',
        `SELECT id, type, schema_version, subject_type, subject_id, payload, correlation_id,
                causation_id, actor, occurred_at
         FROM event_log WHERE organisation_id = $1 ORDER BY occurred_at`,
      ),
      audit: await q(
        'audit',
        `SELECT id, actor_type, actor_id, actor_display, action, resource_type, resource_id,
                outcome, reason, correlation_id, occurred_at
         FROM audit_log WHERE organisation_id = $1 ORDER BY occurred_at`,
      ),
    };
  });

  const counts = Object.fromEntries(
    Object.entries(data).map(([key, rows]) => [key, (rows as unknown[]).length]),
  );

  const bundle = {
    format: 'adericel.organisation-export',
    // Bumped: consumers of v1 were told the bundle was complete and had no way
    // to find out otherwise. A reader must be able to tell the versions apart.
    formatVersion: 2,
    exportedAt,
    generatedBy: `${app.config.serviceName}@${app.config.releaseVersion}`,
    organisation,
    counts,
    /** True row counts, which differ from `counts` wherever a cap was reached. */
    totals,
    /** Tables the cap truncated. Empty in the ordinary case. */
    truncatedTables: [...truncated].sort(),
    /**
     * Whether this bundle contains everything Adericel holds.
     *
     * The field a customer, an auditor or a receiving MSP should read first.
     */
    complete: truncated.length === 0,
    rowLimitPerTable: MAX_ROWS_PER_TABLE,
    ...data,
  };

  return { ...bundle, bundleHash: contentHash(bundle) } as ExportBundle;
}
