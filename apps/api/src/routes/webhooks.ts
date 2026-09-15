import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdericelError, verifyHmacSha256 } from '@adericel/shared';
import { createCollectionService } from '@adericel/actions';
import { observationBatchSchema } from '@adericel/domain';
import type { AppContext } from '../context.js';
import { audit } from '../middleware/request-context.js';
import { parseBody } from '../middleware/validation.js';

/**
 * Inbound webhooks.
 *
 * Webhooks are unauthenticated in the usual sense — the sender has no session —
 * so the payload signature IS the authentication. Every webhook route verifies
 * an HMAC over the raw body before the body is parsed or acted upon, and the
 * organisation is taken from the signed payload rather than from the URL.
 */

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function registerWebhookRoutes(server: FastifyInstance, app: AppContext): void {
  // The raw body is retained only for webhook routes, because a signature must
  // be computed over exactly the bytes that were sent, not over a re-serialised
  // object.
  server.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/v1/webhooks/')) return payload;
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of payload) {
      const buffer = Buffer.from(chunk as Buffer);
      received += buffer.byteLength;
      // A running total, not a concatenation.
      //
      // Concatenating on every chunk to measure the length copies everything
      // accumulated so far, per chunk — quadratic in the number of chunks, and
      // the sender chooses the chunk size. Against a 1 MB body limit, one
      // unauthenticated request sent a byte at a time forced roughly 550 GB of
      // memcpy, all of it before any signature was checked.
      if (received > app.config.api.bodyLimitBytes) {
        throw new AdericelError('VALIDATION_FAILED', 'Webhook body exceeds the permitted size');
      }
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks, received);
    request.rawBody = raw.toString('utf8');
    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });

  function verifySignature(request: { headers: Record<string, unknown>; rawBody?: string }): void {
    const secret = app.config.n8n.webhookSigningSecret;
    if (secret.length === 0) {
      throw new AdericelError(
        'NOT_IMPLEMENTED',
        'Webhook ingestion is not configured. Set N8N_WEBHOOK_SIGNING_SECRET to enable it.',
      );
    }
    const signature = request.headers['x-adericel-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new AdericelError('UNAUTHENTICATED', 'Missing webhook signature');
    }
    const timestamp = request.headers['x-adericel-timestamp'];
    if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) {
      throw new AdericelError('UNAUTHENTICATED', 'Missing or malformed webhook timestamp');
    }
    // A replayed delivery is rejected on age, so a captured request cannot be
    // resubmitted indefinitely.
    const ageMs = Math.abs(app.clock.nowEpochMs() - Number(timestamp));
    if (ageMs > 300_000) {
      throw new AdericelError(
        'UNAUTHENTICATED',
        'Webhook timestamp is outside the accepted window',
      );
    }
    const signedPayload = `${timestamp}.${request.rawBody ?? ''}`;
    if (!verifyHmacSha256(secret, signedPayload, signature)) {
      throw new AdericelError('UNAUTHENTICATED', 'Invalid webhook signature');
    }
  }

  /**
   * Webhook endpoints carry a tighter budget than the authenticated API.
   *
   * The global limiter already covers every route, so CodeQL's finding here was
   * not strictly true — but it pointed at something real. These two endpoints
   * are the only ones reachable without a principal, so the global key
   * generator falls back to the source address, and 600 requests a minute is a
   * generous allowance for an unauthenticated surface. A signature failure
   * costs one HMAC and no database access, which bounds the damage; this bounds
   * the noise as well.
   */
  const webhookRateLimit = {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: 60_000,
      },
    },
  };

  /**
   * Observation ingestion by webhook.
   *
   * Used by n8n workflows and by customer-side scripts that push rather than
   * being polled. The observations travel the same pipeline as connector output.
   */
  server.post('/v1/webhooks/observations', webhookRateLimit, async (request, reply) => {
    verifySignature(request);
    const body = parseBody(
      request,
      observationBatchSchema.extend({ organisationId: z.string().uuid() }),
    );

    const organisation = await app.db.withPlatform(async (ctx) =>
      ctx.one<{ id: string; status: string }>(
        `SELECT id, status FROM organisations WHERE id = $1`,
        [body.organisationId],
      ),
    );
    if (!organisation || organisation.status === 'CLOSED') {
      throw new AdericelError('NOT_FOUND', 'Organisation not found');
    }

    const result = await app.db.withTenant(body.organisationId, async (ctx) =>
      createCollectionService({
        ctx,
        clock: app.clock,
        logger: request.adericel.logger,
        connectors: app.connectors,
        correlationId: request.adericel.correlationId,
        actor: 'webhook',
        unsealCredentials: app.unsealCredentials,
      }).ingestObservations(body.observations, {
        integrationId: body.integrationId ?? null,
        sourceSystem: body.observations[0]?.sourceSystem ?? 'webhook',
      }),
    );

    request.adericel.organisationId = body.organisationId;
    await audit(app, request, {
      action: 'webhook:observations',
      resourceType: 'Observation',
      metadata: { count: body.observations.length },
    });

    return reply.status(202).send({
      accepted: body.observations.length,
      observationsRecorded: result.observationsRecorded,
      evidenceCreated: result.evidenceCreated,
      claimsChanged: result.claimsChanged,
      correlationId: request.adericel.correlationId,
    });
  });

  /** Health ping, so a workflow can confirm signing is configured correctly. */
  server.post('/v1/webhooks/ping', webhookRateLimit, async (request, reply) => {
    verifySignature(request);
    return reply.status(200).send({
      ok: true,
      receivedAt: app.clock.nowIso(),
      correlationId: request.adericel.correlationId,
    });
  });
}
