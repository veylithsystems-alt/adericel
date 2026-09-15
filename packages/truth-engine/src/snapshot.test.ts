import { describe, expect, it } from 'vitest';
import { assessControl, type ControlAssessmentInput } from './engine.js';
import { createRulesetRegistry } from './ruleset.js';
import { adericelBaselineV1 } from './rulesets/adericel-baseline.js';
import { parseAssessmentInput } from './snapshot.js';

/**
 * The snapshot boundary.
 *
 * A snapshot read back from storage is data of unknown provenance. Parsing it
 * before the engine sees it is what stops a corrupted or truncated row from
 * being silently assessed as "we have no facts about this", which would turn a
 * storage fault into an apparent finding about a customer's security.
 */

const registry = createRulesetRegistry([adericelBaselineV1]);
const baseline = registry.get('adericel-baseline');

const INPUT: ControlAssessmentInput = {
  organisationId: 'org-1',
  controlId: 'ctl-1',
  controlKey: 'identity.mfa.enforced',
  ruleKey: 'identity.mfa.enforced',
  parameters: {},
  asOfIso: '2026-09-09T12:00:00.000Z',
  subjects: [
    {
      nodeId: 'node-1',
      kind: 'Identity',
      label: 'someone@example.test',
      attributes: { department: 'finance' },
      claims: [
        {
          id: 'claim-1',
          predicate: 'identity.mfa.enforced',
          value: false,
          origin: 'DETERMINISTIC_NORMALISATION',
          status: 'CONFIRMED',
          observedAt: '2026-09-09T06:00:00.000Z',
          assertedAt: '2026-09-09T06:00:00.000Z',
          validUntil: null,
          evidenceIds: ['ev-1'],
        },
      ],
    },
  ],
  organisationClaims: [],
  evidence: [
    {
      id: 'ev-1',
      status: 'ACTIVE',
      sourceType: 'INTEGRATION_API',
      observedAt: '2026-09-09T06:00:00.000Z',
      collectedAt: '2026-09-09T06:00:00.000Z',
      validFrom: '2026-09-09T06:00:00.000Z',
      validUntil: null,
    },
  ],
  activeExceptions: [],
  observedSubjectKinds: ['Identity'],
};

/** A JSON round trip, which is what storage actually does to a snapshot. */
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('parseAssessmentInput', () => {
  it('survives a JSON round trip without changing the determination', () => {
    const direct = assessControl(baseline, INPUT);
    const restored = assessControl(baseline, parseAssessmentInput(roundTrip(INPUT)));
    expect(restored.state).toBe(direct.state);
    expect(restored.rationale).toBe(direct.rationale);
    expect(restored.provenance.inputDigest).toBe(direct.provenance.inputDigest);
    expect(restored.reasoning).toEqual(direct.reasoning);
  });

  it('preserves the input digest exactly, which is what makes replay a proof', () => {
    const parsed = parseAssessmentInput(roundTrip(INPUT));
    expect(assessControl(baseline, parsed).provenance.inputDigest).toBe(
      assessControl(baseline, INPUT).provenance.inputDigest,
    );
  });

  it('rejects a snapshot missing the subjects it claims to describe', () => {
    const broken = roundTrip(INPUT) as Record<string, unknown>;
    delete broken.subjects;
    expect(() => parseAssessmentInput(broken)).toThrow();
  });

  it('rejects a snapshot whose evidence lost its lifecycle status', () => {
    const broken = roundTrip(INPUT) as { evidence: Record<string, unknown>[] };
    delete broken.evidence[0]!.status;
    // Without a status, the freshness and revocation checks would silently not
    // apply, and a revoked document could prove a control.
    expect(() => parseAssessmentInput(broken)).toThrow();
  });

  it('rejects a claim whose origin is not one the engine recognises', () => {
    const broken = roundTrip(INPUT) as { subjects: { claims: Record<string, unknown>[] }[] };
    broken.subjects[0]!.claims[0]!.origin = 'TRUST_ME';
    // Origin is the AI/truth boundary. An unrecognised value must fail loudly
    // rather than fall through to the default path.
    expect(() => parseAssessmentInput(broken)).toThrow();
  });

  it('rejects a timestamp that is not an instant', () => {
    const broken = roundTrip(INPUT) as Record<string, unknown>;
    broken.asOfIso = 'last Tuesday';
    expect(() => parseAssessmentInput(broken)).toThrow();
  });

  it('rejects a null, a string, and an array', () => {
    for (const value of [null, 'snapshot', [], 42]) {
      expect(() => parseAssessmentInput(value)).toThrow();
    }
  });

  it('keeps a claim value of any JSON shape, because predicates are not all booleans', () => {
    const withValues = roundTrip({
      ...INPUT,
      organisationClaims: [
        {
          id: 'claim-2',
          predicate: 'organisation.identity.admin_count',
          value: { count: 3, sample: ['a', 'b'] },
          origin: 'DETERMINISTIC_NORMALISATION',
          status: 'CONFIRMED',
          observedAt: null,
          assertedAt: '2026-09-09T06:00:00.000Z',
          validUntil: null,
          evidenceIds: [],
        },
      ],
    });
    const parsed = parseAssessmentInput(withValues);
    expect(parsed.organisationClaims[0]!.value).toEqual({ count: 3, sample: ['a', 'b'] });
  });
});
