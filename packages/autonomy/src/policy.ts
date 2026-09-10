import { contentHash } from '@adericel/shared';
import { z } from 'zod';
import {
  mostRestrictive,
  OPERATION_RISK_RANK,
  operationRiskClassSchema,
  type AutonomyCheck,
  type AutonomyDecision,
  type AutonomyOutcome,
  type OperationRiskClass,
} from './decision.js';

/**
 * Autonomy policy: rules as data.
 *
 * Configuration rather than code so that changing what the company may do
 * unattended is a reviewable change, and so a decision can be replayed against
 * the exact rules that produced it years later.
 *
 * Evaluation is pure and total. It performs no I/O, consults no clock and makes
 * no network call, because a decision about authority must be reproducible from
 * its recorded inputs — otherwise "why were we allowed to do that?" has no
 * answer.
 */

/** `sales.*` matches `sales.outreach`; `*` matches everything. */
export function operationMatches(pattern: string, operation: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return operation.startsWith(pattern.slice(0, -1));
  return pattern === operation;
}

export const autonomyRuleSchema = z.object({
  id: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  /** Operations this rule speaks to. */
  operations: z.array(z.string().min(1)).min(1),
  /** Restrict to these risk classes; empty means any. */
  riskClasses: z.array(operationRiskClassSchema).default([]),
  /** The most severe risk class this rule will permit unattended. */
  maxUnattendedRisk: operationRiskClassSchema.nullable().default(null),
  /** The company process maturity this rule requires before permitting. */
  minMaturity: z.number().int().min(0).max(5).default(0),
  outcome: z.enum(['PERMIT', 'REQUIRE_APPROVAL', 'ESCALATE', 'DENY']),
  requiredApprovals: z.number().int().min(0).max(5).default(1),
  requiredAuthority: z.string().max(200).default(''),
  /**
   * Operations of this kind permitted in the trailing window.
   *
   * A cap, not a target. Its purpose is that a malfunctioning automation stops
   * by itself rather than sending four thousand emails before anyone notices.
   */
  rateLimitPerHour: z.number().int().min(0).nullable().default(null),
  /** UTC hours during which this rule permits action. Empty means any hour. */
  allowedUtcHours: z.array(z.number().int().min(0).max(23)).default([]),
  /** Facts that must be present and true for this rule to permit. */
  requiresFacts: z.array(z.string().min(1)).default([]),
});
export type AutonomyRule = z.infer<typeof autonomyRuleSchema>;

export const autonomyPolicySchema = z.object({
  key: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  /**
   * What happens when no rule matches.
   *
   * Constrained to the outcomes that do not permit unattended action. A policy
   * whose fallback was PERMIT would make every unanticipated operation
   * automatically allowed, which is the exact failure this design exists to
   * prevent — so it is not expressible.
   */
  fallback: z.enum(['REQUIRE_APPROVAL', 'ESCALATE', 'DENY', 'UNKNOWN']).default('UNKNOWN'),
  rules: z.array(autonomyRuleSchema).default([]),
});
export type AutonomyPolicyDefinition = z.infer<typeof autonomyPolicySchema>;

export interface CompiledAutonomyPolicy extends AutonomyPolicyDefinition {
  readonly hash: string;
}

export function compileAutonomyPolicy(definition: unknown): CompiledAutonomyPolicy {
  const parsed = autonomyPolicySchema.parse(definition);
  const seen = new Set<string>();
  for (const rule of parsed.rules) {
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate autonomy rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  }
  // Hashed over the parsed definition, so two authors expressing the same rules
  // differently get the same hash and any change in meaning changes it.
  return { ...parsed, hash: contentHash(parsed) };
}

