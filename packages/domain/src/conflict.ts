import { contentHash } from '@adericel/shared';

/**
 * Source conflict.
 *
 * Adericel keeps one live claim per (organisation, predicate, subject), so a
 * newer assertion supersedes the previous one. That is correct when a single
 * source re-observes a fact. It is a silent falsification when two sources
 * disagree.
 *
 *   Intune says   device-17  encrypted = true
 *   The RMM says  device-17  encrypted = false
 *
 * Whichever collection ran last won, and nothing anywhere recorded that the
 * question was contested. Adericel would then have told a customer — and, via
 * an Assurance Passport, their insurer — that a device was encrypted, on the
 * strength of a coin toss between two systems that flatly disagreed.
 *
 * A system of record does not get to pick. When authoritative sources conflict
 * and no configured rule resolves it, the honest answer is that Adericel does
 * not know, and the conflict itself is the finding.
 */

export type ConflictResolution =
  /** Sources agree, or only one spoke. */
  | 'AGREED'
  /** Configuration names one source authoritative for this predicate. */
  | 'RESOLVED_BY_AUTHORITY'
  /** Sources disagree and one is materially fresher than the others. */
  | 'RESOLVED_BY_FRESHNESS'
  /** Sources disagree and nothing resolves it. The determination is UNKNOWN. */
  | 'UNRESOLVED';

export interface SourcedValue {
  readonly integrationId: string;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly value: unknown;
  readonly observedAt: string | null;
  readonly collectedAt: string;
}

export interface AuthorityPolicy {
  /**
   * Integration ids that are authoritative for this predicate, most
   * authoritative first.
   *
   * Deliberately per-predicate. The system that best knows endpoint patch state
   * is rarely the one that best knows identity state, and a single global
   * hierarchy would be wrong for one of them. This belongs in configuration,
   * never in connector code.
   */
  readonly authoritativeIntegrationIds?: readonly string[];
  /**
   * How much fresher one source must be, in hours, before its recency alone
   * settles a disagreement.
   *
   * Undefined means freshness never resolves a conflict — the safe default.
   * Recency is not authority: a wrong answer collected a minute ago is still
   * wrong, and a customer would rightly be alarmed to learn that a five-minute
   * difference in scheduling decided what Adericel believed.
   */
  readonly freshnessWindowHours?: number;
}

export interface ConflictOutcome {
  readonly predicate: string;
  readonly subjectExternalId: string | null;
  readonly resolution: ConflictResolution;
  /** The value Adericel will use, or null when it refuses to choose. */
  readonly value: unknown;
  readonly sources: readonly SourcedValue[];
  /** Distinct values seen, canonically hashed so comparison is total. */
  readonly distinctValues: number;
  readonly detail: string;
}

/** Canonical, so `{a:1,b:2}` and `{b:2,a:1}` are not treated as a conflict. */
function valueKey(value: unknown): string {
  return contentHash({ v: value ?? null });
}

/**
 * Decide what to believe when several sources speak to one predicate.
 *
 * Pure and deterministic: the same sources and policy always produce the same
 * outcome, so a contested determination can be replayed and explained.
 */
export function resolveConflict(
  predicate: string,
  subjectExternalId: string | null,
  sources: readonly SourcedValue[],
  policy: AuthorityPolicy = {},
): ConflictOutcome {
  if (sources.length === 0) {
    return {
      predicate,
      subjectExternalId,
      resolution: 'AGREED',
      value: null,
      sources,
      distinctValues: 0,
      detail: 'No source supplied this predicate.',
    };
  }

  const byValue = new Map<string, SourcedValue[]>();
  for (const source of sources) {
    const key = valueKey(source.value);
    byValue.set(key, [...(byValue.get(key) ?? []), source]);
  }

  if (byValue.size === 1) {
    return {
      predicate,
      subjectExternalId,
      resolution: 'AGREED',
      value: sources[0]!.value,
      sources,
      distinctValues: 1,
      detail:
        sources.length === 1
          ? `Supplied by ${sources[0]!.displayName}.`
          : `All ${sources.length} sources agree.`,
    };
  }

  // Authority first. An operator who has said "Intune is authoritative for
  // device state" has made a decision, and Adericel honours it rather than
  // second-guessing them with a freshness heuristic.
  for (const authoritative of policy.authoritativeIntegrationIds ?? []) {
    const match = sources.find((source) => source.integrationId === authoritative);
    if (!match) continue;
    return {
      predicate,
      subjectExternalId,
      resolution: 'RESOLVED_BY_AUTHORITY',
      value: match.value,
      sources,
      distinctValues: byValue.size,
      detail:
        `${byValue.size} sources disagree; ${match.displayName} is configured as authoritative ` +
        `for ${predicate}.`,
    };
  }

  if (policy.freshnessWindowHours !== undefined) {
    const timeOf = (source: SourcedValue): number =>
      Date.parse(source.observedAt ?? source.collectedAt);
    const ranked = [...sources].sort((a, b) => timeOf(b) - timeOf(a));
    const newest = ranked[0]!;
    const runnerUp = ranked.find((s) => valueKey(s.value) !== valueKey(newest.value));
    const marginHours =
      runnerUp === undefined ? Infinity : (timeOf(newest) - timeOf(runnerUp)) / 3_600_000;
    if (marginHours >= policy.freshnessWindowHours) {
      return {
        predicate,
        subjectExternalId,
        resolution: 'RESOLVED_BY_FRESHNESS',
        value: newest.value,
        sources,
        distinctValues: byValue.size,
        detail:
          `${byValue.size} sources disagree; ${newest.displayName} observed this ` +
          `${Math.floor(marginHours)}h more recently than the next source, which exceeds the ` +
          `configured ${policy.freshnessWindowHours}h window.`,
      };
    }
  }

  // Nothing resolves it, so Adericel does not choose. The claim is withheld and
  // the dependent controls read UNKNOWN — which is true, and is the whole point
  // of UNKNOWN being first-class.
  const description = sources
    .map((source) => `${source.displayName}=${JSON.stringify(source.value ?? null)}`)
    .sort()
    .join(', ');
  return {
    predicate,
    subjectExternalId,
    resolution: 'UNRESOLVED',
    value: null,
    sources,
    distinctValues: byValue.size,
    detail:
      `Sources disagree about ${predicate} and no authority or freshness rule resolves it ` +
      `(${description}). Adericel will not choose between them, so anything depending on this ` +
      `predicate is UNKNOWN until the disagreement is settled.`,
  };
}

/** True when the outcome must not produce an authoritative claim. */
export function conflictBlocksClaim(outcome: ConflictOutcome): boolean {
  return outcome.resolution === 'UNRESOLVED';
}
