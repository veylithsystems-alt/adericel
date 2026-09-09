import {
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  validateEdge,
} from '@adericel/domain';
import { AdericelError, buildPage, decodeCursor, type Page } from '@adericel/shared';
import type { QueryResultRow, TenantContext } from './db.js';

interface NodeRow extends QueryResultRow {
  id: string;
  organisation_id: string;
  kind: string;
  external_id: string | null;
  label: string;
  attributes: Record<string, unknown>;
  lifecycle_state: string;
  source_integration_id: string | null;
  first_observed_at: Date | null;
  last_observed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    kind: row.kind as NodeKind,
    externalId: row.external_id,
    label: row.label,
    attributes: row.attributes,
    lifecycleState: row.lifecycle_state as GraphNode['lifecycleState'],
    sourceIntegrationId: row.source_integration_id,
    firstObservedAt: row.first_observed_at?.toISOString() ?? null,
    lastObservedAt: row.last_observed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

const NODE_COLUMNS = `
  id, organisation_id, kind, external_id, label, attributes, lifecycle_state,
  source_integration_id, first_observed_at, last_observed_at, version, created_at, updated_at`;

export interface UpsertNodeInput {
  readonly kind: NodeKind;
  readonly externalId?: string | null;
  readonly label: string;
  readonly attributes?: Record<string, unknown>;
  readonly lifecycleState?: GraphNode['lifecycleState'];
  readonly sourceIntegrationId?: string | null;
  readonly observedAt?: string | null;
}

export interface NodeFilter {
  readonly kinds?: readonly NodeKind[];
  readonly lifecycleStates?: readonly GraphNode['lifecycleState'][];
  readonly search?: string;
  readonly externalId?: string;
  readonly integrationId?: string;
}

export interface NodeRepository {
  upsert(input: UpsertNodeInput): Promise<GraphNode>;
  upsertMany(inputs: readonly UpsertNodeInput[]): Promise<readonly GraphNode[]>;
  getById(id: string): Promise<GraphNode | null>;
  requireById(id: string): Promise<GraphNode>;
  findByExternalId(kind: NodeKind, externalId: string): Promise<GraphNode | null>;
  list(filter: NodeFilter, limit: number, cursor?: string): Promise<Page<GraphNode>>;
  countByKind(): Promise<Record<string, number>>;
  archive(id: string, reason: string): Promise<GraphNode>;
}

/**
 * Node repository.
 *
 * Upsert is keyed on (kind, external_id) so repeated collection converges on
 * one node rather than accumulating duplicates. `first_observed_at` is only
 * ever set, never moved backwards or forwards — it is the moment Adericel first
 * knew this thing existed and rewriting it would corrupt asset history.
 */
export function createNodeRepository(ctx: TenantContext): NodeRepository {
  return {
    async upsert(input: UpsertNodeInput): Promise<GraphNode> {
      const attributes = input.attributes ?? {};
      const observedAt = input.observedAt ?? null;

      if (input.externalId) {
        const row = await ctx.oneOrFail<NodeRow>(
          `INSERT INTO graph_nodes
             (organisation_id, kind, external_id, label, attributes, lifecycle_state,
              source_integration_id, first_observed_at, last_observed_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $8)
           ON CONFLICT (organisation_id, kind, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET
             label = EXCLUDED.label,
             attributes = graph_nodes.attributes || EXCLUDED.attributes,
             lifecycle_state = EXCLUDED.lifecycle_state,
             source_integration_id = COALESCE(EXCLUDED.source_integration_id, graph_nodes.source_integration_id),
             first_observed_at = LEAST(graph_nodes.first_observed_at, EXCLUDED.first_observed_at),
             last_observed_at = GREATEST(graph_nodes.last_observed_at, EXCLUDED.last_observed_at),
             version = graph_nodes.version + 1
           RETURNING ${NODE_COLUMNS}`,
          [
            ctx.organisationId,
            input.kind,
            input.externalId,
            input.label,
            JSON.stringify(attributes),
            input.lifecycleState ?? 'ACTIVE',
            input.sourceIntegrationId ?? null,
            observedAt,
          ],
          'Node',
        );
        return toNode(row);
      }

      const row = await ctx.oneOrFail<NodeRow>(
        `INSERT INTO graph_nodes
           (organisation_id, kind, external_id, label, attributes, lifecycle_state,
            source_integration_id, first_observed_at, last_observed_at)
         VALUES ($1, $2, NULL, $3, $4::jsonb, $5, $6, $7, $7)
         RETURNING ${NODE_COLUMNS}`,
        [
          ctx.organisationId,
          input.kind,
          input.label,
          JSON.stringify(attributes),
          input.lifecycleState ?? 'ACTIVE',
          input.sourceIntegrationId ?? null,
          observedAt,
        ],
        'Node',
      );
      return toNode(row);
    },

    async upsertMany(inputs: readonly UpsertNodeInput[]): Promise<readonly GraphNode[]> {
      const results: GraphNode[] = [];
      for (const input of inputs) results.push(await this.upsert(input));
      return results;
    },

    async getById(id: string): Promise<GraphNode | null> {
      const row = await ctx.one<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE id = $1 AND organisation_id = $2`,
        [id, ctx.organisationId],
      );
      return row ? toNode(row) : null;
    },

    async requireById(id: string): Promise<GraphNode> {
      const node = await this.getById(id);
      if (!node) throw new AdericelError('NOT_FOUND', 'Node not found', { safeDetails: { id } });
      return node;
    },

    async findByExternalId(kind: NodeKind, externalId: string): Promise<GraphNode | null> {
      const row = await ctx.one<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM graph_nodes
         WHERE organisation_id = $1 AND kind = $2 AND external_id = $3`,
        [ctx.organisationId, kind, externalId],
      );
      return row ? toNode(row) : null;
    },

    async list(filter: NodeFilter, limit: number, cursor?: string): Promise<Page<GraphNode>> {
      const values: unknown[] = [ctx.organisationId];
      const conditions: string[] = ['organisation_id = $1'];

      if (filter.kinds?.length) {
        values.push(filter.kinds);
        conditions.push(`kind = ANY($${values.length}::text[])`);
      }
      if (filter.lifecycleStates?.length) {
        values.push(filter.lifecycleStates);
        conditions.push(`lifecycle_state = ANY($${values.length}::text[])`);
      }
      if (filter.search) {
        values.push(`%${filter.search.toLowerCase()}%`);
        conditions.push(`lower(label) LIKE $${values.length}`);
      }
      if (filter.externalId) {
        values.push(filter.externalId);
        conditions.push(`external_id = $${values.length}`);
      }
      if (filter.integrationId) {
        values.push(filter.integrationId);
        conditions.push(`source_integration_id = $${values.length}`);
      }
      if (cursor) {
        const { k, i } = decodeCursor(cursor);
        values.push(k, i);
        conditions.push(`(updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);

      const rows = await ctx.many<NodeRow>(
        `SELECT ${NODE_COLUMNS} FROM graph_nodes
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, id DESC
         LIMIT $${values.length}`,
        values,
      );
      return buildPage(rows.map(toNode), limit, (node) => ({ k: node.updatedAt, i: node.id }));
    },

    async countByKind(): Promise<Record<string, number>> {
      const rows = await ctx.many<{ kind: string; count: string }>(
        `SELECT kind, count(*)::text AS count FROM graph_nodes
         WHERE organisation_id = $1 AND lifecycle_state = 'ACTIVE'
         GROUP BY kind`,
        [ctx.organisationId],
      );
      return Object.fromEntries(rows.map((row) => [row.kind, Number(row.count)]));
    },

    async archive(id: string, reason: string): Promise<GraphNode> {
      const row = await ctx.oneOrFail<NodeRow>(
        `UPDATE graph_nodes
         SET lifecycle_state = 'ARCHIVED',
             attributes = attributes || jsonb_build_object('archivedReason', $3::text),
             version = version + 1
         WHERE id = $1 AND organisation_id = $2
         RETURNING ${NODE_COLUMNS}`,
        [id, ctx.organisationId, reason],
        'Node',
      );
      return toNode(row);
    },
  };
}

interface EdgeRow extends QueryResultRow {
  id: string;
  organisation_id: string;
  kind: string;
  from_node_id: string;
  to_node_id: string;
  attributes: Record<string, unknown>;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
}

function toEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    kind: row.kind as EdgeKind,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    attributes: row.attributes,
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface EdgeRepository {
  connect(
    kind: EdgeKind,
    fromNodeId: string,
    toNodeId: string,
    attributes?: Record<string, unknown>,
  ): Promise<GraphEdge>;
  disconnect(kind: EdgeKind, fromNodeId: string, toNodeId: string): Promise<boolean>;
  outgoing(nodeId: string, kinds?: readonly EdgeKind[]): Promise<readonly GraphEdge[]>;
  incoming(nodeId: string, kinds?: readonly EdgeKind[]): Promise<readonly GraphEdge[]>;
}

/**
 * Edge repository.
 *
 * Every edge is validated against the structural rules in the domain model
 * before it is written. An edge shape the traversal code cannot interpret is
 * rejected at the boundary rather than discovered later as an unexplainable
 * assurance conclusion.
 */
export function createEdgeRepository(ctx: TenantContext): EdgeRepository {
  async function kindOf(nodeId: string): Promise<NodeKind> {
    const row = await ctx.oneOrFail<{ kind: string }>(
      'SELECT kind FROM graph_nodes WHERE id = $1 AND organisation_id = $2',
      [nodeId, ctx.organisationId],
      'Node',
    );
    return row.kind as NodeKind;
  }

  return {
    async connect(kind, fromNodeId, toNodeId, attributes = {}): Promise<GraphEdge> {
      if (fromNodeId === toNodeId) {
        throw new AdericelError('VALIDATION_FAILED', 'An edge cannot connect a node to itself');
      }
      const [fromKind, toKind] = await Promise.all([kindOf(fromNodeId), kindOf(toNodeId)]);
      const validation = validateEdge(kind, fromKind, toKind);
      if (!validation.valid) {
        throw new AdericelError('VALIDATION_FAILED', validation.reason ?? 'Invalid edge', {
          safeDetails: { kind, from: fromKind, to: toKind },
        });
      }
      const row = await ctx.oneOrFail<EdgeRow>(
        `INSERT INTO graph_edges (organisation_id, kind, from_node_id, to_node_id, attributes)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (organisation_id, kind, from_node_id, to_node_id) WHERE valid_until IS NULL
         DO UPDATE SET attributes = graph_edges.attributes || EXCLUDED.attributes
         RETURNING id, organisation_id, kind, from_node_id, to_node_id, attributes, valid_from, valid_until, created_at`,
        [ctx.organisationId, kind, fromNodeId, toNodeId, JSON.stringify(attributes)],
        'Edge',
      );
      return toEdge(row);
    },

    async disconnect(kind, fromNodeId, toNodeId): Promise<boolean> {
      // Edges are closed, not deleted: a relationship that used to hold is part
      // of the organisation's history.
      const { rowCount } = await ctx.query(
        `UPDATE graph_edges SET valid_until = now()
         WHERE organisation_id = $1 AND kind = $2 AND from_node_id = $3 AND to_node_id = $4
           AND valid_until IS NULL`,
        [ctx.organisationId, kind, fromNodeId, toNodeId],
      );
      return rowCount > 0;
    },

    async outgoing(nodeId, kinds): Promise<readonly GraphEdge[]> {
      const rows = await ctx.many<EdgeRow>(
        `SELECT id, organisation_id, kind, from_node_id, to_node_id, attributes, valid_from, valid_until, created_at
         FROM graph_edges
         WHERE organisation_id = $1 AND from_node_id = $2 AND valid_until IS NULL
           AND ($3::text[] IS NULL OR kind = ANY($3::text[]))`,
        [ctx.organisationId, nodeId, kinds ?? null],
      );
      return rows.map(toEdge);
    },

    async incoming(nodeId, kinds): Promise<readonly GraphEdge[]> {
      const rows = await ctx.many<EdgeRow>(
        `SELECT id, organisation_id, kind, from_node_id, to_node_id, attributes, valid_from, valid_until, created_at
         FROM graph_edges
         WHERE organisation_id = $1 AND to_node_id = $2 AND valid_until IS NULL
           AND ($3::text[] IS NULL OR kind = ANY($3::text[]))`,
        [ctx.organisationId, nodeId, kinds ?? null],
      );
      return rows.map(toEdge);
    },
  };
}

export { toNode as mapNodeRow, NODE_COLUMNS };
export type { NodeRow };
