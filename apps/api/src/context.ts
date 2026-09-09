import {
  createCredentialCipher,
  createLogger,
  createPasswordHasher,
  systemClock,
  type AdericelConfig,
  type Clock,
  type CredentialCipher,
  type Logger,
  type PasswordHasher,
} from '@adericel/shared';
import { createObjectStore, type ObjectStore } from '@adericel/evidence';
import { databaseFromConfig, type Database } from '@adericel/graph';
import { buildConnectorRegistry, type ConnectorRegistry } from '@adericel/integrations';
import { compilePolicy, DEFAULT_ACTION_POLICY, type CompiledPolicy } from '@adericel/policy';
import { createBuiltInRegistry, type RulesetRegistry } from '@adericel/truth-engine';
import type { CredentialUnsealer } from '@adericel/actions';

/**
 * Application context.
 *
 * Every dependency the API needs is constructed once here and passed down
 * explicitly. There are no module-level singletons: tests build a context with
 * a fixed clock and an in-memory store, and production builds one from config,
 * using the same code path.
 */
export interface AppContext {
  readonly config: AdericelConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly db: Database;
  readonly storage: ObjectStore;
  readonly rulesets: RulesetRegistry;
  readonly connectors: ConnectorRegistry;
  readonly defaultPolicy: CompiledPolicy;
  readonly passwords: PasswordHasher;
  readonly credentials: CredentialCipher;
  readonly unsealCredentials: CredentialUnsealer;
  readonly startedAtIso: string;
}

export interface CreateContextOptions {
  readonly config: AdericelConfig;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly db?: Database;
  readonly storage?: ObjectStore;
  readonly connectors?: ConnectorRegistry;
  readonly fetchImpl?: typeof fetch;
}

export function createAppContext(options: CreateContextOptions): AppContext {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      bindings: { service: config.serviceName, release: config.releaseVersion },
      pretty: config.nodeEnv === 'development',
    });

  const db = options.db ?? databaseFromConfig(config, logger);
  const storage = options.storage ?? createObjectStore(config);
  const credentials = createCredentialCipher(config.auth.credentialEncryptionKey);

  /**
   * Integration credentials are sealed with the integration id as additional
   * authenticated data. A sealed blob copied from one integration row to
   * another therefore fails to decrypt rather than silently granting access to
   * a different tenant's system.
   */
  const unsealCredentials: CredentialUnsealer = (sealed, integrationId) =>
    JSON.parse(credentials.decrypt(sealed, integrationId)) as Record<string, unknown>;

  const connectors =
    options.connectors ??
    buildConnectorRegistry({
      egressPolicy: {
        allowlist: config.security.egressAllowlist,
        blockPrivate: config.security.blockPrivateEgress,
      },
      allowDemoConnectors: config.nodeEnv !== 'production',
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }).registry;

  return {
    config,
    logger,
    clock,
    db,
    storage,
    rulesets: createBuiltInRegistry(),
    connectors,
    defaultPolicy: compilePolicy(DEFAULT_ACTION_POLICY),
    passwords: createPasswordHasher(config.auth.passwordPepper),
    credentials,
    unsealCredentials,
    startedAtIso: clock.nowIso(),
  };
}