export interface AutonomyQuestion {
  /** The company process this belongs to, e.g. `sales.outreach`. */
  readonly processKey: string;
  /** The specific operation, e.g. `sales.outreach.send_email`. */
  readonly operation: string;
  readonly riskClass: OperationRiskClass;
  /**
   * The process's recorded maturity.
   *
   * Null when the process is not registered — which is not zero. An
   * unregistered process is one nobody has thought about, and treating that as
   * "manual" would let it inherit whatever a permissive rule allows. It
   * produces UNKNOWN.
   */
  readonly processMaturity: number | null;
  /** Operations of this kind already performed in the trailing hour. */
  readonly recentOperations: number;
  /** Injected, so evaluation stays deterministic and testable. */
  readonly utcHour: number;
  /**
   * Facts the caller has established, by name.
   *
   * A fact that is absent is not false — it is unestablished, and a rule
   * requiring it yields UNKNOWN rather than failing to match. That difference
   * is why an unanswerable question cannot become a quiet refusal that a
   * later, broader rule then permits.
   */
  readonly facts: Readonly<Record<string, boolean>>;
}

function check(name: string, outcome: AutonomyOutcome, detail: string): AutonomyCheck {
  return { check: name, outcome, detail };
}

/**
 * Decide whether an operation may proceed.
 *
 * Every rule that matches the operation is evaluated, and the most restrictive
 * result wins. Rules can therefore only ever narrow authority: adding one can
 * never widen it, which means a policy can be extended without re-auditing
 * everything already in it.
 */
