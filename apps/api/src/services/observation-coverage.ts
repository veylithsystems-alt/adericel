import type { TenantContext } from '@adericel/graph';
import {
  demoFixtureManifestFor,
  discoverCoverage,
  genericHttpManifestFor,
  indexPredicateSources,
  planCollection,
  type CollectCapability,
  type ConnectorRegistry,
  type EvidenceDomain,
  type PlannableIntegration,
} from '@adericel/integrations';
import { referencedPredicates, type RulesetRegistry } from '@adericel/truth-engine';

/**
 * What can this organisation actually see?
 *
 * The question a customer needs answered before they read a single control
 * state, because it reframes every UNKNOWN on the page. An UNKNOWN over
 * something nothing is connected to is a missing integration; an UNKNOWN over
 * something a connected integration covers is a real gap in their estate; and
 * an UNKNOWN caused by a permission a connector was refused this morning is
 * neither — it is a five-minute fix.
 *
 * Adericel could not previously tell those three apart, and presenting them
 * identically is how an assurance product loses a customer's trust: they chase
 * a problem that is ours, or ignore one that is theirs.
 */

export interface PredicateGap {
  readonly predicate: string;
  /** Connectors this deployment ships that could supply it, if connected. */
  readonly wouldBeSuppliedBy: readonly { readonly connectorKey: string; readonly name: string }[];
}

export interface BrokenCapability {
  readonly integrationId: string;
  readonly integrationName: string;
  readonly capability: string;
  readonly outcome: string;
  readonly detail: string;
  readonly requiredPermission: string;
  readonly unavailablePredicates: readonly string[];
  readonly observedAt: string;
}

export interface CoverageReport {
  readonly domains: readonly {
    readonly domain: EvidenceDomain;
    /** No connector this deployment ships supplies anything in this domain. */
    readonly noConnectorExists: boolean;
    readonly capabilities: readonly {
      readonly key: string;
      readonly title: string;
      readonly available: boolean;
      readonly sources: readonly string[];
    }[];
  }[];
  /** Predicates the active rulesets need. */
  readonly requiredPredicates: number;
  readonly satisfiedPredicates: number;
  /** Predicates no configured integration can supply, and what would fix each. */
  readonly gaps: readonly PredicateGap[];
  /** Predicates more than one integration supplies — where conflict can arise. */
  readonly multiplySourced: readonly {
    readonly predicate: string;
    readonly sources: readonly string[];
  }[];
  /** Capabilities that failed on their most recent run. */
  readonly brokenCapabilities: readonly BrokenCapability[];
  /** Predicates currently unavailable because a capability failed, not because nothing supplies them. */
  readonly temporarilyUnavailable: readonly string[];
  /** Whether any configured integration is a demonstration fixture. */
  readonly containsDemonstrationData: boolean;
}

interface IntegrationRow {
  id: string;
  connector_key: string;
  name: string;
  status: string;
  configuration: Record<string, unknown>;
}

/**
 * The manifest an integration actually has.
 *
 * A generic connector's capability is a property of its configuration rather
 * than of its code, so its effective manifest is derived from the field
 * mappings the customer configured. Reading the connector's static manifest
 * instead would report every declaratively configured API as supplying nothing.
 */
export function effectiveManifest(
  connectors: ConnectorRegistry,
  row: Pick<IntegrationRow, 'connector_key' | 'configuration'>,
): PlannableIntegration['manifest'] | null {
  const connector = connectors.tryGet(row.connector_key);
  if (!connector) return null;

  const parsed = connector.configSchema.safeParse(row.configuration);
  if (!parsed.success) return connector.manifest;

  if (connector.key === 'generic-http-json') {
    const config = parsed.data as { observationKind: string; mappings: { to: string }[] };
    return genericHttpManifestFor({
      observationKind: config.observationKind as never,
      mappings: config.mappings ?? [],
    });
  }

  if (connector.key === 'adericel-demo-fixture') {
    const config = parsed.data as {
      records: { kind: string; payload: Record<string, unknown> }[];
    };
    return demoFixtureManifestFor({ records: config.records ?? [] });
  }

  return connector.manifest;
}

