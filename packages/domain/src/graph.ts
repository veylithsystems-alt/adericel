import { z } from 'zod';

/**
 * The Organisational Assurance Graph (OAG).
 *
 * Nodes and edges are the canonical representation. Every other projection —
 * dashboards, reports, exports — is derived from this graph, never the other
 * way round. Relationships are first-class: an evidence item is meaningless
 * without the edges that say what it evidences and which control it supports.
 */
export const NODE_KINDS = [
  'Organisation',
  'Person',
  'Identity',
  'Device',
  'Application',
  'Service',
  'Infrastructure',
  'CloudResource',
  'DataAsset',
  'Supplier',
  'Policy',
  'Requirement',
  'Control',
  'Framework',
  'Evidence',
  'Claim',
  'Observation',
  'Assessment',
  'Finding',
  'Risk',
  'Exception',
  'Decision',
  'Action',
  'Verification',
  'Integration',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export const nodeKindSchema = z.enum(NODE_KINDS);

/** Node kinds that represent things in the organisation's real environment. */
export const ASSET_KINDS: readonly NodeKind[] = [
  'Person',
  'Identity',
  'Device',
  'Application',
  'Service',
  'Infrastructure',
  'CloudResource',
  'DataAsset',
  'Supplier',
];

export function isAssetKind(kind: NodeKind): boolean {
  return ASSET_KINDS.includes(kind);
}

export const EDGE_KINDS = [
  'OWNS',
  'AUTHENTICATES',
  'USES',
  'RUNS_ON',
  'PROCESSES',
  'DEPENDS_ON',
  'SUPPLIED_BY',
  'PROTECTS',
  'SATISFIES',
  'IMPLEMENTS',
  'PART_OF',
  'DERIVED_FROM',
  'OBSERVES',
  'EVIDENCED_BY',
  'SUPPORTS',
  'CONTRADICTS',
  'ASSESSES',
  'PRODUCED',
  'RAISED',
  'CONCERNS',
  'MITIGATES',
  'REMEDIATES',
  'AUTHORISES',
  'APPROVED_BY',
  'VERIFIES',
  'SUPERSEDES',
  'EXCEPTS',
  'COLLECTED_BY',
  'SCOPED_TO',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];
export const edgeKindSchema = z.enum(EDGE_KINDS);

/**
 * Which edges are structurally legal. Enforced on write so the graph cannot
 * drift into shapes the traversal and explanation code does not understand.
 */
export interface EdgeRule {
  readonly kind: EdgeKind;
  readonly from: readonly NodeKind[];
  readonly to: readonly NodeKind[];
  readonly description: string;
}

export const EDGE_RULES: readonly EdgeRule[] = [
  {
    kind: 'OWNS',
    from: ['Organisation', 'Person'],
    to: [...ASSET_KINDS],
    description: 'Ownership of an asset within the organisation.',
  },
  {
    kind: 'AUTHENTICATES',
    from: ['Person'],
    to: ['Identity'],
    description: 'A person authenticates via an identity.',
  },
  {
    kind: 'USES',
    from: ['Identity', 'Person'],
    to: ['Device', 'Application', 'Service', 'CloudResource'],
    description: 'Usage relationship between an actor and a resource.',
  },
  {
    kind: 'RUNS_ON',
    from: ['Application', 'Service'],
    to: ['Device', 'Service', 'Infrastructure', 'CloudResource'],
    description: 'Deployment relationship.',
  },
  {
    kind: 'PROCESSES',
    from: ['Application', 'Service', 'Supplier'],
    to: ['DataAsset'],
    description: 'Processing of a data asset.',
  },
  {
    kind: 'DEPENDS_ON',
    from: ['Application', 'Service', 'Infrastructure', 'CloudResource', 'Organisation'],
    to: ['Application', 'Service', 'Infrastructure', 'CloudResource', 'Supplier'],
    description: 'Operational dependency.',
  },
  {
    kind: 'SUPPLIED_BY',
    from: [...ASSET_KINDS],
    to: ['Supplier'],
    description: 'Asset provided by a third party.',
  },
  {
    kind: 'PROTECTS',
    from: ['Control'],
    to: [...ASSET_KINDS, 'Organisation'],
    description: 'Scope of a control.',
  },
  {
    kind: 'SATISFIES',
    from: ['Control'],
    to: ['Requirement'],
    description: 'A control contributes to satisfying a requirement.',
  },
  {
    kind: 'IMPLEMENTS',
    from: ['Requirement'],
    to: ['Framework'],
    description: 'A requirement belongs to a framework.',
  },
  {
    kind: 'PART_OF',
    from: [...NODE_KINDS],
    to: ['Organisation', 'Framework', 'Requirement', 'Control', 'Risk'],
    description: 'Structural containment.',
  },
  {
    kind: 'DERIVED_FROM',
    from: ['Claim', 'Evidence', 'Observation', 'Assessment'],
    to: ['Claim', 'Evidence', 'Observation', 'Assessment'],
    description: 'Derivation lineage between artefacts.',
  },
  {
    kind: 'OBSERVES',
    from: ['Observation'],
    to: [...ASSET_KINDS, 'Organisation', 'Control', 'Policy'],
    description: 'What an observation was about.',
  },
  {
    kind: 'EVIDENCED_BY',
    from: ['Claim'],
    to: ['Evidence'],
    description: 'The evidence a claim rests on.',
  },
  {
    kind: 'SUPPORTS',
    from: ['Claim', 'Evidence'],
    to: ['Control', 'Requirement', 'Claim'],
    description: 'Positive support for a control or requirement.',
  },
  {
    kind: 'CONTRADICTS',
    from: ['Claim', 'Evidence'],
    to: ['Claim', 'Evidence'],
    description: 'Recorded conflict between two artefacts.',
  },
  {
    kind: 'ASSESSES',
    from: ['Assessment'],
    to: ['Control', 'Requirement', 'Framework', 'Organisation'],
    description: 'The subject of an assessment.',
  },
  {
    kind: 'PRODUCED',
    from: ['Integration', 'Assessment', 'Verification', 'Action'],
    to: ['Observation', 'Evidence', 'Finding', 'Claim'],
    description: 'Production lineage.',
  },
  {
    kind: 'RAISED',
    from: ['Assessment'],
    to: ['Finding'],
    description: 'An assessment raised a finding.',
  },
  {
    kind: 'CONCERNS',
    from: ['Finding', 'Risk'],
    to: [...ASSET_KINDS, 'Control', 'Requirement', 'Organisation'],
    description: 'What a finding or risk is about.',
  },
  {
    kind: 'MITIGATES',
    from: ['Control', 'Action'],
    to: ['Risk'],
    description: 'Risk mitigation.',
  },
  {
    kind: 'REMEDIATES',
    from: ['Action'],
    to: ['Finding'],
    description: 'An action addresses a finding.',
  },
  {
    kind: 'AUTHORISES',
    from: ['Policy', 'Decision'],
    to: ['Action'],
    description: 'The authority under which an action may run.',
  },
  {
    kind: 'APPROVED_BY',
    from: ['Action'],
    to: ['Person'],
    description: 'Human approval of an action.',
  },
  {
    kind: 'VERIFIES',
    from: ['Verification'],
    to: ['Action', 'Claim', 'Control'],
    description: 'What a verification checked.',
  },
  {
    kind: 'SUPERSEDES',
    from: ['Evidence', 'Claim', 'Assessment', 'Policy'],
    to: ['Evidence', 'Claim', 'Assessment', 'Policy'],
    description: 'Replacement of an earlier version.',
  },
  {
    kind: 'EXCEPTS',
    from: ['Exception'],
    to: ['Control', 'Requirement', 'Finding'],
    description: 'An authorised deviation.',
  },
  {
    kind: 'COLLECTED_BY',
    from: ['Observation', 'Evidence'],
    to: ['Integration'],
    description: 'Which integration collected the artefact.',
  },
  {
    kind: 'SCOPED_TO',
    from: ['Requirement', 'Control', 'Policy', 'Exception'],
    to: [...ASSET_KINDS, 'Organisation'],
    description: 'Applicability scope.',
  },
];

const EDGE_RULE_INDEX = new Map<EdgeKind, EdgeRule>(EDGE_RULES.map((rule) => [rule.kind, rule]));

export function edgeRule(kind: EdgeKind): EdgeRule {
  const rule = EDGE_RULE_INDEX.get(kind);
  if (!rule) throw new Error(`Unknown edge kind: ${kind}`);
  return rule;
}

export interface EdgeValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

/** Structural validity check applied before any edge is persisted. */
export function validateEdge(kind: EdgeKind, from: NodeKind, to: NodeKind): EdgeValidation {
  const rule = EDGE_RULE_INDEX.get(kind);
  if (!rule) return { valid: false, reason: `Unknown edge kind ${kind}` };
  if (!rule.from.includes(from)) {
    return { valid: false, reason: `${kind} cannot originate from ${from}` };
  }
  if (!rule.to.includes(to)) {
    return { valid: false, reason: `${kind} cannot terminate at ${to}` };
  }
  return { valid: true };
}

export const NODE_LIFECYCLE_STATES = ['ACTIVE', 'INACTIVE', 'ARCHIVED', 'DELETED'] as const;
export type NodeLifecycleState = (typeof NODE_LIFECYCLE_STATES)[number];
export const nodeLifecycleStateSchema = z.enum(NODE_LIFECYCLE_STATES);

/**
 * A node in the assurance graph.
 *
 * `attributes` holds kind-specific, schema-validated data. Temporal fields are
 * explicit and distinct — see docs/architecture/temporal-model.md — because
 * "when we saw it", "when it was true" and "when we recorded it" answer
 * different questions and conflating them destroys historical assurance.
 */
export interface GraphNode {
  readonly id: string;
  readonly organisationId: string;
  readonly kind: NodeKind;
  readonly externalId: string | null;
  readonly label: string;
  readonly attributes: Record<string, unknown>;
  readonly lifecycleState: NodeLifecycleState;
  readonly sourceIntegrationId: string | null;
  readonly firstObservedAt: string | null;
  readonly lastObservedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface GraphEdge {
  readonly id: string;
  readonly organisationId: string;
  readonly kind: EdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly attributes: Record<string, unknown>;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly createdAt: string;
}

export const graphNodeInputSchema = z.object({
  kind: nodeKindSchema,
  externalId: z.string().min(1).max(512).nullable().optional(),
  label: z.string().min(1).max(512),
  attributes: z.record(z.string(), z.unknown()).default({}),
  lifecycleState: nodeLifecycleStateSchema.default('ACTIVE'),
  sourceIntegrationId: z.string().uuid().nullable().optional(),
  firstObservedAt: z.string().datetime().nullable().optional(),
  lastObservedAt: z.string().datetime().nullable().optional(),
});

export type GraphNodeInput = z.infer<typeof graphNodeInputSchema>;

export const graphEdgeInputSchema = z.object({
  kind: edgeKindSchema,
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().nullable().optional(),
});

export type GraphEdgeInput = z.infer<typeof graphEdgeInputSchema>;

/** A single hop in an explanation path, rendered directly in the UI. */
export interface GraphPathStep {
  readonly node: Pick<GraphNode, 'id' | 'kind' | 'label'>;
  readonly viaEdge: {
    readonly id: string;
    readonly kind: EdgeKind;
    readonly reversed: boolean;
  } | null;
}

export interface GraphPath {
  readonly steps: readonly GraphPathStep[];
  readonly length: number;
}
