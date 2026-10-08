import { z } from 'zod';
import { ACTION_STATES, type ActionState } from './action.js';

/**
 * The lifecycles the contract states, and how this system realises them.
 *
 * Contract v3.2 names two sequences that bear directly on code: the
 * authoritative execution lifecycle (§3.6 VERIFY) and the support lifecycle
 * (§20–26). Both are quoted here verbatim, and every state this system actually
 * has is mapped onto them.
 *
 * WHY THIS MODULE EXISTS AT ALL
 *
 * These eight sequences were recorded in this repository as *missing from the
 * contract* for several days, because two hand-rolled PDF readers could not
 * decode them and the second failure was treated as corroboration of the first.
 * A real library read them immediately. The lesson is written into
 * `docs/contract/README.md`, and this module is the other half of it:
 * conformance to a stated lifecycle is now something the build checks rather
 * than something a document asserts.
 *
 * WHY A MAPPING AND NOT A RENAME
 *
 * The contract's stages are coarser than the states this system needs. An MSP
 * working a support queue has to distinguish "waiting on the customer" from
 * "waiting on the vendor", and the contract's single `ACTION_REQUIRED` cannot.
 * Renaming the operational states to match would destroy the distinctions the
 * queues are built on; mapping proves conformance while keeping them.
 *
 * WHAT THIS MODULE WILL NOT DO
 *
 * It will not claim a stage is realised because something nearby exists. A
 * stage realised by a stored property rather than a state transition says so,
 * and a stage nothing realises is reported as `NOT_REALISED` — which is a
 * finding for the risk register, not a thing to smooth over.
 */

/** §3.6: "The authoritative lifecycle is: …" */
export const EXECUTION_STAGES = [
  'INTENT',
  'POLICY',
  'AUTHORISATION',
  'RISK',
  'ACTION',
  'RE_OBSERVE',
  'VERIFY',
  'EVIDENCE',
] as const;
export type ExecutionStage = (typeof EXECUTION_STAGES)[number];
export const executionStageSchema = z.enum(EXECUTION_STAGES);

/** §20–26: "Support lifecycle: …" */
export const SUPPORT_STAGES = [
  'RECEIVED',
  'TRIAGED',
  'INVESTIGATING',
  'ACTION_REQUIRED',
  'VERIFICATION_PENDING',
  'RESOLVED',
  'CLOSED',
] as const;
export type SupportStage = (typeof SUPPORT_STAGES)[number];

/** How a stated stage is actually realised in this system. */
export const REALISATIONS = [
  /** A state the entity passes through, visible in its transition history. */
  'STATE',
  /**
   * A property recorded on the entity rather than a state it occupies.
   *
   * Legitimate and worth distinguishing: the contract names RISK as a stage,
   * and this system evaluates risk as a classification carried by the action
   * from proposal onwards rather than as a moment it passes through. The
   * obligation is met; the shape differs, and saying so is cheaper than
   * pretending otherwise.
   */
  'PROPERTY',
  /** An artefact written as a consequence, rather than a state or a field. */
  'ARTEFACT',
  /** Nothing in this system realises it. A finding. */
  'NOT_REALISED',
] as const;
export type Realisation = (typeof REALISATIONS)[number];

export interface StageRealisation {
  readonly realisation: Realisation;
  /** What specifically realises it. Never a restatement of the stage name. */
  readonly by: string;
  /**
   * The action states that belong to this stage, where it is realised as one.
   *
   * Empty for PROPERTY and ARTEFACT stages, which is why the totality check
   * runs the other way round — from every action state to its stage — rather
   * than from stages to states.
   */
  readonly actionStates: readonly ActionState[];
}

export const EXECUTION_REALISATION: Readonly<Record<ExecutionStage, StageRealisation>> = {
  INTENT: {
    realisation: 'STATE',
    by: 'An action is proposed, by a person or by a connector capability, before anything evaluates it.',
    actionStates: ['PROPOSED'],
  },
  POLICY: {
    realisation: 'STATE',
    by: 'The policy engine evaluates the proposal and the result is recorded as a state, so a refusal is as durable as a permission.',
    actionStates: ['POLICY_EVALUATED', 'REJECTED'],
  },
  AUTHORISATION: {
    realisation: 'STATE',
    by: 'Approval and authorisation are separate states: approval is a human decision, authorisation is the system accepting it. Adericel never approves its own actions.',
    actionStates: ['AWAITING_APPROVAL', 'APPROVED', 'AUTHORISED'],
  },
  RISK: {
    realisation: 'PROPERTY',
    by: '`riskClass` on the action, from READ_ONLY to DESTRUCTIVE, set when the action is proposed and used by the policy and autonomy engines. It is carried throughout rather than passed through once, because a DESTRUCTIVE action is still destructive at the moment of execution — a stage would let the classification go stale between evaluation and act.',
    actionStates: [],
  },
  ACTION: {
    realisation: 'STATE',
    by: 'Execution is two states, not one. `EXECUTING` is a dispatch that has not returned, which is the state an outcome gets lost in — and the contract is explicit that dispatch is never success.',
    actionStates: ['EXECUTING', 'EXECUTED', 'FAILED', 'TIMED_OUT', 'CANCELLED'],
  },
  RE_OBSERVE: {
    realisation: 'STATE',
    by: 'The estate is read again after execution rather than the result being inferred from the dispatch response.',
    actionStates: ['VERIFYING'],
  },
  VERIFY: {
    realisation: 'STATE',
    by: '`CONFIRMED` and `UNVERIFIED` are both terminal. An outcome that could not be established stays explicitly unestablished and enters reconciliation; it never decays into success.',
    actionStates: ['CONFIRMED', 'UNVERIFIED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'],
  },
  EVIDENCE: {
    realisation: 'ARTEFACT',
    by: "Re-observation writes a claim with origin `VERIFICATION_DERIVED`, whose truth state is `VERIFIED` — the only origin that reaches that state. The evidence is a record produced by the lifecycle rather than a stage within it, which is what makes an action's outcome auditable after the action object itself is archived.",
    actionStates: [],
  },
};

/**
 * Every action state's stage. Derived from `EXECUTION_REALISATION` rather than
 * written twice, because two statements of one mapping drift.
 */
export const STAGE_OF_ACTION_STATE: Readonly<Record<ActionState, ExecutionStage | null>> =
  Object.fromEntries(
    ACTION_STATES.map((state) => [
      state,
      (EXECUTION_STAGES.find((stage) =>
        EXECUTION_REALISATION[stage].actionStates.includes(state),
      ) ?? null) satisfies ExecutionStage | null,
    ]),
  ) as Readonly<Record<ActionState, ExecutionStage | null>>;

/**
 * Action states no stage claims.
 *
 * Reported rather than assumed empty. A state added without deciding which
 * stage of the contract's lifecycle it belongs to is exactly the drift this
 * module exists to catch, and it would otherwise be invisible.
 */
export function unmappedActionStates(): readonly ActionState[] {
  return ACTION_STATES.filter((state) => STAGE_OF_ACTION_STATE[state] === null);
}

/** Stages nothing in this system realises. */
export function unrealisedExecutionStages(): readonly ExecutionStage[] {
  return EXECUTION_STAGES.filter(
    (stage) => EXECUTION_REALISATION[stage].realisation === 'NOT_REALISED',
  );
}
