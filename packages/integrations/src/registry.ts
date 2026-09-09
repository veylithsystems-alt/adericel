import type { Connector, ConnectorRegistry } from './connector.js';
import { createConnectorRegistry } from './connector.js';
import type { EgressPolicy } from './http.js';
import { createMicrosoftEntraConnector } from './connectors/microsoft-entra.js';
import { createMicrosoftIntuneConnector } from './connectors/microsoft-intune.js';
import { createGenericHttpConnector } from './connectors/generic-http.js';
import { createAdericelSelfConnector, type SelfAssuranceProbe } from './connectors/adericel-self.js';
import { createDemoFixtureConnector, createFixtureState, type FixtureState } from './connectors/demo-fixture.js';

export interface RegistryOptions {
  readonly egressPolicy: EgressPolicy;
  readonly selfProbe?: SelfAssuranceProbe;
  /**
   * Register the demonstration fixture connector. Enabled for development,
   * tests and seeded demonstration tenants; refused in production so that
   * demonstration data can never be mistaken for a real environment.
   */
  readonly allowDemoConnectors?: boolean;
  readonly fixtureState?: FixtureState;
  readonly fetchImpl?: typeof fetch;
}

export interface BuiltRegistry {
  readonly registry: ConnectorRegistry;
  readonly fixtureState: FixtureState | null;
}

export function buildConnectorRegistry(options: RegistryOptions): BuiltRegistry {
  const deps = {
    egressPolicy: options.egressPolicy,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  const connectors: Connector[] = [
    createMicrosoftEntraConnector(deps) as unknown as Connector,
    createMicrosoftIntuneConnector(deps) as unknown as Connector,
    createGenericHttpConnector(deps) as unknown as Connector,
  ];

  if (options.selfProbe) {
    connectors.push(createAdericelSelfConnector(options.selfProbe) as unknown as Connector);
  }

  let fixtureState: FixtureState | null = null;
  if (options.allowDemoConnectors) {
    fixtureState = options.fixtureState ?? createFixtureState();
    connectors.push(createDemoFixtureConnector(fixtureState) as unknown as Connector);
  }

  return { registry: createConnectorRegistry(connectors), fixtureState };
}
