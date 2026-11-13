import {
  COLLECTION_FAILURE_CODES,
  type BlockedReason,
  type CollectionFailureCode,
  type DegradedReason,
  aggregateAssurance,
  isUnsubstantiated,
  type AssessmentRecord,
  type AssessmentSubjectKind,
  type AssessmentTrigger,
  type AssuranceState,
  type NewDomainEvent,
  type ReasoningStep,
  type Severity,
  type UnknownReason,
} from '@adericel/domain';
import {
  effectiveLevel,
  impairmentsFor as containmentImpairmentsFor,
  type ContainmentLevel,
} from '@adericel/containment';
import { createClaimRepository, createEvidenceRepository } from '@adericel/evidence';
import { sourceImpairments, type IntegrationHealthFacts } from '@adericel/integrations';
import { publish, type TenantContext } from '@adericel/graph';
import {
  AdericelError,
  canonicalJson,
  contentHash,
  type Clock,
  type Logger,
} from '@adericel/shared';
import {
  assessControl,
  parseAssessmentInput,
  ruleRequiredPredicates,
  type ClaimFacts,
  type ControlAssessmentInput,
  type EvidenceFacts,
  type Ruleset,
  type RulesetRegistry,
  type SubjectFacts,
} from '@adericel/truth-engine';

/**
 * Assessment orchestration.
 *
 * This module gathers exactly the facts a rule declares it needs, hands them to
 * the pure Truth Engine, and persists the determination together with enough
 * provenance to replay it. All impurity — database reads, event publication,
 * finding lifecycle — lives here, never inside the engine.
 */

export interface AssessmentServiceDeps {
  readonly ctx: TenantContext;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly rulesets: RulesetRegistry;
  readonly actor: string;
  readonly correlationId: string;
  /**
   * Which predicates a connector supplies, by connector key.
   *
   * Required, not optional, and that is the point. This is what lets a control
   * whose source has broken report DEGRADED / CREDENTIAL_EXPIRED instead of
   * UNKNOWN / INSUFFICIENT_EVIDENCE. An earlier version of the system had the
   * engine's impairment logic written and tested and *nothing supplying the
   * input*, so DEGRADED was unreachable in production and every broken
   * connector told an engineer to go and connect something that was already
   * connected. An optional dependency would let that happen again silently;
   * a required one makes forgetting it a compile error.
   *
   * Takes a connector key rather than a registry so this package does not have
   * to know how connectors are looked up, and so a test can supply two lines.
   */
  readonly predicatesForConnector: (connectorKey: string) => readonly string[];
}

export interface ControlRow {
  readonly id: string;
  readonly nodeId: string;
  readonly key: string;
  readonly title: string;
  readonly rulesetKey: string;
  readonly ruleKey: string;
  readonly parameters: Record<string, unknown>;
  readonly enabled: boolean;
}

export interface AssessmentOutput {
  readonly assessment: AssessmentRecord;
  readonly stateChanged: boolean;
  readonly previousState: AssuranceState | null;
  readonly findingsOpened: readonly string[];
  readonly findingsResolved: readonly string[];
  readonly events: readonly NewDomainEvent[];
}

interface ControlDbRow {
  id: string;
  node_id: string;
  key: string;
  title: string;
  ruleset_key: string;
  rule_key: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
}

export interface AssessmentService {
  assessControl(
    controlId: string,
    trigger: AssessmentTrigger,
    asOf?: string,
  ): Promise<AssessmentOutput>;
  assessAllControls(
    trigger: AssessmentTrigger,
    asOf?: string,
  ): Promise<readonly AssessmentOutput[]>;
  rollUpRequirement(requirementId: string, asOf?: string): Promise<AssessmentOutput | null>;
  rollUpFramework(frameworkId: string, asOf?: string): Promise<AssessmentOutput | null>;
  rollUpOrganisation(asOf?: string): Promise<AssessmentOutput | null>;
  /** Re-run a historical assessment and report whether it reproduces. */
  replay(assessmentId: string): Promise<ReplayResult>;
}

/** Whether the facts the assessment ran on could be recovered, and intact. */
export type SnapshotIntegrity =
  /** The recorded inputs re-hash to the digest stored on the assessment. */
  | 'VERIFIED'
  /** The inputs were found but no longer hash to the recorded digest. */
  | 'DIGEST_MISMATCH'
  /** The inputs were found but are not a well-formed engine input. */
  | 'UNPARSEABLE'
  /** No inputs are on record for this assessment. */
  | 'NOT_RECORDED';

/** Whether the exact ruleset the assessment ran under is present in this build. */
export type RulesetIntegrity =
  | 'VERIFIED'
  /** The key and version are present but their content differs from the recorded hash. */
  | 'HASH_MISMATCH'
  | 'NOT_AVAILABLE';

export interface ReplayResult {
  readonly assessmentId: string;
  /**
   * True only when the recorded inputs, run under the recorded ruleset, produce
   * the recorded determination in full: same digest, same state, same
   * unknown reason, same rationale.
   */
  readonly reproduced: boolean;
  readonly snapshotIntegrity: SnapshotIntegrity;
  readonly rulesetIntegrity: RulesetIntegrity;
  readonly originalState: AssuranceState;
  readonly replayedState: AssuranceState | null;
  readonly originalUnknownReason: UnknownReason | null;
  readonly replayedUnknownReason: UnknownReason | null;
  readonly originalDigest: string;
  readonly replayedDigest: string | null;
  readonly rationaleMatches: boolean;
  readonly explanation: string;
}

