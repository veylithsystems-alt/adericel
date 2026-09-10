import { z } from 'zod';

/**
 * The company's authority model.
 *
 * Separate from Adericel's action policy on purpose. That engine answers "may
 * we change this setting on a customer's estate?" and is shaped entirely around
 * a finding, a risk class and an autonomy ceiling. This one answers "may the
 * company do this thing at all?", which has to cover sending an email, issuing
 * a proposal, suspending a subscription and deploying to production — questions
 * with nothing in common except that somebody must be authorised to answer them.
 *
 * THE OUTCOME SET IS THE POINT.
 *
 * Adericel's action policy has three outcomes: ALLOW, REQUIRE_APPROVAL, DENY.
 * With three, a question the rules cannot answer falls through to a default and
 * silently becomes a decision. There is no way to say "I do not know".
 *
 * Here there are five, and UNKNOWN is load-bearing. A missing input, a rule
 * referring to a fact nobody supplied, an operation nothing has a rule for —
 * each produces UNKNOWN, and UNKNOWN never resolves to permission. It is the
 * same principle the Truth Engine applies to assurance, applied to authority:
 * not knowing whether you are allowed to act is not the same as being allowed.
 */

export const AUTONOMY_OUTCOMES = [
  /** The system may act now, unattended. */
  'PERMIT',
  /** The system may prepare the action; a person must authorise it. */
  'REQUIRE_APPROVAL',
  /** Nobody has authority to decide this here. A person must be brought in. */
  'ESCALATE',
  /** Explicitly refused. */
  'DENY',
  /**
   * The rules could not determine an answer.
   *
   * Never resolves to PERMIT. Treated as at least as restrictive as ESCALATE by
   * every caller, and callers cannot opt out: `mayProceedUnattended` is the only
   * way to ask, and it returns false here.
   */
  'UNKNOWN',
] as const;
export type AutonomyOutcome = (typeof AUTONOMY_OUTCOMES)[number];

/**
 * Whether this outcome permits unattended action. The single question callers
 * ask, so there is exactly one place the UNKNOWN rule can be got wrong.
 */
export function mayProceedUnattended(outcome: AutonomyOutcome): boolean {
  return outcome === 'PERMIT';
}

/** Whether a person must be involved before anything happens. */
export function requiresHuman(outcome: AutonomyOutcome): boolean {
  return outcome === 'REQUIRE_APPROVAL' || outcome === 'ESCALATE' || outcome === 'UNKNOWN';
}

/**
 * Severity order, most restrictive first.
 *
 * Used to combine several rule results: the most restrictive wins, always. A
 * combination that could relax a restriction would let an added rule widen
 * authority, which is the opposite of what adding a rule should be able to do.
 */
const RESTRICTIVENESS: Record<AutonomyOutcome, number> = {
  DENY: 4,
  UNKNOWN: 3,
  ESCALATE: 2,
  REQUIRE_APPROVAL: 1,
  PERMIT: 0,
};

export function mostRestrictive(
  outcomes: readonly AutonomyOutcome[],
): AutonomyOutcome {
  // An empty rule set does not mean "anything goes". It means nothing has
  // decided, which is UNKNOWN.
  if (outcomes.length === 0) return 'UNKNOWN';
  return outcomes.reduce((worst, outcome) =>
    RESTRICTIVENESS[outcome] > RESTRICTIVENESS[worst] ? outcome : worst,
  );
}

/**
 * Risk classes for company operations.
 *
 * Deliberately not Adericel's `ActionRiskClass`. Sending an email to a prospect
 * carries reputational and regulatory risk and changes nothing technical;
 * `DISRUPTIVE` would be the wrong word for it and the wrong ceiling.
 */
export const OPERATION_RISK_CLASSES = [
  /** Reads and internal record-keeping. No external effect. */
  'INTERNAL',
  /** Leaves the company: an email, a published page, a message to a customer. */
  'OUTWARD_FACING',
  /** Money moves, or a commercial obligation is created. */
  'FINANCIAL',
  /** A contractual or legal position is taken. */
  'CONTRACTUAL',
  /** A production system or a customer environment changes. */
  'OPERATIONAL_CHANGE',
  /** Cannot be undone: a deletion, a send, a payment, a public statement. */
  'IRREVERSIBLE',
] as const;
export type OperationRiskClass = (typeof OPERATION_RISK_CLASSES)[number];

export const operationRiskClassSchema = z.enum(OPERATION_RISK_CLASSES);

export const OPERATION_RISK_RANK: Record<OperationRiskClass, number> = {
  INTERNAL: 0,
  OUTWARD_FACING: 1,
  FINANCIAL: 2,
  CONTRACTUAL: 3,
  OPERATIONAL_CHANGE: 3,
  IRREVERSIBLE: 4,
};

export interface AutonomyCheck {
  readonly check: string;
  readonly outcome: AutonomyOutcome;
  readonly detail: string;
}

export interface AutonomyDecision {
  readonly outcome: AutonomyOutcome;
  readonly reason: string;
  readonly matchedRuleId: string | null;
  readonly policyKey: string;
  readonly policyHash: string;
  /** Every check that ran, in order, so the decision can be shown to a person. */
  readonly evaluation: readonly AutonomyCheck[];
  /** Approvals needed when the outcome is REQUIRE_APPROVAL. */
  readonly requiredApprovals: number;
  /** Who must be found when the outcome is ESCALATE or UNKNOWN. */
  readonly requiredAuthority: string;
}