export function evaluateAutonomy(
  policy: CompiledAutonomyPolicy,
  question: AutonomyQuestion,
): AutonomyDecision {
  const evaluation: AutonomyCheck[] = [];

  const base = {
    policyKey: policy.key,
    policyHash: policy.hash,
    requiredApprovals: 1,
    requiredAuthority: '',
  };

  // An unregistered process is not a low-maturity process. Nobody has decided
  // what may happen here, so nothing may happen unattended.
  if (question.processMaturity === null) {
    evaluation.push(
      check(
        'process_registered',
        'UNKNOWN',
        `Process ${question.processKey} is not in the process registry, so its autonomy ` +
          'boundary has never been decided.',
      ),
    );
    return {
      ...base,
      outcome: 'UNKNOWN',
      reason:
        `No autonomy boundary is recorded for ${question.processKey}. Adericel will not infer ` +
        'one: an unregistered process is one nobody has thought about, not one that is safe.',
      matchedRuleId: null,
      requiredAuthority: 'Register the process and set its autonomy boundary',
      evaluation,
    };
  }
  evaluation.push(
    check(
      'process_registered',
      'PERMIT',
      `Process ${question.processKey} is registered at maturity L${question.processMaturity}.`,
    ),
  );

  const matching = policy.rules.filter(
    (rule) =>
      rule.operations.some((pattern) => operationMatches(pattern, question.operation)) &&
      (rule.riskClasses.length === 0 || rule.riskClasses.includes(question.riskClass)),
  );

  if (matching.length === 0) {
    evaluation.push(
      check(
        'rule_match',
        policy.fallback,
        `No rule in ${policy.key} speaks to ${question.operation} at risk ${question.riskClass}.`,
      ),
    );
    return {
      ...base,
      outcome: policy.fallback,
      reason:
        `No rule covers ${question.operation}. The policy's fallback is ${policy.fallback}, ` +
        'because an operation nobody wrote a rule for is not thereby permitted.',
      matchedRuleId: null,
      requiredAuthority: 'Whoever owns this policy',
      evaluation,
    };
  }

  const outcomes: AutonomyOutcome[] = [];
  let decidingRule: AutonomyRule | null = null;
  let decidingOutcome: AutonomyOutcome = 'PERMIT';
  let decidingDetail = '';

  for (const rule of matching) {
    const ruleChecks: AutonomyCheck[] = [];

    // A rule may only permit what its own risk ceiling covers. A rule that
    // permits `sales.*` unattended does not thereby permit an irreversible
    // operation that happens to live under `sales.`.
    if (
      rule.outcome === 'PERMIT' &&
      rule.maxUnattendedRisk !== null &&
      OPERATION_RISK_RANK[question.riskClass] > OPERATION_RISK_RANK[rule.maxUnattendedRisk]
    ) {
      ruleChecks.push(
        check(
          `${rule.id}:risk_ceiling`,
          'REQUIRE_APPROVAL',
          `${question.riskClass} exceeds the rule's unattended ceiling of ${rule.maxUnattendedRisk}.`,
        ),
      );
    }

    if (rule.outcome === 'PERMIT' && question.processMaturity < rule.minMaturity) {
      ruleChecks.push(
        check(
          `${rule.id}:maturity`,
          'REQUIRE_APPROVAL',
          `Process is at L${question.processMaturity}; the rule permits unattended action from ` +
            `L${rule.minMaturity}.`,
        ),
      );
    }

    if (
      rule.outcome === 'PERMIT' &&
      rule.rateLimitPerHour !== null &&
      question.recentOperations >= rule.rateLimitPerHour
    ) {
      // Deliberately ESCALATE rather than REQUIRE_APPROVAL. Hitting a rate cap
      // usually means something is malfunctioning, and asking a person to
      // rubber-stamp the four thousandth email is not the right question.
      ruleChecks.push(
        check(
          `${rule.id}:rate_limit`,
          'ESCALATE',
          `${question.recentOperations} operations in the trailing hour meets the cap of ` +
            `${rule.rateLimitPerHour}. A rate cap being reached usually means something is wrong.`,
        ),
      );
    }

    if (
      rule.outcome === 'PERMIT' &&
      rule.allowedUtcHours.length > 0 &&
      !rule.allowedUtcHours.includes(question.utcHour)
    ) {
      ruleChecks.push(
        check(
          `${rule.id}:change_window`,
          'REQUIRE_APPROVAL',
          `${String(question.utcHour).padStart(2, '0')}:00 UTC is outside the rule's window.`,
        ),
      );
    }

    for (const fact of rule.requiresFacts) {
      const value = question.facts[fact];
      if (value === undefined) {
        // The distinction that matters. An unestablished fact is not a false
        // one, and pretending otherwise would let "we never checked consent"
        // read the same as "consent was refused" — which would then be
        // overridden by any broader permitting rule.
        ruleChecks.push(
          check(
            `${rule.id}:fact:${fact}`,
            'UNKNOWN',
            `The rule requires ${fact} and nothing established it. Not established is not false.`,
          ),
        );
      } else if (!value) {
        ruleChecks.push(check(`${rule.id}:fact:${fact}`, 'DENY', `${fact} is false.`));
      } else {
        ruleChecks.push(check(`${rule.id}:fact:${fact}`, 'PERMIT', `${fact} holds.`));
      }
    }

    const ruleOutcome = mostRestrictive([
      rule.outcome,
      ...ruleChecks.map((entry) => entry.outcome),
    ]);
    evaluation.push(...ruleChecks);
    evaluation.push(
      check(
        `${rule.id}`,
        ruleOutcome,
        rule.description || `Rule ${rule.id} yields ${ruleOutcome}.`,
      ),
    );
    outcomes.push(ruleOutcome);

    if (decidingRule === null || mostRestrictive([decidingOutcome, ruleOutcome]) === ruleOutcome) {
      if (decidingRule === null || ruleOutcome !== decidingOutcome) {
        decidingRule = rule;
        decidingOutcome = ruleOutcome;
        decidingDetail =
          ruleChecks.find((entry) => entry.outcome === ruleOutcome)?.detail ??
          rule.description ??
          '';
      }
    }
  }

  const outcome = mostRestrictive(outcomes);
  const rule = decidingRule;

  return {
    ...base,
    outcome,
    reason:
      outcome === 'PERMIT'
        ? `Permitted by ${rule?.id ?? 'policy'}.`
        : `${outcome} — ${decidingDetail || `decided by ${rule?.id ?? policy.key}`}`,
    matchedRuleId: rule?.id ?? null,
    requiredApprovals: rule?.requiredApprovals ?? 1,
    requiredAuthority: rule?.requiredAuthority ?? '',
    evaluation,
  };
}
