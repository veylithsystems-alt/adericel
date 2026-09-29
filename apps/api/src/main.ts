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
   * The company's authority model, on a company deployment only.
   *
   * Imported dynamically rather than at the top of the file, and that is the
   * substance of the separation rather than a style choice: a static import
   * pulls `@adericel/vaol` into the module graph of every deployment, so the
   * product could not be built or shipped without the company layer even when
   * it never called it. A dynamic import inside the branch means a product
   * build genuinely does not load it, and `tests/unit/architecture.test.ts`
   * asserts there is no static path from the product to the company layer.
   *
   * Installed only when no version exists — once a policy is in the database it
   * is the company's, possibly deliberately narrowed, and an upgrade
   * overwriting it with the shipped default would be a privilege escalation
   * performed by a deployment.
   */
  if (config.companyLayerEnabled) {
    const { DEFAULT_COMPANY_POLICY, ensureAutonomyPolicy } = await import('@adericel/vaol');
    const policy = await app.db.withPlatform(async (ctx) =>
      ensureAutonomyPolicy(ctx, DEFAULT_COMPANY_POLICY, 'bootstrap', app.clock),
    );
    app.logger.info(
      { installed: policy.installed, policyHash: policy.hash },
      policy.installed
        ? 'installed the default company autonomy policy'
        : 'company autonomy policy already present; left unchanged',
    );
  } else {
    app.logger.info(
      'company layer disabled; this is a product deployment and holds none of Veylith’s own ' +
        'operating or commercial machinery',
    );
  }

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
