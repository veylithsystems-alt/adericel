import { z } from 'zod';

/**
 * What state a capability is actually in.
 *
 * Contract v3.1 §6. Nine statuses, in order, with one rule that does all the
 * work: **no status may be inferred from another.**
 *
 * WHY THAT RULE IS THE WHOLE POINT
 *
 * The natural way to build this is a single `status` column and a transition
 * function, and it would be wrong in a specific and expensive way. A column
 * holding `PRODUCTION_READY` says the capability is production ready. It does
 * not say who established that, against what, or when — and the moment the
 * column moves, every status below it reads as satisfied too. That is
 * inference: a test suite passing becomes "verified", "verified" becomes
 * "operational", and four statuses later a document says a capability is
 * commercially validated because somebody once wrote a unit test.
 *
 * This product exists because that kind of drift is what security tooling does
 * to its own claims. So a capability here carries an **independent attestation
 * per status**, each naming its own evidence, and the furthest attested status
 * is reported alongside the earlier ones that were never attested. A skipped
 * status is visible rather than implied.
 */
export const CAPABILITY_STATUSES = [
  /** The design exists and has been written down. Nothing is built. */
  'DESIGNED',
  /** Code exists and does the thing. Nobody has checked that it does. */
  'IMPLEMENTED',
  /** Tests exist and pass. Passing tests prove the tests agree with the code. */
  'TESTED',
  /**
   * The invariant has been proved by deliberately breaking it.
   *
   * Distinct from TESTED, and the distinction is not academic: a test that
   * would still pass with the guard removed proves nothing about the guard.
   */
  'VERIFIED',
  /** It runs in a deployed environment, with its build and probes in CI. */
  'OPERATIONAL',
  /**
   * It has done its job for a real customer, on real data.
   *
   * No automated check can establish this, and the code refuses to let one
   * try. A demo fixture is not a customer.
   */
  'PROVEN',
  /**
   * Fit to carry a customer's assurance position in production.
   *
   * Requires named human sign-off, because the question is "would we stand
   * behind this in a dispute" and no test answers it.
   */
  'PRODUCTION_READY',
  /** Somebody has paid for it and stayed. Also not establishable by a test. */
  'COMMERCIAL_VALIDATED',
  /** Withdrawn. Kept on the record, because history is not editable. */
  'RETIRED',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];
export const capabilityStatusSchema = z.enum(CAPABILITY_STATUSES);

/**
 * Statuses no automated check may establish.
 *
 * Kept as data because it is a refusal, not a guideline. Each of these is a
 * claim about the world outside this repository — a customer used it, a person
 * would stand behind it, somebody paid — and a green pipeline is not evidence
 * of any of them. §42 forbids claiming production readiness without the gates;
 * this is that prohibition in a form the code can enforce.
 */
export const HUMAN_ESTABLISHED_STATUSES: readonly CapabilityStatus[] = [
  'PROVEN',
  'PRODUCTION_READY',
  'COMMERCIAL_VALIDATED',
];

/** How a status came to be attested. */
export const ATTESTATION_SOURCES = [
  /** A named check in this repository: a test file, a CI job, a script. */
  'AUTOMATED_CHECK',
  /** A named person, on the record. */
  'NAMED_PERSON',
] as const;
export type AttestationSource = (typeof ATTESTATION_SOURCES)[number];

export interface StatusAttestation {
  readonly status: CapabilityStatus;
  readonly source: AttestationSource;
  /**
   * What actually establishes it: a path, a command, a customer, a person.
   * Never a restatement of the status — "it is tested" is not evidence that it
   * is tested.
   */
  readonly evidence: string;
  /** ISO 8601. */
  readonly establishedAt: string;
}

export interface Capability {
  readonly key: string;
  readonly title: string;
  readonly attestations: readonly StatusAttestation[];
}

export interface CapabilityPosition {
  readonly key: string;
  readonly title: string;
  /** The furthest attested status, or null when nothing is attested at all. */
  readonly attested: CapabilityStatus | null;
  /**
   * Statuses earlier than `attested` with no attestation of their own.
   *
   * Reported rather than back-filled. A capability attested OPERATIONAL with
   * no VERIFIED attestation has skipped the step where an invariant gets
   * proved, and that is precisely the thing worth seeing.
   */
  readonly skipped: readonly CapabilityStatus[];
  /** Statuses beyond `attested`, in order. What is left to establish. */
  readonly notYetEstablished: readonly CapabilityStatus[];
  /** One sentence for a reader, stating the position without flattering it. */
  readonly statement: string;
}

