import { z } from 'zod';
import { and, fromBoolean, not, or, type Trilean } from './kleene.js';

/**
 * The rule expression language.
 *
 * Rules are DATA, not code. This matters for three reasons the product depends
 * on:
 *
 *  1. A ruleset can be hashed, and that hash genuinely covers the behaviour. If
 *     rules were TypeScript functions, `rulesetHash` would be a comforting
 *     fiction — the hash would change while the logic did not, or worse, stay
 *     the same while the logic changed.
 *  2. A ruleset can be versioned, deployed and rolled back independently of the
 *     application, so an MSP can adjust its assurance baseline without a code
 *     release.
 *  3. Evaluation is total and side-effect free by construction. There is no
 *     `fetch`, no clock read and no randomness available inside an expression,
 *     which is what makes a historical assessment replayable.
 *
 * Every operator is defined over Kleene logic, so a missing fact yields UNKNOWN
 * rather than a default.
 */

export type Expression =
  | { readonly op: 'const'; readonly value: unknown }
  | {
      readonly op: 'claim';
      readonly predicate: string;
      readonly path?: string;
      /**
       * Value to use when NO claim has been recorded for this predicate.
       *
       * This is an explicit, ruleset-authored assumption — it is part of the
       * ruleset hash and therefore part of the audit record. It applies ONLY to
       * absence. A claim that exists but may not be relied upon (stale
       * evidence, revoked evidence, an unconfirmed AI suggestion) still yields
       * MISSING, so a default can never paper over degraded evidence.
       */
      readonly default?: unknown;
    }
  | { readonly op: 'param'; readonly key: string; readonly default?: unknown }
  | { readonly op: 'fact'; readonly key: string }
  | { readonly op: 'exists'; readonly predicate: string }
  | { readonly op: 'eq'; readonly left: Expression; readonly right: Expression }
  | { readonly op: 'ne'; readonly left: Expression; readonly right: Expression }
  | { readonly op: 'lt'; readonly left: Expression; readonly right: Expression }
  | { readonly op: 'lte'; readonly left: Expression; readonly right: Expression }
  | { readonly op: 'gt'; readonly left: Expression; readonly right: Expression }
  | { readonly op: 'gte'; readonly left: Expression; readonly right: Expression }
  | { readonly op: 'includes'; readonly collection: Expression; readonly value: Expression }
  | { readonly op: 'matches'; readonly value: Expression; readonly pattern: string }
  | { readonly op: 'and'; readonly operands: readonly Expression[] }
  | { readonly op: 'or'; readonly operands: readonly Expression[] }
  | { readonly op: 'not'; readonly operand: Expression }
  | { readonly op: 'isTrue'; readonly operand: Expression }
  | { readonly op: 'olderThanDays'; readonly value: Expression; readonly days: Expression };

const expressionSchema: z.ZodType<Expression> = z.lazy(
  () =>
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('const'), value: z.unknown() }),
      z.object({
        op: z.literal('claim'),
        predicate: z.string().min(1),
        path: z.string().optional(),
        default: z.unknown().optional(),
      }),
      z.object({ op: z.literal('param'), key: z.string().min(1), default: z.unknown().optional() }),
      z.object({ op: z.literal('fact'), key: z.string().min(1) }),
      z.object({ op: z.literal('exists'), predicate: z.string().min(1) }),
      z.object({ op: z.literal('eq'), left: expressionSchema, right: expressionSchema }),
      z.object({ op: z.literal('ne'), left: expressionSchema, right: expressionSchema }),
      z.object({ op: z.literal('lt'), left: expressionSchema, right: expressionSchema }),
      z.object({ op: z.literal('lte'), left: expressionSchema, right: expressionSchema }),
      z.object({ op: z.literal('gt'), left: expressionSchema, right: expressionSchema }),
      z.object({ op: z.literal('gte'), left: expressionSchema, right: expressionSchema }),
      z.object({
        op: z.literal('includes'),
        collection: expressionSchema,
        value: expressionSchema,
      }),
      z.object({ op: z.literal('matches'), value: expressionSchema, pattern: z.string() }),
      z.object({ op: z.literal('and'), operands: z.array(expressionSchema) }),
      z.object({ op: z.literal('or'), operands: z.array(expressionSchema) }),
      z.object({ op: z.literal('not'), operand: expressionSchema }),
      z.object({ op: z.literal('isTrue'), operand: expressionSchema }),
      z.object({ op: z.literal('olderThanDays'), value: expressionSchema, days: expressionSchema }),
    ]) as z.ZodType<Expression>,
);

export { expressionSchema };

