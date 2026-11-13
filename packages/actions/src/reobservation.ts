import type { TenantContext } from '@adericel/graph';
import { AdericelError, type Clock } from '@adericel/shared';
import type { CollectionService } from './collection-service.js';

/**
 * An observation that can be proved to have been observed.
 *
 * WHY THIS EXISTS
 *
 * `verify(actionId, observedValue: unknown)` used to decide `CONFIRMED` versus
 * `UNVERIFIED` from a value its caller handed it. The one caller that existed
 * did the right thing — the API route re-ran the connector against the source
 * first — but the type permitted a caller that did not. A worker job, an n8n
 * flow or a second endpoint could have passed the executor's own report of
 * success, or a literal `true`, and produced a verification record
 * indistinguishable from one that was earned. That record is evidence, and it
 * moves assurance state. Adericel would have been asserting it had checked
 * when it had only been told. (RR-095.)
 *
 * The contract makes `RE-OBSERVE` a stage of the authoritative execution
 * lifecycle, between `ACTION` and `VERIFY`. It was sitting outside the
 * authority boundary.
 *
 * HOW THE GUARANTEE IS MADE
 *
 * The brand below is a `unique symbol` that this module does not export, and
 * **nothing in this module mints a value carrying it except after performing
 * the re-observation**. There is deliberately no exported `attest()`: a
 * constructor anybody could call would move the problem rather than solve it.
 * So the only way to obtain a `ReObservation` is `createReObserver(...)`,
 * whose `reobserve` runs the integration, or whose `notObservable` records
 * that it could not be run and why — and `notObservable` can never produce a
 * reading, only the absence of one.
 *
 * The brand is checked at run time as well, by `assertReObservation`, because
 * the API boundary deserialises JSON and a cast silences the compiler. A type
 * that is only enforced by the compiler is enforced only against people who
 * did not mean it.
 */

declare const ATTESTED: unique symbol;

/** Why a re-observation could not be attempted at all. */
export const NOT_OBSERVABLE_REASONS = [
  /** The action was never bound to an integration, so there is nothing to re-run. */
  'NO_INTEGRATION',
  /** The action has no subject in the external system to look at. */
  'NO_TARGET',
] as const;
export type NotObservableReason = (typeof NOT_OBSERVABLE_REASONS)[number];

interface Branded {
  readonly [ATTESTED]: true;
}

/** A reading that was taken from the source, with the run that produced it. */
export interface ObservedReading extends Branded {
  readonly kind: 'OBSERVED';
  readonly predicate: string;
  readonly subjectExternalId: string;
  readonly integrationId: string;
  /** The `integration_runs` row this reading came out of. Recorded, not inferred. */
  readonly integrationRunId: string;
  readonly observedAt: string;
  /**
   * What the source said, or `null` when the run produced no claim for this
   * predicate. `null` is a real answer — "we looked and could not see" — and is
   * why this is not collapsed into `NotObservable`.
   */
  readonly value: unknown;
}

/** A re-observation that was not attempted, and the reason it could not be. */
export interface NotObservable extends Branded {
  readonly kind: 'NOT_OBSERVABLE';
  readonly predicate: string;
  readonly reason: NotObservableReason;
}

export type ReObservation = ObservedReading | NotObservable;

export interface ReObserver {
  /** Re-run the integration and read back the one predicate for the one subject. */
  reobserve(
    integrationId: string,
    subjectExternalId: string,
    predicate: string,
  ): Promise<ObservedReading>;
  /**
   * Record that re-observation was impossible, and why.
   *
   * Only expressible through the re-observer, so saying "this could not be
   * observed" remains the observer's statement rather than a caller's claim.
   */
  notObservable(predicate: string, reason: NotObservableReason): NotObservable;
}

export interface ReObserverDeps {
  readonly ctx: TenantContext;
  readonly clock: Clock;
  readonly collection: Pick<CollectionService, 'runIntegration'>;
}

export function createReObserver(deps: ReObserverDeps): ReObserver {
  const { ctx, clock, collection } = deps;

  return {
    async reobserve(integrationId, subjectExternalId, predicate): Promise<ObservedReading> {
      // Verification goes back to the source. It deliberately does not trust
      // the execution's own report of success, which is the whole point of
      // there being a VERIFY stage at all.
      const run = await collection.runIntegration(integrationId, 'VERIFICATION');
      const row = await ctx.one<{ value: unknown }>(
        `SELECT c.value FROM claims c
         JOIN graph_nodes n ON n.id = c.subject_node_id
         WHERE c.organisation_id = $1 AND c.predicate = $2 AND n.external_id = $3
           AND c.status IN ('CANDIDATE', 'CONFIRMED')
         ORDER BY c.asserted_at DESC LIMIT 1`,
        [ctx.organisationId, predicate, subjectExternalId],
      );
      return {
        kind: 'OBSERVED',
        predicate,
        subjectExternalId,
        integrationId,
        integrationRunId: run.runId,
        observedAt: clock.nowIso(),
        value: row?.value ?? null,
      } as ObservedReading;
    },

    notObservable(predicate, reason): NotObservable {
      return { kind: 'NOT_OBSERVABLE', predicate, reason } as NotObservable;
    },
  };
}

/**
 * Refuse anything that did not come out of a re-observer.
 *
 * The compile-time brand stops honest mistakes. This stops the two that the
 * compiler cannot see: a value that crossed a process boundary as JSON, and a
 * cast written by somebody in a hurry. It is a refusal rather than a coercion
 * to `INCONCLUSIVE` on purpose — an unattested value is a programming error in
 * the caller, not an inconclusive reading, and recording it as the latter would
 * bury it in the evidence as though somebody had looked.
 */
export function assertReObservation(value: unknown): asserts value is ReObservation {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'OBSERVED') {
    const reading = value as ObservedReading;
    if (
      typeof reading.predicate === 'string' &&
      typeof reading.subjectExternalId === 'string' &&
      typeof reading.integrationId === 'string' &&
      typeof reading.integrationRunId === 'string' &&
      typeof reading.observedAt === 'string'
    ) {
      return;
    }
  } else if (kind === 'NOT_OBSERVABLE') {
    const absent = value as NotObservable;
    if (
      typeof absent.predicate === 'string' &&
      (NOT_OBSERVABLE_REASONS as readonly string[]).includes(absent.reason)
    ) {
      return;
    }
  }
  throw new AdericelError(
    'VALIDATION_FAILED',
    'Verification requires a re-observation taken by the re-observer. A caller-supplied ' +
      'value cannot establish that the external system was looked at.',
  );
}

/**
 * The value a judgement should be made against, or `undefined` if nobody looked.
 *
 * `NOT_OBSERVABLE` deliberately yields `undefined` rather than `null`, so it
 * reaches `evaluateVerification` by the same door as a run that produced no
 * claim: the only outcome either can reach is `INCONCLUSIVE`. There is no path
 * from "we could not look" to `CONFIRMED`.
 */
export function readingOf(reobservation: ReObservation): unknown {
  return reobservation.kind === 'OBSERVED' ? reobservation.value : undefined;
}

/** The provenance to record alongside the verification, where there is any. */
export function provenanceOf(reobservation: ReObservation): {
  readonly integrationRunId: string | null;
  readonly observedAt: string | null;
  readonly notObservableReason: NotObservableReason | null;
} {
  return reobservation.kind === 'OBSERVED'
    ? {
        integrationRunId: reobservation.integrationRunId,
        observedAt: reobservation.observedAt,
        notObservableReason: null,
      }
    : { integrationRunId: null, observedAt: null, notObservableReason: reobservation.reason };
}