/**
 * Whether a stored failure code is still one the system understands.
 *
 * The column is text, written by a possibly older release. Narrowing by
 * membership rather than casting means an unrecognised value degrades to "not
 * classified", which is honest, instead of travelling on as a reason the
 * resolution queue has no mapping for.
 */
function isFailureCode(value: string | null): value is CollectionFailureCode {
  return value !== null && (COLLECTION_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * One child's determination, as a rollup sees it.
 *
 * A rollup used to receive only the states. That was enough to aggregate and
 * not enough to explain: a requirement could be DEGRADED without being able to
 * say why, so an operator reading the framework level learned that something
 * was impaired and had to go and find out what.
 */
interface ChildState {
  readonly state: AssuranceState;
  readonly degradedReason: DegradedReason | null;
  readonly blockedReason: BlockedReason | null;
}

interface ChildStateRow {
  state: string;
  degraded_reason: string | null;
  blocked_reason: string | null;
}

function toChildState(row: ChildStateRow): ChildState {
  return {
    state: row.state as AssuranceState,
    degradedReason: (row.degraded_reason as DegradedReason | null) ?? null,
    blockedReason: (row.blocked_reason as BlockedReason | null) ?? null,
  };
}

export function createAssessmentService(deps: AssessmentServiceDeps): AssessmentService {
  const { ctx, clock, rulesets, actor, correlationId } = deps;
  const claims = createClaimRepository(ctx, clock);
  const evidenceRepo = createEvidenceRepository(ctx, clock);

  async function loadControl(controlId: string): Promise<ControlRow> {
    const row = await ctx.oneOrFail<ControlDbRow>(
      `SELECT id, node_id, key, title, ruleset_key, rule_key, parameters, enabled
       FROM controls WHERE id = $1 AND organisation_id = $2`,
      [controlId, ctx.organisationId],
      'Control',
    );
    return {
      id: row.id,
      nodeId: row.node_id,
      key: row.key,
      title: row.title,
      rulesetKey: row.ruleset_key,
      ruleKey: row.rule_key,
      parameters: row.parameters,
      enabled: row.enabled,
    };
  }

  /**
   * Assemble the engine's input.
   *
   * Only the predicates the rule declares are fetched. That keeps assessment
   * cost proportional to the rule rather than to the size of the tenant, and it
   * makes the input digest a faithful record of what was actually consulted.
   */
  /**
   * Why Adericel cannot currently collect something, in words an operator can
   * act on.
   *
   * Two sources, deliberately separate:
   *
   *   - A connector that is failing. The repair is technical: re-authorise,
   *     grant a scope, wait out a throttle, fix a configuration.
   *   - An estate under containment. Nothing is broken. Somebody decided it
   *     was not safe to keep looking, which is a completely different fact and
   *     must not read as "nobody has looked".
   *
   * Both are facts about the world, so both arrive as engine *input* and land
   * inside the assessment digest. That is what keeps replay honest: re-running
   * a historical assessment reproduces what Adericel reported at the time,
   * including that a source was broken then and is fine now.
   *
   * The engine applies the safety rule, not this function: impairment may only
   * ever rename an UNKNOWN. So being generous here — an impairment for every
   * predicate an unhealthy integration declares — cannot touch a real
   * determination, and a control still reading SATISFIED on evidence inside
   * its freshness window stays SATISFIED while its source is dead. That is the
   * correct answer; connector health is where the dead source is reported in
   * the meantime.
   */
  async function gatherImpairments(): Promise<
    readonly {
      predicate: string;
      kind: 'DEGRADED' | 'BLOCKED';
      reason: DegradedReason | BlockedReason;
      detail: string;
    }[]
  > {
    const rows = await ctx.many<{
      id: string;
      name: string;
      connector_key: string;
      status: string;
      consecutive_failures: number;
      last_success_at: Date | null;
      containment_level: string;
      contained_since: Date | null;
      org_containment_level: string;
      latest_failure_code: string | null;
    }>(
      `SELECT i.id, i.name, i.connector_key, i.status, i.consecutive_failures,
              i.last_success_at, i.containment_level, i.contained_since,
              o.containment_level AS org_containment_level,
              (SELECT r.error_code
                 FROM integration_runs r
                WHERE r.integration_id = i.id AND r.error_code IS NOT NULL
                ORDER BY r.started_at DESC
                LIMIT 1) AS latest_failure_code
         FROM integrations i
         JOIN organisations o ON o.id = i.organisation_id
        WHERE i.organisation_id = $1`,
      [ctx.organisationId],
    );

    /**
     * What each integration has actually been answering.
     *
     * The manifest's declared predicate list is a *claim about* a connector,
     * hand-maintained and therefore capable of being wrong — and when it is
     * wrong by omission, impairment silently stops working for the predicates
     * it forgot, so the operator gets INSUFFICIENT_EVIDENCE ("connect
     * something") in place of the repair. That is exactly how this defect was
     * found: a connector collected `device.managed` for months without
     * declaring it.
     *
     * `claims.source_integration_id` is not a claim about the connector, it is
     * the record of what the connector did. Taking the union of the two means
     * a declaration that is wrong by omission is corrected by observation, and
     * an integration that broke before it ever answered is still covered by
     * its declaration.
     */
    const observed = await ctx.many<{ integration_id: string; predicate: string }>(
      `SELECT DISTINCT source_integration_id AS integration_id, predicate
         FROM claims
        WHERE organisation_id = $1 AND source_integration_id IS NOT NULL`,
      [ctx.organisationId],
    );
    const observedByIntegration = new Map<string, Set<string>>();
    for (const row of observed) {
      const bucket = observedByIntegration.get(row.integration_id) ?? new Set<string>();
      bucket.add(row.predicate);
      observedByIntegration.set(row.integration_id, bucket);
    }
    const predicatesFor = (integrationId: string, connectorKey: string): readonly string[] => [
      ...new Set([
        ...deps.predicatesForConnector(connectorKey),
        ...(observedByIntegration.get(integrationId) ?? []),
      ]),
    ];

    const health: IntegrationHealthFacts[] = rows.map((row) => ({
      integrationId: row.id,
      name: row.name,
      connectorKey: row.connector_key,
      status: row.status,
      // Validated rather than cast. A code that is no longer in the vocabulary
      // — an older release wrote it, or a migration renamed it — must read as
      // "unclassified" rather than be passed through as a reason nothing
      // downstream can map, which would reach an operator as a blank.
      latestFailureCode: isFailureCode(row.latest_failure_code) ? row.latest_failure_code : null,
      consecutiveFailures: row.consecutive_failures,
      lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      predicates: predicatesFor(row.id, row.connector_key),
    }));

    const fromSources = sourceImpairments({ integrations: health });

    const fromContainment = rows.flatMap((row) =>
      containmentImpairmentsFor({
        level: effectiveLevel([
          row.containment_level as ContainmentLevel,
          row.org_containment_level as ContainmentLevel,
        ]),
        predicates: predicatesFor(row.id, row.connector_key),
        since: row.contained_since?.toISOString() ?? 'an earlier date',
        reason: 'security containment',
      }),
    );

    return [...fromSources, ...fromContainment];
  }

  async function buildInput(
    control: ControlRow,
    ruleset: Ruleset,
    asOfIso: string,
  ): Promise<ControlAssessmentInput> {
    const rule = ruleset.rules.find((r) => r.key === control.ruleKey);
    if (!rule) {
      throw new AdericelError('RULESET_NOT_FOUND', `Rule ${control.ruleKey} not found`, {
        safeDetails: {
          rulesetKey: ruleset.key,
          rulesetVersion: ruleset.version,
          ruleKey: control.ruleKey,
        },
      });
    }
    const predicates = ruleRequiredPredicates(rule);
    const impairments = await gatherImpairments();

    const subjectRows =
      rule.subjectKinds.length === 0
        ? []
        : await ctx.many<{
            id: string;
            kind: string;
            label: string;
            attributes: Record<string, unknown>;
          }>(
            `SELECT id, kind, label, attributes FROM graph_nodes
             WHERE organisation_id = $1 AND kind = ANY($2::text[]) AND lifecycle_state = 'ACTIVE'`,
            [ctx.organisationId, rule.subjectKinds],
          );

    const subjectIds = subjectRows.map((row) => row.id);
    const subjectClaims = await claims.forSubjects(subjectIds, predicates);
    const organisationClaims = await claims.organisationClaims(predicates);

    const claimsBySubject = new Map<string, ClaimFacts[]>();
    for (const claim of subjectClaims) {
      if (!claim.subjectNodeId) continue;
      const bucket = claimsBySubject.get(claim.subjectNodeId) ?? [];
      bucket.push(toClaimFacts(claim));
      claimsBySubject.set(claim.subjectNodeId, bucket);
    }

    const evidenceIds = [
      ...new Set([...subjectClaims, ...organisationClaims].flatMap((c) => c.evidenceIds)),
    ];
    const evidenceRecords = await evidenceRepo.forClaims(
      [...subjectClaims, ...organisationClaims].map((c) => c.id),
    );
    const evidence: EvidenceFacts[] = evidenceRecords
      .filter((record) => evidenceIds.includes(record.id))
      .map((record) => ({
        id: record.id,
        status: record.status,
        sourceType: record.sourceType,
        observedAt: record.observedAt,
        collectedAt: record.collectedAt,
        validFrom: record.validFrom,
        validUntil: record.validUntil,
      }));

    const exceptionRows = await ctx.many<{
      id: string;
      subject_node_id: string | null;
      justification: string;
      expires_at: Date;
    }>(
      `SELECT id, subject_node_id, justification, expires_at
       FROM exceptions
       WHERE organisation_id = $1 AND control_id = $2 AND status = 'APPROVED'
         AND revoked_at IS NULL AND effective_from <= $3::timestamptz AND expires_at > $3::timestamptz`,
      [ctx.organisationId, control.id, asOfIso],
    );

    // Which node kinds this organisation has ever actually observed, so the
    // engine can tell "no devices exist" from "we have never seen a device".
    const observedRows = await ctx.many<{ kind: string }>(
      `SELECT DISTINCT kind FROM graph_nodes WHERE organisation_id = $1`,
      [ctx.organisationId],
    );

    const subjects: SubjectFacts[] = subjectRows.map((row) => ({
      nodeId: row.id,
      kind: row.kind,
      label: row.label,
      attributes: row.attributes,
      claims: claimsBySubject.get(row.id) ?? [],
    }));

    return {
      organisationId: ctx.organisationId,
      controlId: control.id,
      controlKey: control.key,
      ruleKey: control.ruleKey,
      parameters: control.parameters,
      asOfIso,
      subjects,
      organisationClaims: organisationClaims.map(toClaimFacts),
      evidence,
      observedSubjectKinds: observedRows.map((row) => row.kind),
      // Narrowed to the predicates this rule actually needs. An impairment on
      // a predicate the rule never reads is noise in the digest, and the
      // digest is what replay compares.
      impairments: impairments.filter((impairment) => predicates.includes(impairment.predicate)),
      activeExceptions: exceptionRows.map((row) => ({
        id: row.id,
        subjectNodeId: row.subject_node_id,
        justification: row.justification,
        expiresAt: row.expires_at.toISOString(),
      })),
    };
  }

  /**
   * Record the exact facts an assessment ran on, so it can be replayed from its
   * own record rather than from data that has since moved on.
   *
   * Content-addressed by the input digest: an unchanged estate reassessed every
   * night yields the same digest by construction, so this writes one row the
   * first time and touches a counter thereafter. The `snapshot` column is never
   * updated once written — a digest collision would have to be a SHA-256
   * collision, and preserving the first-written bytes means a later write can
   * never silently rewrite the basis of an earlier determination.
   */
  async function recordInput(
    control: ControlRow,
    ruleset: Ruleset,
    input: ControlAssessmentInput,
    provenance: { engineVersion: string; inputDigest: string; ruleKey: string },
  ): Promise<void> {
    await ctx.query(
      `INSERT INTO assessment_inputs
         (organisation_id, input_digest, snapshot, engine_version, ruleset_key, ruleset_version,
          ruleset_hash, control_id, rule_key)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organisation_id, input_digest) DO UPDATE SET
         last_used_at = now(),
         use_count = assessment_inputs.use_count + 1`,
      [
        ctx.organisationId,
        provenance.inputDigest,
        canonicalJson(input),
        provenance.engineVersion,
        ruleset.key,
        ruleset.version,
        ruleset.hash,
        control.id,
        provenance.ruleKey,
      ],
    );
  }

  async function persist(
    subjectKind: AssessmentSubjectKind,
    subjectId: string,
    nodeId: string | null,
    outcome: {
      state: AssuranceState;
      unknownReason: UnknownReason | null;
      degradedReason: DegradedReason | null;
      blockedReason: BlockedReason | null;
      rationale: string;
      reasoning: readonly ReasoningStep[];
      claimIds: readonly string[];
      evidenceIds: readonly string[];
      provenance: {
        engineVersion: string;
        rulesetKey: string;
        rulesetVersion: string;
        rulesetHash: string;
        ruleKey: string;
        inputDigest: string;
        assessedAt: string;
      };
    },
    trigger: AssessmentTrigger,
  ): Promise<{
    assessment: AssessmentRecord;
    previousState: AssuranceState | null;
    changed: boolean;
  }> {
    const previous = await ctx.one<{ state: string; assessment_id: string; since: Date }>(
      `SELECT state, assessment_id, since FROM assurance_states
       WHERE organisation_id = $1 AND subject_kind = $2 AND subject_id = $3`,
      [ctx.organisationId, subjectKind, subjectId],
    );
    const previousState = (previous?.state as AssuranceState | undefined) ?? null;
    const changed = previousState !== outcome.state;

    const inserted = await ctx.oneOrFail<{ id: string; created_at: Date }>(
      /**
       * `degraded_reason` and `blocked_reason` are written here, not only
       * `unknown_reason`.
       *
       * Both columns, and the CHECK constraints that tie each to its state,
       * were added with the vocabulary and then never written, because nothing
       * supplied impairment so no assessment could reach DEGRADED or BLOCKED.
       * The read side had already been fixed to prefer the stored column — over
       * a column nothing populated — which is a reminder that a fix to a reader
       * proves nothing about the writer.
       */
      `INSERT INTO assessments
         (organisation_id, node_id, subject_kind, subject_id, state, unknown_reason,
          degraded_reason, blocked_reason, rationale,
          reasoning, trigger, engine_version, ruleset_key, ruleset_version, ruleset_hash, rule_key,
          input_digest, evidence_ids, claim_ids, previous_assessment_id, state_changed, assessed_at,
          correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $22, $23, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15,
               $16::uuid[], $17::uuid[], $18, $19, $20, $21)
       RETURNING id, created_at`,
      [
        ctx.organisationId,
        nodeId,
        subjectKind,
        subjectId,
        outcome.state,
        outcome.unknownReason,
        outcome.rationale,
        JSON.stringify(outcome.reasoning),
        trigger,
        outcome.provenance.engineVersion,
        outcome.provenance.rulesetKey,
        outcome.provenance.rulesetVersion,
        outcome.provenance.rulesetHash,
        outcome.provenance.ruleKey,
        outcome.provenance.inputDigest,
        outcome.evidenceIds,
        outcome.claimIds,
        previous?.assessment_id ?? null,
        changed,
        outcome.provenance.assessedAt,
        correlationId,
        outcome.degradedReason,
        outcome.blockedReason,
      ],
      'Assessment',
    );

    await ctx.query(
      `INSERT INTO assurance_states
         (organisation_id, subject_kind, subject_id, state, unknown_reason,
          degraded_reason, blocked_reason, assessment_id,
          previous_state, since, last_assessed_at)
       VALUES ($1, $2, $3, $4, $5, $9, $10, $6, $7, $8, $8)
       ON CONFLICT (organisation_id, subject_kind, subject_id) DO UPDATE SET
         state = EXCLUDED.state,
         unknown_reason = EXCLUDED.unknown_reason,
         -- Overwritten rather than coalesced. A control that was DEGRADED for a
         -- credential and is now DEGRADED for a throttle must say so; keeping
         -- the first reason would send an engineer to re-do work already done.
         degraded_reason = EXCLUDED.degraded_reason,
         blocked_reason = EXCLUDED.blocked_reason,
         assessment_id = EXCLUDED.assessment_id,
         previous_state = assurance_states.state,
         -- The "since" timestamp only moves when the state actually changes, so
         -- "how long has this been failing?" stays answerable across reassessments.
         since = CASE WHEN assurance_states.state <> EXCLUDED.state
                      THEN EXCLUDED.since ELSE assurance_states.since END,
         last_assessed_at = EXCLUDED.last_assessed_at,
         updated_at = now()`,
      [
        ctx.organisationId,
        subjectKind,
        subjectId,
        outcome.state,
        outcome.unknownReason,
        inserted.id,
        previousState,
        outcome.provenance.assessedAt,
        outcome.degradedReason,
        outcome.blockedReason,
      ],
    );

    const assessment: AssessmentRecord = {
      id: inserted.id,
      organisationId: ctx.organisationId,
      nodeId: nodeId ?? '',
      subjectKind,
      subjectId,
      state: outcome.state,
      unknownReason: outcome.unknownReason,
      rationale: outcome.rationale,
      reasoning: outcome.reasoning,
      trigger,
      provenance: {
        ...outcome.provenance,
        evidenceIds: outcome.evidenceIds,
        claimIds: outcome.claimIds,
      },
      previousAssessmentId: previous?.assessment_id ?? null,
      stateChanged: changed,
      correlationId,
      createdAt: inserted.created_at.toISOString(),
    };

    return { assessment, previousState, changed };
  }

  /**
   * Reconcile findings against a control's current outcome.
   *
   * A finding is identified by a fingerprint over (control, subject, rule), so a
   * problem that persists across reassessments keeps one durable record and its
   * age is measured from first detection. Problems that have gone away are
   * resolved rather than deleted.
   */
  async function reconcileFindings(
    control: ControlRow,
    assessmentId: string,
    severity: Severity,
    failing: readonly { nodeId: string; label: string; detail: string }[],
    evidenceIds: readonly string[],
    assessedAt: string,
  ): Promise<{ opened: string[]; resolved: string[] }> {
    const opened: string[] = [];
    const activeFingerprints = new Set<string>();

    for (const subject of failing) {
      const fingerprint = contentHash({
        controlId: control.id,
        ruleKey: control.ruleKey,
        subjectNodeId: subject.nodeId,
      });
      activeFingerprints.add(fingerprint);

      const row = await ctx.oneOrFail<{ id: string; inserted: boolean }>(
        `INSERT INTO findings
           (organisation_id, node_id, control_id, subject_node_id, assessment_id, fingerprint,
            title, description, severity, evidence_ids, first_detected_at, last_detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $11)
         ON CONFLICT (organisation_id, fingerprint)
           WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION')
         DO UPDATE SET
           last_detected_at = EXCLUDED.last_detected_at,
           assessment_id = EXCLUDED.assessment_id,
           evidence_ids = EXCLUDED.evidence_ids,
           severity = EXCLUDED.severity
         RETURNING id, (xmax = 0) AS inserted`,
        [
          ctx.organisationId,
          control.nodeId,
          control.id,
          subject.nodeId,
          assessmentId,
          fingerprint,
          `${control.title}: ${subject.label}`,
          subject.detail,
          severity,
          evidenceIds,
          assessedAt,
        ],
        'Finding',
      );
      if (row.inserted) opened.push(row.id);
    }

    const resolvedRows = await ctx.many<{ id: string }>(
      `UPDATE findings
       SET status = 'RESOLVED', resolved_at = $3::timestamptz,
           resolution_reason = 'No longer detected by assessment'
       WHERE organisation_id = $1 AND control_id = $2
         AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_REMEDIATION')
         AND NOT (fingerprint = ANY($4::text[]))
       RETURNING id`,
      [ctx.organisationId, control.id, assessedAt, [...activeFingerprints]],
    );

    return { opened, resolved: resolvedRows.map((r) => r.id) };
  }

  const service: AssessmentService = {
    async assessControl(controlId, trigger, asOf): Promise<AssessmentOutput> {
      const asOfIso = asOf ?? clock.nowIso();
      const control = await loadControl(controlId);
      if (!control.enabled) {
        throw new AdericelError('PRECONDITION_FAILED', 'Control is disabled', {
          safeDetails: { controlId },
        });
      }

      const ruleset = rulesets.get(control.rulesetKey);
      const input = await buildInput(control, ruleset, asOfIso);
      const outcome = assessControl(ruleset, input);

      // Written before the assessment row, inside the same transaction, so an
      // assessment can never be persisted without the facts that produced it.
      await recordInput(control, ruleset, input, outcome.provenance);

      const { assessment, previousState, changed } = await persist(
        'CONTROL',
        control.id,
        control.nodeId,
        outcome,
        trigger,
      );

      const findings = await reconcileFindings(
        control,
        assessment.id,
        outcome.severity,
        outcome.failingSubjects.map((s) => ({
          nodeId: s.nodeId,
          label: s.label,
          detail: s.detail,
        })),
        outcome.evidenceIds,
        asOfIso,
      );

      const events: NewDomainEvent[] = [
        {
          type: 'AssessmentCompleted',
          organisationId: ctx.organisationId,
          subjectType: 'Control',
          subjectId: control.id,
          payload: {
            assessmentId: assessment.id,
            controlKey: control.key,
            state: outcome.state,
            unknownReason: outcome.unknownReason,
            rulesetKey: ruleset.key,
            rulesetVersion: ruleset.version,
            failingSubjects: outcome.failingSubjects.length,
            unknownSubjects: outcome.unknownSubjects.length,
          },
          correlationId,
          actor,
        },
      ];

      if (changed) {
        events.push({
          type: 'AssuranceStateChanged',
          organisationId: ctx.organisationId,
          subjectType: 'Control',
          subjectId: control.id,
          payload: {
            controlKey: control.key,
            previousState,
            state: outcome.state,
            unknownReason: outcome.unknownReason,
            rationale: outcome.rationale,
            assessmentId: assessment.id,
          },
          correlationId,
          causationId: null,
          actor,
        });
      }

      for (const findingId of findings.opened) {
        events.push({
          type: 'FindingCreated',
          organisationId: ctx.organisationId,
          subjectType: 'Finding',
          subjectId: findingId,
          payload: { controlId: control.id, controlKey: control.key, severity: outcome.severity },
          correlationId,
          actor,
        });
      }
      for (const findingId of findings.resolved) {
        events.push({
          type: 'FindingResolved',
          organisationId: ctx.organisationId,
          subjectType: 'Finding',
          subjectId: findingId,
          payload: { controlId: control.id, controlKey: control.key },
          correlationId,
          actor,
        });
      }

      for (const event of events) await publish(ctx, event, asOfIso);

      return {
        assessment,
        stateChanged: changed,
        previousState,
        findingsOpened: findings.opened,
        findingsResolved: findings.resolved,
        events,
      };
    },

    async assessAllControls(trigger, asOf): Promise<readonly AssessmentOutput[]> {
      const rows = await ctx.many<{ id: string }>(
        `SELECT id FROM controls WHERE organisation_id = $1 AND enabled ORDER BY key`,
        [ctx.organisationId],
      );
      const outputs: AssessmentOutput[] = [];
      for (const row of rows) {
        try {
          outputs.push(await service.assessControl(row.id, trigger, asOf));
        } catch (error) {
          // One control failing to assess must not abandon the rest; the failure
          // is recorded and the remaining controls still produce state.
          deps.logger.error(
            { controlId: row.id, err: (error as Error).message },
            'control assessment failed',
          );
        }
      }
      return outputs;
    },

    async rollUpRequirement(requirementId, asOf): Promise<AssessmentOutput | null> {
      const asOfIso = asOf ?? clock.nowIso();
      const rows = await ctx.many<ChildStateRow>(
        `SELECT a.state, a.degraded_reason, a.blocked_reason
         FROM control_requirements cr
         JOIN assurance_states a
           ON a.organisation_id = cr.organisation_id
          AND a.subject_kind = 'CONTROL' AND a.subject_id = cr.control_id
         WHERE cr.organisation_id = $1 AND cr.requirement_id = $2`,
        [ctx.organisationId, requirementId],
      );
      return rollUp('REQUIREMENT', requirementId, rows.map(toChildState), asOfIso);
    },

    async rollUpFramework(frameworkId, asOf): Promise<AssessmentOutput | null> {
      const asOfIso = asOf ?? clock.nowIso();
      const rows = await ctx.many<ChildStateRow>(
        `SELECT a.state, a.degraded_reason, a.blocked_reason
         FROM requirements r
         JOIN assurance_states a
           ON a.subject_kind = 'REQUIREMENT' AND a.subject_id = r.id AND a.organisation_id = $1
         WHERE r.framework_id = $2`,
        [ctx.organisationId, frameworkId],
      );
      return rollUp('FRAMEWORK', frameworkId, rows.map(toChildState), asOfIso);
    },

    async rollUpOrganisation(asOf): Promise<AssessmentOutput | null> {
      const asOfIso = asOf ?? clock.nowIso();
      const rows = await ctx.many<ChildStateRow>(
        `SELECT state, degraded_reason, blocked_reason FROM assurance_states
         WHERE organisation_id = $1 AND subject_kind = 'FRAMEWORK'`,
        [ctx.organisationId],
      );
      return rollUp('ORGANISATION', ctx.organisationId, rows.map(toChildState), asOfIso);
    },

    async replay(assessmentId): Promise<ReplayResult> {
      const row = await ctx.oneOrFail<{
        id: string;
        subject_kind: string;
        subject_id: string;
        state: string;
        unknown_reason: string | null;
        rationale: string;
        ruleset_key: string;
        ruleset_version: string;
        ruleset_hash: string;
        input_digest: string;
      }>(
        `SELECT id, subject_kind, subject_id, state, unknown_reason, rationale,
                ruleset_key, ruleset_version, ruleset_hash, input_digest
         FROM assessments WHERE id = $1 AND organisation_id = $2`,
        [assessmentId, ctx.organisationId],
        'Assessment',
      );

      if (row.subject_kind !== 'CONTROL') {
        throw new AdericelError(
          'PRECONDITION_FAILED',
          'Only control assessments are produced by the engine, so only they can be replayed. ' +
            'Roll-ups are derived from the control assessments beneath them.',
          { safeDetails: { assessmentId, subjectKind: row.subject_kind } },
        );
      }

      const base = {
        assessmentId,
        originalState: row.state as AssuranceState,
        originalUnknownReason: (row.unknown_reason as UnknownReason | null) ?? null,
        originalDigest: row.input_digest,
      };
      const irreproducible = (
        snapshotIntegrity: SnapshotIntegrity,
        rulesetIntegrity: RulesetIntegrity,
        explanation: string,
      ): ReplayResult => ({
        ...base,
        reproduced: false,
        snapshotIntegrity,
        rulesetIntegrity,
        replayedState: null,
        replayedUnknownReason: null,
        replayedDigest: null,
        rationaleMatches: false,
        explanation,
      });

      const ruleset = rulesets.tryGet(row.ruleset_key, row.ruleset_version);
      if (!ruleset) {
        return irreproducible(
          'NOT_RECORDED',
          'NOT_AVAILABLE',
          `Ruleset ${row.ruleset_key}@${row.ruleset_version} is not present in this build, so the ` +
            'assessment cannot be reproduced. Deploy a build carrying that ruleset version to replay it.',
        );
      }

      // A published ruleset version is supposed to be immutable. If the content
      // under this key and version no longer hashes to what the assessment
      // recorded, that promise has been broken somewhere, and replaying under
      // the substitute would produce a plausible answer to the wrong question.
      if (ruleset.hash !== row.ruleset_hash) {
        return irreproducible(
          'NOT_RECORDED',
          'HASH_MISMATCH',
          `Ruleset ${row.ruleset_key}@${row.ruleset_version} is present but its content has changed ` +
            `since this assessment ran (recorded ${row.ruleset_hash}, current ${ruleset.hash}). ` +
            'Published ruleset versions must be immutable; this is a build or release fault and ' +
            'should be escalated rather than worked around.',
        );
      }

      const snapshotRow = await ctx.one<{ snapshot: unknown }>(
        `SELECT snapshot FROM assessment_inputs
         WHERE organisation_id = $1 AND input_digest = $2`,
        [ctx.organisationId, row.input_digest],
      );
      if (!snapshotRow) {
        return irreproducible(
          'NOT_RECORDED',
          'VERIFIED',
          'No inputs are on record for this assessment, so it cannot be reproduced. Assessments ' +
            'made before input recording was introduced are in this position; the assessment row ' +
            'remains the authoritative account of the determination made at that instant.',
        );
      }

      let input: ControlAssessmentInput;
      try {
        input = parseAssessmentInput(snapshotRow.snapshot);
      } catch (error) {
        return irreproducible(
          'UNPARSEABLE',
          'VERIFIED',
          'The recorded inputs for this assessment are not a well-formed engine input and cannot ' +
            `be replayed: ${(error as Error).message}. This indicates storage corruption or ` +
            'tampering and should be escalated.',
        );
      }

      const outcome = assessControl(ruleset, input);

      // The digest was written on the assessment row, the snapshot in a separate
      // table. Re-deriving the digest from the snapshot and comparing the two is
      // what makes this a proof rather than a re-read: an altered snapshot no
      // longer hashes to the digest the determination was recorded under.
      const digestMatches = outcome.provenance.inputDigest === row.input_digest;
      const stateMatches = outcome.state === row.state;
      const unknownReasonMatches = (outcome.unknownReason ?? null) === base.originalUnknownReason;
      const rationaleMatches = outcome.rationale === row.rationale;

      const replayed = {
        ...base,
        snapshotIntegrity: (digestMatches ? 'VERIFIED' : 'DIGEST_MISMATCH') as SnapshotIntegrity,
        rulesetIntegrity: 'VERIFIED' as RulesetIntegrity,
        replayedState: outcome.state,
        replayedUnknownReason: outcome.unknownReason,
        replayedDigest: outcome.provenance.inputDigest,
        rationaleMatches,
      };

      if (!digestMatches) {
        return {
          ...replayed,
          reproduced: false,
          explanation:
            'The recorded inputs no longer hash to the digest stored on the assessment ' +
            `(recorded ${row.input_digest}, recomputed ${outcome.provenance.inputDigest}). The ` +
            'stored facts are not the facts this determination was made on. Treat this as ' +
            'evidence tampering or storage corruption and escalate.',
        };
      }

      if (!stateMatches || !unknownReasonMatches || !rationaleMatches) {
        return {
          ...replayed,
          reproduced: false,
          explanation:
            'The inputs are intact and verified, but re-running them produces a different ' +
            `determination (recorded ${row.state}, replayed ${outcome.state}). The engine is not ` +
            'deterministic across these builds. This is a defect in Adericel, not in the ' +
            "customer's data, and should be escalated.",
        };
      }

      return {
        ...replayed,
        reproduced: true,
        explanation:
          'Reproduced exactly. The facts recorded with this assessment, re-run under ruleset ' +
          `${row.ruleset_key}@${row.ruleset_version} (${row.ruleset_hash}), produce the same ` +
          'determination, the same reason and the same explanation.',
      };
    },
  };

  async function rollUp(
    subjectKind: AssessmentSubjectKind,
    subjectId: string,
    children: readonly ChildState[],
    asOfIso: string,
  ): Promise<AssessmentOutput | null> {
    const states = children.map((child) => child.state);
    const aggregate = aggregateAssurance(states);
    /**
     * A rolled-up reason, only where the children agree.
     *
     * A requirement whose four controls are all degraded because the same
     * credential expired has one answer, and saying it at the requirement
     * level saves an operator four clicks. Four controls degraded for four
     * different reasons have no single answer, and inventing one — picking the
     * first, or the most common — would send somebody to do one repair when
     * four are needed. In that case the reason is null and the explanation
     * sends the reader to the children, which is where the truth is.
     */
    const agreedReason = <T extends string>(pick: (child: ChildState) => T | null): T | null => {
      const reasons = new Set(
        children.filter((child) => pick(child) !== null).map((child) => pick(child) as T),
      );
      return reasons.size === 1 ? [...reasons][0]! : null;
    };
    const reasoning: ReasoningStep[] = [
      {
        step: 'aggregate',
        outcome:
          aggregate.state === 'NOT_SATISFIED'
            ? 'FAIL'
            : // DEGRADED and BLOCKED report as UNKNOWN in the reasoning step,
              // never as PASS. `isUnsubstantiated` rather than an equality
              // check on UNKNOWN: a widened state set must not let a rollup
              // quietly claim a pass it cannot support.
              isUnsubstantiated(aggregate.state)
              ? 'UNKNOWN'
              : 'PASS',
        detail:
          `${aggregate.inScope} in-scope child subject(s); ` +
          Object.entries(aggregate.counts)
            .filter(([, count]) => count > 0)
            .map(([state, count]) => `${count} ${state}`)
            .join(', '),
      },
    ];

    const { assessment, previousState, changed } = await persist(
      subjectKind,
      subjectId,
      null,
      {
        state: aggregate.state,
        unknownReason: aggregate.state === 'UNKNOWN' ? 'INSUFFICIENT_EVIDENCE' : null,
        degradedReason:
          aggregate.state === 'DEGRADED' ? agreedReason((child) => child.degradedReason) : null,
        blockedReason:
          aggregate.state === 'BLOCKED' ? agreedReason((child) => child.blockedReason) : null,
        rationale: isUnsubstantiated(aggregate.state)
          ? `Cannot be determined: of ${aggregate.inScope} child subject(s), ` +
            `${aggregate.counts.UNKNOWN} unknown, ${aggregate.counts.DEGRADED} degraded ` +
            `(the source is impaired), ${aggregate.counts.BLOCKED} blocked (Adericel is not ` +
            `permitted to look).`
          : `Rolled up from ${aggregate.inScope} child subject(s); coverage ${(aggregate.coverage * 100).toFixed(0)}%.`,
        reasoning,
        claimIds: [],
        evidenceIds: [],
        provenance: {
          engineVersion: 'rollup-1.0.0',
          rulesetKey: 'aggregation',
          rulesetVersion: '1.0.0',
          rulesetHash: contentHash({ aggregation: 'assurance-lattice', version: 1 }),
          ruleKey: 'aggregate',
          inputDigest: contentHash({ subjectKind, subjectId, states: [...states].sort() }),
          assessedAt: asOfIso,
        },
      },
      'SCHEDULED',
    );

    const events: NewDomainEvent[] = [];
    if (changed) {
      events.push({
        type: 'AssuranceStateChanged',
        organisationId: ctx.organisationId,
        subjectType: subjectKind,
        subjectId,
        payload: { previousState, state: aggregate.state, counts: aggregate.counts },
        correlationId,
        actor,
      });
      await publish(ctx, events[0] as NewDomainEvent, asOfIso);
    }

    return {
      assessment,
      stateChanged: changed,
      previousState,
      findingsOpened: [],
      findingsResolved: [],
      events,
    };
  }

  return service;
}

function toClaimFacts(claim: {
  id: string;
  predicate: string;
  value: unknown;
  origin: ClaimFacts['origin'];
  status: ClaimFacts['status'];
  observedAt: string | null;
  assertedAt: string;
  validUntil: string | null;
  evidenceIds: readonly string[];
}): ClaimFacts {
  return {
    id: claim.id,
    predicate: claim.predicate,
    value: claim.value,
    origin: claim.origin,
    status: claim.status,
    observedAt: claim.observedAt,
    assertedAt: claim.assertedAt,
    validUntil: claim.validUntil,
    evidenceIds: claim.evidenceIds,
  };
}
