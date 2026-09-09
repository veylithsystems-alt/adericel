import { z } from 'zod';
import { ACTION_RISK_RANK, type ActionRiskClass } from './action.js';

/**
 * Autonomy is graduated and earned, never binary.
 *
 * Each level is defined by what Adericel is permitted to do without a human in
 * the loop. Levels are configured per organisation and per action type, so an
 * MSP can run L4 for "disable a dormant account" while remaining at L3 for
 * anything that touches production network configuration.
 */
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const autonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export interface AutonomyLevelDefinition {
  readonly level: AutonomyLevel;
  readonly name: string;
  readonly description: string;
  readonly mayPropose: boolean;
  readonly mayPrepare: boolean;
  readonly mayExecuteWithApproval: boolean;
  readonly mayExecuteWithoutApproval: boolean;
  readonly requiresVerification: boolean;
}

export const AUTONOMY_DEFINITIONS: Readonly<Record<AutonomyLevel, AutonomyLevelDefinition>> = {
  0: {
    level: 0,
    name: 'Observe',
    description: 'Collect and assess only. Adericel proposes nothing.',
    mayPropose: false,
    mayPrepare: false,
    mayExecuteWithApproval: false,
    mayExecuteWithoutApproval: false,
    requiresVerification: false,
  },
  1: {
    level: 1,
    name: 'Suggest',
    description: 'Adericel may propose remediation for a human to carry out elsewhere.',
    mayPropose: true,
    mayPrepare: false,
    mayExecuteWithApproval: false,
    mayExecuteWithoutApproval: false,
    requiresVerification: false,
  },
  2: {
    level: 2,
    name: 'Prepare',
    description: 'Adericel may stage an executable change but never dispatch it.',
    mayPropose: true,
    mayPrepare: true,
    mayExecuteWithApproval: false,
    mayExecuteWithoutApproval: false,
    requiresVerification: false,
  },
  3: {
    level: 3,
    name: 'Human-approved execution',
    description: 'Adericel executes after explicit human approval, then verifies.',
    mayPropose: true,
    mayPrepare: true,
    mayExecuteWithApproval: true,
    mayExecuteWithoutApproval: false,
    requiresVerification: true,
  },
  4: {
    level: 4,
    name: 'Policy-authorised autonomous execution',
    description:
      'Adericel executes without per-action approval where a policy explicitly authorises this action type, then verifies.',
    mayPropose: true,
    mayPrepare: true,
    mayExecuteWithApproval: true,
    mayExecuteWithoutApproval: true,
    requiresVerification: true,
  },
  5: {
    level: 5,
    name: 'Verified autonomous operation',
    description:
      'As level 4, with continuous re-verification and automatic rollback on refutation.',
    mayPropose: true,
    mayPrepare: true,
    mayExecuteWithApproval: true,
    mayExecuteWithoutApproval: true,
    requiresVerification: true,
  },
};

/**
 * Maximum autonomy permitted for a given risk class, regardless of
 * configuration. This is a hard ceiling: a destructive action can never be
 * fully autonomous, because no policy expression is worth an unrecoverable
 * change to a customer's environment.
 */
export const AUTONOMY_CEILING_BY_RISK: Readonly<Record<ActionRiskClass, AutonomyLevel>> = {
  READ_ONLY: 5,
  LOW_IMPACT: 5,
  CONFIGURATION: 4,
  DISRUPTIVE: 3,
  DESTRUCTIVE: 3,
};

export function effectiveAutonomy(
  configured: AutonomyLevel,
  riskClass: ActionRiskClass,
): AutonomyLevel {
  const ceiling = AUTONOMY_CEILING_BY_RISK[riskClass];
  return (configured < ceiling ? configured : ceiling) as AutonomyLevel;
}

export function requiresHumanApproval(
  configured: AutonomyLevel,
  riskClass: ActionRiskClass,
): boolean {
  const level = effectiveAutonomy(configured, riskClass);
  const definition = AUTONOMY_DEFINITIONS[level];
  if (!definition.mayExecuteWithApproval) return true;
  if (definition.mayExecuteWithoutApproval) return false;
  return true;
}

export function canExecuteAtAll(configured: AutonomyLevel, riskClass: ActionRiskClass): boolean {
  const level = effectiveAutonomy(configured, riskClass);
  return AUTONOMY_DEFINITIONS[level].mayExecuteWithApproval;
}

/** Higher-risk actions need more approvers. */
export function defaultRequiredApprovals(riskClass: ActionRiskClass): number {
  return ACTION_RISK_RANK[riskClass] >= ACTION_RISK_RANK.DISRUPTIVE ? 2 : 1;
}
