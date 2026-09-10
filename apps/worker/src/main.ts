import { randomUUID } from 'node:crypto';
import {
  createEnvelopeCipher,
  createLocalRootKeyProvider,
  createLogger,
  errorFields,
  loadConfig,
  sleep,
  systemClock,
} from '@adericel/shared';
import {
  assertTenantIsolationEnforced,
  createDataKeyStore,
  databaseFromConfig,
} from '@adericel/graph';
import { createObjectStore } from '@adericel/evidence';
import { buildConnectorRegistry } from '@adericel/integrations';
import { compilePolicy, DEFAULT_ACTION_POLICY } from '@adericel/policy';
import { createBuiltInRegistry } from '@adericel/truth-engine';
import type { CredentialUnsealer } from '@adericel/actions';
import {
  createLoggingSubscriber,
  createN8nSubscriber,
  dispatchOnce,
  type EventSubscriber,
} from './dispatcher.js';
import { buildHandlers } from './jobs/handlers.js';
import { ensurePlatformJobs, runDueJobs } from './jobs/scheduler.js';

/**
 * Worker entrypoint.
 *
 * Two loops share the process: an outbox dispatcher that runs frequently, and a
 * job runner that runs on a slower cadence. Both are safe to run in several
 * replicas — the dispatcher claims events with SKIP LOCKED and the job runner
 * takes a lock per job.
 *
 * The loop keeps running when a tick fails. A worker that exits on one bad
 * organisation stops assurance for every customer, which is a far worse
 * outcome than a logged error and a retry.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;
  const workerId = `${process.env.HOSTNAME ?? 'worker'}-${randomUUID().slice(0, 8)}`;

  const logger = createLogger({
    level: config.logLevel,
    bindings: { service: 'adericel-worker', workerId, release: config.releaseVersion },
    pretty: config.nodeEnv === 'development',
  });

  if (!config.worker.enabled) {
    logger.warn({}, 'worker is disabled by configuration; exiting');
    return;
  }

  const db = databaseFromConfig(config, logger);
  const storage = createObjectStore(config);
  const cipher = createEnvelopeCipher({
    rootKeys: createLocalRootKeyProvider(config.auth.credentialEncryptionKey),
    store: createDataKeyStore(db),
    legacySecret: config.auth.credentialEncryptionKey,
  });
  const unsealCredentials: CredentialUnsealer = async (sealed, integrationId, organisationId) =>
    JSON.parse(await cipher.open(sealed, { organisationId, aad: integrationId })) as Record<
      string,
      unknown
    >;

  const { registry: connectors } = buildConnectorRegistry({
    egressPolicy: {
      allowlist: config.security.egressAllowlist,
      blockPrivate: config.security.blockPrivateEgress,
    },
    allowDemoConnectors: config.nodeEnv !== 'production',
  });

  const rulesets = createBuiltInRegistry();
  const defaultPolicy = compilePolicy(DEFAULT_ACTION_POLICY);

  const subscribers: EventSubscriber[] = [createLoggingSubscriber(logger)];
  if (config.n8n.enabled && config.n8n.baseUrl && config.n8n.webhookSigningSecret) {
    subscribers.push(
      createN8nSubscriber({
        baseUrl: config.n8n.baseUrl,
        signingSecret: config.n8n.webhookSigningSecret,
        logger,
        clock,
      }),
    );
    logger.info({ baseUrl: config.n8n.baseUrl }, 'n8n event subscriber registered');
  } else {
    logger.info({}, 'n8n subscriber not configured; events are recorded but not forwarded');
  }

  const handlers = buildHandlers({
    db,
    logger,
    clock,
    config,
    rulesets,
    connectors,
    defaultPolicy,
    unsealCredentials,
  });

  await db.withPlatform(async (ctx) => ensurePlatformJobs(ctx, clock.nowIso()));

  await db.ping();
  await storage.ping();

  // Same reasoning as the API. The worker writes evidence and executes actions
  // inside tenant transactions, so an unenforced instance is at least as
  // dangerous here as it is on the request path.
  await assertTenantIsolationEnforced({
    db,
    logger,
    isProduction: config.nodeEnv === 'production',
  });
  logger.info(
    {
      subscribers: subscribers.map((s) => s.name),
      connectors: connectors.list().map((c) => c.key),
    },
    'worker started',
  );

  let running = true;
  const stop = (signal: string): void => {
    logger.info({ signal }, 'stopping worker');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  let lastJobSweep = 0;
  const JOB_INTERVAL_MS = 15_000;

  while (running) {
    const tickStarted = Date.now();

    try {
      const result = await dispatchOnce({ db, logger, clock, config, workerId, subscribers });
      if (result.claimed > 0) {
        logger.info(
          {
            claimed: result.claimed,
            delivered: result.delivered,
            failed: result.failed,
            deadLettered: result.deadLettered,
          },
          'dispatched events',
        );
      }
    } catch (error) {
      logger.error(errorFields(error), 'dispatch tick failed');
    }

    if (Date.now() - lastJobSweep >= JOB_INTERVAL_MS) {
      lastJobSweep = Date.now();
      try {
        const result = await runDueJobs({ db, logger, clock, workerId, limit: 10, handlers });
        if (result.ran > 0 || result.failed > 0) {
          logger.info({ ran: result.ran, failed: result.failed }, 'ran scheduled jobs');
        }
      } catch (error) {
        logger.error(errorFields(error), 'job sweep failed');
      }
    }

    const elapsed = Date.now() - tickStarted;
    const wait = Math.max(0, config.worker.pollIntervalMs - elapsed);
    if (wait > 0) await sleep(wait);
  }

  await db.close();
  logger.info({}, 'worker stopped');
}

main().catch((error: unknown) => {
  console.error('Worker failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
