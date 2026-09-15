import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOnce, type EventSubscriber } from '@adericel/worker';
import { publish } from '@adericel/graph';
import {
  createHarness,
  databaseAvailable,
  seedTenant,
  type Harness,
  type SeededTenant,
} from '../helpers/harness.js';

/**
 * The transactional outbox, end to end through the worker.
 *
 * ADR-0011 makes four claims about this component, and they are the reliability
 * backbone of the whole product: an event and the state change it describes
 * commit together or not at all; several workers can run without coordination;
 * delivery is at-least-once with bounded retries; and an event that cannot be
 * delivered is parked rather than lost.
 *
 * Those are testable claims, so they are tested here rather than asserted in a
 * document. This suite exists at the integration level rather than in the
 * end-to-end scenario because it needs to do things a user cannot — roll a
 * transaction back, run two dispatchers at once, make a subscriber fail on
 * demand.
 */

const available = await databaseAvailable();

describe.skipIf(!available)('transactional outbox', () => {
  let harness: Harness;
  let tenant: SeededTenant;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.truncate();
    tenant = await seedTenant(harness, { slug: 'outbox-corp', records: [] });
  });

  afterAll(async () => {
    await harness.close();
  });

  /** A subscriber that records what it received, and can be made to fail. */
  function recorder(options: { failTimes?: number; name?: string } = {}) {
    const received: string[] = [];
    let remainingFailures = options.failTimes ?? 0;
    const subscriber: EventSubscriber = {
      name: options.name ?? 'test-recorder',
      eventTypes: ['*'],
      async deliver(event) {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error('subscriber is unavailable');
        }
        received.push(event.id);
      },
    };
    return { subscriber, received };
  }

  const dispatch = (subscribers: EventSubscriber[], workerId = 'worker-a') =>
    dispatchOnce({
      db: harness.db,
      logger: harness.app.logger,
      clock: harness.clock,
      config: harness.config,
      workerId,
      subscribers,
    });

  const publishOne = (type = 'AssuranceStateChanged') =>
    harness.db.withTenant(tenant.organisationId, async (ctx) =>
      publish(
        ctx,
        {
          type: type as never,
          organisationId: tenant.organisationId,
          mspId: tenant.mspId,
          subjectType: 'Control',
          subjectId: tenant.rootNodeId,
          payload: { note: 'test' },
          correlationId: crypto.randomUUID(),
          actor: { type: 'SYSTEM', id: 'test', display: 'Test' },
        },
        harness.clock.nowIso(),
      ),
    );

  const outboxRow = (id: string) =>
    harness.db.withPlatform(async (ctx) =>
      ctx.one<{ state: string; attempts: number; last_error: string | null }>(
        `SELECT state, attempts, last_error FROM outbox_events WHERE id = $1`,
        [id],
      ),
    );

  it('delivers a published event to a subscriber', async () => {
    const event = await publishOne();
    const { subscriber, received } = recorder();

    const result = await dispatch([subscriber]);
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(received).toContain(event.id);
    expect((await outboxRow(event.id))?.state).toBe('DELIVERED');
  });

  it('writes the event and the state change in one transaction, or neither', async () => {
    // The claim ADR-0011 exists for. Without it there is a window in which the
    // state changed and no event was published — or an event was published for
    // work that was rolled back, which is how an approved action gets executed
    // twice.
    let rolledBackEventId: string | null = null;

    await expect(
      harness.db.withTenant(tenant.organisationId, async (ctx) => {
        const event = await publish(
          ctx,
          {
            type: 'AssuranceStateChanged' as never,
            organisationId: tenant.organisationId,
            mspId: tenant.mspId,
            subjectType: 'Control',
            subjectId: tenant.rootNodeId,
            payload: { note: 'this transaction fails' },
            correlationId: crypto.randomUUID(),
            actor: { type: 'SYSTEM', id: 'test', display: 'Test' },
          },
          harness.clock.nowIso(),
        );
        rolledBackEventId = event.id;
        throw new Error('the state change failed after the event was written');
      }),
    ).rejects.toThrow(/state change failed/);

    expect(rolledBackEventId).not.toBeNull();
    // Nothing to deliver, and nothing in the durable history either.
    expect(await outboxRow(rolledBackEventId!)).toBeNull();
    const logged = await harness.db.withPlatform(async (ctx) =>
      ctx.one(`SELECT id FROM event_log WHERE id = $1`, [rolledBackEventId]),
    );
    expect(logged).toBeNull();
  });

  it('records every delivered event in the durable log, which is not pruned', async () => {
    const event = await publishOne();
    await dispatch([recorder().subscriber]);

    const logged = await harness.db.withPlatform(async (ctx) =>
      ctx.one<{ type: string }>(`SELECT type FROM event_log WHERE id = $1`, [event.id]),
    );
    // outbox_events is a work queue and is pruned; event_log is the record and
    // is not. Losing the distinction loses the history.
    expect(logged?.type).toBe('AssuranceStateChanged');
  });

  it('does not hand the same event to two workers at once', async () => {
    // SKIP LOCKED is what makes a second worker safe to add. If this breaks,
    // scaling out silently double-delivers.
    for (let i = 0; i < 5; i += 1) await publishOne();

    const a = recorder({ name: 'worker-a' });
    const b = recorder({ name: 'worker-b' });
    const [resultA, resultB] = await Promise.all([
      dispatch([a.subscriber], 'worker-a'),
      dispatch([b.subscriber], 'worker-b'),
    ]);

    const overlap = a.received.filter((id) => b.received.includes(id));
    expect(overlap, 'the same event was delivered by both workers').toEqual([]);
    expect(resultA.claimed + resultB.claimed).toBeGreaterThan(0);
  });

  it('retries a failed delivery rather than dropping it', async () => {
    const event = await publishOne();
    const { subscriber } = recorder({ failTimes: 1 });

    await dispatch([subscriber]);
    const afterFailure = await outboxRow(event.id);
    expect(afterFailure?.state).toBe('PENDING');
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.last_error).toMatch(/unavailable/);
  });

  it('parks an event that keeps failing instead of retrying it forever', async () => {
    const event = await publishOne();
    const { subscriber } = recorder({ failTimes: 100 });

    // Backoff schedules the next attempt in the future, and `available_at` is
    // computed from the *database* clock rather than the injected one. That is
    // deliberate and not an oversight: it is a deadline several worker
    // processes compare against, so it needs one authority, and a worker with a
    // skewed clock must not be able to claim work early. The consequence is
    // that this test has to move the database's view rather than the harness's.
    for (let attempt = 0; attempt < harness.config.worker.maxDeliveryAttempts + 1; attempt += 1) {
      await dispatch([subscriber]);
      await harness.db.withPlatform(async (ctx) => {
        await ctx.query(
          `UPDATE outbox_events SET available_at = now() - interval '1 hour' WHERE id = $1`,
          [event.id],
        );
      });
    }

    const parked = await outboxRow(event.id);
    expect(parked?.state).toBe('DEAD_LETTER');
    // Parked, not deleted. An operator can see it and replay it.
    expect(parked?.attempts).toBeGreaterThanOrEqual(harness.config.worker.maxDeliveryAttempts);
  });

  it('delivers only the event types a subscriber asked for', async () => {
    const event = await publishOne('AssuranceStateChanged');
    const uninterested: EventSubscriber = {
      name: 'only-actions',
      eventTypes: ['ActionProposed'],
      deliver: async () => {
        throw new Error('should not have been called');
      },
    };

    // The event is still marked delivered: no subscriber wanted it, which is
    // not a failure. Leaving it PENDING would retry it forever.
    await dispatch([uninterested]);
    expect((await outboxRow(event.id))?.state).toBe('DELIVERED');
  });
});

describe.skipIf(available)('transactional outbox (skipped)', () => {
  it('requires a test database', () => {
    expect(true).toBe(true);
  });
});
