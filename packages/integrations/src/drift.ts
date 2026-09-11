/**
 * Schema drift detection.
 *
 * External APIs change without telling anyone. A vendor moves
 *
 *   { "mfaEnabled": true }
 *
 * to
 *
 *   { "authentication": { "mfa": { "status": "enabled" } } }
 *
 * and a connector that plucks `mfaEnabled` starts finding nothing. Every
 * request succeeds, the integration reports healthy, no error is logged, and
 * the affected controls quietly become UNKNOWN — indistinguishable from a
 * customer who genuinely has no MFA data.
 *
 * That is the worst failure mode available to this product: it is silent, it
 * looks like the customer's problem, and it degrades assurance while every
 * light stays green.
 *
 * So a connector declares the fields it depends on, and their absence across a
 * population is reported as drift rather than as absence.
 */

export interface FieldExpectation {
  /** Dotted path into the record, e.g. `authentication.mfa.status`. */
  readonly path: string;
  /**
   * Whether every record should carry it.
   *
   * `always` — absence in any record is drift.
   * `population` — absence in ALL records is drift; some records legitimately
   *   lack it. This is the common case: not every user has a manager, but if no
   *   user in a thousand has one, the field has moved.
   */
  readonly presence: 'always' | 'population';
}

export interface DriftReport {
  readonly drifted: boolean;
  readonly recordsInspected: number;
  readonly missingFields: readonly string[];
  readonly detail: string;
}

function pluck(record: unknown, path: string): unknown {
  let cursor: unknown = record;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Compare a sample of upstream records against what the connector expects.
 *
 * A sample rather than the whole population: drift is a property of the shape,
 * not of any one record, and inspecting a thousand records to learn what fifty
 * already prove is wasted work on every collection run.
 */
export function detectDrift(
  records: readonly unknown[],
  expectations: readonly FieldExpectation[],
  options: { readonly sampleSize?: number } = {},
): DriftReport {
  const sample = records.slice(0, options.sampleSize ?? 50);
  if (sample.length === 0) {
    // Nothing to compare against. An empty response is a legitimate answer —
    // an organisation may genuinely have no devices — and calling that drift
    // would fire an alarm at every small customer.
    return {
      drifted: false,
      recordsInspected: 0,
      missingFields: [],
      detail: 'No records returned; nothing to compare against the expected shape.',
    };
  }

  const missing: string[] = [];
  for (const expectation of expectations) {
    const present = sample.filter((record) => pluck(record, expectation.path) !== undefined).length;
    if (expectation.presence === 'always' ? present < sample.length : present === 0) {
      missing.push(expectation.path);
    }
  }

  if (missing.length === 0) {
    return {
      drifted: false,
      recordsInspected: sample.length,
      missingFields: [],
      detail: `All ${expectations.length} expected field(s) present across ${sample.length} record(s).`,
    };
  }

  return {
    drifted: true,
    recordsInspected: sample.length,
    missingFields: missing.sort(),
    detail:
      `Expected field(s) ${missing.sort().join(', ')} were not found in any of ${sample.length} ` +
      'records. The upstream response parsed successfully, so this is most likely a change to ' +
      'the vendor’s schema rather than a permission or connectivity problem. Observations ' +
      'depending on these fields were not produced, and the controls that rest on them will ' +
      'read UNKNOWN until the connector is updated.',
  };
}
