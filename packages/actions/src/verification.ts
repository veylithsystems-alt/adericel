import type { VerificationOutcome } from '@adericel/domain';

/**
 * Deciding what a re-observation proved.
 *
 * Pure and separate from the action service on purpose. This is the single
 * place where ACTION ATTEMPTED becomes ACTION VERIFIED, and it is the last
 * thing standing between Adericel and telling a customer that something was
 * fixed because a request returned 200. It must be readable in isolation and
 * testable without a database.
 *
 * There is no path here that produces CONFIRMED from an absent value.
 */

export type VerificationComparison = 'EQUALS' | 'OBSERVED_AFTER_EXECUTION';

export interface VerificationQuestion {
  readonly predicate: string;
  readonly expectedValue: unknown;
  readonly comparison: VerificationComparison;
  /** The value re-observed from the external system, or null if none was found. */
  readonly observedValue: unknown;
  /** When the action ran. Required by OBSERVED_AFTER_EXECUTION. */
  readonly executedAt: string | null;
}

export interface VerificationJudgement {
  readonly outcome: VerificationOutcome;
  readonly detail: string;
}

export function evaluateVerification(question: VerificationQuestion): VerificationJudgement {
  const { predicate, expectedValue, comparison, observedValue, executedAt } = question;

  if (observedValue === undefined || observedValue === null) {
    // No claim came back. That is not a refutation and it is emphatically not a
    // confirmation: nobody looked, or nobody could see.
    return {
      outcome: 'INCONCLUSIVE',
      detail: `Re-observation of ${predicate} produced no value. The outcome cannot be confirmed.`,
    };
  }

  if (comparison === 'OBSERVED_AFTER_EXECUTION') {
    // The predicate is a timestamp and the question is whether the thing
    // happened after we asked. A timestamp unchanged since before execution is
    // the exact failure this catches: the request was accepted and the device
    // never checked in.
    const observedAt = Date.parse(String(observedValue));
    const ranAt = executedAt === null ? Number.NaN : Date.parse(executedAt);
    if (Number.isNaN(observedAt) || Number.isNaN(ranAt)) {
      return {
        outcome: 'INCONCLUSIVE',
        detail:
          `Re-observation of ${predicate} returned ${JSON.stringify(observedValue)}, which ` +
          'cannot be compared as a timestamp against when the action ran. The outcome cannot ' +
          'be confirmed.',
      };
    }
    if (observedAt > ranAt) {
      return {
        outcome: 'CONFIRMED',
        detail: `${predicate} advanced to ${new Date(observedAt).toISOString()}, after the action ran.`,
      };
    }
    return {
      outcome: 'REFUTED',
      detail:
        `${predicate} still reads ${new Date(observedAt).toISOString()}, which is not later than ` +
        `the moment the action ran (${new Date(ranAt).toISOString()}). The external system has ` +
        'not done what was asked.',
    };
  }

  if (JSON.stringify(observedValue) === JSON.stringify(expectedValue)) {
    return {
      outcome: 'CONFIRMED',
      detail: `Re-observation of ${predicate} returned the expected value.`,
    };
  }

  return {
    outcome: 'REFUTED',
    detail:
      `Re-observation of ${predicate} returned ${JSON.stringify(observedValue)}, expected ` +
      `${JSON.stringify(expectedValue)}. The action did not achieve the intended state.`,
  };
}
