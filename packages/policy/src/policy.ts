import {
  ACTION_RISK_RANK,
  AUTONOMY_DEFINITIONS,
  defaultRequiredApprovals,
  effectiveAutonomy,
  type ActionRiskClass,
  type AutonomyLevel,
  type Severity,
} from '@adericel/domain';
import { contentHash } from '@adericel/shared';
import { z } from 'zod';

/**
 * Action policy.
 *
 * Policies decide three things about a proposed action: may it run at all, may
 * it run without a human, and how many humans must agree. Like rulesets they
 * are declarative data — versioned, hashable and reviewable — because "why was
 * this action allowed to execute?" must be answerable months later from the
 * audit record alone.
 *
 * The evaluator is deliberately deny-by-default and monotonic: a policy can
 * only ever *narrow* what the autonomy ceiling already permits. There is no
 * expression in this language that grants more authority than the risk class
 * allows.
 */

export const policyRuleSchema = z.object({
  id: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  /** Action types this rule governs. `*` suffix matches a namespace prefix. */
  actionTypes: z.array(z.string().min(1)).min(1),
  /** Restrict to these risk classes; empty means all. */
  riskClasses: z
    .array(z.enum(['READ_ONLY', 'LOW_IMPACT', 'CONFIGURATION', 'DISRUPTIVE', 'DESTRUCTIVE']))
    .default([]),
  /** Only apply when the originating finding is at least this severe. */
  minSeverity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().default(null),
  effect: z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']),
  /** Maximum autonomy this rule permits for matching actions. */
  maxAutonomyLevel: z.number().int().min(0).max(5).default(3),
  requiredApprovals: z.number().int().min(1).max(5).nullable().default(null),
  /** Approval window; the action expires unapproved after this many hours. */
  approvalWindowHours: z.number().int().min(1).max(720).default(72),
  /** Cap on matching actions executed per organisation per hour. */
  rateLimitPerHour: z.number().int().min(1).nullable().default(null),
  /** Only permit execution inside these UTC hours, e.g. a change window. */
  allowedHoursUtc: z.array(z.number().int().min(0).max(23)).default([]),
  reason: z.string().max(1000).default(''),
});

export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policyDefinitionSchema = z.object({
  key: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  /** Autonomy ceiling applied when no rule matches. */
  defaultAutonomyLevel: z.number().int().min(0).max(5).default(1),
  /** Effect when no rule matches. Deny-by-default is the shipped posture. */
  defaultEffect: z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']).default('DENY'),
  rules: z.array(policyRuleSchema).default([]),
});

export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;

export interface CompiledPolicy extends PolicyDefinition {
  readonly hash: string;
}

export function compilePolicy(definition: unknown): CompiledPolicy {
  const parsed = policyDefinitionSchema.parse(definition);
  const seen = new Set<string>();
  for (const rule of parsed.rules) {
    if (seen.has(rule.id)) throw new Error(`Policy ${parsed.key}: duplicate rule id ${rule.id}`);
    seen.add(rule.id);
  }
  return { ...parsed, hash: contentHash(parsed) };
}

export interface PolicyQuestion {
  readonly actionType: string;
  readonly riskClass: ActionRiskClass;
  readonly findingSeverity: Severity | null;
  /** Organisation-configured autonomy ceiling. */
  readonly organisationAutonomyLevel: AutonomyLevel;
  /** Actions of this type already executed in the trailing hour. */
  readonly recentExecutions: number;
  /** UTC hour, injected so evaluation stays deterministic and testable. */
  readonly utcHour: number;
  /** Set when the proposer is a human; used to enforce four-eyes downstream. */
  readonly proposerUserId: string | null;
}

export const POLICY_OUTCOMES = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly reason: string;
  readonly matchedRuleId: string | null;
  readonly effectiveAutonomyLevel: AutonomyLevel;
  readonly requiredApprovals: number;
  readonly approvalWindowHours: number;
  readonly policyKey: string;
  readonly policyHash: string;
  /** Every check that ran, so the decision can be explained in the UI. */
  readonly evaluation: readonly PolicyCheck[];
}

export interface PolicyCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** `identity.*` matches `identity.mfa.require`; exact strings match exactly. */
export function actionTypeMatches(pattern: string, actionType: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return actionType.startsWith(pattern.slice(0, -1));
  return pattern === actionType;
}

function ruleApplies(rule: PolicyRule, question: PolicyQuestion): boolean {
  if (!rule.actionTypes.some((pattern) => actionTypeMatches(pattern, question.actionType))) {
    return false;
  }
  if (rule.riskClasses.length > 0 && !rule.riskClasses.includes(question.riskClass)) return false;
  if (rule.minSeverity !== null) {
    if (question.findingSeverity === null) return false;
    if (SEVERITY_ORDER[question.findingSeverity] < SEVERITY_ORDER[rule.minSeverity]) return false;
  }
  return true;
}

