import { z } from 'zod';
import type { Permission } from './authz.js';

/**
 * Break-glass: emergency access that leaves a mark.
 *
 * Contract v3.1 §28 and §30. Veylith holds no standing authority over any
 * customer organisation — support access is explicit, scoped and time-limited.
 * That is correct, and it leaves a gap: when something is genuinely on fire at
 * 3am, an operator needs in, and if the product has no route they will use the
 * database. Unattributed, unscoped, untimed, and invisible.
 *
 * THE DESIGN CHOICE THAT MATTERS
 *
 * Break-glass is deliberately SELF-SERVICE. One person can invoke it alone.
 *
 * That looks weaker than requiring a second approver, and it is the stronger
 * design, because a control that is hard to use in an emergency does not get
 * used in an emergency — it gets bypassed, and the bypass has no controls at
 * all. Four-eyes on emergency access produces one of two outcomes: the operator
 * waits while the incident worsens, or somebody keeps a shared database
 * password for exactly this. Both are worse than a single named person opening
 * a door that announces itself.
 *
 * So the cost is moved from "hard to obtain" to "impossible to hide":
 *
 *   short          minutes to hours, never days, and it cannot be extended
 *   scoped         one organisation, and only the permissions asked for
 *   justified      a sentence, recorded verbatim, before the door opens
 *   announced      the MSP whose customer it is finds out, immediately
 *   attributed     every action taken under it is tagged with the grant
 *   reviewed       mandatory afterwards, whether or not it was warranted
 *
 * A door anyone may open, that cannot be opened quietly, is safer than a door
 * with a lock everybody has learned to go around.
 */

export const BREAK_GLASS_REASONS = [
  /** An active security incident on this estate. */
  'SECURITY_INCIDENT',
  /** Assurance is broken in a way the customer cannot resolve themselves. */
  'SERVICE_FAILURE',
  /** Data-protection obligation requiring immediate action. */
  'LEGAL_OBLIGATION',
  /** Recovering an estate after containment or data loss. */
  'RECOVERY',
  /** A customer has explicitly asked Veylith to look, in writing. */
  'CUSTOMER_REQUEST',
] as const;
export type BreakGlassReason = (typeof BREAK_GLASS_REASONS)[number];
export const breakGlassReasonSchema = z.enum(BREAK_GLASS_REASONS);

/**
 * The longest a break-glass grant may live.
 *
 * Four hours. Long enough to work an incident; short enough that nobody treats
 * it as access. It cannot be extended — a second grant is another decision,
 * another justification and another notification, which is the point. Extension
 * would let one 3am decision quietly become a week of standing access.
 */
export const MAX_BREAK_GLASS_MINUTES = 240;
export const DEFAULT_BREAK_GLASS_MINUTES = 60;

/** The shortest justification that is a sentence rather than a shrug. */
export const MINIMUM_BREAK_GLASS_JUSTIFICATION = 30;

/**
 * Permissions break-glass may never confer.
 *
 * Emergency access is for understanding and repairing an estate, not for
 * changing who can reach it afterwards or what Adericel asserts about it. An
 * operator who needs these has left the territory where speed beats scrutiny.
 */
export const BREAK_GLASS_FORBIDDEN_PERMISSIONS: readonly Permission[] = [
  // Granting authority under emergency authority is how temporary access
  // becomes permanent access, in one step, with a plausible reason.
  'org:member:manage',
  'msp:member:manage',
  'platform:admin',
  /**
   * Executing changes on a customer's external systems.
   *
   * Break-glass is for understanding an estate and repairing Adericel's view of
   * it. Changing the customer's own systems goes through the ordinary action
   * path, where policy, approval and verification by re-observation apply — and
   * those exist precisely for the moments when somebody is certain and in a
   * hurry.
   */
  'org:action:execute',
];

export interface BreakGlassRequest {
  readonly organisationId: string;
  readonly reason: BreakGlassReason;
  readonly justification: string;
  readonly minutes: number;
  readonly permissions: readonly Permission[];
  /** Whether the requester holds a second factor on this session. */
  readonly mfaSatisfied: boolean;
}

export interface BreakGlassGranted {
  readonly permitted: true;
  readonly minutes: number;
  readonly permissions: readonly Permission[];
  /** Everyone who must be told, immediately rather than in a digest. */
  readonly notify: readonly ('MSP_OWNER' | 'VEYLITH_SECURITY')[];
  readonly reviewRequired: true;
}

export interface BreakGlassRefused {
  readonly permitted: false;
  readonly reason: string;
}

export type BreakGlassDecision = BreakGlassGranted | BreakGlassRefused;

export function authoriseBreakGlass(request: BreakGlassRequest): BreakGlassDecision {
  /**
   * A second factor is required even in an emergency.
   *
   * The one place where friction is worth the delay: break-glass is precisely
   * what a stolen session would be used for, and a password alone opening
   * emergency access to a customer estate turns any credential theft into a
   * tenancy breach.
   */
  if (!request.mfaSatisfied) {
    return {
      permitted: false,
      reason:
        'Break-glass requires a second factor. This is the one control not relaxed under ' +
        'emergency: a stolen session is exactly what would be used to open this door, and a ' +
        'password alone would turn any credential theft into access to a customer estate.',
    };
  }

  if (request.justification.trim().length < MINIMUM_BREAK_GLASS_JUSTIFICATION) {
    return {
      permitted: false,
      reason:
        'Say what is happening, in a sentence. It is recorded verbatim, sent to the MSP whose ' +
        'customer this is, and read again in the review — and a reason written afterwards is ' +
        'never the reason.',
    };
  }

  if (request.minutes < 1 || request.minutes > MAX_BREAK_GLASS_MINUTES) {
    return {
      permitted: false,
      reason:
        `Break-glass lasts between 1 and ${MAX_BREAK_GLASS_MINUTES} minutes and cannot be ` +
        'extended. If an incident outlives it, opening a second grant is another decision with ' +
        'another justification — which is deliberate, and is what stops one night becoming a ' +
        'standing arrangement.',
    };
  }

  if (request.permissions.length === 0) {
    return {
      permitted: false,
      reason:
        'Name the permissions needed. Emergency access to everything is standing access with a ' +
        'shorter expiry.',
    };
  }

  const forbidden = request.permissions.filter((p) =>
    BREAK_GLASS_FORBIDDEN_PERMISSIONS.includes(p),
  );
  if (forbidden.length > 0) {
    return {
      permitted: false,
      reason:
        `Break-glass cannot confer ${forbidden.join(', ')}. Emergency access is for ` +
        'understanding and repairing an estate, not for changing who can reach it afterwards. ' +
        'Anyone who needs these has left the territory where speed beats scrutiny.',
    };
  }

  return {
    permitted: true,
    minutes: request.minutes,
    permissions: request.permissions,
    // The MSP owns this customer relationship and finds out that their supplier
    // went into their customer's estate — at the time, not from an audit log
    // later. Anything else is a relationship problem waiting to happen.
    notify: ['MSP_OWNER', 'VEYLITH_SECURITY'],
    reviewRequired: true,
  };
}

/** Whether a grant is still live at a given instant. */
export function isLive(
  grant: { readonly expiresAt: string; readonly revokedAt: string | null },
  nowIso: string,
): boolean {
  if (grant.revokedAt !== null) return false;
  return Date.parse(grant.expiresAt) > Date.parse(nowIso);
}
