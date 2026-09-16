import { z } from 'zod';

/**
 * Governed containment.
 *
 * Containment is not a "suspend customer" button. It is a controlled security
 * state transition that limits harm while preserving evidence, attribution and
 * a route back (contract v3.1 §15).
 *
 * THREE AXES THAT MUST NOT COLLAPSE INTO ONE
 *
 * Adericel keeps commercial entitlement, security containment and assurance
 * state strictly apart:
 *
 *   Commercial    Has this MSP paid? Governs entitlement, never safety.
 *   Containment   Is it safe to keep operating on this estate?
 *   Assurance     Is the control met? PASS/FAIL/UNKNOWN/DEGRADED/BLOCKED.
 *
 * Non-payment is not a security event. A failing control is not a reason to cut
 * somebody off. And a security containment is not a commercial termination.
 * Collapsing any pair produces the same class of mistake: an operational
 * decision made for the wrong reason, to somebody who cannot tell why.
 *
 * THE INVARIANT THAT HOLDS AT EVERY LEVEL
 *
 * Evidence stays readable. At C5, with the whole platform in a protective
 * state, an organisation can still read what Adericel holds about it.
 * Containment exists to stop Adericel doing things, not to stop customers
 * knowing things — and an organisation locked out of its own assurance record
 * during an incident is an organisation that cannot respond to it.
 */

export const CONTAINMENT_LEVELS = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'] as const;
export type ContainmentLevel = (typeof CONTAINMENT_LEVELS)[number];
export const containmentLevelSchema = z.enum(CONTAINMENT_LEVELS);

/** What a containment level applies to. */
export const CONTAINMENT_SCOPES = ['INTEGRATION', 'ORGANISATION', 'PLATFORM'] as const;
export type ContainmentScope = (typeof CONTAINMENT_SCOPES)[number];
export const containmentScopeSchema = z.enum(CONTAINMENT_SCOPES);

export interface ContainmentLevelDefinition {
  readonly level: ContainmentLevel;
  readonly name: string;
  readonly description: string;
  /** Whether Adericel keeps collecting. Observation is usually safe and useful. */
  readonly observationContinues: boolean;
  /** Whether scheduled and autonomous work may run. */
  readonly automationPermitted: boolean;
  /** Whether Adericel may change anything in an external system. */
  readonly externalActionsPermitted: boolean;
  /** Whether the tenant may perform privileged write operations. */
  readonly tenantWritesPermitted: boolean;
  /**
   * Whether an organisation may read the assurance record Adericel holds.
   *
   * True at every level, without exception. See the note above: this is an
   * invariant, and a test asserts it over the whole set rather than trusting
   * that nobody will one day set it false for a good-sounding reason.
   */
  readonly evidenceReadable: boolean;
  /** The narrowest thing this level can be applied to. */
  readonly appliesTo: readonly ContainmentScope[];
  /** Whether Adericel may enter this level without a human deciding. */
  readonly automaticEntryPermitted: boolean;
  /** Whether Adericel may leave this level without a human deciding. */
  readonly automaticRecoveryPermitted: boolean;
}

export const CONTAINMENT_DEFINITIONS: Readonly<
  Record<ContainmentLevel, ContainmentLevelDefinition>
