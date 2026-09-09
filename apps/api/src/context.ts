import {
  createCredentialCipher,
  createEnvelopeCipher,
  createLocalRootKeyProvider,
  createLogger,
  createPasswordHasher,
  systemClock,
  type AdericelConfig,
  type Clock,
  type CredentialCipher,
  type EnvelopeCipher,
  type Logger,
  type PasswordHasher,
} from '@adericel/shared';
import { createObjectStore, type ObjectStore } from '@adericel/evidence';
import { createDataKeyStore, databaseFromConfig, type Database } from '@adericel/graph';
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
  /** Organisation-scoped secrets: integration credentials. Envelope sealed. */
  readonly credentials: EnvelopeCipher;
  /**
   * Platform-scoped secrets that belong to a person rather than to an
   * organisation — a user's TOTP seed. These cannot use a per-organisation data
   * key because a user is not inside an organisation: they hold grants over
   * several. Sealed directly under the root secret, with the user id as
   * additional authenticated data.
   */
  readonly secrets: CredentialCipher;
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
  /**
   * Integration credentials are sealed under a per-organisation data key, with
   * the integration id as additional authenticated data (ADR-0019). A sealed
   * blob copied to another integration's row fails to open; one copied to
   * another organisation's row fails on the key lookup before that.
   */
  const credentials = createEnvelopeCipher({
    rootKeys: createLocalRootKeyProvider(config.auth.credentialEncryptionKey),
    store: createDataKeyStore(db),
    // Values written before envelope encryption existed were sealed directly
    // with this secret. They keep opening, and are re-sealed the next time they
    // are written — no migration window, no stop-the-world.
    legacySecret: config.auth.credentialEncryptionKey,
  });

  const unsealCredentials: CredentialUnsealer = async (sealed, integrationId, organisationId) => {
    const plaintext = await credentials.open(sealed, { organisationId, aad: integrationId });

    // Re-seal on read, in the background, when the value is still in the old
    // format. Doing it here rather than in a migration script means the upgrade
    // completes on its own as integrations are used, and a deployment that is
    // never fully exercised simply keeps working on the legacy path.
    //
    // The failure is logged and swallowed: the caller asked for a credential
    // and got one, and turning a successful read into an error because an
    // opportunistic write failed would be the wrong trade.
    if (credentials.needsReseal(sealed)) {
      void (async () => {
        try {
          const resealed = await credentials.seal(plaintext, {
            organisationId,
            aad: integrationId,
          });
          await db.withTenant(organisationId, async (ctx) => {
            // Guarded on the value we read, so a credential rotated in the
            // meantime is not overwritten with the old one.
            await ctx.query(
              `UPDATE integrations SET sealed_credentials = $2
                WHERE id = $1 AND sealed_credentials = $3`,
              [integrationId, resealed, sealed],
            );
          });
        } catch (error) {
          logger.warn(
            { integrationId, error: String(error) },
            'could not re-seal a legacy credential; it remains readable on the legacy path',
          );
        }
      })();
    }

    return JSON.parse(plaintext) as Record<string, unknown>;
  };

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
    secrets: createCredentialCipher(config.auth.credentialEncryptionKey),
    unsealCredentials,
    startedAtIso: clock.nowIso(),
  };
}
