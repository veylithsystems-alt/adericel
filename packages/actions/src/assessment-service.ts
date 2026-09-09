import {
  aggregateAssurance,
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
  createClaimRepository,
  createEvidenceRepository,
} from '@adericel/evidence';
import { publish, type TenantContext } from '@adericel/graph';
import { AdericelError, contentHash, type Clock, type Logger } from '@adericel/shared';
import {
  assessControl,
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
  assessControl(controlId: string, trigger: AssessmentTrigger, asOf?: string): Promise<AssessmentOutput>;
  assessAllControls(trigger: AssessmentTrigger, asOf?: string): Promise<readonly AssessmentOutput[]>;
  rollUpRequirement(requirementId: string, asOf?: string): Promise<AssessmentOutput | null>;
  rollUpFramework(frameworkId: string, asOf?: string): Promise<AssessmentOutput | null>;
  rollUpOrganisation(asOf?: string): Promise<AssessmentOutput | null>;
  /** Re-run a historical assessment and report whether it reproduces. */
  replay(assessmentId: string): Promise<ReplayResult>;
}

export interface ReplayResult {
  readonly assessmentId: string;
  readonly reproduced: boolean;
  readonly originalState: AssuranceState;
  readonly replayedState: AssuranceState;
  readonly originalDigest: string;
  readonly replayedDigest: string;
  readonly explanation: string;
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
  async function buildInput(
    control: ControlRow,
    ruleset: Ruleset,
    asOfIso: string,
  ): Promise<ControlAssessmentInput> {
    const rule = ruleset.rules.find((r) => r.key === control.ruleKey);
    if (!rule) {
      throw new AdericelError('RULESET_NOT_FOUND', `Rule ${control.ruleKey} not found`, {
        safeDetails: { rulesetKey: ruleset.key, rulesetVersion: ruleset.version, ruleKey: control.ruleKey },
      });
    }
    const predicates = ruleRequiredPredicates(rule);

    const subjectRows =
      rule.subjectKinds.length === 0
        ? []
        : await ctx.many<{ id: string; kind: string; label: string; attributes: Record<string, unknown> }>(
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
      activeExceptions: exceptionRows.map((row) => ({
        id: row.id,
        subjectNodeId: row.subject_node_id,
        justification: row.justification,
        expiresAt: row.expires_at.toISOString(),
      })),
    };
  }

