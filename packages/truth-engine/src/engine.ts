import {
  evaluateEvidenceUsability,
  isRuleEligible,
  type AssuranceState,
  type ClaimOrigin,
  type ClaimStatus,
  type EvidenceSourceType,
  type EvidenceStatus,
  type ReasoningStep,
  type Severity,
  type UnknownReason,
} from '@adericel/domain';
import { contentHash } from '@adericel/shared';
import { evaluate, type EvaluationContext, type ResolvedClaim } from './expression.js';
import { ENGINE_VERSION, findRule, type Rule, type Ruleset } from './ruleset.js';
import type { Trilean } from './kleene.js';

/**
 * The Adericel Truth Engine.
 *
 * Properties this module guarantees, and which its tests assert:
 *
 *  - Deterministic. No clock, no randomness, no network, no database. `asOfIso`
 *    is an input.
 *  - Replayable. Given the same inputs and the same ruleset hash, the output is
 *    byte-identical, and `inputDigest` proves which facts were used.
 *  - Honest about uncertainty. UNKNOWN is produced whenever the evidence does
 *    not support a stronger statement, and never silently converted.
 *  - Independent of AI. LLM-derived claims are excluded unless confirmed, which
 *    is enforced here rather than trusted to callers.
 */

export interface EvidenceFacts {
  readonly id: string;
  readonly status: EvidenceStatus;
  readonly sourceType: EvidenceSourceType;
  readonly observedAt: string | null;
  readonly collectedAt: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface ClaimFacts {
  readonly id: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly origin: ClaimOrigin;
  readonly status: ClaimStatus;
  readonly observedAt: string | null;
  readonly assertedAt: string;
  readonly validUntil: string | null;
  readonly evidenceIds: readonly string[];
}

export interface SubjectFacts {
  readonly nodeId: string;
  readonly kind: string;
  readonly label: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly claims: readonly ClaimFacts[];
}

export interface ExceptionFacts {
  readonly id: string;
  /** Null means the exception covers the whole control. */
  readonly subjectNodeId: string | null;
  readonly justification: string;
  readonly expiresAt: string;
}

export interface ControlAssessmentInput {
  readonly organisationId: string;
  readonly controlId: string;
  readonly controlKey: string;
  readonly ruleKey: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly asOfIso: string;
  readonly subjects: readonly SubjectFacts[];
  /** Claims not attached to a subject; used by SINGLE-aggregation rules. */
  readonly organisationClaims: readonly ClaimFacts[];
  readonly evidence: readonly EvidenceFacts[];
  readonly activeExceptions: readonly ExceptionFacts[];
}

export interface SubjectOutcome {
  readonly nodeId: string;
  readonly label: string;
  readonly kind: string;
  readonly value: Trilean;
  readonly inScope: boolean;
  readonly excepted: boolean;
  readonly missingPredicates: readonly string[];
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly detail: string;
}

export interface AssessmentProvenanceOut {
  readonly engineVersion: string;
  readonly rulesetKey: string;
  readonly rulesetVersion: string;
  readonly rulesetHash: string;
  readonly ruleKey: string;
  readonly inputDigest: string;
  readonly assessedAt: string;
}

export interface AssessmentOutcome {
  readonly state: AssuranceState;
  readonly unknownReason: UnknownReason | null;
  readonly rationale: string;
  readonly reasoning: readonly ReasoningStep[];
  readonly severity: Severity;
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly subjectOutcomes: readonly SubjectOutcome[];
  readonly failingSubjects: readonly SubjectOutcome[];
  readonly unknownSubjects: readonly SubjectOutcome[];
  readonly provenance: AssessmentProvenanceOut;
}

/**
 * Turn raw claim facts into resolvable claims, discarding those that may not be
 * relied upon and recording exactly why.
 *
 * Three gates apply, in order:
 *   1. Claim eligibility — an unconfirmed AI suggestion is never a fact.
 *   2. Claim validity — an expired claim is not current.
 *   3. Evidence usability — a claim whose supporting evidence is stale, revoked
 *      or superseded loses its standing, even though the claim row is intact.
 */
function resolveClaims(
  claims: readonly ClaimFacts[],
  evidenceById: ReadonlyMap<string, EvidenceFacts>,
  asOfIso: string,
  maxEvidenceAgeDays: number | null,
): Map<string, ResolvedClaim> {
  const asOf = Date.parse(asOfIso);

  const assess = (claim: ClaimFacts): string | null => {
    const eligibility = isRuleEligible(claim);
    if (!eligibility.eligible) return eligibility.reason;

    if (claim.validUntil !== null && Date.parse(claim.validUntil) <= asOf) {
      return 'Claim validity period has ended';
    }

    if (claim.evidenceIds.length === 0) return null;

    const usability = claim.evidenceIds.map((id) => {
      const evidence = evidenceById.get(id);
      if (!evidence) {
        return { usable: false, reason: `Supporting evidence ${id} is not available` };
      }
      const result = evaluateEvidenceUsability(
        evidence,
        asOfIso,
        maxEvidenceAgeDays === null
          ? undefined
          : { maxAgeDays: maxEvidenceAgeDays, warnAfterDays: Math.floor(maxEvidenceAgeDays * 0.75) },
      );
      return { usable: result.usable, reason: result.reason };
    });
    // A claim stands if at least one piece of its evidence still stands.
    if (usability.some((u) => u.usable)) return null;
    return usability.find((u) => u.reason !== null)?.reason ?? 'No usable supporting evidence';
  };

  // Several claims may share a predicate (a re-collection that has not yet been
  // superseded, or a human assertion alongside an integration one). Prefer the
  // most recently asserted usable claim; if none is usable, keep the most
  // recent unusable one so the reason can be reported rather than swallowed.
  const byPredicate = new Map<string, { claim: ClaimFacts; unusableReason: string | null }[]>();
  for (const claim of claims) {
    const bucket = byPredicate.get(claim.predicate) ?? [];
    bucket.push({ claim, unusableReason: assess(claim) });
    byPredicate.set(claim.predicate, bucket);
  }

  const resolved = new Map<string, ResolvedClaim>();
  for (const [predicate, candidates] of byPredicate) {
    const ranked = [...candidates].sort((a, b) => {
      const usableDelta =
        Number(a.unusableReason !== null) - Number(b.unusableReason !== null);
      if (usableDelta !== 0) return usableDelta;
      const timeDelta = Date.parse(b.claim.assertedAt) - Date.parse(a.claim.assertedAt);
      if (timeDelta !== 0) return timeDelta;
      // Total ordering, so the engine is deterministic even for identical timestamps.
      return a.claim.id.localeCompare(b.claim.id);
    });
    const winner = ranked[0];
    if (!winner) continue;
    resolved.set(predicate, {
      claimId: winner.claim.id,
      predicate,
      value: winner.claim.value,
      evidenceIds: winner.claim.evidenceIds,
      unusableReason: winner.unusableReason,
    });
  }

  return resolved;
}

function unknownReasonFor(
  missingPredicates: readonly string[],
  claims: ReadonlyMap<string, ResolvedClaim>,
  hadAnyClaims: boolean,
): UnknownReason {
  if (!hadAnyClaims) return 'NO_EVIDENCE';
  for (const predicate of missingPredicates) {
    const claim = claims.get(predicate);
    if (!claim) continue;
    const reason = claim.unusableReason ?? '';
    if (reason.includes('revoked')) return 'EVIDENCE_REVOKED';
    if (reason.includes('stale') || reason.includes('days old') || reason.includes('validity period')) {
      return 'STALE_EVIDENCE';
    }
    if (reason.includes('AI-suggested')) return 'INSUFFICIENT_EVIDENCE';
  }
  return missingPredicates.length > 0 ? 'INSUFFICIENT_EVIDENCE' : 'RULE_INPUTS_MISSING';
}

/**
 * Compute the digest of everything that influenced the determination.
 *
 * Replay compares this digest: if it matches, the same facts were used, and any
 * difference in outcome must come from the ruleset or the engine, both of which
 * are separately versioned.
 */
function computeInputDigest(input: ControlAssessmentInput, ruleset: Ruleset, rule: Rule): string {
  return contentHash({
    organisationId: input.organisationId,
    controlId: input.controlId,
    ruleKey: rule.key,
    rulesetHash: ruleset.hash,
    engineVersion: ENGINE_VERSION,
    asOf: input.asOfIso,
    parameters: { ...rule.defaultParameters, ...input.parameters },
    subjects: [...input.subjects]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map((subject) => ({
        nodeId: subject.nodeId,
        kind: subject.kind,
        attributes: subject.attributes,
        claims: [...subject.claims]
          .sort((a, b) => a.predicate.localeCompare(b.predicate))
          .map((claim) => ({
            predicate: claim.predicate,
            value: claim.value,
            origin: claim.origin,
            status: claim.status,
            evidenceIds: [...claim.evidenceIds].sort(),
            validUntil: claim.validUntil,
          })),
      })),
    organisationClaims: [...input.organisationClaims]
      .sort((a, b) => a.predicate.localeCompare(b.predicate))
      .map((claim) => ({
        predicate: claim.predicate,
        value: claim.value,
        origin: claim.origin,
        status: claim.status,
        evidenceIds: [...claim.evidenceIds].sort(),
      })),
    evidence: [...input.evidence]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        status: e.status,
        sourceType: e.sourceType,
        observedAt: e.observedAt,
        collectedAt: e.collectedAt,
        validFrom: e.validFrom,
        validUntil: e.validUntil,
      })),
    exceptions: [...input.activeExceptions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({ id: e.id, subjectNodeId: e.subjectNodeId, expiresAt: e.expiresAt })),
  });
}

