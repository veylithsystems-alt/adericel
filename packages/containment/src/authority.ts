import { z } from 'zod';
import { definitionOf, isAtLeast, type ContainmentLevel, type ContainmentScope } from './level.js';
import { profileOf, type ContainmentTrigger } from './trigger.js';

/**
 * Who may contain, and how far.
 *
 * The design question v3.1 §15 forces before anything is built: pure
 * Veylith-only authority is too slow, because the MSP is the one watching their
 * own customers at 3am; pure automation is too dangerous, because a false
 * positive is an outage Adericel caused.
 *
 * The answer here is graduated, and it follows the same logic as the autonomy
 * levels: authority is earned per level, not held in general.
 *
 *   AUTOMATIC   May reach C2. Enough to stop using a compromised credential,
 *               not enough to restrict what a customer can do.
 *   MSP         May reach C3 over its own customers. It owns that
 *               relationship, it answers for that estate, and it will be
 *               awake before Veylith is.
 *   VEYLITH     May reach C5, over anything. Platform-wide protection is not
 *               an MSP's to declare, because it affects every other MSP.
 *
 * Nobody may contain an estate they have no relationship with. That is checked
 * here AND by row-level security; this is the layer that can explain why.
 */

export const CONTAINMENT_ACTORS = ['AUTOMATIC', 'MSP', 'VEYLITH'] as const;
export type ContainmentActor = (typeof CONTAINMENT_ACTORS)[number];
export const containmentActorSchema = z.enum(CONTAINMENT_ACTORS);

/** The highest level each actor may apply. */
export const AUTHORITY_CEILING: Readonly<Record<ContainmentActor, ContainmentLevel>> = {
  AUTOMATIC: 'C2',
  MSP: 'C3',
  VEYLITH: 'C5',
};

export interface ContainmentRequest {
  readonly actor: ContainmentActor;
  readonly level: ContainmentLevel;
  readonly scope: ContainmentScope;
  readonly trigger: ContainmentTrigger;
  /**
   * Whether the actor holds a relationship with the estate being contained.
   *
   * Resolved from grants by the caller, never from anything the caller was
   * told. An MSP may contain its own customer and no one else's.
   */
  readonly actorGovernsTarget: boolean;
  /** Why. Recorded verbatim; a containment with no stated reason is not one. */
  readonly justification: string;
}

export interface ContainmentAuthorised {
  readonly permitted: true;
  readonly level: ContainmentLevel;
  readonly requiresHumanReview: boolean;
}

export interface ContainmentRefused {
  readonly permitted: false;
  readonly reason: string;
  /** The highest level this actor could have applied, if any. */
  readonly permittedCeiling: ContainmentLevel;
}

export type ContainmentDecision = ContainmentAuthorised | ContainmentRefused;

/** The shortest justification that is a sentence rather than a shrug. */
export const MINIMUM_JUSTIFICATION_LENGTH = 20;

export function authoriseContainment(request: ContainmentRequest): ContainmentDecision {
  const ceiling = AUTHORITY_CEILING[request.actor];
  const definition = definitionOf(request.level);

  if (!request.actorGovernsTarget) {
    return {
      permitted: false,
      reason:
        'This actor holds no relationship with the estate it is trying to contain. Containment ' +
        'is an operational authority over a customer, not a capability anybody with access to ' +
        'the API has.',
      permittedCeiling: 'C0',
    };
  }

  if (isAtLeast(request.level, ceiling) && request.level !== ceiling) {
    return {
      permitted: false,
      reason:
        `${request.actor} may contain up to ${ceiling}. ${request.level} reaches further than ` +
        'this actor’s authority, and containment beyond authority is the failure mode this ' +
        'model exists to prevent.',
      permittedCeiling: ceiling,
    };
  }

  if (!definition.appliesTo.includes(request.scope)) {
    return {
      permitted: false,
      reason:
        `${request.level} cannot be applied at ${request.scope} scope. It is defined for ` +
        `${definition.appliesTo.join(' or ')}, and stretching a level to a scope it was not ` +
        'designed for produces containment nobody can reason about.',
      permittedCeiling: ceiling,
    };
  }

  if (request.actor === 'AUTOMATIC') {
    if (!definition.automaticEntryPermitted) {
      return {
        permitted: false,
        reason:
          `${request.level} restricts what a customer can do, so a person decides. Automation ` +
          'raises the signal; it does not apply the restriction.',
        permittedCeiling: 'C2',
      };
    }
    if (!profileOf(request.trigger).automaticEntryPermitted) {
      return {
        permitted: false,
        reason:
          `${request.trigger} is not a signal Adericel acts on unattended. It is either ` +
          'ambiguous enough to produce false positives, or expensive enough to reverse that a ' +
          'person should weigh it.',
        permittedCeiling: 'C0',
      };
    }
  }

  if (request.justification.trim().length < MINIMUM_JUSTIFICATION_LENGTH) {
    return {
      permitted: false,
      reason:
        'A containment must say why, in a sentence somebody can read during the incident and ' +
        'again in the review afterwards. This is the record of a decision, and a decision with ' +
        'no stated reason cannot be reviewed.',
      permittedCeiling: ceiling,
    };
  }

  return {
    permitted: true,
    level: request.level,
    // Everything automatic gets looked at by a person, even where it was
    // correct. Unreviewed automatic restriction is how a system quietly
    // develops a habit nobody chose.
    requiresHumanReview: request.actor === 'AUTOMATIC' || isAtLeast(request.level, 'C3'),
  };
}

/**
 * The least disruptive level that actually addresses a trigger.
 *
 * Containment that reaches further than the threat is itself a harm, and §15
 * requires the least-disruptive response. This returns the floor, not a
 * recommendation to stop there: an operator with more context may go higher,
 * and the authority check above decides whether they may.
 */
export function leastDisruptiveLevel(trigger: ContainmentTrigger): ContainmentLevel {
  return profileOf(trigger).minimumLevel;
}
