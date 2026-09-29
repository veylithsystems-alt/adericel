import type { AssuranceState } from '@adericel/domain';
import { EVIDENCE_BEARING_RELATIONS } from './relation.js';
import { isUsable, type Crosswalk, type CrosswalkConfidence } from './crosswalk.js';

/**
 * What a crosswalk is allowed to do.
 *
 * This is the file that enforces contract v3.2's constraint: "One observation
 * may satisfy multiple controls, but the system must never imply equivalence
 * where the underlying requirements differ."
 *
 * A crosswalk here produces exactly two things — a place to look for evidence
 * that already exists, and an honest statement of how far that gets you. It
 * never produces an assurance state. A determination for a destination
 * requirement comes from the Truth Engine evaluating that requirement's own
 * controls against that organisation's own observations, and from nothing else.
 *
 * WHY THIS BOUNDARY IS THE WHOLE VALUE
 *
 * The commercially attractive feature is "answer ISO 27001 automatically from
 * your Cyber Essentials evidence". It is also the feature that would make
 * Adericel worthless, because the moment a crosswalk can assert a state, every
 * determination in the system is only as good as somebody's opinion about two
 * paragraphs of prose. What an MSP can honestly be sold is the expensive part
 * of the work removed — knowing which evidence to reach for — with the
 * determination still made properly.
 */

/** How much weight a confidence band may carry. Lower is weaker. */
const CONFIDENCE_ORDER: Readonly<Record<CrosswalkConfidence, number>> = {
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
  UNKNOWN: 0,
};

export interface EvidenceLead {
  /** The requirement whose evidence may be worth looking at. */
  readonly sourceRequirementKey: string;
  readonly sourceFrameworkKey: string;
  readonly sourceFrameworkVersion: string;
  /** What that evidence would and would not do for the destination. */
  readonly worthLookingBecause: string;
  /** Stated on every lead, and identical on all of them by design. */
  readonly doesNotDetermine: string;
  readonly confidence: CrosswalkConfidence;
  readonly relation: Crosswalk['relation'];
  /** The conditions under which the mapping was said to hold. */
  readonly appliesWhen: string;
}

export interface CrosswalkCoverage {
  readonly destinationFrameworkKey: string;
  readonly destinationFrameworkVersion: string;
  readonly destinationRequirementKey: string;
  /** Where to look, strongest relation first. */
  readonly leads: readonly EvidenceLead[];
  /** Crosswalks excluded, and why, so the omission is explicable. */
  readonly excluded: readonly { key: string; because: string }[];
  /** Requirements this destination is in conflict with. */
  readonly conflicts: readonly string[];
  /**
   * The state a crosswalk contributes to the destination requirement.
   *
   * Always null. Present as a field, and always null, because a caller reading
   * this type should be told the answer rather than left to wonder whether some
   * other call would give them one.
   */
  readonly contributesState: null;
  readonly statement: string;
}

const DOES_NOT_DETERMINE =
  'This does not determine the destination requirement. It says where relevant evidence may ' +
  'already exist. The determination still comes from the Truth Engine evaluating this ' +
  'requirement’s own controls.';

const RELATION_ORDER: Readonly<Record<Crosswalk['relation'], number>> = {
  EQUIVALENT: 4,
  SATISFIES: 3,
  PARTIALLY_SATISFIES: 2,
  SUPPORTS: 1,
  CONFLICTS: 0,
  UNRELATED: 0,
};

function worthLookingBecause(crosswalk: Crosswalk): string {
  switch (crosswalk.relation) {
    case 'EQUIVALENT':
      return (
        'The two requirements were assessed as asking the same thing, so evidence held for the ' +
        'source is very likely to be the evidence this requirement needs.'
      );
    case 'SATISFIES':
      return (
        'Meeting the source was assessed as fully satisfying this requirement, so its evidence ' +
        'is the first place to look. Whether the source is met here is still a separate question.'
      );
    case 'PARTIALLY_SATISFIES':
      return (
        'Meeting the source covers part of this requirement. Expect a remainder, and expect to ' +
        'have to establish it separately.'
      );
    case 'SUPPORTS':
      return (
        'Evidence for the source is relevant without satisfying any part of this requirement. ' +
        'Useful for an assessor’s narrative rather than for coverage.'
      );
    case 'CONFLICTS':
    case 'UNRELATED':
      return 'Not a lead.';
  }
}

