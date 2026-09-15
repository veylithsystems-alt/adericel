/**
 * Three-valued (Kleene) logic.
 *
 * Adericel cannot use ordinary boolean logic, because ordinary boolean logic
 * has no way to say "we do not know". Under two-valued logic, a missing fact
 * becomes `false`, and `false` in a security control means "not satisfied" —
 * which is a manufactured certainty. Kleene logic keeps the third value all the
 * way through evaluation so an unknown input yields an unknown conclusion
 * unless the other operands settle the question on their own.
 */
export type Trilean = 'TRUE' | 'FALSE' | 'UNKNOWN';

export const TRUE: Trilean = 'TRUE';
export const FALSE: Trilean = 'FALSE';
export const UNKNOWN: Trilean = 'UNKNOWN';

export function fromBoolean(value: boolean): Trilean {
  return value ? 'TRUE' : 'FALSE';
}

/**
 * Conjunction. FALSE dominates: `false AND unknown` is FALSE, because one
 * disproved conjunct is enough to disprove the whole regardless of what else we
 * do not know.
 */
export function and(values: readonly Trilean[]): Trilean {
  if (values.length === 0) return 'TRUE';
  if (values.includes('FALSE')) return 'FALSE';
  if (values.includes('UNKNOWN')) return 'UNKNOWN';
  return 'TRUE';
}

/**
 * Disjunction. TRUE dominates: `true OR unknown` is TRUE, because one proved
 * disjunct settles it.
 */
export function or(values: readonly Trilean[]): Trilean {
  if (values.length === 0) return 'FALSE';
  if (values.includes('TRUE')) return 'TRUE';
  if (values.includes('UNKNOWN')) return 'UNKNOWN';
  return 'FALSE';
}

/** Negation leaves UNKNOWN untouched — the negation of an unknown is unknown. */
export function not(value: Trilean): Trilean {
  if (value === 'TRUE') return 'FALSE';
  if (value === 'FALSE') return 'TRUE';
  return 'UNKNOWN';
}

/** Material implication under Kleene semantics. */
export function implies(antecedent: Trilean, consequent: Trilean): Trilean {
  return or([not(antecedent), consequent]);
}

export function isKnown(value: Trilean): value is 'TRUE' | 'FALSE' {
  return value !== 'UNKNOWN';
}
