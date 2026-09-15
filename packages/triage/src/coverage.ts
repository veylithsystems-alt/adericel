import type { PlatformContext } from '@adericel/graph';

/**
 * The connector coverage ladder.
 *
 * "Is the connector connected?" is the wrong question, and answering it is how
 * an assurance product ends up green while knowing nothing. A connector can be
 * authenticated, healthy, returning 200s, and still be supplying none of the
 * facts the controls actually need — because it lacks one permission, or the
 * customer has none of the thing it collects, or the vendor changed a field.
 *
 * So coverage is a ladder, and a customer is at exactly one rung:
 *
 *   NOT_CONNECTED        nothing configured
 *   CONNECTED            configuration exists, never successfully run
 *   AUTHENTICATED        credentials accepted
 *   AUTHORISED           permissions sufficient for what it asked for
 *   DATA_AVAILABLE       the upstream returned records
 *   PREDICATES_OBSERVED  those records became facts Adericel can reason about
 *   ASSURANCE_COVERED    those facts are the ones the controls actually need
 *
 * The last rung is the only one that means anything commercially, and it is the
 * one every other product in this market conflates with the second.
 *
 * A customer stuck below the top rung has controls that are UNKNOWN and must
 * stay UNKNOWN. This module says which rung, and why it stopped there.
 */

export const COVERAGE_STAGES = [
  'NOT_CONNECTED',
  'CONNECTED',
  'AUTHENTICATED',
  'AUTHORISED',
  'DATA_AVAILABLE',
  'PREDICATES_OBSERVED',
  'ASSURANCE_COVERED',
] as const;
export type CoverageStage = (typeof COVERAGE_STAGES)[number];

/** Position on the ladder. Higher is further. */
export function stageRank(stage: CoverageStage): number {
  return COVERAGE_STAGES.indexOf(stage);
}

export interface CoverageAssessment {
  readonly organisationId: string;
  readonly organisationName: string;
  /** The furthest rung this organisation has actually reached. */
  readonly stage: CoverageStage;
  /** Why it stopped there, in terms of what to do about it. */
  readonly blockedBy: string | null;
  readonly integrationsConfigured: number;
  readonly integrationsAuthenticated: number;
  /** Capabilities that ran and returned something informative. */
  readonly capabilitiesAvailable: number;
  readonly capabilitiesTotal: number;
  /** Predicates the estate has actually produced observations for. */
  readonly predicatesObserved: number;
  /**
   * Facts a connector reported it could not supply on its last run.
   *
   * Not "facts the controls require": that set lives in the rulesets, which are
   * code, and deriving it from the database produced a circular measure. This
   * is narrower and true — every member is a fact something tried and failed to
   * establish.
   */
  readonly predicatesUnavailable: number;
  /** Which ones, so the operator knows what is not being seen. */
  readonly predicatesUnavailableNames: readonly string[];
  /** Controls that are UNKNOWN and would not be if coverage were complete. */
  readonly controlsUnknown: number;
  readonly controlsTotal: number;
  /**
   * The share of this customer's enabled controls Adericel can determine.
   *
   * Null rather than 1 when no control is enabled. This is the honest coverage
   * number: not how many connectors are green, but how much of what the
   * customer is assessed against can actually be answered.
   */
  readonly coverageRatio: number | null;
}

