import { z } from 'zod';
import { definitionOf, isAtLeast, type ContainmentLevel } from './level.js';
import { AUTHORITY_CEILING, type ContainmentActor } from './authority.js';

/**
 * Coming back out.
 *
 * Recovery is harder than containment and is treated that way. Containment is a
 * judgement made under pressure with incomplete information; recovery is a
 * statement that the thing which caused it is genuinely dealt with. The second
 * deserves more scrutiny than the first, which is the opposite of how most
 * systems behave — they make it easy to undo an inconvenient restriction.
 *
 * Contract v3.1 §15: no automatic recovery from C3, C4 or C5.
 */

export const RESOLUTION_KINDS = [
  /** The cause was found and fixed. */
  'RESOLVED',
  /** The cause was found and its effect limited, but it is not gone. */
  'MITIGATED',
  /** Investigated and found not to be real. */
  'NOT_SUBSTANTIATED',
  /**
   * Understood, still present, and deliberately accepted.
   *
   * Requires a named person. An accepted risk with no owner is an unresolved
   * risk somebody stopped talking about.
   */
  'RISK_ACCEPTED',
] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];
export const resolutionKindSchema = z.enum(RESOLUTION_KINDS);

export interface RecoveryRequest {
  readonly actor: ContainmentActor;
  readonly fromLevel: ContainmentLevel;
  readonly toLevel: ContainmentLevel;
  readonly resolution: ResolutionKind;
  /** What was found. Recorded verbatim in the append-only history. */
  readonly findings: string;
  /** Whether the original trigger condition has been re-observed as clear. */
  readonly reObserved: boolean;
  /** Whether evidence from the containment period is intact and retained. */
  readonly evidencePreserved: boolean;
  /** Named human accepting the residual risk, for RISK_ACCEPTED. */
  readonly riskAcceptedBy: string | null;
  readonly actorGovernsTarget: boolean;
}

export interface RecoveryAuthorised {
  readonly permitted: true;
  readonly toLevel: ContainmentLevel;
  /** Recovery must be re-verified after the fact, not assumed to have worked. */
  readonly verificationRequired: true;
}

export interface RecoveryRefused {
  readonly permitted: false;
  readonly reason: string;
  readonly missing: readonly string[];
}

export type RecoveryDecision = RecoveryAuthorised | RecoveryRefused;

export const MINIMUM_FINDINGS_LENGTH = 30;

export function authoriseRecovery(request: RecoveryRequest): RecoveryDecision {
  const missing: string[] = [];

  if (!request.actorGovernsTarget) {
    return {
      permitted: false,
      reason: 'This actor holds no relationship with the estate it is trying to restore.',
      missing: ['authority over the target'],
    };
  }

  if (!isAtLeast(request.fromLevel, request.toLevel) || request.fromLevel === request.toLevel) {
    return {
      permitted: false,
      reason:
        'Recovery reduces containment. Raising it is a containment decision and goes through ' +
        'the containment path, where the authority ceiling and trigger rules apply.',
      missing: ['a lower target level'],
    };
  }

  /**
   * The rule at the centre of this file.
   *
   * Automation may enter C1 and C2 and may never leave anything. Above C2,
   * nothing leaves without a person — including AUTOMATIC, which is the case
   * that matters: a system able to un-contain itself has no containment, only a
   * pause. It is checked on the level being LEFT rather than the one being
   * entered, because the risk lives in what is being relaxed.
   */
  if (
    request.actor === 'AUTOMATIC' &&
    !definitionOf(request.fromLevel).automaticRecoveryPermitted
  ) {
    return {
      permitted: false,
      reason:
        `Leaving ${request.fromLevel} requires a person. A system that can release its own ` +
        'containment does not have containment; it has a pause.',
      missing: ['a human decision'],
    };
  }

  const ceiling = AUTHORITY_CEILING[request.actor];
  if (isAtLeast(request.fromLevel, ceiling) && request.fromLevel !== ceiling) {
    return {
      permitted: false,
      reason:
        `${request.actor} may act up to ${ceiling}, and this estate is contained at ` +
        `${request.fromLevel}. Whoever was able to impose it is who may lift it.`,
      missing: [`authority for ${request.fromLevel}`],
    };
  }

  if (request.findings.trim().length < MINIMUM_FINDINGS_LENGTH) {
    missing.push('what the investigation actually found');
  }

  // Re-observation is the difference between "we believe it is fixed" and "we
  // looked". §5.5: an action being accepted is not proof the state changed.
  if (!request.reObserved) missing.push('re-observation showing the trigger condition is clear');

  if (!request.evidencePreserved) {
    missing.push('confirmation that evidence from the containment period is intact');
  }

  if (request.resolution === 'RISK_ACCEPTED' && !request.riskAcceptedBy) {
    missing.push('the name of the person accepting the residual risk');
  }

  if (missing.length > 0) {
    return {
      permitted: false,
      reason:
        'Recovery is a statement that the cause is dealt with, and it is recorded permanently. ' +
        'It is refused until the statement is one somebody could defend in a review.',
      missing,
    };
  }

  return { permitted: true, toLevel: request.toLevel, verificationRequired: true };
}

/**
 * Whether a recovery may go straight to C0.
 *
 * From C1 or C2, yes — the thing was narrow and is now clear. From C3 upward,
 * no: an estate that needed operations restricted comes back through C1, where
 * observation resumes and automation stays off, so somebody watches it run
 * before Adericel is trusted to act on it again.
 */
export function mayReturnDirectlyToNormal(fromLevel: ContainmentLevel): boolean {
  return !isAtLeast(fromLevel, 'C3');
}