/** A resolved claim value together with the provenance needed to explain it. */
export interface ResolvedClaim {
  readonly claimId: string;
  readonly predicate: string;
  readonly value: unknown;
  readonly evidenceIds: readonly string[];
  /** Set when the claim exists but may not be relied upon. */
  readonly unusableReason: string | null;
}

/**
 * Everything an expression may read. There is no other channel — no globals, no
 * ambient time, no network.
 */
export interface EvaluationContext {
  /** Claims about the subject, keyed by predicate. */
  readonly claims: ReadonlyMap<string, ResolvedClaim>;
  /** Control parameters, e.g. `{ maxPasswordAgeDays: 90 }`. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Non-claim facts supplied by the engine, e.g. subject attributes. */
  readonly facts: Readonly<Record<string, unknown>>;
  /** The instant the assessment is made as at. Injected, never read from a clock. */
  readonly asOfEpochMs: number;
}

/** A value that may be absent. `MISSING` is distinct from `null`. */
export const MISSING = Symbol('MISSING');
export type Value = unknown | typeof MISSING;

export interface Trace {
  readonly op: string;
  readonly result: Trilean | 'VALUE';
  readonly detail: string;
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface EvaluationResult {
  readonly value: Trilean;
  readonly traces: readonly Trace[];
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  /** Predicates the expression needed but could not resolve. */
  readonly missingPredicates: readonly string[];
}

function pluck(value: unknown, path: string | undefined): Value {
  if (path === undefined || path === '') return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return MISSING;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return MISSING;
  }
  return current;
}

interface Collector {
  readonly traces: Trace[];
  readonly claimIds: Set<string>;
  readonly evidenceIds: Set<string>;
  readonly missing: Set<string>;
}

function resolveValue(expression: Expression, ctx: EvaluationContext, out: Collector): Value {
  switch (expression.op) {
    case 'const':
      return expression.value;

    case 'param': {
      const value = ctx.parameters[expression.key];
      if (value === undefined) {
        return 'default' in expression ? expression.default : MISSING;
      }
      return value;
    }

    case 'fact': {
      const value = ctx.facts[expression.key];
      return value === undefined ? MISSING : value;
    }

    case 'claim': {
      const claim = ctx.claims.get(expression.predicate);
      if (!claim) {
        if ('default' in expression) {
          out.traces.push({
            op: 'claim',
            result: 'VALUE',
            detail: `No claim recorded for ${expression.predicate}; using the ruleset default`,
            claimIds: [],
            evidenceIds: [],
          });
          return expression.default;
        }
        out.missing.add(expression.predicate);
        out.traces.push({
          op: 'claim',
          result: 'VALUE',
          detail: `No claim recorded for ${expression.predicate}`,
          claimIds: [],
          evidenceIds: [],
        });
        return MISSING;
      }
      out.claimIds.add(claim.claimId);
      for (const id of claim.evidenceIds) out.evidenceIds.add(id);
      if (claim.unusableReason !== null) {
        out.missing.add(expression.predicate);
        out.traces.push({
          op: 'claim',
          result: 'VALUE',
          detail: `Claim ${expression.predicate} is not usable: ${claim.unusableReason}`,
          claimIds: [claim.claimId],
          evidenceIds: [...claim.evidenceIds],
        });
        return MISSING;
      }
      return pluck(claim.value, expression.path);
    }

    default:
      // Logical operators produce a Trilean; expose it as a value so that
      // comparisons over nested logic still behave sensibly.
      return evaluateInternal(expression, ctx, out);
  }
}

