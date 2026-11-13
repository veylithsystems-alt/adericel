import { z } from 'zod';
import type { BlockedReason, DegradedReason } from './assurance.js';

/**
 * Why a collection failed, as a code rather than a sentence.
 *
 * WHY THIS EXISTS
 *
 * A connector that throws records a message: "Request failed with status code
 * 401". That is enough for an engineer reading a log and useless to everything
 * downstream, because nothing can act on prose. The resolution queue needs to
 * tell an operator *which repair* to carry out, and "re-authenticate the
 * Microsoft Entra connection" and "wait, you are being throttled" are
 * different jobs with different owners.
 *
 * The alternative — pattern-matching the message — was considered and
 * rejected. Reading intent out of a vendor's error prose means a regular
 * expression decides what Adericel tells a customer, and it will be wrong
 * silently, in both directions, whenever a vendor rewords an error. A closed
 * set the connector itself chooses from is the only version of this that can
 * be relied on.
 *
 * Each code answers one question: what would somebody have to do about it?
 */
export const COLLECTION_FAILURE_CODES = [
  /**
   * The stored credential no longer authenticates.
   *
   * Somebody re-authorises the connection. Until they do, nothing can be
   * observed through it, and no amount of retrying will help.
   */
  'CREDENTIAL_INVALID',
  /**
   * The credential authenticates but lacks the permission this call needs.
   *
   * Distinct from `CREDENTIAL_INVALID` because the repair is different: an
   * administrator grants a scope, rather than anybody signing in again.
   */
  'PERMISSION_DENIED',
  /**
   * The customer, or an administrator acting for them, withdrew consent.
   *
   * Not a fault. Somebody decided Adericel should stop looking, and a product
   * that reported this as a technical error would be misrepresenting a
   * customer's decision as a bug.
   */
  'CONSENT_WITHDRAWN',
  /** The source is throttling hard enough that the run cannot complete. */
  'RATE_LIMITED',
  /** The source did not answer in time. */
  'TIMEOUT',
  /** The source is unreachable, or answering with server errors. */
  'SOURCE_UNAVAILABLE',
  /**
   * The source answers, and normalisation no longer recognises its shape.
   *
   * The most dangerous of the set, because the request succeeded. A vendor
   * shipped a v2 API and renamed its fields; everything looks healthy and
   * nothing can be read out of it.
   */
  'SCHEMA_DRIFT',
  /**
   * The connector is configured in a way that cannot work.
   *
   * A tenant identifier that does not exist, a region that is not served. The
   * repair is a configuration change, not a retry and not a credential.
   */
  'CONFIGURATION_INVALID',
  /**
   * Something else, and the connector cannot say what.
   *
   * Deliberately present, and deliberately last. A connector facing an error
   * it does not recognise must be able to say so honestly rather than pick the
   * nearest-looking code, because a wrong code sends an engineer to do the
   * wrong repair. It maps to the most general degraded reason, which is the
   * truthful answer: collection is failing, and we cannot yet tell you why.
   */
  'UNCLASSIFIED',
] as const;
export type CollectionFailureCode = (typeof COLLECTION_FAILURE_CODES)[number];
export const collectionFailureCodeSchema = z.enum(COLLECTION_FAILURE_CODES);

/**
 * What a failed collection means for a control that needed it.
 *
 * Written as a total record rather than a switch with a default. Adding a
 * failure code without deciding what it means for assurance is then a compile
 * error, which is the only way this stays correct: a `default` branch would
 * quietly route every future code to `COLLECTION_FAILING` and lose exactly the
 * distinction this table exists to preserve.
 */
export const DEGRADED_REASON_OF_FAILURE: Readonly<Record<CollectionFailureCode, DegradedReason>> = {
  CREDENTIAL_INVALID: 'CREDENTIAL_EXPIRED',
  // There is no PERMISSION_DENIED degraded reason, and inventing one here
  // would put vocabulary in the wrong place. A missing scope stops collection
  // the same way a bad credential does, and the capability report already
  // names the permission.
  PERMISSION_DENIED: 'COLLECTION_FAILING',
  CONSENT_WITHDRAWN: 'CONSENT_WITHDRAWN',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'SOURCE_UNAVAILABLE',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  SCHEMA_DRIFT: 'SCHEMA_DRIFT',
  CONFIGURATION_INVALID: 'COLLECTION_FAILING',
  UNCLASSIFIED: 'COLLECTION_FAILING',
};

/**
 * Failures that need somebody with authority rather than an engineer.
 *
 * `CONSENT_WITHDRAWN` is the one case where the MSP cannot simply repair the
 * connection: the customer has to agree. Routing it as DEGRADED would put it
 * on an engineer's queue, where it would sit, because there is nothing an
 * engineer can do with it.
 */
export const BLOCKED_REASON_OF_FAILURE: Readonly<
  Record<CollectionFailureCode, BlockedReason | null>
> = {
  CREDENTIAL_INVALID: null,
  PERMISSION_DENIED: null,
  CONSENT_WITHDRAWN: 'CONSENT_REQUIRED',
  RATE_LIMITED: null,
  TIMEOUT: null,
  SOURCE_UNAVAILABLE: null,
  SCHEMA_DRIFT: null,
  CONFIGURATION_INVALID: null,
  UNCLASSIFIED: null,
};

/**
 * Whether retrying the same call could plausibly succeed.
 *
 * Used to decide whether a failure is worth another attempt before it reaches
 * an operator's queue. A credential that does not authenticate will not
 * authenticate on the third try, and retrying it only delays the moment
 * somebody is told.
 */
export const RETRYABLE_FAILURE: Readonly<Record<CollectionFailureCode, boolean>> = {
  CREDENTIAL_INVALID: false,
  PERMISSION_DENIED: false,
  CONSENT_WITHDRAWN: false,
  RATE_LIMITED: true,
  TIMEOUT: true,
  SOURCE_UNAVAILABLE: true,
  SCHEMA_DRIFT: false,
  CONFIGURATION_INVALID: false,
  UNCLASSIFIED: true,
};

/**
 * A collection failure a connector is reporting deliberately.
 *
 * Thrown by a connector so the collection service can record the code without
 * reading the message. A connector that throws anything else is recorded as
 * `UNCLASSIFIED`, which is correct and visible rather than guessed.
 */
export class CollectionFailure extends Error {
  readonly failureCode: CollectionFailureCode;

  constructor(failureCode: CollectionFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CollectionFailure';
    this.failureCode = failureCode;
  }
}

/**
 * Classify a thrown value.
 *
 * Only a `CollectionFailure` carries a code. Everything else is
 * `UNCLASSIFIED` — not the nearest guess, because a guess here becomes an
 * instruction to an engineer.
 */
export function classifyCollectionFailure(error: unknown): CollectionFailureCode {
  if (error instanceof CollectionFailure) return error.failureCode;
  // Deliberately no message inspection. See the note on the code list above.
  return 'UNCLASSIFIED';
}