/**
 * What the crosswalks say about one destination requirement.
 *
 * Pure. Takes the crosswalks the caller has loaded and returns leads; it does
 * not read a database and cannot reach an organisation's data, which is part of
 * why it cannot produce a determination even by accident.
 */
export function crosswalkCoverage(
  destination: {
    readonly frameworkKey: string;
    readonly frameworkVersion: string;
    readonly requirementKey: string;
  },
  crosswalks: readonly Crosswalk[],
): CrosswalkCoverage {
  const relevant = crosswalks.filter(
    (c) =>
      c.destinationFrameworkKey === destination.frameworkKey &&
      c.destinationFrameworkVersion === destination.frameworkVersion &&
      c.destinationRequirementKey === destination.requirementKey,
  );

  const excluded: { key: string; because: string }[] = [];
  const conflicts: string[] = [];
  const leads: EvidenceLead[] = [];

  for (const crosswalk of relevant) {
    if (crosswalk.relation === 'CONFLICTS') {
      conflicts.push(
        `${crosswalk.sourceFrameworkKey}@${crosswalk.sourceFrameworkVersion} ` +
          `${crosswalk.sourceRequirementKey}: ${crosswalk.rationale}`,
      );
      continue;
    }

    if (crosswalk.relation === 'UNRELATED') {
      excluded.push({
        key: crosswalk.key,
        because: 'Recorded as deliberately unrelated, which is a finding rather than a gap.',
      });
      continue;
    }

    if (!isUsable(crosswalk)) {
      excluded.push({
        key: crosswalk.key,
        because:
          'Proposed by a model and not confirmed by a person. A suggested crosswalk may be ' +
          'reviewed; it may not inform coverage.',
      });
      continue;
    }

    if (!EVIDENCE_BEARING_RELATIONS.includes(crosswalk.relation)) {
      excluded.push({ key: crosswalk.key, because: 'The relation bears no evidence.' });
      continue;
    }

    leads.push({
      sourceRequirementKey: crosswalk.sourceRequirementKey,
      sourceFrameworkKey: crosswalk.sourceFrameworkKey,
      sourceFrameworkVersion: crosswalk.sourceFrameworkVersion,
      worthLookingBecause: worthLookingBecause(crosswalk),
      doesNotDetermine: DOES_NOT_DETERMINE,
      confidence: crosswalk.confidence,
      relation: crosswalk.relation,
      appliesWhen: crosswalk.appliesWhen,
    });
  }

  leads.sort(
    (a, b) =>
      RELATION_ORDER[b.relation] - RELATION_ORDER[a.relation] ||
      CONFIDENCE_ORDER[b.confidence] - CONFIDENCE_ORDER[a.confidence],
  );

  return {
    destinationFrameworkKey: destination.frameworkKey,
    destinationFrameworkVersion: destination.frameworkVersion,
    destinationRequirementKey: destination.requirementKey,
    leads,
    excluded,
    conflicts,
    contributesState: null,
    statement:
      leads.length === 0
        ? `No crosswalk offers evidence towards ${destination.requirementKey}. It has to be ` +
          'established on its own evidence.' +
          (conflicts.length > 0
            ? ` ${conflicts.length} requirement(s) conflict with it, which is a decision for the organisation.`
            : '')
        : `${leads.length} other requirement(s) may already hold relevant evidence for ` +
          `${destination.requirementKey}. None of them determines it: a crosswalk says where to ` +
          'look, and the Truth Engine still decides.' +
          (conflicts.length > 0 ? ` ${conflicts.length} requirement(s) conflict with it.` : ''),
  };
}

/**
 * The state a crosswalk establishes for a destination requirement.
 *
 * Always UNKNOWN, whatever the crosswalks say, and the function exists so that
 * the refusal is a thing in the codebase rather than an absence somebody has to
 * notice. A future caller reaching for "what does the crosswalk make this"
 * finds this and its reason, instead of writing the join themselves.
 */
export function stateFromCrosswalks(_crosswalks: readonly Crosswalk[]): {
  readonly state: AssuranceState;
  readonly because: string;
} {
  return {
    state: 'UNKNOWN',
    because:
      'A crosswalk never establishes an assurance state. It relates two requirements; it ' +
      'observes nothing about this organisation. Determining this requirement means evaluating ' +
      'its own controls against this organisation’s own observations.',
  };
}