  async function persist(
    subjectKind: AssessmentSubjectKind,
    subjectId: string,
    nodeId: string | null,
    outcome: {
      state: AssuranceState;
      unknownReason: UnknownReason | null;
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
  ): Promise<{ assessment: AssessmentRecord; previousState: AssuranceState | null; changed: boolean }> {
    const previous = await ctx.one<{ state: string; assessment_id: string; since: Date }>(
      `SELECT state, assessment_id, since FROM assurance_states
       WHERE organisation_id = $1 AND subject_kind = $2 AND subject_id = $3`,
      [ctx.organisationId, subjectKind, subjectId],
    );
    const previousState = (previous?.state as AssuranceState | undefined) ?? null;
    const changed = previousState !== outcome.state;

    const inserted = await ctx.oneOrFail<{ id: string; created_at: Date }>(
      `INSERT INTO assessments
         (organisation_id, node_id, subject_kind, subject_id, state, unknown_reason, rationale,
          reasoning, trigger, engine_version, ruleset_key, ruleset_version, ruleset_hash, rule_key,
          input_digest, evidence_ids, claim_ids, previous_assessment_id, state_changed, assessed_at,
          correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15,
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
      ],
      'Assessment',
    );

    await ctx.query(
      `INSERT INTO assurance_states
         (organisation_id, subject_kind, subject_id, state, unknown_reason, assessment_id,
          previous_state, since, last_assessed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (organisation_id, subject_kind, subject_id) DO UPDATE SET
         state = EXCLUDED.state,
         unknown_reason = EXCLUDED.unknown_reason,
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
        outcome.failingSubjects.map((s) => ({ nodeId: s.nodeId, label: s.label, detail: s.detail })),
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
      const rows = await ctx.many<{ state: string }>(
        `SELECT a.state
         FROM control_requirements cr
         JOIN assurance_states a
           ON a.organisation_id = cr.organisation_id
          AND a.subject_kind = 'CONTROL' AND a.subject_id = cr.control_id
         WHERE cr.organisation_id = $1 AND cr.requirement_id = $2`,
        [ctx.organisationId, requirementId],
      );
      return rollUp('REQUIREMENT', requirementId, rows.map((r) => r.state as AssuranceState), asOfIso);
    },

    async rollUpFramework(frameworkId, asOf): Promise<AssessmentOutput | null> {
      const asOfIso = asOf ?? clock.nowIso();
      const rows = await ctx.many<{ state: string }>(
        `SELECT a.state
         FROM requirements r
         JOIN assurance_states a
           ON a.subject_kind = 'REQUIREMENT' AND a.subject_id = r.id AND a.organisation_id = $1
         WHERE r.framework_id = $2`,
        [ctx.organisationId, frameworkId],
      );
      return rollUp('FRAMEWORK', frameworkId, rows.map((r) => r.state as AssuranceState), asOfIso);
    },

    async rollUpOrganisation(asOf): Promise<AssessmentOutput | null> {
      const asOfIso = asOf ?? clock.nowIso();
      const rows = await ctx.many<{ state: string }>(
        `SELECT state FROM assurance_states
         WHERE organisation_id = $1 AND subject_kind = 'FRAMEWORK'`,
        [ctx.organisationId],
      );
      const states = rows.map((r) => r.state as AssuranceState);
      return rollUp('ORGANISATION', ctx.organisationId, states, asOfIso);
    },

    async replay(assessmentId): Promise<ReplayResult> {
      const row = await ctx.oneOrFail<{
        id: string;
        subject_kind: string;
        subject_id: string;
        state: string;
        ruleset_key: string;
        ruleset_version: string;
        input_digest: string;
        assessed_at: Date;
      }>(
        `SELECT id, subject_kind, subject_id, state, ruleset_key, ruleset_version, input_digest, assessed_at
         FROM assessments WHERE id = $1 AND organisation_id = $2`,
        [assessmentId, ctx.organisationId],
        'Assessment',
      );

      if (row.subject_kind !== 'CONTROL') {
        throw new AdericelError('PRECONDITION_FAILED', 'Only control assessments can be replayed');
      }

      const control = await loadControl(row.subject_id);
      const ruleset = rulesets.tryGet(row.ruleset_key, row.ruleset_version);
      if (!ruleset) {
        return {
          assessmentId,
          reproduced: false,
          originalState: row.state as AssuranceState,
          replayedState: 'UNKNOWN',
          originalDigest: row.input_digest,
          replayedDigest: '',
          explanation:
            `Ruleset ${row.ruleset_key}@${row.ruleset_version} is no longer available in this build, ` +
            'so the assessment cannot be reproduced. Deploy the archived ruleset version to replay it.',
        };
      }

      const asOfIso = row.assessed_at.toISOString();
      const input = await buildInput(control, ruleset, asOfIso);
      const outcome = assessControl(ruleset, input);

      const digestMatches = outcome.provenance.inputDigest === row.input_digest;
      const stateMatches = outcome.state === row.state;

      return {
        assessmentId,
        reproduced: digestMatches && stateMatches,
        originalState: row.state as AssuranceState,
        replayedState: outcome.state,
        originalDigest: row.input_digest,
        replayedDigest: outcome.provenance.inputDigest,
        explanation: digestMatches
          ? stateMatches
            ? 'Reproduced exactly: identical inputs produced an identical determination.'
            : 'Inputs match but the determination differs. This indicates an engine defect and should be escalated.'
          : 'Inputs have changed since the original assessment, so the historical determination cannot be ' +
            'reproduced from current data. The original assessment record remains authoritative for that instant.',
      };
    },
  };

  async function rollUp(
    subjectKind: AssessmentSubjectKind,
    subjectId: string,
    states: readonly AssuranceState[],
    asOfIso: string,
  ): Promise<AssessmentOutput | null> {
    const aggregate = aggregateAssurance(states);
    const reasoning: ReasoningStep[] = [
      {
        step: 'aggregate',
        outcome:
          aggregate.state === 'NOT_SATISFIED'
            ? 'FAIL'
            : aggregate.state === 'UNKNOWN'
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
        rationale:
          aggregate.state === 'UNKNOWN'
            ? `Cannot be determined: ${aggregate.counts.UNKNOWN} of ${aggregate.inScope} child subject(s) are unknown.`
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
