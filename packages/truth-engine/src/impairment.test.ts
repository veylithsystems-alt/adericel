import { describe, expect, it } from 'vitest';
import {
  assessControl,
  type ClaimFacts,
  type ControlAssessmentInput,
  type EvidenceFacts,
  type PredicateImpairment,
  type SubjectFacts,
} from './engine.js';
import { createRulesetRegistry } from './ruleset.js';
import { adericelBaselineV1 } from './rulesets/adericel-baseline.js';
import { cyberEssentialsV1 } from './rulesets/cyber-essentials.js';

/**
 * Impairment: how a broken source becomes DEGRADED rather than UNKNOWN.
 *
 * The engine performs no I/O and reads no clock (ADR-0002), so it cannot ask
 * whether a connector is healthy. Impairment therefore arrives as input, inside
 * the digest, exactly like every other fact about the world. That is what keeps
 * replay honest: re-running a historical assessment reproduces what Adericel
 * reported at the time, including that a source was broken then.
 *
 * The safety rule these tests exist to defend: impairment may only ever convert
 * UNKNOWN into DEGRADED or BLOCKED. It must never touch a real determination.
 */

const AS_OF = '2026-09-09T12:00:00.000Z';
const registry = createRulesetRegistry([adericelBaselineV1, cyberEssentialsV1]);
const baseline = registry.get('adericel-baseline');

function evidence(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
  return {
    id: overrides.id ?? 'ev-1',
    status: 'ACTIVE',
    sourceType: 'INTEGRATION_API',
    observedAt: '2026-09-09T06:00:00.000Z',
    collectedAt: '2026-09-09T06:00:00.000Z',
    validFrom: '2026-09-09T06:00:00.000Z',
    validUntil: null,
    ...overrides,
  };
}

function claim(predicate: string, value: unknown, overrides: Partial<ClaimFacts> = {}): ClaimFacts {
  return {
    id: overrides.id ?? `claim-${predicate}`,
    predicate,
    value,
    origin: 'DETERMINISTIC_NORMALISATION',
    status: 'CONFIRMED',
    observedAt: '2026-09-09T06:00:00.000Z',
    assertedAt: '2026-09-09T06:00:00.000Z',
    validUntil: null,
    evidenceIds: ['ev-1'],
    ...overrides,
  };
}

function identity(id: string, claims: ClaimFacts[]): SubjectFacts {
  return { nodeId: id, kind: 'Identity', label: id, attributes: {}, claims };
}

function input(overrides: Partial<ControlAssessmentInput> = {}): ControlAssessmentInput {
  return {
    organisationId: 'org-1',
    controlId: 'ctl-1',
    controlKey: 'identity.mfa.enforced',
    ruleKey: 'identity.mfa.enforced',
    parameters: {},
    asOfIso: AS_OF,
    subjects: [],
    organisationClaims: [],
    evidence: [evidence()],
    activeExceptions: [],
    observedSubjectKinds: [
      'Identity',
      'Device',
      'CloudResource',
      'DataAsset',
      'Policy',
      'Supplier',
    ],
    ...overrides,
  };
}

const COLLECTION_BROKEN: PredicateImpairment = {
  predicate: 'identity.mfa.enforced',
  kind: 'DEGRADED',
  reason: 'CREDENTIAL_EXPIRED',
  detail: 'The Microsoft Entra credential expired on 12 September and collection has stopped.',
};

const NOT_PERMITTED: PredicateImpairment = {
  predicate: 'identity.mfa.enforced',
  kind: 'BLOCKED',
  reason: 'CONSENT_REQUIRED',
  detail: 'The customer has not yet granted consent for directory read.',
};

/** A subject whose required predicate is absent, so the rule cannot determine. */
function undeterminable(): SubjectFacts {
  return identity('id-1', [claim('identity.is_active', true)]);
}

describe('impairment turns an unknown into something actionable', () => {
  it('reports DEGRADED when the source that supplies the predicate is broken', () => {
    const without = assessControl(baseline, input({ subjects: [undeterminable()] }));
    expect(without.state).toBe('UNKNOWN');

    const withImpairment = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [COLLECTION_BROKEN] }),
    );
    expect(withImpairment.state).toBe('DEGRADED');
    expect(withImpairment.degradedReason).toBe('CREDENTIAL_EXPIRED');
    expect(withImpairment.unknownReason).toBeNull();
  });

  it('reports BLOCKED when Adericel is not permitted to look', () => {
    const result = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [NOT_PERMITTED] }),
    );
    expect(result.state).toBe('BLOCKED');
    expect(result.blockedReason).toBe('CONSENT_REQUIRED');
    expect(result.degradedReason).toBeNull();
  });

  it('tells the operator what actually happened, not a generic missing-input message', () => {
    const result = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [COLLECTION_BROKEN] }),
    );
    expect(result.rationale).toContain('credential expired');
  });

  it('prefers DEGRADED when a control is both degraded and blocked', () => {
    const result = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [NOT_PERMITTED, COLLECTION_BROKEN] }),
    );
    // A broken mechanism usually explains more, and an operator can act on it
    // without first finding somebody with authority.
    expect(result.state).toBe('DEGRADED');
  });

  it('ignores an impairment for a predicate this rule does not need', () => {
    const unrelated: PredicateImpairment = { ...COLLECTION_BROKEN, predicate: 'device.encrypted' };
    const result = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [unrelated] }),
    );
    // A connector failing elsewhere does not degrade a control it never fed.
    expect(result.state).toBe('UNKNOWN');
  });
});

