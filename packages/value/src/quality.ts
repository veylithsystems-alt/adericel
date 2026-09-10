import type { PlatformContext } from '@adericel/graph';
import type { LedgerWindow } from './ledger.js';

/**
 * Whether the assurance actually got better.
 *
 * The commercial claim has two halves — less work AND better assurance — and
 * only the first is flattering to measure. A system that cut the labour by
 * ninety per cent and quietly stopped looking at half the estate would score
 * brilliantly on the ledger and be worse than useless.
 *
 * So this file measures the things that would expose that:
 *
 *   freshness      how old the evidence behind a satisfied control is
 *   gap age        how long a control has been UNKNOWN without being resolved
 *   coverage       how much of the estate is observed rather than asserted
 *   staleness      determinations nobody has revisited
 *
 * A vendor would not choose these metrics. That is the argument for them.
 */

export interface AssuranceQuality extends LedgerWindow {
  readonly organisationIds: readonly string[];

  /**
   * Median age, in hours, of the active evidence supporting a claim.
   *
   * Measured across the evidence base rather than per control, because a
   * control resolves to evidence through ruleset predicates rather than a
   * foreign key, and a per-control figure would have to be assembled from the
   * assessment input snapshots. That is a truer measure and it is not this one;
   * the field is named for what it actually counts so nobody reads more into
   * it than it says.
   *
   * Median rather than mean, because one integration refreshing hourly would
   * otherwise disguise fifty documents nobody has looked at since March.
   */
  readonly medianEvidenceAgeHours: number | null;
  /** The worst case, which is what an auditor will find. */
  readonly oldestEvidenceAgeHours: number | null;
  /** Active evidence, supporting a claim, older than 30 days. */
  readonly staleEvidenceItems: number;
  /** Active evidence supporting a claim, as the denominator for the above. */
  readonly evidenceSupportingClaims: number;

  /** Controls currently answering UNKNOWN. */
  readonly unknownControls: number;
  /** How long the oldest of them has been UNKNOWN, in days. */
  readonly oldestUnknownDays: number | null;
  /** UNKNOWN for more than 30 days: a gap nobody is closing. */
  readonly unresolvedGaps: number;

  /** Controls with any determination at all. */
  readonly controlsDetermined: number;
  readonly controlsTotal: number;
  /** Determined controls as a share of all controls. Null if there are none. */
  readonly determinationCoverage: number | null;

  /** Determinations not revisited in 7 days. */
  readonly staleDeterminations: number;

  /**
   * Claims held DISPUTED because two sources disagreed.
   *
   * A rise here is not a regression. It means Adericel is seeing a
   * contradiction it previously would have resolved by picking one — which is
   * the failure mode this product exists to refuse.
   */
  readonly disputedClaims: number;
}

function nullableNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function measureQuality(
  ctx: PlatformContext,
  organisationIds: readonly string[],
  window: LedgerWindow,
): Promise<AssuranceQuality> {
  const ids = [...organisationIds];
  const empty: AssuranceQuality = {
    ...window,
    organisationIds: ids,
    medianEvidenceAgeHours: null,
    oldestEvidenceAgeHours: null,
    staleEvidenceItems: 0,
    evidenceSupportingClaims: 0,
    unknownControls: 0,
    oldestUnknownDays: null,
    unresolvedGaps: 0,
    controlsDetermined: 0,
    controlsTotal: 0,
    determinationCoverage: null,
    staleDeterminations: 0,
    disputedClaims: 0,
  };
  if (ids.length === 0) return empty;

  const at = window.to;

  /**
   * How fresh the evidence base is.
   *
   * Restricted to evidence that actually supports a claim, because an upload
   * nothing references is not part of the assurance picture and counting it
   * would move the median for no reason.
   */
  const freshness = await ctx.one<{
    median_hours: string | null;
    oldest_hours: string | null;
    stale: string;
    supporting: string;
  }>(
    `WITH supporting AS (
       SELECT DISTINCT e.id, e.collected_at
         FROM evidence e
         JOIN claim_evidence ce ON ce.evidence_id = e.id
        WHERE e.organisation_id = ANY($1::uuid[])
          AND ce.organisation_id = ANY($1::uuid[])
          AND e.status = 'ACTIVE'
     )
     SELECT
       (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM ($2::timestamptz - collected_at)) / 3600
        ))::text AS median_hours,
       (max(EXTRACT(EPOCH FROM ($2::timestamptz - collected_at)) / 3600))::text AS oldest_hours,
       count(*) FILTER (WHERE collected_at < $2::timestamptz - interval '30 days')::text AS stale,
       count(*)::text AS supporting
     FROM supporting`,
    [ids, at],
  );

  const gaps = await ctx.one<{ unknown: string; oldest_days: string | null; unresolved: string }>(
    `SELECT count(*)::text AS unknown,
            (max(EXTRACT(EPOCH FROM ($2::timestamptz - since)) / 86400))::text AS oldest_days,
            count(*) FILTER (WHERE since < $2::timestamptz - interval '30 days')::text AS unresolved
       FROM assurance_states
      WHERE organisation_id = ANY($1::uuid[])
        AND subject_kind = 'CONTROL'
        AND state = 'UNKNOWN'`,
    [ids, at],
  );

  const coverage = await ctx.one<{ determined: string; total: string; stale: string }>(
    `SELECT
       (SELECT count(*)::text FROM assurance_states
         WHERE organisation_id = ANY($1::uuid[]) AND subject_kind = 'CONTROL') AS determined,
       (SELECT count(*)::text FROM controls
         WHERE organisation_id = ANY($1::uuid[])) AS total,
       (SELECT count(*)::text FROM assurance_states
         WHERE organisation_id = ANY($1::uuid[]) AND subject_kind = 'CONTROL'
           AND last_assessed_at < $2::timestamptz - interval '7 days') AS stale`,
    [ids, at],
  );

  const disputed = await ctx.one<{ disputed: string }>(
    `SELECT count(*)::text AS disputed FROM claims
      WHERE organisation_id = ANY($1::uuid[]) AND status = 'DISPUTED'`,
    [ids],
  );

  const determined = Number(coverage?.determined ?? '0');
  const total = Number(coverage?.total ?? '0');

  return {
    ...window,
    organisationIds: ids,
    medianEvidenceAgeHours: nullableNumber(freshness?.median_hours ?? null),
    oldestEvidenceAgeHours: nullableNumber(freshness?.oldest_hours ?? null),
    staleEvidenceItems: Number(freshness?.stale ?? '0'),
    evidenceSupportingClaims: Number(freshness?.supporting ?? '0'),
    unknownControls: Number(gaps?.unknown ?? '0'),
    oldestUnknownDays: nullableNumber(gaps?.oldest_days ?? null),
    unresolvedGaps: Number(gaps?.unresolved ?? '0'),
    controlsDetermined: determined,
    controlsTotal: total,
    // Null rather than zero when there are no controls: a coverage ratio over
    // nothing is not 0%, it is no information, and rendering it as 0% would
    // make an empty organisation look like a failing one.
    determinationCoverage: total === 0 ? null : determined / total,
    staleDeterminations: Number(coverage?.stale ?? '0'),
    disputedClaims: Number(disputed?.disputed ?? '0'),
  };
}
