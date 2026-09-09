import type { ActionRiskClass, ObservationInput } from '@adericel/domain';
import type { Logger } from '@adericel/shared';
import { z } from 'zod';

/**
 * The connector contract.
 *
 * Every integration implements this same interface. The Truth Engine never
 * learns how Microsoft Entra or a particular RMM represents an account: a
 * connector's job is to turn a vendor's data into canonical observations and
 * claims, and to expose whatever executable capabilities that vendor supports.
 *
 * Adding a new vendor for an existing capability should therefore require a new
 * connector and no changes to rules, the engine, the API or the UI.
 */

export const CONNECTOR_CATEGORIES = [
  'IDENTITY',
  'ENDPOINT',
  'CLOUD',
  'PRODUCTIVITY',
  'VULNERABILITY',
  'TICKETING',
  'BACKUP',
  'NETWORK',
  'DOCUMENT',
  'MANUAL',
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export const AUTH_KINDS = ['NONE', 'API_KEY', 'BASIC', 'OAUTH2_CLIENT_CREDENTIALS', 'BEARER'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/** A capability the connector can execute against the external system. */
export interface ConnectorCapability {
  readonly actionType: string;
  readonly title: string;
  readonly description: string;
  readonly riskClass: ActionRiskClass;
  readonly parameterSchema: z.ZodType;
  /**
   * How Adericel proves the action worked. Every executable capability must
   * declare one — an action without a verification method could never leave
   * UNVERIFIED, which would make autonomy meaningless.
   */
  readonly verification: {
    readonly method: string;
    readonly description: string;
    /** Claim predicate re-collected after execution to confirm the change. */
    readonly predicate: string;
    readonly expectedValue: unknown;
  };
}

export interface CollectionResult {
  readonly observations: readonly ObservationInput[];
  /**
   * Advisory notes about the run. A warning is informational — it does not by
   * itself mean the collection was incomplete, and it must not be allowed to
   * mark a healthy integration as degraded.
   */
  readonly warnings: readonly string[];
  /**
   * Set when the connector knows it did not collect everything it should have:
   * a page limit was hit, a permission was missing, a sub-resource failed. This
   * is what marks the run PARTIAL and the integration DEGRADED, because it means
   * the resulting assurance picture has holes the connector can see.
   */
  readonly partial?: boolean;
  /** Opaque cursor for incremental collection on the next run. */
  readonly cursor: string | null;
}

export interface ExecutionRequest {
  readonly actionType: string;
  readonly targetExternalId: string | null;
  readonly parameters: Record<string, unknown>;
  /**
   * Passed to the external system where it supports request idempotency, and
   * always recorded, so a retry can be reconciled against the prior attempt.
   */
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ExecutionResult {
  readonly status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_OUTCOME';
  /** The external system's own identifier for the operation, for reconciliation. */
  readonly externalOperationRef: string | null;
  readonly detail: string;
  readonly errorCode?: string;
  /** Whether retrying could plausibly succeed. */
  readonly retryable?: boolean;
}

export interface ConnectorContext {
  readonly organisationId: string;
  readonly integrationId: string;
  readonly logger: Logger;
  readonly correlationId: string;
  readonly nowIso: string;
  /** Cursor recorded by the previous successful run, if any. */
  readonly cursor: string | null;
  readonly signal?: AbortSignal;
}

export interface ConnectionCheck {
  readonly connected: boolean;
  readonly detail: string;
  /** Permissions the credentials were observed to hold, where discoverable. */
  readonly grantedScopes?: readonly string[];
  readonly missingScopes?: readonly string[];
}

export interface Connector<TConfig = Record<string, unknown>, TCredentials = Record<string, unknown>> {
  readonly key: string;
  readonly name: string;
  readonly vendor: string;
  readonly category: ConnectorCategory;
  readonly description: string;
  readonly authKind: AuthKind;
  /** Configuration the customer or MSP supplies (non-secret). */
  readonly configSchema: z.ZodType<TConfig>;
  /** Secrets, sealed before storage and never logged. */
  readonly credentialSchema: z.ZodType<TCredentials>;
  /** Documented permissions the credentials need in the external system. */
  readonly requiredPermissions: readonly string[];
  readonly capabilities: readonly ConnectorCapability[];
  /** Default collection schedule as a cron expression. */
  readonly defaultSchedule: string;

  checkConnection(
    config: TConfig,
    credentials: TCredentials,
    context: ConnectorContext,
  ): Promise<ConnectionCheck>;

  collect(
    config: TConfig,
    credentials: TCredentials,
    context: ConnectorContext,
  ): Promise<CollectionResult>;

  execute?(
    config: TConfig,
    credentials: TCredentials,
    request: ExecutionRequest,
    context: ConnectorContext,
  ): Promise<ExecutionResult>;
}

export interface ConnectorRegistry {
  get(key: string): Connector;
  tryGet(key: string): Connector | null;
  list(): readonly Connector[];
  register(connector: Connector): void;
  /** Every executable capability across all registered connectors. */
  capabilities(): readonly (ConnectorCapability & { connectorKey: string })[];
  capabilityFor(actionType: string): (ConnectorCapability & { connectorKey: string }) | null;
}

export function createConnectorRegistry(initial: readonly Connector[] = []): ConnectorRegistry {
  const byKey = new Map<string, Connector>();

  const registry: ConnectorRegistry = {
    register(connector: Connector): void {
      if (byKey.has(connector.key)) {
        throw new Error(`Connector ${connector.key} is already registered`);
      }
      for (const capability of connector.capabilities) {
        if (!connector.execute) {
          throw new Error(
            `Connector ${connector.key} declares capability ${capability.actionType} but implements no execute()`,
          );
        }
      }
      byKey.set(connector.key, connector as Connector);
    },
    tryGet(key: string): Connector | null {
      return byKey.get(key) ?? null;
    },
    get(key: string): Connector {
      const connector = byKey.get(key);
      if (!connector) throw new Error(`Unknown connector: ${key}`);
      return connector;
    },
    list(): readonly Connector[] {
      return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    },
    capabilities() {
      return registry
        .list()
        .flatMap((connector) =>
          connector.capabilities.map((capability) => ({ ...capability, connectorKey: connector.key })),
        );
    },
    capabilityFor(actionType: string) {
      return registry.capabilities().find((c) => c.actionType === actionType) ?? null;
    },
  };

  for (const connector of initial) registry.register(connector);
  return registry;
}