/** Decide the rung and the reason, from what the estate actually shows. */
function classify(input: {
  integrationsConfigured: number;
  integrationsAuthenticated: number;
  authFailures: number;
  permissionFailures: number;
  capabilitiesAvailable: number;
  predicatesObserved: number;
  controlsTotal: number;
  controlsUnknownForEvidence: number;
}): { stage: CoverageStage; blockedBy: string | null } {
  if (input.integrationsConfigured === 0) {
    return {
      stage: 'NOT_CONNECTED',
      blockedBy: 'No integration is configured. Nothing is being observed.',
    };
  }
  if (input.authFailures > 0 && input.integrationsAuthenticated === 0) {
    return {
      stage: 'CONNECTED',
      blockedBy: `${input.authFailures} credential(s) rejected. Reconnect the integration.`,
    };
  }
  if (input.integrationsAuthenticated === 0) {
    return {
      stage: 'CONNECTED',
      blockedBy: 'Configured but never successfully collected from.',
    };
  }
  if (input.permissionFailures > 0) {
    return {
      stage: 'AUTHENTICATED',
      blockedBy:
        `${input.permissionFailures} capability(ies) refused for want of a permission. ` +
        'The credentials are valid; the grant is missing.',
    };
  }
  if (input.capabilitiesAvailable === 0) {
    return {
      stage: 'AUTHORISED',
      blockedBy: 'Authorised, and no capability returned usable data.',
    };
  }
  if (input.predicatesObserved === 0) {
    return {
      stage: 'DATA_AVAILABLE',
      blockedBy:
        'Records were collected and produced no facts Adericel can reason about. ' +
        'Usually a schema change at the vendor.',
    };
  }
  if (input.controlsTotal === 0) {
    return {
      stage: 'PREDICATES_OBSERVED',
      blockedBy:
        'Facts are being observed and no control requires them. Enable a framework, ' +
        'or this customer is being watched for nothing.',
    };
  }
  /**
   * The rung that matters, and the one that must not be given away.
   *
   * Coverage is not "the connector works". It is "every control this customer
   * is assessed against can actually be determined". A control answering
   * UNKNOWN because nothing supplies the fact behind it IS the gap — measured
   * from the Truth Engine's own conclusions rather than from a predicate-set
   * comparison, which an earlier version of this file derived circularly and
   * which consequently reported 96 of 100 customers fully covered while 84% of
   * their determinations were UNKNOWN.
   */
  if (input.controlsUnknownForEvidence > 0) {
    return {
      stage: 'PREDICATES_OBSERVED',
      blockedBy:
        `${input.controlsUnknownForEvidence} of ${input.controlsTotal} control(s) cannot be ` +
        'determined because nothing observed supplies the facts they need. Connect a system ' +
        'that can, or record an attestation.',
    };
  }
  return { stage: 'ASSURANCE_COVERED', blockedBy: null };
}

/**
 * Assess coverage across a portfolio.
 *
 * One query per concern rather than one enormous join, because the interesting
 * failure is a customer stuck at a particular rung and each rung has a
 * different shape of evidence behind it.
 */