export async function buildCoverageReport(
  ctx: TenantContext,
  connectors: ConnectorRegistry,
  rulesets: RulesetRegistry,
  options: { readonly frameworks?: readonly string[] } = {},
): Promise<CoverageReport> {
  const rows = await ctx.many<IntegrationRow>(
    `SELECT id, connector_key, name, status, configuration
     FROM integrations
     WHERE organisation_id = $1 AND status <> 'DISABLED'
     ORDER BY name`,
    [ctx.organisationId],
  );

  const integrations: PlannableIntegration[] = [];
  let containsDemonstrationData = false;
  for (const row of rows) {
    const manifest = effectiveManifest(connectors, row);
    if (!manifest) continue;
    if (manifest.fidelity === 'DEMONSTRATION') containsDemonstrationData = true;
    integrations.push({
      integrationId: row.id,
      connectorKey: row.connector_key,
      displayName: row.name,
      manifest,
    });
  }

  // What the active rulesets need. Derived from the rules themselves rather
  // than maintained by hand, so a new rule cannot silently need evidence
  // nothing is set up to collect.
  const required = new Set<string>();
  for (const ruleset of rulesets.list()) {
    if (options.frameworks && !options.frameworks.includes(ruleset.key)) continue;
    for (const rule of ruleset.rules) {
      for (const predicate of referencedPredicates(rule.expression)) required.add(predicate);
      if (rule.applicability) {
        for (const predicate of referencedPredicates(rule.applicability)) required.add(predicate);
      }
    }
  }

  const plan = planCollection([...required], integrations);

  // What WOULD supply a gap, across every connector this deployment ships. The
  // difference between "we cannot assess this" and "connect Intune and we can".
  const everyConnector: PlannableIntegration[] = connectors.list().map((connector) => ({
    integrationId: `available:${connector.key}`,
    connectorKey: connector.key,
    displayName: connector.name,
    manifest: connector.manifest,
  }));
  const availableIndex = indexPredicateSources(everyConnector);

  const gaps: PredicateGap[] = plan.unsatisfiable.map((predicate) => ({
    predicate,
    wouldBeSuppliedBy: (availableIndex.get(predicate) ?? [])
      .filter((source) => source.fidelity === 'LIVE')
      .map((source) => ({ connectorKey: source.connectorKey, name: source.displayName })),
  }));

  // Capabilities that failed on each integration's most recent run. A failure
  // three runs ago that has since recovered is history, not a live problem.
  const broken = await ctx.many<{
    integration_id: string;
    name: string;
    capability: string;
    outcome: string;
    detail: string;
    required_permission: string;
    unavailable_predicates: string[];
    created_at: Date;
  }>(
    `SELECT r.integration_id, i.name, r.capability, r.outcome, r.detail,
            r.required_permission, r.unavailable_predicates, r.created_at
     FROM integration_capability_reports r
     JOIN integrations i ON i.id = r.integration_id
     WHERE r.organisation_id = $1
       AND r.outcome <> 'AVAILABLE'
       AND r.integration_run_id = (
         SELECT run.id FROM integration_runs run
         WHERE run.integration_id = r.integration_id AND run.organisation_id = $1
         ORDER BY run.started_at DESC LIMIT 1
       )
     ORDER BY i.name, r.capability`,
    [ctx.organisationId],
  );

  const temporarilyUnavailable = new Set<string>();
  for (const row of broken) {
    for (const predicate of row.unavailable_predicates) temporarilyUnavailable.add(predicate);
  }

  // The catalogue a customer is shown, which is what they could connect. A
  // demonstration connector's capabilities are excluded: listing one as
  // available coverage would invite a customer to satisfy a control with
  // fixture data, which is the single worst thing this page could do.
  const knownCapabilities: CollectCapability[] = connectors
    .list()
    .filter((connector) => connector.manifest.fidelity === 'LIVE')
    .flatMap((connector) => connector.manifest.collect);

  return {
    domains: discoverCoverage(integrations, knownCapabilities),
    requiredPredicates: required.size,
    satisfiedPredicates: required.size - plan.unsatisfiable.length,
    gaps,
    multiplySourced: plan.multiplySourced.map((entry) => ({
      predicate: entry.predicate,
      sources: entry.sources.map((source) => source.displayName),
    })),
    brokenCapabilities: broken.map((row) => ({
      integrationId: row.integration_id,
      integrationName: row.name,
      capability: row.capability,
      outcome: row.outcome,
      detail: row.detail,
      requiredPermission: row.required_permission,
      unavailablePredicates: row.unavailable_predicates,
      observedAt: row.created_at.toISOString(),
    })),
    temporarilyUnavailable: [...temporarilyUnavailable].sort(),
    containsDemonstrationData,
  };
}

