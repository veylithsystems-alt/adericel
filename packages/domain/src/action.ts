import { z } from 'zod';

/**
 * Controlled autonomous action.
 *
 * The lifecycle is explicit and one-directional. Nothing skips policy
 * evaluation, and nothing reaches EXECUTED without an execution record and a
 * verification attempt. "The action was issued" and "the desired state now
 * holds" are different facts and the model keeps them apart.
 */
export const ACTION_STATES = [
  'PROPOSED',
  'POLICY_EVALUATED',
  'REJECTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'AUTHORISED',
  'EXECUTING',
  'EXECUTED',
  'VERIFYING',
  'CONFIRMED',
  'UNVERIFIED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'ROLLBACK_REQUIRED',
  'ROLLED_BACK',
] as const;

export type ActionState = (typeof ACTION_STATES)[number];
export const actionStateSchema = z.enum(ACTION_STATES);

/** Terminal states: no further transition is permitted. */
export const TERMINAL_ACTION_STATES: readonly ActionState[] = [
  'REJECTED',
  'CONFIRMED',
  'UNVERIFIED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'ROLLED_BACK',
];

export function isTerminalActionState(state: ActionState): boolean {
  return TERMINAL_ACTION_STATES.includes(state);
}

/**
 * The legal transition graph. Encoded as data so it can be tested exhaustively
 * and rendered in the UI, and so no code path can invent a transition.
 */
export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  PROPOSED: ['POLICY_EVALUATED', 'CANCELLED'],
  POLICY_EVALUATED: ['REJECTED', 'AWAITING_APPROVAL', 'AUTHORISED', 'CANCELLED'],
  REJECTED: [],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED', 'TIMED_OUT'],
  APPROVED: ['AUTHORISED', 'CANCELLED'],
  AUTHORISED: ['EXECUTING', 'CANCELLED'],
  EXECUTING: ['EXECUTED', 'FAILED', 'TIMED_OUT', 'ROLLBACK_REQUIRED'],
  EXECUTED: ['VERIFYING'],
  VERIFYING: ['CONFIRMED', 'UNVERIFIED', 'ROLLBACK_REQUIRED', 'TIMED_OUT'],
  CONFIRMED: [],
  UNVERIFIED: [],
  FAILED: [],
  TIMED_OUT: [],
  CANCELLED: [],
  ROLLBACK_REQUIRED: ['ROLLED_BACK', 'FAILED'],
  ROLLED_BACK: [],
};

export function canTransition(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal action transition ${from} -> ${to}`);
  }
}

/** Risk class of an action, used by policy to decide approval requirements. */
export const ACTION_RISK_CLASSES = ['READ_ONLY', 'LOW_IMPACT', 'CONFIGURATION', 'DISRUPTIVE', 'DESTRUCTIVE'] as const;
export type ActionRiskClass = (typeof ACTION_RISK_CLASSES)[number];
export const actionRiskClassSchema = z.enum(ACTION_RISK_CLASSES);

export const ACTION_RISK_RANK: Record<ActionRiskClass, number> = {
  READ_ONLY: 0,
  LOW_IMPACT: 1,
  CONFIGURATION: 2,
  DISRUPTIVE: 3,
  DESTRUCTIVE: 4,
};

export interface ActionRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  /** Identifies the executable capability, e.g. `entra.user.require_mfa`. */
  readonly actionType: string;
  readonly integrationId: string | null;
  readonly targetNodeId: string | null;
  readonly targetExternalId: string | null;
  readonly parameters: Record<string, unknown>;
  readonly riskClass: ActionRiskClass;
  readonly state: ActionState;
  readonly findingId: string | null;
  readonly riskId: string | null;
  readonly proposedByActor: string;
  readonly proposalRationale: string;
  /** Which policy authorised (or refused) the action, and at what autonomy level. */
  readonly policyId: string | null;
  readonly policyDecision: Record<string, unknown> | null;
  readonly autonomyLevel: number | null;
  readonly approvalId: string | null;
  /** Caller-supplied or derived key that makes execution exactly-once. */
  readonly idempotencyKey: string;
  /** Identifier returned by the external system, used for reconciliation. */
  readonly externalOperationRef: string | null;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly verificationId: string | null;
  readonly correlationId: string | null;
  readonly proposedAt: string;
  readonly authorisedAt: string | null;
  readonly executedAt: string | null;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const actionProposalSchema = z.object({
  actionType: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/, 'Action type must be a dotted lowercase namespace'),
  integrationId: z.string().uuid().nullable().optional(),
  targetNodeId: z.string().uuid().nullable().optional(),
  targetExternalId: z.string().max(512).nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  findingId: z.string().uuid().nullable().optional(),
  riskId: z.string().uuid().nullable().optional(),
  rationale: z.string().min(1).max(4000),
  idempotencyKey: z.string().min(8).max(200).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export type ActionProposal = z.infer<typeof actionProposalSchema>;

export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * Human approval record.
 *
 * `approverUserId` is always a real user. Adericel never records a machine or
 * an AI as an approver; four-eyes control is meaningless if it can be
 * satisfied by the same system that proposed the action.
 */
export interface ApprovalRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly actionId: string;
  readonly requiredApprovals: number;
  readonly decision: ApprovalDecision | null;
  readonly approverUserId: string | null;
  readonly approverNote: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export const approvalDecisionSchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  note: z.string().max(2000).optional(),
});

export const VERIFICATION_OUTCOMES = ['CONFIRMED', 'REFUTED', 'INCONCLUSIVE'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];
export const verificationOutcomeSchema = z.enum(VERIFICATION_OUTCOMES);

/**
 * Verification re-observes the external system after an action. INCONCLUSIVE is
 * a genuine outcome and maps the action to UNVERIFIED — never to success.
 */
export interface VerificationRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly nodeId: string;
  readonly actionId: string | null;
  readonly claimId: string | null;
  readonly method: string;
  readonly outcome: VerificationOutcome;
  readonly detail: string;
  readonly observationIds: readonly string[];
  readonly evidenceId: string | null;
  readonly attempt: number;
  readonly verifiedAt: string;
  readonly createdAt: string;
}

export function actionStateForVerification(outcome: VerificationOutcome): ActionState {
  switch (outcome) {
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'REFUTED':
      return 'ROLLBACK_REQUIRED';
    case 'INCONCLUSIVE':
      return 'UNVERIFIED';
  }
}
