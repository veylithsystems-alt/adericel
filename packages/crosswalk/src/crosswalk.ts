import { z } from 'zod';
import {
  CROSSWALK_RELATIONS,
  EVIDENCE_BEARING_RELATIONS,
  readableInReverse,
  type CrosswalkRelation,
} from './relation.js';

/**
 * A crosswalk: one directed statement about two requirements in two frameworks.
 *
 * Contract v3.2 requires every crosswalk to preserve seven things — source
 * framework, destination framework, mapping rationale, confidence,
 * applicability, version and provenance. All seven are required fields here,
 * and none of them has a default, because a default is how six of the seven
 * stop being supplied.
 *
 * WHY CONFIDENCE IS A BAND AND NOT A NUMBER
 *
 * "Confidence: 0.85" is the kind of figure this product does not write
 * (ADR-0017, and v3.2's own refusal of opaque scoring). Nobody could say what
 * distinguishes 0.85 from 0.8, and the number would be quoted as though
 * somebody could. So confidence is one of four named bands, and every band
 * requires a sentence saying why it was chosen — which is the part an assessor
 * actually needs.
 */

/** Who or what asserted the mapping. */
export const CROSSWALK_PROVENANCE = [
  /** The scheme owner published it. The only provenance that is not an opinion. */
  'SCHEME_PUBLISHED',
  /** A named person at the MSP or at Veylith mapped it. */
  'NAMED_PERSON',
  /** Derived from an existing published crosswalk by transitive reasoning. */
  'DERIVED_FROM_PUBLISHED',
  /**
   * Proposed by a model.
   *
   * Never authoritative, exactly as everywhere else in Adericel: a suggested
   * crosswalk may be shown to a person and may not inform coverage until one
   * confirms it.
   */
  'AI_SUGGESTED',
] as const;
export type CrosswalkProvenance = (typeof CROSSWALK_PROVENANCE)[number];

/** Provenance that may not inform anything until a person confirms it. */
export const UNCONFIRMED_PROVENANCE: readonly CrosswalkProvenance[] = ['AI_SUGGESTED'];

export const CROSSWALK_CONFIDENCE = ['HIGH', 'MODERATE', 'LOW', 'UNKNOWN'] as const;
export type CrosswalkConfidence = (typeof CROSSWALK_CONFIDENCE)[number];

export const CONFIDENCE_MEANING: Readonly<Record<CrosswalkConfidence, string>> = {
  HIGH:
    'The requirements were read side by side and the relation holds on scope, evidence and ' +
    'threshold.',
  MODERATE: 'The relation holds on the substance, with a difference of scope or threshold noted.',
  LOW: 'The relation is plausible and the requirements differ in ways that were not resolved.',
  UNKNOWN:
    'Recorded without an assessment of how well it holds. Treated as the weakest band ' +
    'everywhere, because an unassessed confidence is not a high one.',
};

export const crosswalkSchema = z
  .object({
    /** Stable identifier, so a mapping can be cited in a report. */
    key: z.string().min(3).max(200),

    sourceFrameworkKey: z.string().min(1).max(120),
    sourceFrameworkVersion: z.string().min(1).max(40),
    sourceRequirementKey: z.string().min(1).max(200),

    destinationFrameworkKey: z.string().min(1).max(120),
    destinationFrameworkVersion: z.string().min(1).max(40),
    destinationRequirementKey: z.string().min(1).max(200),

    relation: z.enum(CROSSWALK_RELATIONS),

    /**
     * Why the relation holds, in the words somebody would defend it with.
     *
     * Required, with a real minimum length. A crosswalk whose rationale is
     * "similar" is the mapping table this model exists to replace.
     */
    rationale: z.string().min(40).max(4000),

    confidence: z.enum(CROSSWALK_CONFIDENCE),
    confidenceBecause: z.string().min(20).max(2000),

    /**
     * When the mapping applies.
     *
     * "Always" is a legitimate answer and must be stated rather than assumed,
     * because a great many real crosswalks hold only for part of an estate — a
     * cloud-only organisation, a scheme's small-business variant, a particular
     * device class.
     */
    appliesWhen: z.string().min(6).max(2000),

    provenance: z.enum(CROSSWALK_PROVENANCE),
    /** The source of the provenance: a publication, a person, a prior crosswalk. */
    provenanceDetail: z.string().min(6).max(1000),

    /** When this statement was made, so a later scheme revision is visible. */
    assertedAt: z.string().min(10),
    /** Set when a person has confirmed a suggested mapping. */
    confirmedBy: z.string().max(200).nullable().default(null),
  })
  .strict();

export type Crosswalk = z.infer<typeof crosswalkSchema>;

/**
 * Whether this crosswalk may inform anything at all.
 *
 * Separate from schema validity: a crosswalk can be perfectly well formed and
 * still not usable, because a model proposed it and nobody has confirmed it.
 */
export function isUsable(crosswalk: Crosswalk): boolean {
  if (UNCONFIRMED_PROVENANCE.includes(crosswalk.provenance)) {
    return crosswalk.confirmedBy !== null && crosswalk.confirmedBy.trim().length > 0;
  }
  return true;
}