export async function assessCoverage(
  ctx: PlatformContext,
  organisationIds: readonly string[],
): Promise<readonly CoverageAssessment[]> {
  const ids = [...organisationIds];
  if (ids.length === 0) return [];

  const rows = await ctx.many<{
    organisation_id: string;
    organisation_name: string;
    integrations_configured: number;
    integrations_authenticated: number;
    auth_failures: number;
    permission_failures: number;
    capabilities_available: number;
    capabilities_total: number;
    controls_total: number;
    controls_unknown: number;
    controls_unknown_evidence: number;
  }>(
    // The latest report per integration and capability, so a problem fixed this
    // morning does not still count as a blocker.
    `WITH latest AS (
       SELECT DISTINCT ON (organisation_id, integration_id, capability)
              organisation_id, integration_id, capability, outcome
         FROM integration_capability_reports
        WHERE organisation_id = ANY($1::uuid[])
        ORDER BY organisation_id, integration_id, capability, created_at DESC
     )
     SELECT o.id AS organisation_id, o.name AS organisation_name,
            (SELECT count(*)::int FROM integrations i
              WHERE i.organisation_id = o.id AND i.status <> 'DISABLED') AS integrations_configured,
            (SELECT count(*)::int FROM integrations i
              WHERE i.organisation_id = o.id AND i.status = 'CONNECTED') AS integrations_authenticated,
            (SELECT count(*)::int FROM latest r
              WHERE r.organisation_id = o.id
                AND r.outcome = 'AUTHENTICATION_FAILED') AS auth_failures,
            (SELECT count(*)::int FROM latest r
              WHERE r.organisation_id = o.id
                AND r.outcome = 'PERMISSION_DENIED') AS permission_failures,
            (SELECT count(*)::int FROM latest r
              WHERE r.organisation_id = o.id
                AND r.outcome IN ('AVAILABLE','PARTIAL','EMPTY')) AS capabilities_available,
            (SELECT count(*)::int FROM latest r
              WHERE r.organisation_id = o.id) AS capabilities_total,
            (SELECT count(*)::int FROM controls c
              WHERE c.organisation_id = o.id AND c.enabled) AS controls_total,
            (SELECT count(*)::int FROM assurance_states s
              WHERE s.organisation_id = o.id AND s.subject_kind = 'CONTROL'
                AND s.state = 'UNKNOWN') AS controls_unknown,
            -- UNKNOWN specifically for want of evidence, which is what a
            -- coverage gap is. An UNKNOWN caused by a source conflict is a
            -- different problem with a different fix, and counting it here
            -- would send the operator to connect a system that is already
            -- connected.
            (SELECT count(*)::int FROM assurance_states s
              WHERE s.organisation_id = o.id AND s.subject_kind = 'CONTROL'
                AND s.state = 'UNKNOWN'
                AND (s.unknown_reason IS NULL
                     OR s.unknown_reason NOT ILIKE '%conflict%')) AS controls_unknown_evidence
       FROM organisations o
      WHERE o.id = ANY($1::uuid[])
      ORDER BY o.name`,
    [ids],
  );

  /**
   * Which facts are in play, and which of those are actually known.
   *
   * "Required" is derived from what the connectors were trying to supply rather
   * than from the rulesets, because the rulesets are code and this runs against
   * the database. The union of predicates observed and predicates a capability
   * reported it could not supply is the set Adericel is demonstrably working
   * with — narrower than the full ruleset requirement, and every member of it
   * is a fact somebody tried to establish.
   *
   * Narrower is the right direction to be wrong in: it understates the gap
   * rather than inventing one.
   */
  const observed = await ctx.many<{ organisation_id: string; predicate: string }>(
    `SELECT DISTINCT organisation_id, predicate FROM claims
      WHERE organisation_id = ANY($1::uuid[]) AND status <> 'DISPUTED'`,
    [ids],
  );
  const unavailable = await ctx.many<{ organisation_id: string; predicate: string }>(
    `SELECT DISTINCT r.organisation_id, p.predicate
       FROM integration_capability_reports r
       CROSS JOIN LATERAL unnest(r.unavailable_predicates) AS p(predicate)
      WHERE r.organisation_id = ANY($1::uuid[])`,
    [ids],
  );

  const observedBy = new Map<string, Set<string>>();
  for (const row of observed) {
    const set = observedBy.get(row.organisation_id) ?? new Set<string>();
    set.add(row.predicate);
    observedBy.set(row.organisation_id, set);
  }
  const unavailableBy = new Map<string, Set<string>>();
  for (const row of unavailable) {
    const set = unavailableBy.get(row.organisation_id) ?? new Set<string>();
    set.add(row.predicate);
    unavailableBy.set(row.organisation_id, set);
  }

  return rows.map((row) => {
    const seen = observedBy.get(row.organisation_id) ?? new Set<string>();
    const unavailableHere = unavailableBy.get(row.organisation_id) ?? new Set<string>();
    const stillMissing = [...unavailableHere].filter((predicate) => !seen.has(predicate)).sort();

    const { stage, blockedBy } = classify({
      integrationsConfigured: row.integrations_configured,
      integrationsAuthenticated: row.integrations_authenticated,
      authFailures: row.auth_failures,
      permissionFailures: row.permission_failures,
      capabilitiesAvailable: row.capabilities_available,
      predicatesObserved: seen.size,
      controlsTotal: row.controls_total,
      controlsUnknownForEvidence: row.controls_unknown_evidence,
    });

    return {
      organisationId: row.organisation_id,
      organisationName: row.organisation_name,
      stage,
      blockedBy,
      integrationsConfigured: row.integrations_configured,
      integrationsAuthenticated: row.integrations_authenticated,
      capabilitiesAvailable: row.capabilities_available,
      capabilitiesTotal: row.capabilities_total,
      predicatesObserved: seen.size,
      predicatesUnavailable: stillMissing.length,
      predicatesUnavailableNames: stillMissing,
      controlsUnknown: row.controls_unknown,
      controlsTotal: row.controls_total,
      // The share of this customer's controls Adericel can actually determine.
      // Null rather than 1 where no control is enabled: an unconfigured
      // organisation is not fully covered, and reporting 100% would be the most
      // misleading number in the product.
      coverageRatio:
        row.controls_total === 0
          ? null
          : Math.max(0, (row.controls_total - row.controls_unknown_evidence) / row.controls_total),
    };
  });
}