/**
 * Evaluate a proposed action against a policy.
 *
 * Order matters and is fixed:
 *   1. Find the most specific matching rule (DENY wins ties).
 *   2. Apply the rule's effect.
 *   3. Clamp autonomy to the minimum of rule, organisation and risk ceiling.
 *   4. Apply operational guards (change window, rate limit).
 *   5. Decide whether a human is required.
 *
 * Every step can only reduce authority. That property is what lets an operator
 * reason about the blast radius of a policy change.
 */
export function evaluatePolicy(policy: CompiledPolicy, question: PolicyQuestion): PolicyDecision {
  const checks: PolicyCheck[] = [];

  const matching = policy.rules.filter((rule) => ruleApplies(rule, question));
  // A DENY that matches always wins, regardless of specificity. Otherwise the
  // most specific rule (longest matching pattern) governs.
  const denyRule = matching.find((rule) => rule.effect === 'DENY');
  const matched =
    denyRule ??
    [...matching].sort((a, b) => specificity(b, question) - specificity(a, question))[0] ??
    null;

  checks.push({
    check: 'rule-match',
    passed: matched !== null,
    detail: matched
      ? `Matched rule ${matched.id}`
      : `No rule matched; applying the policy default (${policy.defaultEffect})`,
  });

  const ruleEffect = matched?.effect ?? policy.defaultEffect;
  const ruleAutonomy = (matched?.maxAutonomyLevel ?? policy.defaultAutonomyLevel) as AutonomyLevel;

  // Three independent ceilings; the lowest governs.
  const riskCeiling = effectiveAutonomy(5, question.riskClass);
  const level = Math.min(
    ruleAutonomy,
    question.organisationAutonomyLevel,
    riskCeiling,
  ) as AutonomyLevel;
  const definition = AUTONOMY_DEFINITIONS[level];

  checks.push({
    check: 'autonomy-ceiling',
    passed: true,
    detail:
      `Effective autonomy L${level} (${definition.name}) — ` +
      `rule L${ruleAutonomy}, organisation L${question.organisationAutonomyLevel}, ` +
      `risk-class ceiling L${riskCeiling} for ${question.riskClass}`,
  });

  const approvalWindowHours = matched?.approvalWindowHours ?? 72;
  const requiredApprovals =
    matched?.requiredApprovals ?? defaultRequiredApprovals(question.riskClass);

  const deny = (reason: string): PolicyDecision => ({
    outcome: 'DENY',
    reason,
    matchedRuleId: matched?.id ?? null,
    effectiveAutonomyLevel: level,
    requiredApprovals,
    approvalWindowHours,
    policyKey: policy.key,
    policyHash: policy.hash,
    evaluation: checks,
  });

  if (ruleEffect === 'DENY') {
    checks.push({ check: 'effect', passed: false, detail: 'Policy effect is DENY' });
    return deny(matched?.reason || 'Action is denied by policy');
  }

  if (!definition.mayExecuteWithApproval) {
    checks.push({
      check: 'autonomy-permits-execution',
      passed: false,
      detail: `Autonomy level L${level} (${definition.name}) does not permit execution`,
    });
    return deny(
      `Autonomy level L${level} (${definition.name}) permits proposal but not execution. ` +
        'Raise the organisation autonomy level or execute the change outside Adericel.',
    );
  }
  checks.push({
    check: 'autonomy-permits-execution',
    passed: true,
    detail: `Autonomy level L${level} permits execution`,
  });

  if (matched?.allowedHoursUtc.length && !matched.allowedHoursUtc.includes(question.utcHour)) {
    checks.push({
      check: 'change-window',
      passed: false,
      detail: `Current hour ${question.utcHour}:00 UTC is outside the permitted window`,
    });
    return deny(
      `Execution is only permitted during hours ${matched.allowedHoursUtc.join(', ')} UTC`,
    );
  }
  if (matched?.allowedHoursUtc.length) {
    checks.push({
      check: 'change-window',
      passed: true,
      detail: `Hour ${question.utcHour}:00 UTC is inside the permitted window`,
    });
  }

  if (matched?.rateLimitPerHour !== null && matched?.rateLimitPerHour !== undefined) {
    const withinLimit = question.recentExecutions < matched.rateLimitPerHour;
    checks.push({
      check: 'rate-limit',
      passed: withinLimit,
      detail: `${question.recentExecutions} of ${matched.rateLimitPerHour} permitted executions used this hour`,
    });
    if (!withinLimit) {
      // A rate limit is a blast-radius control: a mis-scoped rule that would
      // disable five hundred accounts stops after the configured number.
      return deny(
        `Rate limit reached: ${matched.rateLimitPerHour} executions per hour for ${question.actionType}`,
      );
    }
  }

  const humanRequired =
    ruleEffect === 'REQUIRE_APPROVAL' || !definition.mayExecuteWithoutApproval;

  checks.push({
    check: 'human-approval',
    passed: true,
    detail: humanRequired
      ? `Human approval required (${requiredApprovals} approver(s))`
      : 'Policy authorises autonomous execution',
  });

  return {
    outcome: humanRequired ? 'REQUIRE_APPROVAL' : 'ALLOW',
    reason: humanRequired
      ? matched?.reason || `Approval required for ${question.riskClass} action at autonomy L${level}`
      : matched?.reason || `Autonomously authorised at autonomy L${level}`,
    matchedRuleId: matched?.id ?? null,
    effectiveAutonomyLevel: level,
    requiredApprovals,
    approvalWindowHours,
    policyKey: policy.key,
    policyHash: policy.hash,
    evaluation: checks,
  };
}

