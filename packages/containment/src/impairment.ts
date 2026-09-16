import { definitionOf, type ContainmentLevel } from './level.js';

/**
 * What containment does to assurance.
 *
 * The connection that makes containment honest rather than merely safe.
 *
 * When Adericel stops collecting from an estate, every control depending on
 * that collection loses its footing. Left alone those controls decay to
 * UNKNOWN, which is true and deeply misleading: UNKNOWN reads as "nobody has
 * looked". Somebody looked, decided it was not safe to keep looking, and wrote
 * down why. That is a completely different fact and the record should say so.
 *
 * So a contained estate reports BLOCKED with reason CONTAINED. An MSP reading
 * their portfolio sees "deliberately not assessed" rather than a customer who
 * appears to have quietly stopped being monitored.
 *
 * This shape matches `PredicateImpairment` in the Truth Engine, which is
 * deliberately not imported: the engine must not depend on containment, and
 * containment must not depend on the engine. The structural test for engine
 * purity enforces the first; keeping the shape duplicated and asserted by test
 * is the price of the second.
 */

export interface ContainmentImpairment {
  readonly predicate: string;
  readonly kind: 'BLOCKED';
  readonly reason: 'CONTAINED';
  readonly detail: string;
}

/**
 * Whether a containment level actually stops collection.
 *
 * C0 and C1 do not: C0 restricts nothing, and C1 stops Adericel *acting* while
 * deliberately keeping it *watching*. Marking controls BLOCKED at those levels
 * would report a loss of assurance that has not happened.
 */
export function stopsCollection(level: ContainmentLevel): boolean {
  return !definitionOf(level).observationContinues;
}

/**
 * Impairments for every predicate an estate can no longer supply.
 *
 * Returns empty where collection continues, which is the common case and the
 * one worth getting right: containment that does not stop observation must not
 * degrade a single control.
 */
export function impairmentsFor(input: {
  readonly level: ContainmentLevel;
  readonly predicates: readonly string[];
  readonly since: string;
  readonly reason: string;
}): readonly ContainmentImpairment[] {
  if (!stopsCollection(input.level)) return [];

  const detail =
    `Collection is stopped: this estate has been under ${input.level} containment since ` +
    `${input.since} (${input.reason}). The control has not changed and has not failed — ` +
    'Adericel has deliberately stopped looking, and will resume when containment is lifted.';

  return input.predicates.map((predicate) => ({
    predicate,
    kind: 'BLOCKED' as const,
    reason: 'CONTAINED' as const,
    detail,
  }));
}
