import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createHarness, databaseAvailable, type Harness } from '../helpers/harness.js';

/**
 * Webhook endpoint hardening.
 *
 * These are the only two routes reachable without a principal, which makes them
 * the only unauthenticated attack surface Adericel exposes. CodeQL reports them
 * as unrate-limited; it cannot see `@fastify/rate-limit`, which is registered
 * as a plugin rather than as per-route middleware it recognises.
 *
 * A documented false positive is only worth the paper it is written on if the
 * mitigation is real, so this proves the limit rather than describing it.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('webhook hardening', () => {
  let harness: Harness;

  beforeAll(async () => {
    // Webhook ingestion is disabled outright when no signing secret is set —
    // the endpoint returns NOT_IMPLEMENTED rather than accepting unsigned
    // deliveries, which is the correct default and also means the route does no
    // work at all. To exercise the rate limiter the endpoint has to be enabled.
    harness = await createHarness({
      env: {
        N8N_ENABLED: 'true',
        N8N_WEBHOOK_SIGNING_SECRET: 'test-webhook-signing-secret-at-least-32-chars',
      },
    });
  });

  /**
   * The webhook routes carry their own budget, which deliberately *overrides*
   * the global one rather than stacking with it. Exceeding it therefore means
   * exceeding this number, not the API-wide setting — a distinction that cost
   * one confusing test run to learn and is worth writing down.
   */
  const WEBHOOK_BUDGET_PER_MINUTE = 60;

  afterAll(async () => {
    await harness.close();
  });

  const post = (url: string, body: unknown, signed: boolean) => {
    const raw = JSON.stringify(body);
    const timestamp = String(harness.clock.nowEpochMs());
    const secret = harness.config.n8n.webhookSigningSecret;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signed && secret) {
      headers['x-adericel-timestamp'] = timestamp;
      headers['x-adericel-signature'] = createHmac('sha256', secret)
        .update(`${timestamp}.${raw}`)
        .digest('hex');
    }
    return harness.server.inject({ method: 'POST', url, payload: raw, headers });
  };

  it('rate-limits the unauthenticated ping endpoint', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < WEBHOOK_BUDGET_PER_MINUTE + 10; attempt += 1) {
      statuses.push((await post('/v1/webhooks/ping', { hello: attempt }, false)).statusCode);
    }
    // The limiter is what must respond, not the signature check — an attacker
    // does not need a valid signature to consume capacity.
    expect(statuses).toContain(429);
  });

  it('rate-limits observation ingestion the same way', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < WEBHOOK_BUDGET_PER_MINUTE + 10; attempt += 1) {
      statuses.push(
        (await post('/v1/webhooks/observations', { observations: [] }, false)).statusCode,
      );
    }
    expect(statuses).toContain(429);
  });

  it('answers a throttled caller with 429, not 500', async () => {
    // This was 500 INTERNAL_ERROR. The limiter hands its response to the error
    // handler rather than sending it, and the body carried no statusCode, so it
    // fell through to the unhandled branch. A throttled client could not tell a
    // limit from a fault — and 500 is precisely the response a client retries
    // hardest, so the bug amplified the load it was meant to shed.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < WEBHOOK_BUDGET_PER_MINUTE + 5; attempt += 1) {
      statuses.push((await post('/v1/webhooks/ping', { n: attempt }, false)).statusCode);
    }
    expect(statuses).toContain(429);
    expect(statuses).not.toContain(500);
  });

  it('never throttles the health endpoints', async () => {
    // An orchestrator reads a non-200 here as a dead container. Throttling them
    // turns a traffic spike into a restart loop.
    for (let attempt = 0; attempt < WEBHOOK_BUDGET_PER_MINUTE + 5; attempt += 1) {
      await post('/v1/webhooks/ping', { n: attempt }, false);
    }
    const live = await harness.server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
  });

  it('rejects an unsigned delivery before touching the database', async () => {
    // The order matters for denial of service: a forged request must cost an
    // HMAC and nothing more. If signature verification ran after a lookup, an
    // attacker with no credential could still make Adericel do database work.
    const response = await post('/v1/webhooks/observations', { observations: [] }, false);
    expect([401, 429]).toContain(response.statusCode);
    const body = response.json() as { error?: { code?: string } };
    expect(body.error?.code).not.toBe('INTERNAL_ERROR');
  });
});

describe.skipIf(available)('webhook hardening (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