/**
 * Problems that make a crosswalk misleading rather than merely incomplete.
 *
 * Returned as a list so a whole imported set can be reported in one pass. Each
 * of these was chosen because it is a way a crosswalk can pass schema
 * validation and still assert something false.
 */
export function crosswalkProblems(crosswalk: Crosswalk): readonly string[] {
  const problems: string[] = [];

  if (
    crosswalk.sourceFrameworkKey === crosswalk.destinationFrameworkKey &&
    crosswalk.sourceFrameworkVersion === crosswalk.destinationFrameworkVersion
  ) {
    problems.push(
      'Source and destination are the same framework at the same version. A crosswalk is ' +
        'between frameworks; a relationship inside one belongs in that framework’s own ' +
        'requirement hierarchy.',
    );
  }

  /**
   * EQUIVALENT is held to a higher standard than the schema can express.
   *
   * It is the only relation readable in both directions, so a careless
   * EQUIVALENT is the equivalence claim the contract forbids — stated twice.
   * The rationale has to address the three things that almost always differ.
   */
  if (crosswalk.relation === 'EQUIVALENT') {
    const rationale = crosswalk.rationale.toLowerCase();
    const addressed = ['scope', 'evidence', 'threshold'].filter((term) => rationale.includes(term));
    if (addressed.length < 3) {
      problems.push(
        'EQUIVALENT requires a rationale addressing scope, evidence and threshold, because those ' +
          `are what almost always differ. Missing: ${['scope', 'evidence', 'threshold']
            .filter((term) => !rationale.includes(term))
            .join(', ')}.`,
      );
    }
    if (crosswalk.confidence !== 'HIGH') {
      problems.push(
        `EQUIVALENT at ${crosswalk.confidence} confidence is a contradiction: it is the one ` +
          'relation read in both directions, so it cannot be asserted tentatively.',
      );
    }
  }

  // A relation that carries evidence at UNKNOWN confidence would let an
  // unassessed mapping contribute coverage.
  if (
    EVIDENCE_BEARING_RELATIONS.includes(crosswalk.relation) &&
    crosswalk.confidence === 'UNKNOWN'
  ) {
    problems.push(
      `${crosswalk.relation} at UNKNOWN confidence may not bear evidence. Assess the mapping or ` +
        'record it as SUPPORTS, which asserts nothing about satisfaction.',
    );
  }

  if (crosswalk.relation === 'UNRELATED' && crosswalk.confidence === 'UNKNOWN') {
    problems.push(
      'UNRELATED at UNKNOWN confidence records nothing. The value of UNRELATED is that somebody ' +
        'looked; an unassessed one is indistinguishable from no crosswalk at all.',
    );
  }

  return problems;
}

/**
 * The reverse of a crosswalk, where one exists.
 *
 * Returns null for every directed relation, which is the point: a caller that
 * wants to show "what maps to this requirement" has to query for crosswalks
 * whose destination it is, not flip the ones whose source it is. Flipping is
 * how a PARTIALLY_SATISFIES becomes a claim nobody made.
 */
export function reverseOf(crosswalk: Crosswalk): Crosswalk | null {
  if (!readableInReverse(crosswalk.relation)) return null;
  return {
    ...crosswalk,
    key: `${crosswalk.key}:reversed`,
    sourceFrameworkKey: crosswalk.destinationFrameworkKey,
    sourceFrameworkVersion: crosswalk.destinationFrameworkVersion,
    sourceRequirementKey: crosswalk.destinationRequirementKey,
    destinationFrameworkKey: crosswalk.sourceFrameworkKey,
    destinationFrameworkVersion: crosswalk.sourceFrameworkVersion,
    destinationRequirementKey: crosswalk.sourceRequirementKey,
  };
}

/** Every problem across a set, keyed by crosswalk. */
export function setProblems(
  crosswalks: readonly Crosswalk[],
): readonly { key: string; problems: readonly string[] }[] {
  const seen = new Map<string, number>();
  const results: { key: string; problems: readonly string[] }[] = [];

  for (const crosswalk of crosswalks) {
    const problems = [...crosswalkProblems(crosswalk)];

    /**
     * The same directed pair asserted twice with different relations.
     *
     * Two contradictory statements about one pair means whichever a reader hits
     * first decides what the product claims, which is a coin toss dressed as a
     * mapping.
     */
    const pair = [
      crosswalk.sourceFrameworkKey,
      crosswalk.sourceFrameworkVersion,
      crosswalk.sourceRequirementKey,
      crosswalk.destinationFrameworkKey,
      crosswalk.destinationFrameworkVersion,
      crosswalk.destinationRequirementKey,
    ].join('|');
    const count = (seen.get(pair) ?? 0) + 1;
    seen.set(pair, count);
    if (count > 1) {
      problems.push(
        'This directed pair is asserted more than once in the set. Whichever a reader reaches ' +
          'first would decide what Adericel claims.',
      );
    }

    if (problems.length > 0) results.push({ key: crosswalk.key, problems });
  }

  return results;
}

export type { CrosswalkRelation };