> = {
  C0: {
    level: 'C0',
    name: 'Observe only',
    description:
      'Recorded and being triaged. Nothing is restricted. C0 exists so that a suspicion has ' +
      'somewhere to live before anybody restricts anything — an incident with no C0 is an ' +
      'incident that starts at the point somebody panicked.',
    observationContinues: true,
    automationPermitted: true,
    externalActionsPermitted: true,
    tenantWritesPermitted: true,
    evidenceReadable: true,
    appliesTo: ['INTEGRATION', 'ORGANISATION', 'PLATFORM'],
    automaticEntryPermitted: true,
    automaticRecoveryPermitted: true,
  },
  C1: {
    level: 'C1',
    name: 'Restrict automation',
    description:
      'Adericel stops acting on its own and keeps watching. The cheapest useful containment: ' +
      'it removes the thing most likely to make a bad situation worse — unattended action on a ' +
      'system nobody currently understands — while keeping the observation that explains it.',
    observationContinues: true,
    automationPermitted: false,
    externalActionsPermitted: false,
    tenantWritesPermitted: true,
    evidenceReadable: true,
    appliesTo: ['INTEGRATION', 'ORGANISATION', 'PLATFORM'],
    automaticEntryPermitted: true,
    automaticRecoveryPermitted: false,
  },
  C2: {
    level: 'C2',
    name: 'Isolate integration or credential',
    description:
      'A specific connector, token or credential stops being used. Collection through it stops, ' +
      'and the controls that depended on it become BLOCKED rather than quietly UNKNOWN — the ' +
      'estate has not changed, Adericel has stopped looking at it, and the record says which.',
    observationContinues: false,
    automationPermitted: false,
    externalActionsPermitted: false,
    tenantWritesPermitted: true,
    evidenceReadable: true,
    appliesTo: ['INTEGRATION'],
    automaticEntryPermitted: true,
    automaticRecoveryPermitted: false,
  },
  C3: {
    level: 'C3',
    name: 'Restrict organisation operations',
    description:
      'Privileged write operations on this organisation stop. Reading the assurance record does ' +
      'not. This is the first level that constrains what a customer can do, which is why it is ' +
      'the first that no automatic trigger may reach.',
    observationContinues: false,
    automationPermitted: false,
    externalActionsPermitted: false,
    tenantWritesPermitted: false,
    evidenceReadable: true,
    appliesTo: ['ORGANISATION'],
    automaticEntryPermitted: false,
    automaticRecoveryPermitted: false,
  },
  C4: {
    level: 'C4',
    name: 'Emergency containment',
    description:
      'Immediate action to prevent material harm, across an organisation or the platform. ' +
      'Deliberately blunt and deliberately rare: it is the level chosen when the cost of being ' +
      'wrong is lower than the cost of waiting.',
    observationContinues: false,
    automationPermitted: false,
    externalActionsPermitted: false,
    tenantWritesPermitted: false,
    evidenceReadable: true,
    appliesTo: ['ORGANISATION', 'PLATFORM'],
    automaticEntryPermitted: false,
    automaticRecoveryPermitted: false,
  },
  C5: {
    level: 'C5',
    name: 'Platform protective state',
    description:
      'Adericel stops operating on every estate. Reserved for a threat to tenant isolation, ' +
      'credentials, the supply chain or evidence integrity — the cases where continuing to run ' +
      'correctly for most customers is not worth the risk of running wrongly for one.',
    observationContinues: false,
    automationPermitted: false,
    externalActionsPermitted: false,
    tenantWritesPermitted: false,
    evidenceReadable: true,
    appliesTo: ['PLATFORM'],
    automaticEntryPermitted: false,
    automaticRecoveryPermitted: false,
  },
};

const ORDER: Readonly<Record<ContainmentLevel, number>> = {
  C0: 0,
  C1: 1,
  C2: 2,
  C3: 3,
  C4: 4,
  C5: 5,
};

export function levelRank(level: ContainmentLevel): number {
  return ORDER[level];
}

/** True when `a` restricts at least as much as `b`. */
export function isAtLeast(a: ContainmentLevel, b: ContainmentLevel): boolean {
  return ORDER[a] >= ORDER[b];
}

/**
 * The definition of a level, or a refusal.
 *
 * The guard is not decoration. Types stop at the process boundary, and the
 * value reaching here may have come from a database column, an API body, or —
 * the case that matters — a caller who confused a commercial state for a
 * security one (§16). Without it, `definitionOf('COMMERCIAL_SUSPENSION')`
 * returns `undefined` and the caller crashes one line later on a property
 * read, which reads as a bug in containment rather than as the category error
 * it is.
 *
 * It refuses by name, so the message says what was actually wrong.
 */
export function definitionOf(level: ContainmentLevel): ContainmentLevelDefinition {
  const definition = CONTAINMENT_DEFINITIONS[level];
  if (!definition) {
    throw new Error(
      `${String(level)} is not a containment level. Containment is C0-C5 and is a security ` +
        'state; commercial states (§16) are a separate concern and never map onto one.',
    );
  }
  return definition;
}

/**
 * The most restrictive of several levels in force.
 *
 * An organisation may be contained while one of its integrations is separately
 * contained harder. What actually applies is the stricter of the two: a C1 on
 * the organisation does not re-enable a C2'd connector.
 */
export function effectiveLevel(levels: readonly ContainmentLevel[]): ContainmentLevel {
  return levels.reduce<ContainmentLevel>((worst, l) => (isAtLeast(l, worst) ? l : worst), 'C0');
}
