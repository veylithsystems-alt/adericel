import { createHmac } from 'node:crypto';
import {
  claimBatch,
  markDelivered,
  markFailed,
  type ClaimedEvent,
  type Database,
} from '@adericel/graph';
import {
  backoffDelayMs,
  errorFields,
  withTimeout,
  DEFAULT_RETRY_POLICY,
  type AdericelConfig,
  type Clock,
  type Logger,
} from '@adericel/shared';

/**
 * Outbox dispatcher.
 *
 * Events are claimed with `FOR UPDATE SKIP LOCKED`, so several worker replicas
 * can run without coordination. A claimed event carries a visibility deadline:
 * a worker that dies mid-batch releases its work automatically instead of
 * stranding it.
 *
 * Delivery is at-least-once. Subscribers must tolerate duplicates, and the
 * event id makes that straightforward. The alternative — exactly-once delivery —
 * is not achievable across a network boundary, and pretending otherwise would
 * push a false guarantee onto every consumer.
 */

export interface EventSubscriber {
  readonly name: string;
  /** Event types this subscriber wants; `*` for all. */
  readonly eventTypes: readonly string[];
  deliver(event: ClaimedEvent): Promise<void>;
}

export interface DispatcherOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly config: AdericelConfig;
  readonly workerId: string;
  readonly subscribers: readonly EventSubscriber[];
}

export interface DispatchResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export function subscriberWants(subscriber: EventSubscriber, type: string): boolean {
  return subscriber.eventTypes.includes('*') || subscriber.eventTypes.includes(type);
}

export async function dispatchOnce(options: DispatcherOptions): Promise<DispatchResult> {
  const { db, logger, config, workerId, subscribers } = options;

  const events = await db.withPlatform(async (ctx) =>
    claimBatch(ctx, workerId, config.worker.batchSize, config.worker.visibilityTimeoutMs),
  );
  if (events.length === 0) {
    return { claimed: 0, delivered: 0, failed: 0, deadLettered: 0 };
  }

  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const event of events) {
    const eventLogger = logger.child({
      eventId: event.id,
      eventType: event.type,
      correlationId: event.correlationId,
      organisationId: event.organisationId,
      attempt: event.attempts,
    });

    const interested = subscribers.filter((s) => subscriberWants(s, event.type));
    if (interested.length === 0) {
      // Nothing is listening for this type. That is a normal, healthy state —
      // the event is still durably recorded in the event log.
      await db.withPlatform(async (ctx) => markDelivered(ctx, event.id));
      delivered += 1;
      continue;
    }

    const failures: string[] = [];
    for (const subscriber of interested) {
      try {
        await subscriber.deliver(event);
      } catch (error) {
        failures.push(`${subscriber.name}: ${(error as Error).message}`);
        eventLogger.warn(
          { subscriber: subscriber.name, ...errorFields(error) },
          'event delivery failed',
        );
      }
    }

    if (failures.length === 0) {
      await db.withPlatform(async (ctx) => markDelivered(ctx, event.id));
      delivered += 1;
      continue;
    }

    const nextDelay = backoffDelayMs(DEFAULT_RETRY_POLICY, event.attempts);
    const outcome = await db.withPlatform(async (ctx) =>
      markFailed(ctx, event.id, failures.join('; '), config.worker.maxDeliveryAttempts, nextDelay),
    );

    if (outcome === 'DEAD_LETTER') {
      deadLettered += 1;
      // A dead-lettered event means a downstream view of assurance is now
      // stale. It is never dropped: it stays visible to operators and appears
      // in system health until it is replayed or explicitly discarded.
      eventLogger.error(
        { failures },
        'event exhausted delivery attempts and moved to the dead-letter queue',
      );
    } else {
      failed += 1;
    }
  }

  return { claimed: events.length, delivered, failed, deadLettered };
}

/**
 * n8n subscriber.
 *
 * Posts each event to the configured n8n webhook, signed with an HMAC over
 * `{timestamp}.{body}` so n8n can verify the delivery came from this Adericel
 * deployment and is not a replay.
 */
export function createN8nSubscriber(options: {
  readonly baseUrl: string;
  readonly signingSecret: string;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly eventTypes?: readonly string[];
}): EventSubscriber {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/$/, '')}/webhook/adericel-events`;

  return {
    name: 'n8n',
    eventTypes: options.eventTypes ?? ['*'],
    async deliver(event: ClaimedEvent): Promise<void> {
      const body = JSON.stringify(event);
      const timestamp = String(options.clock.nowEpochMs());
      const signature = createHmac('sha256', options.signingSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      const response = await withTimeout(
        async (signal) =>
          doFetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-adericel-signature': signature,
              'x-adericel-timestamp': timestamp,
              'x-adericel-event-type': event.type,
              'x-adericel-event-id': event.id,
              'x-correlation-id': event.correlationId,
            },
            body,
            signal,
          }),
        15_000,
        'n8n event delivery',
      );

      if (!response.ok) {
        throw new Error(`n8n returned ${response.status}`);
      }
    },
  };
}

/** Logs every event. Useful in development and as a delivery floor in tests. */
export function createLoggingSubscriber(logger: Logger): EventSubscriber {
  return {
    name: 'log',
    eventTypes: ['*'],
    async deliver(event: ClaimedEvent): Promise<void> {
      logger.debug(
        {
          eventId: event.id,
          type: event.type,
          subject: `${event.subjectType}:${event.subjectId}`,
          correlationId: event.correlationId,
        },
        'event',
      );
    },
  };
}