function compare(
  left: Value,
  right: Value,
  compareFn: (a: number | string, b: number | string) => boolean,
): Trilean {
  if (left === MISSING || right === MISSING) return 'UNKNOWN';
  if (left === null || right === null) return 'UNKNOWN';
  if (typeof left === 'number' && typeof right === 'number')
    return fromBoolean(compareFn(left, right));
  if (typeof left === 'string' && typeof right === 'string')
    return fromBoolean(compareFn(left, right));
  // Dates arrive as ISO strings; comparing them lexically is correct for
  // ISO-8601 with a fixed offset, which is the only form Adericel stores.
  return 'UNKNOWN';
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEquals(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) =>
      deepEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function toTrilean(value: Value): Trilean {
  if (value === MISSING || value === null || value === undefined) return 'UNKNOWN';
  if (value === 'TRUE' || value === 'FALSE' || value === 'UNKNOWN') return value;
  if (typeof value === 'boolean') return fromBoolean(value);
  return 'UNKNOWN';
}

function evaluateInternal(expression: Expression, ctx: EvaluationContext, out: Collector): Trilean {
  switch (expression.op) {
    case 'const':
    case 'claim':
    case 'param':
    case 'fact':
      return toTrilean(resolveValue(expression, ctx, out));

    case 'exists': {
      const claim = ctx.claims.get(expression.predicate);
      if (!claim) {
        out.missing.add(expression.predicate);
        return 'FALSE';
      }
      out.claimIds.add(claim.claimId);
      for (const id of claim.evidenceIds) out.evidenceIds.add(id);
      return claim.unusableReason === null ? 'TRUE' : 'UNKNOWN';
    }

    case 'eq':
    case 'ne': {
      const left = resolveValue(expression.left, ctx, out);
      const right = resolveValue(expression.right, ctx, out);
      if (left === MISSING || right === MISSING) return 'UNKNOWN';
      const equal = deepEquals(left, right);
      return fromBoolean(expression.op === 'eq' ? equal : !equal);
    }

    case 'lt':
      return compare(
        resolveValue(expression.left, ctx, out),
        resolveValue(expression.right, ctx, out),
        (a, b) => a < b,
      );
    case 'lte':
      return compare(
        resolveValue(expression.left, ctx, out),
        resolveValue(expression.right, ctx, out),
        (a, b) => a <= b,
      );
    case 'gt':
      return compare(
        resolveValue(expression.left, ctx, out),
        resolveValue(expression.right, ctx, out),
        (a, b) => a > b,
      );
    case 'gte':
      return compare(
        resolveValue(expression.left, ctx, out),
        resolveValue(expression.right, ctx, out),
        (a, b) => a >= b,
      );

    case 'includes': {
      const collection = resolveValue(expression.collection, ctx, out);
      const value = resolveValue(expression.value, ctx, out);
      if (collection === MISSING || value === MISSING) return 'UNKNOWN';
      if (Array.isArray(collection)) {
        return fromBoolean(collection.some((item) => deepEquals(item, value)));
      }
      if (typeof collection === 'string' && typeof value === 'string') {
        return fromBoolean(collection.includes(value));
      }
      return 'UNKNOWN';
    }

    case 'matches': {
      const value = resolveValue(expression.value, ctx, out);
      if (value === MISSING || typeof value !== 'string') return 'UNKNOWN';
      // Patterns are authored in rulesets, which are reviewed artefacts, but a
      // malformed pattern must still not crash an assessment.
      try {
        return fromBoolean(new RegExp(expression.pattern).test(value));
      } catch {
        return 'UNKNOWN';
      }
    }

    case 'and':
      return and(expression.operands.map((operand) => evaluateInternal(operand, ctx, out)));

    case 'or':
      return or(expression.operands.map((operand) => evaluateInternal(operand, ctx, out)));

    case 'not':
      return not(evaluateInternal(expression.operand, ctx, out));

    case 'isTrue':
      return toTrilean(resolveValue(expression.operand, ctx, out));

    case 'olderThanDays': {
      const value = resolveValue(expression.value, ctx, out);
      const days = resolveValue(expression.days, ctx, out);
      if (value === MISSING || days === MISSING) return 'UNKNOWN';
      if (typeof days !== 'number') return 'UNKNOWN';
      const instant = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      if (Number.isNaN(instant)) return 'UNKNOWN';
      return fromBoolean(ctx.asOfEpochMs - instant > days * 86_400_000);
    }
  }
}

/** Evaluate an expression, collecting the provenance needed to explain it. */
export function evaluate(expression: Expression, ctx: EvaluationContext): EvaluationResult {
  const out: Collector = {
    traces: [],
    claimIds: new Set(),
    evidenceIds: new Set(),
    missing: new Set(),
  };
  const value = evaluateInternal(expression, ctx, out);
  return {
    value,
    traces: out.traces,
    claimIds: [...out.claimIds].sort(),
    evidenceIds: [...out.evidenceIds].sort(),
    missingPredicates: [...out.missing].sort(),
  };
}

/** Every predicate an expression can read. Used to fetch exactly what a rule needs. */
export function referencedPredicates(expression: Expression): readonly string[] {
  const found = new Set<string>();
  const walk = (node: Expression): void => {
    switch (node.op) {
      case 'claim':
      case 'exists':
        found.add(node.predicate);
        break;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        walk(node.left);
        walk(node.right);
        break;
      case 'includes':
        walk(node.collection);
        walk(node.value);
        break;
      case 'matches':
      case 'isTrue':
        walk(node.op === 'matches' ? node.value : node.operand);
        break;
      case 'and':
      case 'or':
        node.operands.forEach(walk);
        break;
      case 'not':
        walk(node.operand);
        break;
      case 'olderThanDays':
        walk(node.value);
        walk(node.days);
        break;
      default:
        break;
    }
  };
  walk(expression);
  return [...found].sort();
}