describe('impairment never touches a real determination', () => {
  const satisfied = () => identity('id-1', [claim('identity.mfa.enforced', true)]);
  const failing = () => identity('id-2', [claim('identity.mfa.enforced', false)]);

  it('leaves SATISFIED alone even when the source is broken', () => {
    // The tempting alternative is to degrade any control whose connector is
    // unhealthy. It is wrong in the direction that matters: the control IS
    // satisfied on the evidence held, and saying otherwise would report a
    // finding about the organisation on the strength of a fault in Adericel.
    // Evidence that has actually gone stale is handled upstream — the claim
    // becomes ineligible and the control falls to UNKNOWN on its own.
    const result = assessControl(
      baseline,
      input({ subjects: [satisfied()], impairments: [COLLECTION_BROKEN] }),
    );
    expect(result.state).toBe('SATISFIED');
    expect(result.degradedReason).toBeNull();
    expect(result.impairment).toBeNull();
  });

  it('leaves NOT_SATISFIED alone even when the source is broken', () => {
    const result = assessControl(
      baseline,
      input({ subjects: [failing()], impairments: [COLLECTION_BROKEN] }),
    );
    expect(result.state).toBe('NOT_SATISFIED');
    expect(result.blockedReason).toBeNull();
  });

  it('cannot turn a failure into anything softer', () => {
    // The adversarial reading: could a connector marked "impaired" be used to
    // make a real failure look like a collection fault? No — the state is
    // already determinate before impairment is consulted.
    for (const impairment of [COLLECTION_BROKEN, NOT_PERMITTED]) {
      const result = assessControl(
        baseline,
        input({ subjects: [failing()], impairments: [impairment] }),
      );
      expect(result.state).toBe('NOT_SATISFIED');
    }
  });

  it('leaves a determinate control alone even though some inputs are missing', () => {
    /**
     * The case that actually exercises the guard, and the reason this test
     * exists in this shape.
     *
     * An earlier version of this suite asserted the rule only against
     * SATISFIED and NOT_SATISFIED. Both have no missing predicates, so
     * `applyImpairment` returned early on the "nothing relevant is impaired"
     * branch and the `state !== 'UNKNOWN'` guard was never reached. Deleting
     * the guard broke nothing and every test still passed — a green suite that
     * survived removal of the property it claimed to protect.
     *
     * The combination that bites is a real determination that ALSO carries
     * missing predicates: one account demonstrably without MFA, and another
     * whose state could not be read because the connector broke half way
     * through. The control genuinely fails.
     *
     * Without the guard, the impairment would rewrite that failure into
     * DEGRADED — reporting a collection fault and hiding an account that really
     * is unprotected. That is the most dangerous single regression available in
     * this change, and it is the one the guard prevents.
     */
    const subjects = [failing(), undeterminable()];

    const clean = assessControl(baseline, input({ subjects }));
    expect(clean.state).toBe('NOT_SATISFIED');

    const withImpairment = assessControl(
      baseline,
      input({ subjects, impairments: [COLLECTION_BROKEN] }),
    );
    expect(withImpairment.state).toBe('NOT_SATISFIED');
    expect(withImpairment.degradedReason).toBeNull();
    expect(withImpairment.impairment).toBeNull();
  });

  it('never invents a reason for a state that does not carry one', () => {
    const result = assessControl(baseline, input({ subjects: [satisfied()] }));
    expect(result.degradedReason).toBeNull();
    expect(result.blockedReason).toBeNull();
    expect(result.unknownReason).toBeNull();
  });
});

describe('determinism survives the new input', () => {
  it('produces identical output for identical input including impairment', () => {
    const args = input({ subjects: [undeterminable()], impairments: [COLLECTION_BROKEN] });
    const a = assessControl(baseline, args);
    const b = assessControl(baseline, args);
    expect(a.provenance.inputDigest).toBe(b.provenance.inputDigest);
    expect(a.state).toBe(b.state);
  });

  it('changes the input digest when impairment changes', () => {
    // Impairment changes the answer, so it must change the digest. Two
    // assessments with different states sharing a digest is the one thing the
    // digest exists to prevent.
    const clean = assessControl(baseline, input({ subjects: [undeterminable()] }));
    const impaired = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [COLLECTION_BROKEN] }),
    );
    expect(impaired.provenance.inputDigest).not.toBe(clean.provenance.inputDigest);
  });

  it('is insensitive to the order impairments arrive in', () => {
    const forward = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [COLLECTION_BROKEN, NOT_PERMITTED] }),
    );
    const reverse = assessControl(
      baseline,
      input({ subjects: [undeterminable()], impairments: [NOT_PERMITTED, COLLECTION_BROKEN] }),
    );
    expect(forward.provenance.inputDigest).toBe(reverse.provenance.inputDigest);
    expect(forward.state).toBe(reverse.state);
  });
});