/** Longer, more specific action-type patterns win over broad ones. */
function specificity(rule: PolicyRule, question: PolicyQuestion): number {
  const best = rule.actionTypes
    .filter((pattern) => actionTypeMatches(pattern, question.actionType))
    .reduce((max, pattern) => Math.max(max, pattern === '*' ? 0 : pattern.length), 0);
  return best + (rule.riskClasses.length > 0 ? 100 : 0) + (rule.minSeverity !== null ? 50 : 0);
}

/**
 * The shipped default policy.
 *
 * Deny-by-default, with a small set of explicitly enumerated remediations that
 * an MSP can execute under approval. Nothing is autonomous out of the box: an
 * organisation earns higher autonomy by raising its configured level once it
 * trusts the evidence and verification behaviour it has observed.
 */
export const DEFAULT_ACTION_POLICY: PolicyDefinition = {
  key: 'adericel-default',
  name: 'Adericel default action policy',
  description:
    'Deny-by-default action policy. Enumerated low-risk and configuration remediations may run ' +
    'with human approval; disruptive and destructive actions always require two approvers.',
  defaultAutonomyLevel: 1,
  defaultEffect: 'DENY',
  rules: [
    {
      id: 'read-only-allowed',
      description: 'Read-only verification and collection actions need no approval.',
      actionTypes: ['*'],
      riskClasses: ['READ_ONLY'],
      minSeverity: null,
      effect: 'ALLOW',
      maxAutonomyLevel: 5,
      requiredApprovals: null,
      approvalWindowHours: 72,
      rateLimitPerHour: null,
      allowedHoursUtc: [],
      reason: 'Read-only actions do not change customer state.',
    },
    {
      id: 'identity-mfa',
      description: 'Enforcing MFA is a well-understood, reversible configuration change.',
      actionTypes: ['identity.mfa.*'],
      riskClasses: ['CONFIGURATION'],
      minSeverity: null,
      effect: 'REQUIRE_APPROVAL',
      maxAutonomyLevel: 4,
      requiredApprovals: 1,
      approvalWindowHours: 72,
      rateLimitPerHour: 50,
      allowedHoursUtc: [],
      reason: 'Enforce multi-factor authentication after human approval.',
    },
    {
      id: 'endpoint-hardening',
      description: 'Device hardening changes an MSP routinely performs.',
      actionTypes: ['device.encryption.*', 'device.firewall.*'],
      riskClasses: ['CONFIGURATION'],
      minSeverity: null,
      effect: 'REQUIRE_APPROVAL',
      maxAutonomyLevel: 3,
      requiredApprovals: 1,
      approvalWindowHours: 72,
      rateLimitPerHour: 25,
      allowedHoursUtc: [],
      reason: 'Device hardening after human approval.',
    },
    {
      id: 'cloud-public-access',
      description: 'Removing public access from cloud storage is urgent and reversible.',
      actionTypes: ['cloud.storage.block_public_access'],
      riskClasses: ['CONFIGURATION'],
      minSeverity: 'HIGH',
      effect: 'REQUIRE_APPROVAL',
      maxAutonomyLevel: 4,
      requiredApprovals: 1,
      approvalWindowHours: 12,
      rateLimitPerHour: 10,
      allowedHoursUtc: [],
      reason: 'Publicly exposed storage is remediated promptly after approval.',
    },
    {
      id: 'disruptive-two-approvers',
      description: 'Disruptive changes always need two people.',
      actionTypes: ['*'],
      riskClasses: ['DISRUPTIVE'],
      minSeverity: null,
      effect: 'REQUIRE_APPROVAL',
      maxAutonomyLevel: 3,
      requiredApprovals: 2,
      approvalWindowHours: 48,
      rateLimitPerHour: 5,
      allowedHoursUtc: [],
      reason: 'Disruptive actions require two approvers.',
    },
    {
      id: 'destructive-denied',
      description:
        'Destructive actions are never dispatched by Adericel. They are proposed, documented and ' +
        'carried out by a human in the target system.',
      actionTypes: ['*'],
      riskClasses: ['DESTRUCTIVE'],
      minSeverity: null,
      effect: 'DENY',
      maxAutonomyLevel: 1,
      requiredApprovals: null,
      approvalWindowHours: 72,
      rateLimitPerHour: null,
      allowedHoursUtc: [],
      reason:
        'Adericel does not execute destructive actions. The remediation is recorded for a human to perform.',
    },
  ],
};

export { ACTION_RISK_RANK };
