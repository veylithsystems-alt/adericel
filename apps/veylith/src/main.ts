import { assertTenantIsolationEnforced } from '@adericel/graph';
import { buildServer, createAppContext } from '@adericel/api';
import { errorFields, loadConfig } from '@adericel/shared';
import { DEFAULT_COMPANY_POLICY, ensureAutonomyPolicy } from '@adericel/vaol';
import { registerVeylithRoutes } from './routes.js';

/**
 * Veylith's own deployment of Adericel.
 *
 * WHY THIS EXISTS AS A SEPARATE ENTRY POINT
 *
 * The product used to carry the company layer behind a flag: a company route
 * file inside `apps/api/src`, and a dynamic import of the company package in
 * the product's own startup. That kept the company code out of a product
 * build's module graph, and it did not keep it out of the product's **source
 * tree** — `apps/api` declared the dependency and its TypeScript project
 * referenced it. Giving Adericel its own repository therefore meant editing
 * manifests on the way out, and a separation held by a patch script is one that
 * eventually does not hold.
 *
 * So the dependency is inverted. This entry point depends on the product; the
 * product depends on nothing of Veylith's and cannot name it. The product's own
 * `apps/api` entry point starts a customer's deployment and has no company
 * branch left in it at all.
 *
 * WHAT THIS DOES THAT THE PRODUCT ENTRY DOES NOT
 *
 * Installs the company's default autonomy policy, and registers the internal
 * control room. Both were previously conditional on `ADERICEL_COMPANY_LAYER`;
 * the flag is still required here, because a company deployment must be
 * deliberate and an operator who starts the wrong binary should be told rather
 * than quietly given Veylith's control room.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.companyLayerEnabled) {
    // Refused rather than degraded to a product deployment. Starting this
    // binary is a statement about which deployment this is, and an operator
    // who disagrees with their own configuration needs to resolve it, not be
    // silently given one of the two.
    process.stderr.write(
      "This is Veylith's own deployment and ADERICEL_COMPANY_LAYER is not set.\n" +
        'Set it, or run the product entry point (adericel-api) instead.\n',
    );
    process.exit(1);
  }

  const app = createAppContext({ config });

  app.logger.info(
    { release: config.releaseVersion, nodeEnv: config.nodeEnv, deployment: 'veylith' },
    'starting Veylith on Adericel',
  );

  const latency = await app.db.ping();
  app.logger.info({ latencyMs: latency }, 'database reachable');

  // The same refusal the product makes, for the same reason: an instance whose
  // row level security is silently bypassed works perfectly right up until it
  // serves one customer another customer's assurance data.
  await assertTenantIsolationEnforced({
    db: app.db,
    logger: app.logger,
    isProduction: config.nodeEnv === 'production',
  });

  /**
   * The company's authority model.
   *
   * Installed only when no version exists — once a policy is in the database it
   * is the company's, possibly deliberately narrowed, and an upgrade
   * overwriting it with the shipped default would be a privilege escalation
   * performed by a deployment.
   */
  const policy = await app.db.withPlatform(async (ctx) =>
    ensureAutonomyPolicy(ctx, DEFAULT_COMPANY_POLICY, 'bootstrap', app.clock),
  );
  app.logger.info(
    { installed: policy.installed, policyHash: policy.hash },
    policy.installed
      ? 'installed the default company autonomy policy'
      : 'company autonomy policy already present; left unchanged',
  );

  const server = await buildServer(app, { additionalRoutes: [registerVeylithRoutes] });

  await server.listen({ host: config.api.host, port: config.api.port });
  app.logger.info({ host: config.api.host, port: config.api.port }, 'listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.logger.info({ signal }, 'shutting down');
      void server
        .close()
        .then(async () => app.db.close())
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          app.logger.error(errorFields(error), 'shutdown failed');
          process.exit(1);
        });
    });
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(errorFields(error))}\n`);
  process.exit(1);
});
