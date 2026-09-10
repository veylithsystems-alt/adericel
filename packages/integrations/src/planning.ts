import type { CollectCapability, ConnectorManifest, EvidenceDomain } from './manifest.js';

/**
 * Collection planning and capability discovery.
 *
 * Two questions, one index.
 *
 *   What must we go and collect to assess this ruleset?
 *   What can this customer's integrations actually tell us?
 *
 * Both are answered by resolving canonical predicates to connector
 * capabilities. Without that resolution Adericel can only query every connector
 * for everything and hope, and — much worse — it cannot tell a control that is
 * FAILING from one that CANNOT BE ASSESSED.
 */

/** One configured integration, as the planner sees it. */
export interface PlannableIntegration {
  readonly integrationId: string;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly manifest: ConnectorManifest;
  /** Capabilities disabled by configuration or by a previous failure. */
  readonly disabledCapabilities?: readonly string[];
}

export interface PredicateSource {
  readonly integrationId: string;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly capability: string;
  readonly domain: EvidenceDomain;
  readonly requiredPermission: string;
  readonly fidelity: 'LIVE' | 'DEMONSTRATION';
}

export interface CollectionTask {
  readonly integrationId: string;
  readonly connectorKey: string;
  readonly capability: string;
  /** The predicates this task exists to satisfy. */
  readonly predicates: readonly string[];
  readonly incremental: boolean;
}

export interface CollectionPlan {
  readonly tasks: readonly CollectionTask[];
  /** Predicates no configured integration can supply. */
  readonly unsatisfiable: readonly string[];
  /** Predicates more than one integration can supply. */
  readonly multiplySourced: readonly {
    readonly predicate: string;
    readonly sources: readonly PredicateSource[];
  }[];
}

/** Index every configured integration by the predicates it can supply. */
export function indexPredicateSources(
  integrations: readonly PlannableIntegration[],
): ReadonlyMap<string, readonly PredicateSource[]> {
  const index = new Map<string, PredicateSource[]>();
  for (const integration of integrations) {
    const disabled = new Set(integration.disabledCapabilities ?? []);
    for (const capability of integration.manifest.collect) {
      if (disabled.has(capability.key)) continue;
      for (const predicate of capability.predicates) {
        const sources = index.get(predicate) ?? [];
        sources.push({
          integrationId: integration.integrationId,
          connectorKey: integration.connectorKey,
          displayName: integration.displayName,
          capability: capability.key,
          domain: capability.domain,
          requiredPermission: capability.requiredPermission,
          fidelity: integration.manifest.fidelity,
        });
        index.set(predicate, sources);
      }
    }
  }
  return index;
}

/**
 * Build the minimal plan that satisfies a set of required predicates.
 *
 * Deduplicated by (integration, capability): if three controls all need
 * `device.encryption.enabled`, the device capability is collected once. That
 * matters at MSP scale, where the difference between per-control and per-
 * capability collection is the difference between one API call and forty.
 *
 * Pure and deterministic, so the plan for a given ruleset and integration set
 * is reproducible and can be shown to an operator before anything runs.
 */
export function planCollection(
  requiredPredicates: readonly string[],
  integrations: readonly PlannableIntegration[],
): CollectionPlan {
  const index = indexPredicateSources(integrations);
  const tasks = new Map<string, { task: CollectionTask; predicates: Set<string> }>();
  const unsatisfiable: string[] = [];
  const multiplySourced: { predicate: string; sources: readonly PredicateSource[] }[] = [];

  for (const predicate of [...new Set(requiredPredicates)].sort()) {
    const sources = index.get(predicate) ?? [];
    if (sources.length === 0) {
      // Recorded, not dropped. A predicate nothing can supply is the reason a
      // control will read UNKNOWN, and the customer deserves to be told which
      // integration would fix it rather than left to guess.
      unsatisfiable.push(predicate);
      continue;
    }
    if (sources.length > 1) multiplySourced.push({ predicate, sources });

    // Every source is collected, not just a preferred one. Choosing here would
    // hide a disagreement between two systems, and a disagreement is exactly
    // the thing a system of record must surface rather than resolve by
    // accident. Conflict resolution happens after collection, where it is
    // visible.
    for (const source of sources) {
      const key = `${source.integrationId}:${source.capability}`;
      const existing = tasks.get(key);
      if (existing) {
        existing.predicates.add(predicate);
        continue;
      }
      const capability = integrations
        .find((i) => i.integrationId === source.integrationId)
        ?.manifest.collect.find((c) => c.key === source.capability);
      tasks.set(key, {
        task: {
          integrationId: source.integrationId,
          connectorKey: source.connectorKey,
          capability: source.capability,
          predicates: [],
          incremental: capability?.incremental ?? false,
        },
        predicates: new Set([predicate]),
      });
    }
  }

  return {
    tasks: [...tasks.values()]
      .map(({ task, predicates }) => ({ ...task, predicates: [...predicates].sort() }))
      .sort((a, b) =>
        a.integrationId === b.integrationId
          ? a.capability.localeCompare(b.capability)
          : a.integrationId.localeCompare(b.integrationId),
      ),
    unsatisfiable,
    multiplySourced,
  };
}

export interface DomainCoverage {
  readonly domain: EvidenceDomain;
  readonly capabilities: readonly {
    readonly key: string;
    readonly title: string;
    readonly available: boolean;
    readonly sources: readonly string[];
  }[];
}

/**
 * What this organisation's integrations can currently tell us.
 *
 * The answer a customer needs before they read a single control state, because
 * it reframes every UNKNOWN on the page: an UNKNOWN over a domain nothing can
 * see is a missing integration, and an UNKNOWN over a domain that is covered is
 * a genuine gap in the evidence.
 */
export function discoverCoverage(
  integrations: readonly PlannableIntegration[],
  /** Every capability Adericel knows how to consume, from all connectors. */
  knownCapabilities: readonly CollectCapability[],
): readonly DomainCoverage[] {
  const configured = new Map<string, string[]>();
  for (const integration of integrations) {
    const disabled = new Set(integration.disabledCapabilities ?? []);
    for (const capability of integration.manifest.collect) {
      if (disabled.has(capability.key)) continue;
      const sources = configured.get(capability.key) ?? [];
      sources.push(integration.displayName);
      configured.set(capability.key, sources);
    }
  }

  const byDomain = new Map<EvidenceDomain, DomainCoverage['capabilities'][number][]>();
  const seen = new Set<string>();
  for (const capability of knownCapabilities) {
    if (seen.has(capability.key)) continue;
    seen.add(capability.key);
    const sources = configured.get(capability.key) ?? [];
    const list = byDomain.get(capability.domain) ?? [];
    list.push({
      key: capability.key,
      title: capability.title,
      available: sources.length > 0,
      sources: [...new Set(sources)].sort(),
    });
    byDomain.set(capability.domain, list);
  }

  return [...byDomain.entries()]
    .map(([domain, capabilities]) => ({
      domain,
      capabilities: [...capabilities].sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}
