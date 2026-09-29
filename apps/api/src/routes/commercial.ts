import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  COMMERCIAL_CAPABILITY,
  COMMERCIAL_STATES,
  COMMERCIAL_TRANSITIONS,
  MINIMUM_COMMERCIAL_REASON,
} from '@adericel/domain';
import { AdericelError } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { audit, requireMsp, requirePrincipal } from '../middleware/request-context.js';
import { parseBody, parseParams } from '../middleware/validation.js';
import { commercialPosition, moveCommercialState } from '../services/commercial.js';

/**
 * Commercial state routes.
 *
 * Every route here changes or discloses somebody's commercial position, so
 * every one is authenticated against the MSP that holds the agreement. None of
 * them can reach containment, which is a separate concern with separate routes
 * and separate authority (§16, ADR-0045, ADR-0047).
 */

const subscriptionParam = z.object({ subscriptionId: z.string().uuid() });

const moveSchema = z
  .object({
    to: z.enum(COMMERCIAL_STATES),
    reason: z.string().min(MINIMUM_COMMERCIAL_REASON).max(2000),
    customerNotified: z.boolean(),
  })
  // A client sending `decidedByKind: 'PROVIDER'` would be asserting that a
  // payment processor made this decision, which is exactly the attribution a
  // person would want to hide behind. It is derived from the authenticated
  // principal, never read from the body.
  .strict();

export function registerCommercialRoutes(server: FastifyInstance, app: AppContext): void {
  /**
   * The commercial vocabulary: what each state costs a customer, and which
   * moves are legal from where.
   *
   * Reference data, identical for every caller, naming no organisation. An
   * operator reads this while deciding what to do about an unpaid invoice, and
   * the thing they most need to see is which states stop assurance being
   * maintained — so that is stated rather than inferred from a boolean.
   */
  server.get('/v1/commercial/states', { preHandler: server.authenticate }, async (_req, reply) =>
    reply.status(200).send({
      states: COMMERCIAL_STATES.map((state) => ({
        state,
        ...COMMERCIAL_CAPABILITY[state],
        transitionsTo: COMMERCIAL_TRANSITIONS[state],
      })),
      invariant:
        'No commercial state withholds an organisation’s own assurance record. A customer who ' +
        'stops paying stops receiving new assurance; they never stop being able to read and ' +
        'export what they already proved.',
      separation:
        'A commercial state is not a security state. Non-payment is never a containment, and ' +
        'a containment is never a commercial restriction. There is no path between them.',
    }),
  );

  server.get(
    '/v1/msps/:mspId/subscriptions/:subscriptionId/commercial',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, subscriptionParam.extend({ mspId: z.string().uuid() }));
      await requireMsp(app, request, params.mspId, 'msp:billing:read');
      await assertSubscriptionBelongsToMsp(app, params.subscriptionId, params.mspId);

      return reply.status(200).send(await commercialPosition(app, params.subscriptionId));
    },
  );

  server.post(
    '/v1/msps/:mspId/subscriptions/:subscriptionId/commercial',
    { preHandler: server.authenticate },
    async (request, reply) => {
      const params = parseParams(request, subscriptionParam.extend({ mspId: z.string().uuid() }));
      await requireMsp(app, request, params.mspId, 'msp:billing:manage');
      await assertSubscriptionBelongsToMsp(app, params.subscriptionId, params.mspId);

      const body = parseBody(request, moveSchema);
      const principal = requirePrincipal(request);

      const record = await moveCommercialState(app, {
        subscriptionId: params.subscriptionId,
        to: body.to,
        reason: body.reason,
        customerNotified: body.customerNotified,
        // Attribution comes from the session. An API key is a system, not a
        // person, and a person is required for anything that restricts a
        // customer — so a key gets SYSTEM and the transition table's
        // operator-is-named constraint does the rest.
        decidedByKind: principal.principalType === 'USER' ? 'OPERATOR' : 'SYSTEM',
        decidedBy: principal.principalType === 'USER' ? principal.principalId : null,
        decidedByLabel: principal.displayName,
        correlationId: request.adericel.correlationId,
      });

      await audit(app, request, {
        action: 'commercial:transition',
        resourceType: 'Subscription',
        resourceId: params.subscriptionId,
        metadata: { from: record.from, to: record.to, customerNotified: record.customerNotified },
      });

      return reply.status(201).send(record);
    },
  );
}

/**
 * Prove the subscription belongs to the MSP in the path.
 *
 * The MSP id is authorised, the subscription id is not — without this, an
 * operator with a legitimate grant over their own MSP could move another MSP's
 * account by pairing their own id with somebody else's subscription. A
 * caller-supplied identifier is never sufficient (§22).
 */
async function assertSubscriptionBelongsToMsp(
  app: AppContext,
  subscriptionId: string,
  mspId: string,
): Promise<void> {
  const row = await app.db.withPlatform(async (ctx) =>
    ctx.one<{ id: string }>(`SELECT id FROM subscriptions WHERE id = $1 AND msp_id = $2`, [
      subscriptionId,
      mspId,
    ]),
  );
  // Deliberately the same answer as a subscription that does not exist: a
  // caller must not be able to probe for other MSPs' subscription ids.
  if (!row) throw new AdericelError('NOT_FOUND', 'No such subscription');
}
