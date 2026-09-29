import { z } from 'zod';

/**
 * How a requirement in one framework relates to a requirement in another.
 *
 * Contract v3.2 requires a framework-independent layer with crosswalks, and
 * follows it with the sentence that constrains the whole design: "One
 * observation may satisfy multiple controls, but the system must never imply
 * equivalence where the underlying requirements differ."
 *
 * WHY A MAPPING TABLE WOULD BREAK THAT RULE BY EXISTING
 *
 * The obvious implementation is a join table of requirement pairs. A pair is
 * symmetric, and symmetry *is* an equivalence claim: if Cyber Essentials
 * `access.mfa_on_cloud_services` is paired with ISO 27001 `A.5.17`, the table
 * says each satisfies the other. It does not. Meeting the Cyber Essentials
 * requirement goes some way towards A.5.17 and nowhere near all of it, and
 * meeting A.5.17 says nothing about whether the specific Cyber Essentials
 * condition was met.
 *
 * So a crosswalk here is **directed**, and the relation names what the
 * direction means. There is no relation that can be read both ways except
 * EQUIVALENT, which is deliberately hard to justify and exists mainly so that
 * the rare genuine case does not have to be expressed as two lies.
 */
export const CROSSWALK_RELATIONS = [
  /**
   * The two requirements ask for the same thing.
   *
   * Symmetric, and rare. Almost every apparent equivalence between schemes
   * turns out to differ in scope, evidence or threshold on close reading, so
   * this relation requires a rationale that addresses all three.
   */
  'EQUIVALENT',
  /**
   * Meeting the source requirement fully satisfies the destination.
   *
   * Directed. It does not follow that meeting the destination satisfies the
   * source — usually it does not, because the source is the narrower of the two.
   */
  'SATISFIES',
  /**
   * Meeting the source contributes to the destination without completing it.
   *
   * The most common honest relation between two real schemes, and the one a
   * symmetric table silently upgrades to equivalence.
   */
  'PARTIALLY_SATISFIES',
  /**
   * Evidence for the source is relevant to the destination but satisfies no
   * part of it on its own.
   *
   * Useful for pointing an assessor at evidence that already exists. Never a
   * basis for a determination.
   */
  'SUPPORTS',
  /**
   * The two requirements ask for incompatible things.
   *
   * Recorded rather than omitted, because an MSP holding both frameworks needs
   * to know before an assessor tells them.
   */
  'CONFLICTS',
  /**
   * Considered, and deliberately not mapped.
   *
   * The relation that makes the absence of a mapping meaningful. Without it,
   * "no crosswalk exists" and "somebody looked and there is no relationship"
   * are the same empty result.
   */
  'UNRELATED',
] as const;
export type CrosswalkRelation = (typeof CROSSWALK_RELATIONS)[number];
export const crosswalkRelationSchema = z.enum(CROSSWALK_RELATIONS);

/** Relations that read the same in both directions. */
export const SYMMETRIC_RELATIONS: readonly CrosswalkRelation[] = [
  'EQUIVALENT',
  'CONFLICTS',
  'UNRELATED',
];

/**
 * Relations under which the source's evidence may be offered towards the
 * destination.
 *
 * Note what is absent: CONFLICTS and UNRELATED, obviously, but also that this
 * list says only that evidence may be *offered*. Nothing here authorises a
 * determination. See `coverage.ts`.
 */
export const EVIDENCE_BEARING_RELATIONS: readonly CrosswalkRelation[] = [
  'EQUIVALENT',
  'SATISFIES',
  'PARTIALLY_SATISFIES',
  'SUPPORTS',
];

/**
 * Whether a relation, read in reverse, would assert something the crosswalk
 * does not.
 *
 * The check that keeps the model honest when somebody wants to display a
 * crosswalk "from the other side". SATISFIES reversed is not SATISFIES, and
 * PARTIALLY_SATISFIES reversed is not anything at all — the fact that A goes
 * some way towards B implies nothing about B going towards A.
 */
export function readableInReverse(relation: CrosswalkRelation): boolean {
  return SYMMETRIC_RELATIONS.includes(relation);
}

export const RELATION_MEANING: Readonly<Record<CrosswalkRelation, string>> = {
  EQUIVALENT:
    'Both requirements ask for the same thing, in scope, evidence and threshold. Reading this ' +
    'either way is safe.',
  SATISFIES:
    'Meeting the source requirement fully satisfies the destination. The reverse does not ' +
    'follow and must not be inferred.',
  PARTIALLY_SATISFIES:
    'Meeting the source contributes to the destination without completing it. The destination ' +
    'still needs its own determination.',
  SUPPORTS:
    'Evidence for the source is relevant to the destination but satisfies no part of it. Useful ' +
    'for finding evidence that already exists, never for concluding anything.',
  CONFLICTS:
    'The two requirements ask for incompatible things. An organisation holding both frameworks ' +
    'has a decision to make, and should make it before an assessor makes it for them.',
  UNRELATED:
    'Considered and deliberately not mapped. Recorded so that the absence of a relationship is ' +
    'a finding rather than a gap in the data.',
};
