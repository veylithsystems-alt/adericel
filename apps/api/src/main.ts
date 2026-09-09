import { loadConfig, errorFields } from '@adericel/shared';
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
