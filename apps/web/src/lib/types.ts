import type { AssuranceState, Severity } from './assurance-presentation.js';

/** API response shapes the interface consumes. */

export interface Me {
  principal: { type: string; id: string; displayName: string; email: string | null; mspId: string | null };
  grants: { scopeType: string; scopeId: string | null; roles: string[]; expiresAt: string | null }[];
  permissions: string[];
  organisations: { id: string; name: string; slug: string; mspId: string | null }[];
  msps: { id: string; name: string; slug: string }[];
  serverTime: string;
}

export interface StateCounts {
  SATISFIED: number;
  PARTIALLY_SATISFIED: number;
  NOT_SATISFIED: number;
  EXCEPTED: number;
  NOT_APPLICABLE: number;
  UNKNOWN: number;
}

export interface PortfolioOrganisation {
  organisationId: string;
  name: string;
  slug: string;
  status: string;
  state: AssuranceState;
  counts: StateCounts;
  coverage: number;
  satisfactionOfKnown: number | null;
  criticalFindings: number;
  highFindings: number;
  openFindings: number;
  oldestFindingDays: number | null;
  staleEvidence: number;
  awaitingApproval: number;
  unverifiedActions: number;
  failedIntegrations: number;
  degradedIntegrations: number;
  lastAssessedAt: string | null;
}

export interface Portfolio {
  mspId: string;
  organisationCount: number;
  totals: {
    criticalFindings: number;
    openFindings: number;
    unknownControls: number;
    failingControls: number;
    awaitingApproval: number;
    unverifiedActions: number;
    staleEvidence: number;
    failedIntegrations: number;
    degradedIntegrations: number;
  };
  organisations: PortfolioOrganisation[];
}

export interface AssuranceSummary {
  organisationId: string;
  state: AssuranceState;
  counts: StateCounts;
  inScope: number;
  coverage: number;
  satisfactionOfKnown: number | null;
  frameworks: { id: string; key: string; name: string; state: AssuranceState }[];
  controls: {
    id: string;
    key: string;
    title: string;
    state: AssuranceState;
    unknownReason: string | null;
    since: string;
    lastAssessedAt: string;
  }[];
  openFindings: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    oldestDetectedAt: string | null;
  };
  evidence: { total: number; expiringWithin7Days: number; expired: number };
  actions: { awaitingApproval: number; unverified: number };
}

export interface ReasoningStep {
  step: string;
  outcome: 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIPPED';
  detail: string;
}

export interface ControlExplanation {
  control: { id: string; key: string; title: string; description: string | null; enabled: boolean; parameters: Record<string, unknown> };
  state: AssuranceState;
  unknownReason: string | null;
  rationale: string;
  reasoning: ReasoningStep[];
  assessment: {
    id: string;
    trigger: string;
    assessedAt: string;
    stateChanged: boolean;
    provenance: {
      engineVersion: string;
      rulesetKey: string;
      rulesetVersion: string;
      rulesetHash: string;
      ruleKey: string;
      inputDigest: string;
    };
  } | null;
  rule: {
    key: string;
    title: string;
    description: string;
    severity: Severity;
    aggregation: string;
    subjectKinds: string[];
    maxEvidenceAgeDays: number | null;
    requiredWhenFailing: string;
    remediation: { actionType: string; riskClass: string; rationale: string } | null;
  } | null;
  evidence: {
    id: string;
    title: string;
    sourceSystem: string;
    sourceType: string;
    integrityLevel: string;
    status: string;
    observedAt: string | null;
    collectedAt: string;
    validUntil: string | null;
    contentHash: string;
  }[];
  claims: {
    id: string;
    predicate: string;
    value: unknown;
    origin: string;
    status: string;
    subject: string | null;
    assertedAt: string;
  }[];
  openFindings: { id: string; title: string; severity: Severity; status: string; firstDetectedAt: string }[];
  activeExceptions: { id: string; justification: string; expiresAt: string; subjectNodeId: string | null }[];
  requirements: { id: string; key: string; title: string; framework: string }[];
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  status: string;
  control: { id: string; key: string | null } | null;
  subject: string | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
  resolvedAt: string | null;
  ageDays: number;
  openActions: number;
}

export interface ActionSummary {
  id: string;
  actionType: string;
  riskClass: string;
  state: string;
  target: string | null;
  rationale: string;
  proposedBy: string;
  autonomyLevel: number | null;
  finding: { id: string; title: string | null } | null;
  approvals: { required: number; recorded: number } | null;
  proposedAt: string;
  executedAt: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
}

export interface EvidenceItem {
  id: string;
  title: string;
  sourceSystem: string;
  sourceType: string;
  collectionMethod: string;
  integrityLevel: string;
  status: string;
  usable: boolean;
  usabilityReason: string | null;
  freshness: string;
  ageDays: number;
  contentHash: string;
  contentType: string;
  contentSizeBytes: number | null;
  hasStoredArtefact: boolean;
  observedAt: string | null;
  collectedAt: string;
  validFrom: string;
  validUntil: string | null;
  collectedByActor: string;
}

export interface AuditEntry {
  id: string;
  actorDisplay: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  reason: string | null;
  correlationId: string | null;
  occurredAt: string;
}

export interface GraphNodeSummary {
  id: string;
  kind: string;
  label: string;
  externalId: string | null;
  lifecycleState: string;
  lastObservedAt: string | null;
  attributes: Record<string, unknown>;
}
