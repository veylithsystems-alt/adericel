import { describe, expect, it } from 'vitest';
import {
  BLOCKED_REASON_OF_FAILURE,
  COLLECTION_FAILURE_CODES,
  CollectionFailure,
  DEGRADED_REASON_OF_FAILURE,
  RETRYABLE_FAILURE,
  classifyCollectionFailure,
  collectionFailureCodeSchema,
} from './collection-failure.js';
import { BLOCKED_REASONS, DEGRADED_REASONS } from './assurance.js';

/**
 * Why a collection failed, and what somebody does about it.
 *
 * The tests that matter here are the totality ones. A failure code without a
 * decision about what it means for assurance is a code that reaches an
 * operator as a blank, and the point of writing these as records rather than
 * switches is that forgetting one cannot compile.
 */
describe('collection failure codes', () => {
  it('decides what every code means for a control', () => {
    // Not a restatement of the type. The record is `Record<Code, Reason>`, so a
    // missing key is a compile error — but a value that drifted outside the
    // vocabulary is not, and that is what reaches a customer as a blank.
    for (const code of COLLECTION_FAILURE_CODES) {
      expect(DEGRADED_REASONS, code).toContain(DEGRADED_REASON_OF_FAILURE[code]);
      const blocked = BLOCKED_REASON_OF_FAILURE[code];
      if (blocked !== null) expect(BLOCKED_REASONS, code).toContain(blocked);
      expect(typeof RETRYABLE_FAILURE[code], code).toBe('boolean');
    }
  });

  it('never calls a credential or permission failure retryable', () => {
    // Retrying these only delays the moment somebody is told. A credential
    // that does not authenticate will not authenticate on the third attempt.
    for (const code of ['CREDENTIAL_INVALID', 'PERMISSION_DENIED', 'CONSENT_WITHDRAWN'] as const) {
      expect(RETRYABLE_FAILURE[code], code).toBe(false);
    }
  });

  it('routes a withdrawn consent to somebody with authority, not to an engineer', () => {
    // The only code in the set that is not an engineering fault. Putting it on
    // an engineer's queue would leave it sitting there, because there is
    // nothing an engineer can do about a customer's decision.
    expect(BLOCKED_REASON_OF_FAILURE.CONSENT_WITHDRAWN).toBe('CONSENT_REQUIRED');
    const engineerFixable = COLLECTION_FAILURE_CODES.filter(
      (code) => BLOCKED_REASON_OF_FAILURE[code] === null,
    );
    expect(engineerFixable.length).toBe(COLLECTION_FAILURE_CODES.length - 1);
  });

  it('keeps a credential failure distinguishable from a general one', () => {
    /**
     * The whole reason this vocabulary exists. If every code mapped to
     * COLLECTION_FAILING the table would be decoration, and the operator would
     * be told to go and look at something the stored code already identified.
     */
    expect(DEGRADED_REASON_OF_FAILURE.CREDENTIAL_INVALID).toBe('CREDENTIAL_EXPIRED');
    expect(DEGRADED_REASON_OF_FAILURE.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(DEGRADED_REASON_OF_FAILURE.SCHEMA_DRIFT).toBe('SCHEMA_DRIFT');
    const distinct = new Set(
      COLLECTION_FAILURE_CODES.map((code) => DEGRADED_REASON_OF_FAILURE[code]),
    );
    expect(distinct.size).toBeGreaterThan(3);
  });

  it('classifies a deliberate failure by its code', () => {
    const error = new CollectionFailure('RATE_LIMITED', 'Too many requests');
    expect(classifyCollectionFailure(error)).toBe('RATE_LIMITED');
    expect(error.message).toBe('Too many requests');
  });

  it('refuses to guess a code from an error message', () => {
    /**
     * Deliberate, and the most important test in this file.
     *
     * Every one of these messages names its cause in prose a regular
     * expression could match, and matching them would mean a pattern decides
     * what Adericel tells a customer — wrong silently, in both directions,
     * whenever a vendor rewords an error. UNCLASSIFIED is the honest answer: a
     * collection failed and the connector did not say why.
     */
    const tempting = [
      new Error('401 Unauthorized: the credential has expired'),
      new Error('429 Too Many Requests, retry after 60s'),
      new Error('consent was withdrawn by the administrator'),
      new Error('ETIMEDOUT'),
    ];
    for (const error of tempting) {
      expect(classifyCollectionFailure(error), error.message).toBe('UNCLASSIFIED');
    }
    expect(classifyCollectionFailure('a string')).toBe('UNCLASSIFIED');
    expect(classifyCollectionFailure(null)).toBe('UNCLASSIFIED');
  });

  it('maps the unclassified case to the most general reason, never to a specific one', () => {
    // A specific guess sends an engineer to do the wrong repair, which costs
    // more than being told we do not yet know.
    expect(DEGRADED_REASON_OF_FAILURE.UNCLASSIFIED).toBe('COLLECTION_FAILING');
    expect(BLOCKED_REASON_OF_FAILURE.UNCLASSIFIED).toBeNull();
  });

  it('validates a stored code and rejects anything else', () => {
    expect(collectionFailureCodeSchema.safeParse('CREDENTIAL_INVALID').success).toBe(true);
    expect(collectionFailureCodeSchema.safeParse('credential_invalid').success).toBe(false);
    expect(collectionFailureCodeSchema.safeParse('WHATEVER').success).toBe(false);
  });
});
