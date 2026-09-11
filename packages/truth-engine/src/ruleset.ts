import { contentHash } from '@adericel/shared';
import { z } from 'zod';
import { expressionSchema, referencedPredicates, type Expression } from './expression.js';

/**
 * Rulesets.
 *
 * A published ruleset version is immutable. Assessments record the ruleset key,
 * version and hash they ran under, so changing a rule creates a new version and
 * leaves every historical determination explicable exactly as it was made.
 */
export const ENGINE_VERSION = '1.0.0';

/** How a rule combines per-subject outcomes into one control state. */
export const AGGREGATIONS = ['ALL', 'ANY', 'THRESHOLD', 'SINGLE'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const ruleSchema = z.object({
  key: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  description: z.string().max(4000).default(''),
  /**
   * Node kinds this rule evaluates. An empty list means the rule is evaluated
   * once for the organisation as a whole rather than per subject.
   */
  subjectKinds: z.array(z.string().min(1)).default([]),
  /** Optional expression restricting which subjects are in scope. */
  applicability: expressionSchema.optional(),
  /** The determination itself. */
  expression: expressionSchema,
  aggregation: z.enum(AGGREGATIONS).default('ALL'),
  /** For THRESHOLD: the minimum passing proportion, 0..1. */
  threshold: z.number().min(0).max(1).default(1),
  /**
   * Fraction of subjects that may be UNKNOWN before the whole control is
   * reported UNKNOWN. Defaults to 0: if we cannot speak to a subject, we do not
   * claim the control holds for it.
   */
  unknownTolerance: z.number().min(0).max(1).default(0),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  /** Human-readable statement used when the rule fails. */
  failureTitle: z.string().min(1).max(300),
  failureDescription: z.string().min(1).max(4000),
  /** Remediation the action engine may propose. */
  remediation: z
    .object({
      actionType: z.string().min(1),
      riskClass: z.enum(['READ_ONLY', 'LOW_IMPACT', 'CONFIGURATION', 'DISRUPTIVE', 'DESTRUCTIVE']),
      parameterTemplate: z.record(z.string(), z.unknown()).default({}),
      rationale: z.string().min(1),
    })
    .nullable()
    .default(null),
  /** Default control parameters; a control may override them. */
  defaultParameters: z.record(z.string(), z.unknown()).default({}),
  /** Freshness bound applied to the evidence behind each claim, in days. */
  maxEvidenceAgeDays: z.number().int().positive().nullable().default(null),
});

export type Rule = z.infer<typeof ruleSchema>;

export const rulesetDefinitionSchema = z.object({
  key: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  engineVersion: z.string().min(1),
  rules: z.array(ruleSchema).min(1),
});

export type RulesetDefinition = z.infer<typeof rulesetDefinitionSchema>;

export interface Ruleset extends RulesetDefinition {
  readonly hash: string;
}

/**
 * Compile and hash a ruleset.
 *
 * The hash is taken over the *parsed* definition, so it is stable against
 * formatting, key order and defaults being written explicitly — two authors who
 * express the same rules differently get the same hash, and any change in
 * meaning changes it.
 */
export function compileRuleset(definition: unknown): Ruleset {
  const parsed = rulesetDefinitionSchema.parse(definition);

  const seen = new Set<string>();
  for (const rule of parsed.rules) {
    if (seen.has(rule.key)) {
      throw new Error(`Ruleset ${parsed.key}: duplicate rule key ${rule.key}`);
    }
    seen.add(rule.key);
    if (rule.aggregation === 'THRESHOLD' && rule.threshold >= 1) {
      throw new Error(
        `Ruleset ${parsed.key}, rule ${rule.key}: THRESHOLD aggregation requires a threshold below 1`,
      );
    }
    if (rule.aggregation === 'SINGLE' && rule.subjectKinds.length > 0) {
      throw new Error(
        `Ruleset ${parsed.key}, rule ${rule.key}: SINGLE aggregation cannot declare subject kinds`,
      );
    }
  }

  return { ...parsed, hash: contentHash(parsed) };
}

export function ruleRequiredPredicates(rule: Rule): readonly string[] {
  const fromExpression = referencedPredicates(rule.expression);
  const fromApplicability = rule.applicability ? referencedPredicates(rule.applicability) : [];
  return [...new Set([...fromExpression, ...fromApplicability])].sort();
}

/** Registry of the rulesets available to this engine build. */
export interface RulesetRegistry {
  get(key: string, version?: string): Ruleset;
  tryGet(key: string, version?: string): Ruleset | null;
  latest(key: string): Ruleset | null;
  list(): readonly Ruleset[];
  register(definition: unknown): Ruleset;
}

export function createRulesetRegistry(initial: readonly unknown[] = []): RulesetRegistry {
  const byKey = new Map<string, Map<string, Ruleset>>();

  function register(definition: unknown): Ruleset {
    const ruleset = compileRuleset(definition);
    const versions = byKey.get(ruleset.key) ?? new Map<string, Ruleset>();
    const existing = versions.get(ruleset.version);
    if (existing && existing.hash !== ruleset.hash) {
      throw new Error(
        `Ruleset ${ruleset.key}@${ruleset.version} is already registered with a different hash. ` +
          'Published ruleset versions are immutable; publish a new version instead.',
      );
    }
    versions.set(ruleset.version, ruleset);
    byKey.set(ruleset.key, versions);
    return ruleset;
  }

  for (const definition of initial) register(definition);

  function latest(key: string): Ruleset | null {
    const versions = byKey.get(key);
    if (!versions || versions.size === 0) return null;
    const sorted = [...versions.values()].sort((a, b) => compareVersions(a.version, b.version));
    return sorted.at(-1) ?? null;
  }

  return {
    register,
    latest,
    tryGet(key: string, version?: string): Ruleset | null {
      if (version === undefined) return latest(key);
      return byKey.get(key)?.get(version) ?? null;
    },
    get(key: string, version?: string): Ruleset {
      const ruleset = this.tryGet(key, version);
      if (!ruleset) {
        throw new Error(`Ruleset not found: ${key}${version ? `@${version}` : ''}`);
      }
      return ruleset;
    },
    list(): readonly Ruleset[] {
      return [...byKey.values()].flatMap((versions) => [...versions.values()]);
    },
  };
}

/** Semantic-ish version comparison; falls back to lexical for non-numeric parts. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isInteger(na) && Number.isInteger(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export function findRule(ruleset: Ruleset, ruleKey: string): Rule {
  const rule = ruleset.rules.find((r) => r.key === ruleKey);
  if (!rule) {
    throw new Error(`Rule ${ruleKey} not found in ruleset ${ruleset.key}@${ruleset.version}`);
  }
  return rule;
}

export type { Expression };
