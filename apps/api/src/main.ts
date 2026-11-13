import { loadConfig, errorFields } from '@adericel/shared';
import { assertTenantIsolationEnforced } from '@adericel/graph';
import { createAppContext } from './context.js';
import { buildServer } from './app.js';

/**
 * API entrypoint.
 *
 * Startup is fail-fast: configuration is validated, production placeholders are
 * refused, and the database is reached before the listener opens. A process that
 * cannot serve correctly should not accept traffic at all.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = createAppContext({ config });

  app.logger.info(
    {
      release: config.releaseVersion,
      nodeEnv: config.nodeEnv,
      storageDriver: config.storage.driver,
      rulesets: app.rulesets.list().map((r) => `${r.key}@${r.version}`),
      connectors: app.connectors.list().map((c) => c.key),
    },
    'starting Adericel API',
  );

  const latency = await app.db.ping();
  app.logger.info({ latencyMs: latency }, 'database reachable');

  // Before serving a single request, prove that tenant isolation is actually in
  // force. An instance where row level security is silently bypassed works
  // perfectly right up until it serves one customer another customer's
  // assurance data, so this refuses to start rather than reporting unhealthy.
  await assertTenantIsolationEnforced({
    db: app.db,
    logger: app.logger,
    isProduction: config.nodeEnv === 'production',
  });

  /**
   * This is the product. There is no company branch here any more.
   *
   * There used to be one: a dynamic import of the company package behind
   * `ADERICEL_COMPANY_LAYER`, which kept the company layer out of a product
   * build's module graph. It did not keep it out of the product's source tree —
   * `apps/api` declared the dependency and its TypeScript project referenced it
   * — so giving Adericel its own repository meant editing manifests on the way
   * out, and a separation held by a patch script is one that eventually does
   * not hold.
   *
   * Veylith's own deployment is now `apps/veylith`, which depends on this app
   * and installs the company's autonomy policy itself. Nothing points back.
   */
  app.logger.info(
    'product deployment: holds none of Veylith\u2019s own operating or commercial machinery, ' +
      'and cannot be configured into holding it',
  );

  const server = await buildServer(app);

  const shutdown = async (signal: string): Promise<void> => {
    app.logger.info({ signal }, 'shutting down');
    // Stop accepting connections first, then let in-flight work finish, then
    // release the pool. Cutting the pool first would fail requests that were
    // already accepted.
    try {
      await server.close();
      await app.db.close();
      app.logger.info({}, 'shutdown complete');
      process.exit(0);
    } catch (error) {
      app.logger.error(errorFields(error), 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.logger.fatal(errorFields(reason), 'unhandled rejection');
    process.exit(1);
  });

  await server.listen({ host: config.api.host, port: config.api.port });
  app.logger.info({ host: config.api.host, port: config.api.port }, 'API listening');
}

main().catch((error: unknown) => {
  console.error('Failed to start Adericel API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