function order(status: CapabilityStatus): number {
  return CAPABILITY_STATUSES.indexOf(status);
}

/**
 * A capability's position, derived from its attestations and nothing else.
 *
 * Deliberately not a transition function. There is no `advance()` here,
 * because advancing implies the previous status is now settled — which is the
 * inference §6 forbids. The only way a status becomes attested is by somebody
 * recording evidence for that status specifically.
 */
export function positionOf(capability: Capability): CapabilityPosition {
  const attestedStatuses = new Set(capability.attestations.map((a) => a.status));

  // RETIRED is terminal and is not "further along" than COMMERCIAL_VALIDATED.
  // Treating it as the furthest status would report a withdrawn capability as
  // the most mature thing in the system.
  if (attestedStatuses.has('RETIRED')) {
    return {
      key: capability.key,
      title: capability.title,
      attested: 'RETIRED',
      skipped: [],
      notYetEstablished: [],
      statement: `${capability.title} is retired. It is kept on the record because history is not editable.`,
    };
  }

  const live = CAPABILITY_STATUSES.filter(
    (status) => status !== 'RETIRED' && attestedStatuses.has(status),
  );
  const attested = live.at(-1) ?? null;

  if (attested === null) {
    return {
      key: capability.key,
      title: capability.title,
      attested: null,
      skipped: [],
      notYetEstablished: CAPABILITY_STATUSES.filter((status) => status !== 'RETIRED'),
      statement:
        `${capability.title} has no attested status. That is not the same as it not ` +
        'existing — it means nobody has recorded evidence for any stage of it.',
    };
  }

  const skipped = CAPABILITY_STATUSES.filter(
    (status) =>
      status !== 'RETIRED' && order(status) < order(attested) && !attestedStatuses.has(status),
  );
  const notYetEstablished = CAPABILITY_STATUSES.filter(
    (status) => status !== 'RETIRED' && order(status) > order(attested),
  );

  return {
    key: capability.key,
    title: capability.title,
    attested,
    skipped,
    notYetEstablished,
    statement:
      `${capability.title} is attested to ${attested}.` +
      (skipped.length > 0
        ? ` ${skipped.join(', ')} ${skipped.length === 1 ? 'has' : 'have'} no attestation, ` +
          'so that step was skipped rather than satisfied.'
        : '') +
      (notYetEstablished.length > 0
        ? ` ${notYetEstablished.length} further status(es) remain unestablished, and nothing ` +
          'here implies them.'
        : ''),
  };
}

/**
 * Reasons an attestation is refused.
 *
 * Returned as a list rather than thrown, so a register can report every
 * problem in one pass instead of one per run.
 */
export function attestationProblems(attestation: StatusAttestation): readonly string[] {
  const problems: string[] = [];

  if (
    attestation.source === 'AUTOMATED_CHECK' &&
    HUMAN_ESTABLISHED_STATUSES.includes(attestation.status)
  ) {
    problems.push(
      `${attestation.status} cannot be established by an automated check. It is a claim about ` +
        'the world outside this repository, and a green pipeline is not evidence of it.',
    );
  }

  if (attestation.evidence.trim().length < 12) {
    problems.push(
      `${attestation.status} carries no usable evidence. A status with nothing behind it is the ` +
        'thing this model exists to prevent.',
    );
  }

  // The evidence must not simply restate the status. "It is production ready"
  // is the claim, not the proof, and a register full of those reads as
  // substantiated when it is not.
  const normalised = attestation.evidence.toLowerCase().replace(/[^a-z]+/g, ' ');
  const statusWords = attestation.status.toLowerCase().replace(/_/g, ' ');
  if (normalised.trim() === statusWords || normalised.trim() === `it is ${statusWords}`) {
    problems.push(
      `${attestation.status}'s evidence restates the status instead of establishing it.`,
    );
  }

  return problems;
}

/** Every problem across a register, keyed by capability. */
export function registerProblems(
  capabilities: readonly Capability[],
): readonly { key: string; problems: readonly string[] }[] {
  return capabilities
    .map((capability) => ({
      key: capability.key,
      problems: capability.attestations.flatMap((attestation) => attestationProblems(attestation)),
    }))
    .filter((entry) => entry.problems.length > 0);
}