/** Evaluate one control against one ruleset rule. Pure. */
export function assessControl(
  ruleset: Ruleset,
  input: ControlAssessmentInput,
): AssessmentOutcome {
  const rule = findRule(ruleset, input.ruleKey);
  const parameters = { ...rule.defaultParameters, ...input.parameters };
  const asOfEpochMs = Date.parse(input.asOfIso);
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]));
  const inputDigest = computeInputDigest(input, ruleset, rule);

  const provenance: AssessmentProvenanceOut = {
    engineVersion: ENGINE_VERSION,
    rulesetKey: ruleset.key,
    rulesetVersion: ruleset.version,
    rulesetHash: ruleset.hash,
    ruleKey: rule.key,
    inputDigest,
    assessedAt: input.asOfIso,
  };

  const reasoning: ReasoningStep[] = [];
  const allClaimIds = new Set<string>();
  const allEvidenceIds = new Set<string>();

  // A control-wide exception short-circuits evaluation, but the exception is
  // itself recorded as the reason so nobody mistakes it for a passing control.
  const controlException = input.activeExceptions.find((e) => e.subjectNodeId === null);
  if (controlException) {
    return {
      state: 'EXCEPTED',
      unknownReason: null,
      rationale: `Control ${input.controlKey} is covered by an authorised exception expiring ${controlException.expiresAt}: ${controlException.justification}`,
      reasoning: [
        {
          step: 'exception',
          outcome: 'SKIPPED',
          detail: `Exception ${controlException.id} applies to the whole control until ${controlException.expiresAt}`,
        },
      ],
      severity: rule.severity,
      claimIds: [],
      evidenceIds: [],
      subjectOutcomes: [],
      failingSubjects: [],
      unknownSubjects: [],
      provenance,
    };
  }

  const exceptedSubjects = new Set(
    input.activeExceptions
      .map((e) => e.subjectNodeId)
      .filter((id): id is string => id !== null),
  );

  // ---- Organisation-level rule (SINGLE aggregation) -----------------------
  if (rule.aggregation === 'SINGLE' || rule.subjectKinds.length === 0) {
    const claims = resolveClaims(
      input.organisationClaims,
      evidenceById,
      input.asOfIso,
      rule.maxEvidenceAgeDays,
    );
    const ctx: EvaluationContext = {
      claims,
      parameters,
      facts: { organisationId: input.organisationId },
      asOfEpochMs,
    };
    const result = evaluate(rule.expression, ctx);
    for (const id of result.claimIds) allClaimIds.add(id);
    for (const id of result.evidenceIds) allEvidenceIds.add(id);

    const state: AssuranceState =
      result.value === 'TRUE' ? 'SATISFIED' : result.value === 'FALSE' ? 'NOT_SATISFIED' : 'UNKNOWN';

    reasoning.push({
      step: rule.key,
      outcome: result.value === 'TRUE' ? 'PASS' : result.value === 'FALSE' ? 'FAIL' : 'UNKNOWN',
      detail:
        result.value === 'UNKNOWN'
          ? `Cannot determine: missing or unusable inputs (${result.missingPredicates.join(', ') || 'none recorded'})`
          : rule.title,
      claimIds: result.claimIds,
      evidenceIds: result.evidenceIds,
    });

    return {
      state,
      unknownReason:
        state === 'UNKNOWN'
          ? unknownReasonFor(result.missingPredicates, claims, input.organisationClaims.length > 0)
          : null,
      rationale:
        state === 'SATISFIED'
          ? `${rule.title}: satisfied.`
          : state === 'NOT_SATISFIED'
            ? `${rule.failureTitle} ${rule.failureDescription}`
            : `${rule.title}: cannot be determined. ${describeMissing(result.missingPredicates, claims)}`,
      reasoning,
      severity: rule.severity,
      claimIds: [...allClaimIds].sort(),
      evidenceIds: [...allEvidenceIds].sort(),
      subjectOutcomes: [],
      failingSubjects: [],
      unknownSubjects: [],
      provenance,
    };
  }

  // ---- Per-subject rule ---------------------------------------------------
  const inScopeKinds = new Set(rule.subjectKinds);
  const outcomes: SubjectOutcome[] = [];

  for (const subject of input.subjects) {
    if (!inScopeKinds.has(subject.kind)) continue;

    const claims = resolveClaims(subject.claims, evidenceById, input.asOfIso, rule.maxEvidenceAgeDays);
    const ctx: EvaluationContext = {
      claims,
      parameters,
      facts: { ...subject.attributes, nodeId: subject.nodeId, kind: subject.kind, label: subject.label },
      asOfEpochMs,
    };

    if (rule.applicability) {
      const applicable = evaluate(rule.applicability, ctx);
      if (applicable.value === 'FALSE') {
        outcomes.push({
          nodeId: subject.nodeId,
          label: subject.label,
          kind: subject.kind,
          value: 'TRUE',
          inScope: false,
          excepted: false,
          missingPredicates: [],
          claimIds: applicable.claimIds,
          evidenceIds: applicable.evidenceIds,
          detail: 'Rule does not apply to this subject',
        });
        continue;
      }
      // An applicability check we cannot resolve leaves the subject in scope and
      // unknown, rather than quietly excluding it from the denominator.
      if (applicable.value === 'UNKNOWN') {
        outcomes.push({
          nodeId: subject.nodeId,
          label: subject.label,
          kind: subject.kind,
          value: 'UNKNOWN',
          inScope: true,
          excepted: false,
          missingPredicates: applicable.missingPredicates,
          claimIds: applicable.claimIds,
          evidenceIds: applicable.evidenceIds,
          detail: 'Cannot determine whether this rule applies to the subject',
        });
        for (const id of applicable.claimIds) allClaimIds.add(id);
        for (const id of applicable.evidenceIds) allEvidenceIds.add(id);
        continue;
      }
    }

    if (exceptedSubjects.has(subject.nodeId)) {
      outcomes.push({
        nodeId: subject.nodeId,
        label: subject.label,
        kind: subject.kind,
        value: 'TRUE',
        inScope: true,
        excepted: true,
        missingPredicates: [],
        claimIds: [],
        evidenceIds: [],
        detail: 'Covered by an authorised exception',
      });
      continue;
    }

    const result = evaluate(rule.expression, ctx);
    for (const id of result.claimIds) allClaimIds.add(id);
    for (const id of result.evidenceIds) allEvidenceIds.add(id);

    outcomes.push({
      nodeId: subject.nodeId,
      label: subject.label,
      kind: subject.kind,
      value: result.value,
      inScope: true,
      excepted: false,
      missingPredicates: result.missingPredicates,
      claimIds: result.claimIds,
      evidenceIds: result.evidenceIds,
      detail:
        result.value === 'TRUE'
          ? 'Satisfied'
          : result.value === 'FALSE'
            ? rule.failureTitle
            : describeMissing(result.missingPredicates, claims),
    });
  }

  const inScope = outcomes.filter((o) => o.inScope);
  const passing = inScope.filter((o) => o.value === 'TRUE');
  const failing = inScope.filter((o) => o.value === 'FALSE');
  const unknown = inScope.filter((o) => o.value === 'UNKNOWN');

  const state = aggregateSubjects(rule, inScope.length, passing.length, failing.length, unknown.length);

  reasoning.push({
    step: `${rule.key}:scope`,
    outcome: inScope.length === 0 ? 'SKIPPED' : 'PASS',
    detail: `${inScope.length} subject(s) in scope of kinds ${rule.subjectKinds.join(', ')}`,
  });
  reasoning.push({
    step: `${rule.key}:evaluation`,
    outcome: failing.length > 0 ? 'FAIL' : unknown.length > 0 ? 'UNKNOWN' : 'PASS',
    detail: `${passing.length} satisfied, ${failing.length} not satisfied, ${unknown.length} unknown`,
    claimIds: [...allClaimIds].sort(),
    evidenceIds: [...allEvidenceIds].sort(),
  });

  const allMissing = [...new Set(unknown.flatMap((o) => o.missingPredicates))].sort();

  return {
    state,
    unknownReason:
      state === 'UNKNOWN'
        ? inScope.length === 0
          ? 'NO_EVIDENCE'
          : unknown.length === inScope.length && allMissing.length === 0
            ? 'RULE_INPUTS_MISSING'
            : 'INSUFFICIENT_EVIDENCE'
        : null,
    rationale: buildRationale(rule, state, inScope.length, passing.length, failing.length, unknown.length, allMissing),
    reasoning,
    severity: rule.severity,
    claimIds: [...allClaimIds].sort(),
    evidenceIds: [...allEvidenceIds].sort(),
    subjectOutcomes: outcomes,
    failingSubjects: failing,
    unknownSubjects: unknown,
    provenance,
  };
}

