import type { EdgeKind, GraphPath, GraphPathStep, NodeKind } from '@adericel/domain';
import type { TenantContext } from './db.js';

/**
 * Graph traversal.
 *
 * Traversal is what turns "this control is NOT_SATISFIED" into an explanation a
 * human can act on: the path from a requirement down through controls, claims
 * and evidence to the asset and source system that produced it. Depth is always
 * bounded — an unbounded recursive query against a large tenant is an
 * availability incident waiting to happen.
 */
export const MAX_TRAVERSAL_DEPTH = 8;

export interface TraversalOptions {
  readonly maxDepth?: number;
  readonly edgeKinds?: readonly EdgeKind[];
  readonly nodeKinds?: readonly NodeKind[];
  readonly direction?: 'OUT' | 'IN' | 'BOTH';
  readonly limit?: number;
}

export interface NeighbourhoodNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly depth: number;
}

export interface NeighbourhoodEdge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

export interface Neighbourhood {
  readonly rootId: string;
  readonly nodes: readonly NeighbourhoodNode[];
  readonly edges: readonly NeighbourhoodEdge[];
  readonly truncated: boolean;
}

interface WalkRow {
  node_id: string;
  kind: string;
  label: string;
  depth: number;
  edge_id: string | null;
  edge_kind: string | null;
  from_node_id: string | null;
  to_node_id: string | null;
}

/**
 * Breadth-first neighbourhood around a node.
 *
 * The recursive CTE carries the visited path so a cycle terminates instead of
 * looping — assurance graphs legitimately contain cycles (a control protects an
 * asset that a claim about that control depends on).
 */
export async function neighbourhood(
  ctx: TenantContext,
  rootId: string,
  options: TraversalOptions = {},
): Promise<Neighbourhood> {
  const maxDepth = Math.min(options.maxDepth ?? 2, MAX_TRAVERSAL_DEPTH);
  const limit = Math.min(options.limit ?? 500, 2000);
  const direction = options.direction ?? 'BOTH';
  const edgeKinds = options.edgeKinds ?? null;
  const nodeKinds = options.nodeKinds ?? null;

  const followOut = direction === 'OUT' || direction === 'BOTH';
  const followIn = direction === 'IN' || direction === 'BOTH';

  const rows = await ctx.many<WalkRow>(
    `WITH RECURSIVE walk AS (
       SELECT n.id AS node_id, n.kind, n.label, 0 AS depth,
              NULL::uuid AS edge_id, NULL::text AS edge_kind,
              NULL::uuid AS from_node_id, NULL::uuid AS to_node_id,
              ARRAY[n.id] AS path
       FROM graph_nodes n
       WHERE n.organisation_id = $1 AND n.id = $2

       UNION ALL

       SELECT next.id, next.kind, next.label, walk.depth + 1,
              e.id, e.kind, e.from_node_id, e.to_node_id,
              walk.path || next.id
       FROM walk
       JOIN graph_edges e
         ON e.organisation_id = $1
        AND e.valid_until IS NULL
        AND ( ($5 AND e.from_node_id = walk.node_id)
           OR ($6 AND e.to_node_id = walk.node_id) )
        AND ($7::text[] IS NULL OR e.kind = ANY($7::text[]))
       JOIN graph_nodes next
         ON next.organisation_id = $1
        AND next.id = CASE WHEN e.from_node_id = walk.node_id THEN e.to_node_id ELSE e.from_node_id END
        AND ($8::text[] IS NULL OR next.kind = ANY($8::text[]))
       WHERE walk.depth < $3
         AND NOT next.id = ANY(walk.path)
     )
     SELECT node_id, kind, label, depth, edge_id, edge_kind, from_node_id, to_node_id
     FROM walk
     ORDER BY depth, node_id
     LIMIT $4`,
    [ctx.organisationId, rootId, maxDepth, limit + 1, followOut, followIn, edgeKinds, nodeKinds],
  );

  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;

  const nodes = new Map<string, NeighbourhoodNode>();
  const edges = new Map<string, NeighbourhoodEdge>();
  for (const row of kept) {
    const existing = nodes.get(row.node_id);
    if (!existing || existing.depth > row.depth) {
      nodes.set(row.node_id, {
        id: row.node_id,
        kind: row.kind as NodeKind,
        label: row.label,
        depth: row.depth,
      });
    }
    if (row.edge_id && row.edge_kind && row.from_node_id && row.to_node_id) {
      edges.set(row.edge_id, {
        id: row.edge_id,
        kind: row.edge_kind as EdgeKind,
        fromNodeId: row.from_node_id,
        toNodeId: row.to_node_id,
      });
    }
  }

  return {
    rootId,
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
    edges: [...edges.values()],
    truncated,
  };
}

interface PathRow {
  node_ids: string[];
  edge_ids: string[];
  edge_kinds: string[];
  depth: number;
}

/**
 * Shortest path between two nodes, ignoring edge direction.
 *
 * Used by the explainability view: "show me how this finding connects to this
 * requirement". Returns null when no path exists within the depth bound rather
 * than searching indefinitely.
 */
export async function shortestPath(
  ctx: TenantContext,
  fromNodeId: string,
  toNodeId: string,
  maxDepth = 6,
): Promise<GraphPath | null> {
  const depth = Math.min(maxDepth, MAX_TRAVERSAL_DEPTH);
  const row = await ctx.one<PathRow>(
    `WITH RECURSIVE walk AS (
       SELECT ARRAY[$2::uuid] AS node_ids, ARRAY[]::uuid[] AS edge_ids,
              ARRAY[]::text[] AS edge_kinds, 0 AS depth, $2::uuid AS current
       UNION ALL
       SELECT walk.node_ids || next_id, walk.edge_ids || e.id, walk.edge_kinds || e.kind,
              walk.depth + 1, next_id
       FROM walk
       JOIN LATERAL (
         SELECT e.id, e.kind,
                CASE WHEN e.from_node_id = walk.current THEN e.to_node_id ELSE e.from_node_id END AS next_id
         FROM graph_edges e
         WHERE e.organisation_id = $1 AND e.valid_until IS NULL
           AND (e.from_node_id = walk.current OR e.to_node_id = walk.current)
       ) e ON true
       WHERE walk.depth < $4
         AND NOT e.next_id = ANY(walk.node_ids)
     )
     SELECT node_ids, edge_ids, edge_kinds, depth
     FROM walk
     WHERE current = $3::uuid
     ORDER BY depth
     LIMIT 1`,
    [ctx.organisationId, fromNodeId, toNodeId, depth],
  );
  if (!row) return null;

  const nodes = await ctx.many<{ id: string; kind: string; label: string }>(
    'SELECT id, kind, label FROM graph_nodes WHERE organisation_id = $1 AND id = ANY($2::uuid[])',
    [ctx.organisationId, row.node_ids],
  );
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const steps: GraphPathStep[] = row.node_ids.map((nodeId, index) => {
    const node = nodeById.get(nodeId);
    const edgeId = index === 0 ? null : (row.edge_ids[index - 1] ?? null);
    const edgeKind = index === 0 ? null : (row.edge_kinds[index - 1] ?? null);
    return {
      node: {
        id: nodeId,
        kind: (node?.kind ?? 'Organisation') as NodeKind,
        label: node?.label ?? '(unknown)',
      },
      viaEdge:
        edgeId && edgeKind ? { id: edgeId, kind: edgeKind as EdgeKind, reversed: false } : null,
    };
  });

  return { steps, length: row.depth };
}
