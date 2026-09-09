import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EDGE_KINDS,
  NODE_KINDS,
  graphEdgeInputSchema,
  graphNodeInputSchema,
} from '@adericel/domain';
import {
  createEdgeRepository,
  createNodeRepository,
  neighbourhood,
  shortestPath,
} from '@adericel/graph';
import { pageRequestSchema } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireOrganisation } from '../middleware/request-context.js';
import { parseBody, parseParams, parseQuery, organisationParam } from '../middleware/validation.js';

/**
 * Assurance graph routes.
 *
 * The graph is the canonical model, so it is a first-class part of the API
 * rather than an internal detail. An MSP platform or a customer portal can
 * traverse the same structure the UI does.
 */

const orgChild = z.object({ organisationId: z.string().uuid(), id: z.string().uuid() });

export function registerGraphRoutes(server: FastifyInstance, app: AppContext): void {
  server.get(
    '/v1/organisations/:organisationId/nodes',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:asset:read');
      const query = parseQuery(
        request,
        pageRequestSchema.extend({
          kind: z.enum(NODE_KINDS).optional(),
          search: z.string().max(200).optional(),
          lifecycleState: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED', 'DELETED']).optional(),
          integrationId: z.string().uuid().optional(),
        }),
      );

      const page = await app.db.withTenant(organisationId, async (ctx) =>
        createNodeRepository(ctx).list(
          {
            ...(query.kind ? { kinds: [query.kind] } : {}),
            ...(query.search ? { search: query.search } : {}),
            ...(query.lifecycleState ? { lifecycleStates: [query.lifecycleState] } : {}),
            ...(query.integrationId ? { integrationId: query.integrationId } : {}),
          },
          query.limit,
          query.cursor,
        ),
      );

      return reply.status(200).send({
        nodes: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    },
  );

  server.get(
    '/v1/organisations/:organisationId/nodes/summary',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:asset:read');
      const counts = await app.db.withTenant(organisationId, async (ctx) =>
        createNodeRepository(ctx).countByKind(),
      );
      return reply.status(200).send({ countsByKind: counts });
    },
  );

  /** One node with everything Adericel knows about it. */
  server.get(
    '/v1/organisations/:organisationId/nodes/:id',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:asset:read');

      const data = await app.db.withTenant(params.organisationId, async (ctx) => {
        const node = await createNodeRepository(ctx).requireById(params.id);
        const edges = createEdgeRepository(ctx);
        const [outgoing, incoming] = await Promise.all([
          edges.outgoing(params.id),
          edges.incoming(params.id),
        ]);
        const claims = await ctx.many<{
          id: string;
          predicate: string;
          value: unknown;
          origin: string;
          status: string;
          asserted_at: Date;
        }>(
          `SELECT id, predicate, value, origin, status, asserted_at FROM claims
           WHERE organisation_id = $1 AND subject_node_id = $2
             AND status IN ('CANDIDATE','CONFIRMED')
           ORDER BY predicate`,
          [params.organisationId, params.id],
        );
        const evidenceCount = await ctx.oneOrFail<{ count: string }>(
          `SELECT count(*)::text AS count FROM evidence_subjects
           WHERE organisation_id = $1 AND node_id = $2`,
          [params.organisationId, params.id],
          'Evidence count',
        );
        const findings = await ctx.many<{
          id: string;
          title: string;
          severity: string;
          status: string;
        }>(
          `SELECT id, title, severity, status FROM findings
           WHERE organisation_id = $1 AND subject_node_id = $2
             AND status IN ('OPEN','ACKNOWLEDGED','IN_REMEDIATION')`,
          [params.organisationId, params.id],
        );
        return { node, outgoing, incoming, claims, evidenceCount, findings };
      });

      return reply.status(200).send({
        node: data.node,
        edges: {
          outgoing: data.outgoing,
          incoming: data.incoming,
        },
        claims: data.claims.map((c) => ({
          id: c.id,
          predicate: c.predicate,
          value: c.value,
          origin: c.origin,
          status: c.status,
          assertedAt: c.asserted_at.toISOString(),
        })),
        evidenceCount: Number(data.evidenceCount.count),
        openFindings: data.findings,
      });
    },
  );

  /** Bounded neighbourhood traversal, for the graph explorer. */
  server.get(
    '/v1/organisations/:organisationId/nodes/:id/neighbourhood',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, orgChild);
      await requireOrganisation(app, request, params.organisationId, 'org:asset:read');
      const query = parseQuery(
        request,
        z.object({
          depth: z.coerce.number().int().min(1).max(6).default(2),
          direction: z.enum(['OUT', 'IN', 'BOTH']).default('BOTH'),
          edgeKind: z.enum(EDGE_KINDS).optional(),
          limit: z.coerce.number().int().min(10).max(2000).default(300),
        }),
      );

      const result = await app.db.withTenant(params.organisationId, async (ctx) =>
        neighbourhood(ctx, params.id, {
          maxDepth: query.depth,
          direction: query.direction,
          limit: query.limit,
          ...(query.edgeKind ? { edgeKinds: [query.edgeKind] } : {}),
        }),
      );

      return reply.status(200).send(result);
    },
  );

  /** Shortest path between two nodes — the explainability walk. */
  server.get(
    '/v1/organisations/:organisationId/graph/path',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:asset:read');
      const query = parseQuery(
        request,
        z.object({
          from: z.string().uuid(),
          to: z.string().uuid(),
          maxDepth: z.coerce.number().int().min(1).max(8).default(6),
        }),
      );

      const path = await app.db.withTenant(organisationId, async (ctx) =>
        shortestPath(ctx, query.from, query.to, query.maxDepth),
      );

      return reply.status(200).send({
        path,
        found: path !== null,
        // A missing path within the bound is a real answer, not an error.
        detail:
          path === null
            ? `No path of length ${query.maxDepth} or less connects these nodes.`
            : `Connected in ${path.length} hop(s).`,
      });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/nodes',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:asset:write');
      const body = parseBody(request, graphNodeInputSchema);

      const node = await app.db.withTenant(organisationId, async (ctx) =>
        createNodeRepository(ctx).upsert({
          kind: body.kind,
          label: body.label,
          attributes: body.attributes,
          ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
          ...(body.lifecycleState ? { lifecycleState: body.lifecycleState } : {}),
          ...(body.sourceIntegrationId === undefined
            ? {}
            : { sourceIntegrationId: body.sourceIntegrationId }),
          ...(body.lastObservedAt === undefined ? {} : { observedAt: body.lastObservedAt }),
        }),
      );

      await audit(app, request, {
        action: 'node:upsert',
        resourceType: 'GraphNode',
        resourceId: node.id,
        metadata: { kind: node.kind },
      });

      return reply.status(201).send({ node });
    },
  );

  server.post(
    '/v1/organisations/:organisationId/edges',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const { organisationId } = parseParams(request, organisationParam);
      await requireOrganisation(app, request, organisationId, 'org:asset:write');
      const body = parseBody(request, graphEdgeInputSchema);

      const edge = await app.db.withTenant(organisationId, async (ctx) =>
        createEdgeRepository(ctx).connect(
          body.kind,
          body.fromNodeId,
          body.toNodeId,
          body.attributes,
        ),
      );

      await audit(app, request, {
        action: 'edge:connect',
        resourceType: 'GraphEdge',
        resourceId: edge.id,
        metadata: { kind: edge.kind },
      });

      return reply.status(201).send({ edge });
    },
  );

  /** The structural rules governing the graph, for tooling and documentation. */
  server.get('/v1/graph/schema', { preHandler: server.authenticate }, async (_request, reply) => {
    const { EDGE_RULES } = await import('@adericel/domain');
    return reply.status(200).send({
      nodeKinds: NODE_KINDS,
      edgeKinds: EDGE_KINDS,
      edgeRules: EDGE_RULES,
    });
  });
}