/**
 * Aggregate per-subject outcomes.
 *
 * The unknown-tolerance check runs BEFORE the pass/fail decision, because a
 * control assessed over subjects we cannot see is not a satisfied control, no
 * matter how well the visible subjects score.
 */
function aggregateSubjects(
  rule: Rule,
  inScope: number,
  passing: number,
  failing: number,
  unknown: number,
): AssuranceState {
  if (inScope === 0) return 'NOT_APPLICABLE';

  const unknownRatio = unknown / inScope;
  if (unknownRatio > rule.unknownTolerance && failing === 0) return 'UNKNOWN';

  switch (rule.aggregation) {
    case 'ALL':
      if (failing > 0) return 'NOT_SATISFIED';
      return unknown > 0 ? 'UNKNOWN' : 'SATISFIED';
    case 'ANY':
      if (passing > 0) return 'SATISFIED';
      return unknown > 0 ? 'UNKNOWN' : 'NOT_SATISFIED';
    case 'THRESHOLD': {
      const ratio = passing / inScope;
      if (ratio >= rule.threshold) return unknown > 0 ? 'PARTIALLY_SATISFIED' : 'SATISFIED';
      if (ratio > 0) return 'PARTIALLY_SATISFIED';
      return failing > 0 ? 'NOT_SATISFIED' : 'UNKNOWN';
    }
    case 'SINGLE':
      return failing > 0 ? 'NOT_SATISFIED' : unknown > 0 ? 'UNKNOWN' : 'SATISFIED';
  }
}