/**
 * Why a specific control cannot be assessed.
 *
 * "No evidence recorded" is true and useless. This turns it into one of three
 * answers a person can act on: nothing supplies this and here is what would;
 * something supplies it and is currently refused this permission; or two
 * systems disagree and we will not choose between them.
 */
export interface EvidenceGapExplanation {
  readonly predicate: string;
  readonly reason: 'NO_SOURCE' | 'CAPABILITY_FAILING' | 'SOURCES_DISAGREE' | 'AWAITING_COLLECTION';
  readonly detail: string;
  readonly remedy: string | null;
}

export async function explainEvidenceGaps(
  ctx: TenantContext,
  connectors: ConnectorRegistry,
  predicates: readonly string[],
): Promise<readonly EvidenceGapExplanation[]> {
  if (predicates.length === 0) return [];

  const rows = await ctx.many<IntegrationRow>(
    `SELECT id, connector_key, name, status, configuration
     FROM integrations WHERE organisation_id = $1 AND status <> 'DISABLED'`,
    [ctx.organisationId],
  );
  const integrations: PlannableIntegration[] = [];
  for (const row of rows) {
    const manifest = effectiveManifest(connectors, row);
    if (manifest) {
      integrations.push({
        integrationId: row.id,
        connectorKey: row.connector_key,
        displayName: row.name,
        manifest,
      });
    }
  }
  const configured = indexPredicateSources(integrations);
  const available = indexPredicateSources(
    connectors.list().map((connector) => ({
      integrationId: `available:${connector.key}`,
      connectorKey: connector.key,
      displayName: connector.name,
      manifest: connector.manifest,
    })),
  );

  const conflicts = await ctx.many<{ predicate: string; detail: string }>(
    `SELECT predicate, detail FROM claim_conflicts
     WHERE organisation_id = $1 AND resolved_at IS NULL AND predicate = ANY($2::text[])`,
    [ctx.organisationId, [...predicates]],
  );
  const conflictByPredicate = new Map(conflicts.map((row) => [row.predicate, row.detail]));

  const failing = await ctx.many<{
    predicate: string;
    name: string;
    detail: string;
    required_permission: string;
  }>(
    `SELECT unnest(r.unavailable_predicates) AS predicate, i.name, r.detail, r.required_permission
     FROM integration_capability_reports r
     JOIN integrations i ON i.id = r.integration_id
     WHERE r.organisation_id = $1
       AND r.outcome <> 'AVAILABLE'
       AND r.integration_run_id = (
         SELECT run.id FROM integration_runs run
         WHERE run.integration_id = r.integration_id AND run.organisation_id = $1
         ORDER BY run.started_at DESC LIMIT 1
       )`,
    [ctx.organisationId],
  );
  const failingByPredicate = new Map(failing.map((row) => [row.predicate, row]));

  return [...new Set(predicates)].sort().map((predicate) => {
    // Ordered by what a person should do about it. A disagreement outranks a
    // failing capability, because a disagreement means we have the evidence and
    // are refusing to act on it — a different and more urgent conversation.
    const disagreement = conflictByPredicate.get(predicate);
    if (disagreement !== undefined) {
      return {
        predicate,
        reason: 'SOURCES_DISAGREE' as const,
        detail: disagreement,
        remedy:
          'Decide which system is authoritative for this fact, or correct the one that is wrong.',
      };
    }

    const failure = failingByPredicate.get(predicate);
    if (failure !== undefined) {
      return {
        predicate,
        reason: 'CAPABILITY_FAILING' as const,
        detail: `${failure.name}: ${failure.detail}`,
        remedy: failure.required_permission
          ? `Grant ${failure.required_permission} to ${failure.name}.`
          : null,
      };
    }

    const sources = configured.get(predicate) ?? [];
    if (sources.length === 0) {
      const candidates = (available.get(predicate) ?? []).filter((s) => s.fidelity === 'LIVE');
      return {
        predicate,
        reason: 'NO_SOURCE' as const,
        detail: 'No connected integration supplies this evidence.',
        remedy:
          candidates.length > 0
            ? `Connect ${[...new Set(candidates.map((c) => c.displayName))].join(' or ')}.`
            : 'Adericel has no connector that supplies this yet; it must be recorded manually.',
      };
    }

    return {
      predicate,
      reason: 'AWAITING_COLLECTION' as const,
      detail: `${sources[0]!.displayName} supplies this and has not yet reported a value for this subject.`,
      remedy: null,
    };
  });
}
