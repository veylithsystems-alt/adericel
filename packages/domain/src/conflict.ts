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

/**
 * What a conflict costs.
 *
 * Contract v3.2 requires a conflict to expose its sources, timestamps,
 * observations, **affected controls**, resolution state and **the resulting
 * assurance limitation**. `ConflictOutcome` had the first three and the fifth.
 * It reported that two systems disagreed and left an operator to work out for
 * themselves what that meant for the organisation's position — which is the
 * same cost the resolution queue was built to remove, in a different place.
 *
 * WHY THIS IS SEPARATE FROM `resolveConflict`
 *
 * Deciding what to believe is a question about sources and needs nothing else.
 * Deciding what the disagreement costs is a question about the assurance graph:
 * which controls read this predicate. Keeping them apart means `resolveConflict`
 * stays pure over its own inputs, and the consequence can be computed wherever
 * the fan-out is known — which is the same map the resolution queue already
 * builds.
 */
export const ASSURANCE_LIMITATIONS = [
  /** Sources agree, or only one spoke. Nothing is limited. */
  'NONE',
  /**
   * No determination is possible for the affected controls.
   *
   * The honest outcome of an unresolved conflict: collecting again produces the
   * same disagreement, so the controls stay UNKNOWN until somebody decides
   * which source is authoritative.
   */
  'DETERMINATION_WITHHELD',
  /**
   * A determination exists and rests on one source over another that disagreed.
   *
   * Not a failure — a configured authority or a materially fresher reading is a
   * legitimate basis. But a recipient of an Assurance Passport is entitled to
   * know that the reading was contested, because "Intune says encrypted" and
   * "Intune says encrypted while the RMM says otherwise" are different
   * statements and only one of them is the whole truth.
   */
  'DETERMINATION_RESTS_ON_ONE_SOURCE',
] as const;
export type AssuranceLimitation = (typeof ASSURANCE_LIMITATIONS)[number];

export interface ConflictConsequence {
  readonly predicate: string;
  readonly subjectExternalId: string | null;
  /** Controls that read this predicate and are therefore affected. */
  readonly affectedControlKeys: readonly string[];
  readonly limitation: AssuranceLimitation;
  /** Why that limitation, in the words an operator would use. */
  readonly limitationBecause: string;
  /** What happens if nobody decides. Never "the control stays UNKNOWN". */
  readonly ifUnresolved: string;
  /** Who resolves it. Adericel deliberately does not (ADR-0029). */
  readonly resolvedBy: string;
}

/**
 * The consequence of one conflict, given the controls that read the predicate.
 *
 * `controlsReadingPredicate` is supplied by the caller because this module has
 * no database and no graph. The resolution service already computes exactly this
 * map for the whole organisation.
 */
export function conflictConsequence(
  outcome: ConflictOutcome,
  controlsReadingPredicate: readonly string[],
): ConflictConsequence {
  const affectedControlKeys = [...new Set(controlsReadingPredicate)].sort();
  const affected = affectedControlKeys.length;
  const subject =
    outcome.subjectExternalId === null ? 'the organisation' : outcome.subjectExternalId;

  if (outcome.resolution === 'AGREED') {
    return {
      predicate: outcome.predicate,
      subjectExternalId: outcome.subjectExternalId,
      affectedControlKeys,
      limitation: 'NONE',
      limitationBecause: 'Every source that spoke to this agreed, so nothing is limited by it.',
      ifUnresolved: 'Nothing. There is no disagreement to resolve.',
      resolvedBy: 'Nobody. Nothing is outstanding.',
    };
  }

  const names = outcome.sources.map((source) => source.displayName).join(' and ');
  const contested =
    `${names} disagree about \`${outcome.predicate}\` for ${subject}, ` +
    `across ${outcome.distinctValues} distinct value(s).`;

  if (outcome.resolution === 'UNRESOLVED') {
    return {
      predicate: outcome.predicate,
      subjectExternalId: outcome.subjectExternalId,
      affectedControlKeys,
      limitation: 'DETERMINATION_WITHHELD',
      limitationBecause:
        `${contested} No configured authority and no freshness difference resolves it, so ` +
        `Adericel withholds a determination for ${affected === 0 ? 'any control reading it' : `${affected} control(s)`}.`,
      ifUnresolved:
        affected === 0
          ? 'No control currently reads this predicate, so nothing is undecided by it today. ' +
            'The disagreement is still on record and will matter the moment one does.'
          : `${affected} control(s) stay undecided. If a questionnaire or an assessor asks, the ` +
            'honest answer is that two systems disagree and the organisation has not decided ' +
            'which is right — which reads to a third party exactly like a failure.',
      resolvedBy:
        'A recorded decision about which source is authoritative for this predicate, or a ' +
        'correction at whichever source is wrong. Adericel does not choose between disagreeing ' +
        'sources (ADR-0029), and collecting again will produce the same disagreement.',
    };
  }

  const basis =
    outcome.resolution === 'RESOLVED_BY_AUTHORITY'
      ? 'a configured authority names one of them authoritative for this predicate'
      : 'one reading is materially fresher than the others';

  return {
    predicate: outcome.predicate,
    subjectExternalId: outcome.subjectExternalId,
    affectedControlKeys,
    limitation: 'DETERMINATION_RESTS_ON_ONE_SOURCE',
    limitationBecause:
      `${contested} A determination was made because ${basis}. It is a legitimate basis and it ` +
      'is not unanimity: the reading was contested, and anybody relying on it is entitled to ' +
      'know that.',
    ifUnresolved:
      affected === 0
        ? 'The determination stands. No control reads this predicate today, so nothing rests ' +
          'on it yet.'
        : `${affected} control(s) rest on a contested reading. They are decided, not undecided — ` +
          'but the disagreement remains unexplained, and the source that was overruled will keep ' +
          'reporting what it reports.',
    resolvedBy:
      'Correcting whichever source is wrong. Until then the determination stands on the ' +
      'configured basis and the disagreement stays on record.',
  };
}

/**
 * Whether a conflict is worth putting in front of a person.
 *
 * A resolved conflict is not silent: it produced a determination on a contested
 * reading, and a source that keeps disagreeing is usually a real fault in one of
 * the two systems. It ranks below an unresolved one, and above nothing.
 */
export function conflictNeedsAttention(consequence: ConflictConsequence): boolean {
  return consequence.limitation !== 'NONE';
}