function describeMissing(
  missing: readonly string[],
  claims: ReadonlyMap<string, ResolvedClaim>,
): string {
  if (missing.length === 0) return 'Required inputs were not available.';
  const parts = missing.map((predicate) => {
    const claim = claims.get(predicate);
    return claim?.unusableReason ? `${predicate} (${claim.unusableReason})` : `${predicate} (no claim recorded)`;
  });
  return `Missing or unusable: ${parts.join('; ')}.`;
}

function buildRationale(
  rule: Rule,
  state: AssuranceState,
  inScope: number,
  passing: number,
  failing: number,
  unknown: number,
  missing: readonly string[],
): string {
  switch (state) {
    case 'SATISFIED':
      return `${rule.title}: all ${inScope} in-scope subject(s) satisfy the control.`;
    case 'PARTIALLY_SATISFIED':
      return `${rule.title}: ${passing} of ${inScope} subject(s) satisfy the control (${failing} failing, ${unknown} unknown).`;
    case 'NOT_SATISFIED':
      return `${rule.failureTitle} ${rule.failureDescription} ${failing} of ${inScope} subject(s) do not satisfy the control.`;
    case 'NOT_APPLICABLE':
      return `${rule.title}: no subjects of kind ${rule.subjectKinds.join(', ')} are in scope.`;
    case 'EXCEPTED':
      return `${rule.title}: covered by an authorised exception.`;
    case 'UNKNOWN':
      return `${rule.title}: cannot be determined for ${unknown} of ${inScope} subject(s).${
        missing.length > 0 ? ` Missing inputs: ${missing.join(', ')}.` : ''
      }`;
  }
}

export { ENGINE_VERSION };
