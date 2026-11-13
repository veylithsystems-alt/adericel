import { SUPPORT_STAGES, type SupportStage } from '@adericel/domain';
import { SUPPORT_CASE_STATES, type SupportCaseState } from './case.js';

/**
 * Where each support case state sits in the lifecycle the contract states.
 *
 * WHY THIS EXISTS
 *
 * §20–26 states a seven-stage support lifecycle:
 *
 *   RECEIVED → TRIAGED → INVESTIGATING → ACTION_REQUIRED →
 *   VERIFICATION_PENDING → RESOLVED → CLOSED
 *
 * This system carries twenty states. Three of the contract's names exist here
 * verbatim; four do not. Until this module, **nothing stated the
 * correspondence**, so neither the contract's author nor an auditor could tell
 * a deliberate refinement from a stage that had been quietly dropped. That was
 * half of RR-080; the execution lifecycle is the other half, mapped in
 * `@adericel/domain`'s `contract-lifecycle.ts`.
 *
 * WHY A TOTAL RECORD RATHER THAN A FUNCTION
 *
 * `Record<SupportCaseState, …>` with no index signature and no default: adding
 * a twenty-first state is a compile error until somebody decides which stage of
 * the contract's lifecycle it belongs to. A `switch` with a `default`, or a
 * lookup returning `undefined`, would let a new state arrive unassigned and
 * nothing would say so — which is how the correspondence went unstated for
 * three weeks in the first place.
 *
 * WHERE THE SHAPES GENUINELY DIFFER
 *
 * Said here rather than smoothed over, because a mapping that pretends to be
 * exact is worse than one that names its seams:
 *
 *   - The contract names `TRIAGED`, the completed form. This system names
 *     `TRIAGING`, the activity, and then names triage's *outcome* separately
 *     (`ROUTED_TO_MSP`, `QUEUED`). All three are one contract stage.
 *   - `IDENTITY_PENDING` and `ENTITLEMENT_PENDING` precede triage. The contract
 *     has no stage for "arrived, and we do not yet know who this is", so they
 *     belong to `RECEIVED`.
 *   - The contract's `ACTION_REQUIRED` does not say *whose* action. This system
 *     distinguishes four, because "waiting on the customer" and "waiting on the
 *     vendor" are different operational facts with different remedies.
 *   - `RESOLUTION_PROPOSED` and `AWAITING_VERIFICATION` are two moments the
 *     contract collapses into `VERIFICATION_PENDING`: a proposal nobody has
 *     accepted, and an acceptance nobody has confirmed.
 *   - `WITHDRAWN` and `REJECTED` map to **no stage at all**, deliberately. The
 *     contract's lifecycle is a path to resolution and these are endings that
 *     are not resolutions. Recording either as `RESOLVED` or `CLOSED` would
 *     make a case that was refused indistinguishable from one that was fixed,
 *     which is the single thing the support state set exists to prevent.
 */
export const STAGE_OF_CASE_STATE: Readonly<Record<SupportCaseState, SupportStage | null>> = {
  // Arrival
  RECEIVED: 'RECEIVED',
  IDENTITY_PENDING: 'RECEIVED',
  ENTITLEMENT_PENDING: 'RECEIVED',
  TRIAGING: 'TRIAGED',
  // Ownership — triage's outcome, which the contract does not separate
  ROUTED_TO_MSP: 'TRIAGED',
  QUEUED: 'TRIAGED',
  IN_PROGRESS: 'INVESTIGATING',
  // Waiting — the contract's ACTION_REQUIRED, with whose action named
  AWAITING_CUSTOMER: 'ACTION_REQUIRED',
  AWAITING_MSP: 'ACTION_REQUIRED',
  AWAITING_VENDOR: 'ACTION_REQUIRED',
  AWAITING_CHANGE: 'ACTION_REQUIRED',
  // Specialist handling is still investigation, by somebody else
  SECURITY_REVIEW: 'INVESTIGATING',
  PRIVACY_REVIEW: 'INVESTIGATING',
  COMMERCIAL_REVIEW: 'INVESTIGATING',
  // Resolution
  RESOLUTION_PROPOSED: 'VERIFICATION_PENDING',
  AWAITING_VERIFICATION: 'VERIFICATION_PENDING',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
  // Endings that are not resolutions, and must not be recorded as one
  WITHDRAWN: null,
  REJECTED: null,
};

/**
 * The states that belong to no stage of the contract's lifecycle.
 *
 * Returned rather than asserted empty. These two are deliberate and the reason
 * is above; a third appearing is a decision somebody skipped.
 */
export function caseStatesOutsideTheLifecycle(): readonly SupportCaseState[] {
  return SUPPORT_CASE_STATES.filter((state) => STAGE_OF_CASE_STATE[state] === null);
}

/**
 * Stages of the stated lifecycle that no state of this system occupies.
 *
 * Non-empty means a stage the contract requires has been dropped — the finding
 * this module was written to make impossible to miss.
 */
export function unoccupiedSupportStages(): readonly SupportStage[] {
  return SUPPORT_STAGES.filter(
    (stage) => !SUPPORT_CASE_STATES.some((state) => STAGE_OF_CASE_STATE[state] === stage),
  );
}

/** Every state occupying one stage, in the order the state set declares them. */
export function caseStatesInStage(stage: SupportStage): readonly SupportCaseState[] {
  return SUPPORT_CASE_STATES.filter((state) => STAGE_OF_CASE_STATE[state] === stage);
}
