import type { FastifyRequest } from 'fastify';
import { AdericelError, contentHash, type Clock } from '@adericel/shared';
import type { AppContext } from '../context.js';
import { requirePrincipal } from './request-context.js';

/**
 * API-level idempotency.
 *
 * A retried POST — a dropped connection, an n8n retry, a user double-click —
 * must not perform the operation twice. The key is claimed atomically before
 * the handler runs; the stored response is replayed on a repeat.
 *
 * The request digest is stored alongside, so reusing a key with a different
 * body is rejected rather than silently returning the earlier result. That
 * distinction matters: quietly returning a stale response for a different
 * request would be worse than performing the work twice.
 */

export interface IdempotentOutcome<T> {
  readonly replayed: boolean;
  readonly status: number;
  readonly body: T;
}

const RETENTION_HOURS = 24;

export async function withIdempotency<T>(
  app: AppContext,
  request: FastifyRequest,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    const result = await handler();
    return { replayed: false, status: result.status, body: result.body };
  }
  if (key.length > 200) {
    throw new AdericelError('VALIDATION_FAILED', 'Idempotency-Key must be at most 200 characters');
  }

  const principal = requirePrincipal(request);
  const digest = contentHash({
    method: request.method,
    path: request.routeOptions?.url ?? request.url,
    body: request.body ?? null,
  });

  const claim = await claimKey(app, principal.principalId, key, request, digest, app.clock);

  if (claim.state === 'REPLAY') {
    return { replayed: true, status: claim.status, body: claim.body as T };
  }
  if (claim.state === 'IN_PROGRESS') {
    throw new AdericelError(
      'CONFLICT',
      'A request with this Idempotency-Key is still in progress. Retry shortly.',
      { retryable: true },
    );
  }

  try {
    const result = await handler();
    await app.db.withPlatform(async (ctx) => {
      await ctx.query(
        `UPDATE idempotency_keys
         SET state = 'COMPLETED', response_status = $2, response_body = $3::jsonb, completed_at = now()
         WHERE id = $1`,
        [claim.id, result.status, JSON.stringify(result.body)],
      );
    });
    return { replayed: false, status: result.status, body: result.body };
  } catch (error) {
    // A failed attempt releases its key so the caller can retry the same
    // operation rather than being permanently blocked by a transient failure.
    await app.db.withPlatform(async (ctx) => {
      await ctx.query(`DELETE FROM idempotency_keys WHERE id = $1`, [claim.id]);
    });
    throw error;
  }
}

type Claim =
  | { state: 'CLAIMED'; id: string }
  | { state: 'IN_PROGRESS' }
  | { state: 'REPLAY'; status: number; body: unknown };

async function claimKey(
  app: AppContext,
  principalId: string,
  key: string,
  request: FastifyRequest,
  digest: string,
  clock: Clock,
): Promise<Claim> {
  return app.db.withPlatform(async (ctx) => {
    const expiresAt = new Date(clock.nowEpochMs() + RETENTION_HOURS * 3_600_000).toISOString();

    const inserted = await ctx.one<{ id: string }>(
      `INSERT INTO idempotency_keys
         (organisation_id, principal_id, key, method, path, request_digest, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS', $7)
       ON CONFLICT (principal_id, key) DO NOTHING
       RETURNING id`,
      [
        request.adericel.organisationId,
        principalId,
        key,
        request.method,
        request.routeOptions?.url ?? request.url,
        digest,
        expiresAt,
      ],
    );
    if (inserted) return { state: 'CLAIMED', id: inserted.id };

    const existing = await ctx.oneOrFail<{
      id: string;
      request_digest: string;
      state: string;
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT id, request_digest, state, response_status, response_body
       FROM idempotency_keys WHERE principal_id = $1 AND key = $2`,
      [principalId, key],
      'Idempotency key',
    );

    if (existing.request_digest !== digest) {
      throw new AdericelError(
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with a different request body',
      );
    }
    if (existing.state === 'IN_PROGRESS') return { state: 'IN_PROGRESS' };
    return {
      state: 'REPLAY',
      status: existing.response_status ?? 200,
      body: existing.response_body,
    };
  });
}

/** Remove expired keys. Run from the worker's maintenance sweep. */
export async function purgeExpiredIdempotencyKeys(app: AppContext): Promise<number> {
  return app.db.withPlatform(async (ctx) => {
    const { rowCount } = await ctx.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
    return rowCount;
  });
}
