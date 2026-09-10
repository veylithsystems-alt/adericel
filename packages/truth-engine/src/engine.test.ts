import { describe, expect, it } from 'vitest';
import {
  assessControl,
  type ClaimFacts,
  type ControlAssessmentInput,
  type EvidenceFacts,
  type SubjectFacts,
} from './engine.js';
import { compileRuleset, createRulesetRegistry } from './ruleset.js';
import { adericelBaselineV1 } from './rulesets/adericel-baseline.js';
import { cyberEssentialsV1 } from './rulesets/cyber-essentials.js';
import { iso27001V1 } from './rulesets/iso-27001.js';
import { BUILT_IN_RULESETS } from './rulesets/index.js';

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

describe('assessControl — determinism and reproducibility', () => {
  it('produces identical output for identical input', () => {
    const args = input({
      subjects: [
        identity('id-1', [
          claim('identity.mfa.enforced', true),
          claim('identity.account.enabled', true),
        ]),
      ],
    });
    const a = assessControl(baseline, args);
    const b = assessControl(baseline, args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is insensitive to the order of subjects and claims in the input digest', () => {
    const s1 = identity('id-1', [
      claim('identity.mfa.enforced', true),
      claim('identity.account.enabled', true),
    ]);
    const s2 = identity('id-2', [
      claim('identity.account.enabled', true, { id: 'c2a' }),
      claim('identity.mfa.enforced', true, { id: 'c2b' }),
    ]);
    const forward = assessControl(baseline, input({ subjects: [s1, s2] }));
    const reversed = assessControl(baseline, input({ subjects: [s2, s1] }));
    expect(forward.provenance.inputDigest).toBe(reversed.provenance.inputDigest);
    expect(forward.state).toBe(reversed.state);
  });

  it('changes the input digest when a fact changes', () => {
    const passing = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
        ],
      }),
    );
    const failing = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', false),
            claim('identity.account.enabled', true),
          ]),
        ],
      }),
    );
    expect(passing.provenance.inputDigest).not.toBe(failing.provenance.inputDigest);
  });

  it('records the ruleset hash it ran under', () => {
    const result = assessControl(baseline, input());
    expect(result.provenance.rulesetHash).toBe(baseline.hash);
    expect(result.provenance.rulesetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.provenance.rulesetVersion).toBe('1.0.0');
  });

  it('does not read the wall clock', () => {
    // Assessing "as at" a historical instant must reproduce the historical
    // answer even though real time has moved on.
    const historical = assessControl(
      baseline,
      input({
        asOfIso: '2026-09-09T07:00:00.000Z',
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
        ],
      }),
    );
    expect(historical.state).toBe('SATISFIED');
    expect(historical.provenance.assessedAt).toBe('2026-09-09T07:00:00.000Z');
  });
});

describe('assessControl — UNKNOWN is preserved', () => {
  it('reports UNKNOWN when no claim exists for a required predicate', () => {
    const result = assessControl(
      baseline,
      input({ subjects: [identity('id-1', [claim('identity.account.enabled', true)])] }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.unknownReason).not.toBeNull();
  });

  it('reports UNKNOWN, not SATISFIED, when one subject of many is unknown', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
          identity('id-2', [claim('identity.account.enabled', true, { id: 'c2' })]),
        ],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.unknownSubjects.map((s) => s.nodeId)).toEqual(['id-2']);
  });

  it('reports NOT_SATISFIED when a known failure coexists with an unknown', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', false),
            claim('identity.account.enabled', true),
          ]),
          identity('id-2', [claim('identity.account.enabled', true, { id: 'c2' })]),
        ],
      }),
    );
    expect(result.state).toBe('NOT_SATISFIED');
    expect(result.failingSubjects).toHaveLength(1);
    expect(result.unknownSubjects).toHaveLength(1);
  });

  it('reports NOT_APPLICABLE when the asset class was observed and none are in scope', () => {
    expect(assessControl(baseline, input({ subjects: [] })).state).toBe('NOT_APPLICABLE');
  });

  it('reports UNKNOWN, not NOT_APPLICABLE, when the asset class has never been observed', () => {
    // The dangerous case: an organisation with no endpoint collection at all
    // must not look better than one where collection works and found a problem.
    const result = assessControl(
      baseline,
      input({ subjects: [], observedSubjectKinds: ['Organisation'] }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.unknownReason).toBe('NO_EVIDENCE');
    expect(result.rationale).toMatch(/never observed/);
  });

  it('keeps a subject in scope and unknown when applicability cannot be resolved', () => {
    // device.managed is absent and the rule declares no default for it, so we
    // cannot say whether the rule applies. The subject must stay in scope and
    // unknown rather than being quietly dropped from the denominator.
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'device.disk.encrypted',
        controlKey: 'device.disk.encrypted',
        subjects: [
          {
            nodeId: 'dev-1',
            kind: 'Device',
            label: 'Laptop',
            attributes: {},
            claims: [claim('device.disk.encrypted', true)],
          },
        ],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.subjectOutcomes[0]?.inScope).toBe(true);
    expect(result.subjectOutcomes[0]?.detail).toMatch(/whether this rule applies/);
  });
});

describe('assessControl — evidence lifecycle drives usability', () => {
  it('treats stale evidence as unusable and reports UNKNOWN', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
        ],
        evidence: [
          evidence({
            observedAt: '2026-07-01T00:00:00.000Z',
            collectedAt: '2026-07-01T00:00:00.000Z',
            validFrom: '2026-07-01T00:00:00.000Z',
          }),
        ],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.unknownReason).toBe('INSUFFICIENT_EVIDENCE');
    // Staleness disqualifies every claim resting on that evidence, including the
    // one the applicability check needs — so the whole subject becomes unknown.
    expect(result.subjectOutcomes[0]?.value).toBe('UNKNOWN');
    expect(result.rationale).toMatch(/cannot be determined/);
  });

  it('treats revoked evidence as unusable', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
        ],
        evidence: [evidence({ status: 'REVOKED' })],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
  });

  it('treats superseded evidence as unusable', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
        ],
        evidence: [evidence({ status: 'SUPERSEDED' })],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
  });

  it('accepts a claim when at least one of its evidence items is still usable', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true, { evidenceIds: ['ev-old', 'ev-1'] }),
            claim('identity.account.enabled', true),
          ]),
        ],
        evidence: [evidence({ id: 'ev-old', status: 'REVOKED' }), evidence({ id: 'ev-1' })],
      }),
    );
    expect(result.state).toBe('SATISFIED');
  });
});

describe('assessControl — the AI/truth boundary', () => {
  it('refuses to rely on an unconfirmed AI-suggested claim', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true, { origin: 'AI_SUGGESTED', status: 'CANDIDATE' }),
            claim('identity.account.enabled', true),
          ]),
        ],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.subjectOutcomes[0]?.detail).toMatch(/AI-suggested claims require confirmation/);
    expect(result.rationale).toMatch(/identity\.mfa\.enforced/);
  });

  it('accepts an AI-suggested claim once a human or verification confirms it', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true, { origin: 'AI_SUGGESTED', status: 'CONFIRMED' }),
            claim('identity.account.enabled', true),
          ]),
        ],
      }),
    );
    expect(result.state).toBe('SATISFIED');
  });

  it('prefers the most recent usable claim when a predicate has several', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', false, {
              id: 'old',
              assertedAt: '2026-09-01T00:00:00.000Z',
            }),
            claim('identity.mfa.enforced', true, {
              id: 'new',
              assertedAt: '2026-09-09T06:00:00.000Z',
            }),
            claim('identity.account.enabled', true),
          ]),
        ],
      }),
    );
    expect(result.state).toBe('SATISFIED');
    expect(result.claimIds).toContain('new');
  });
});

describe('assessControl — exceptions', () => {
  it('reports EXCEPTED, not SATISFIED, for a control-wide exception', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', false),
            claim('identity.account.enabled', true),
          ]),
        ],
        activeExceptions: [
          {
            id: 'exc-1',
            subjectNodeId: null,
            justification: 'Legacy line-of-business application under replacement',
            expiresAt: '2026-12-31T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(result.state).toBe('EXCEPTED');
    expect(result.rationale).toMatch(/authorised exception/);
  });

  it('excludes only the excepted subject, leaving the rest assessed', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', false),
            claim('identity.account.enabled', true),
          ]),
          identity('id-2', [
            claim('identity.mfa.enforced', true, { id: 'c2a' }),
            claim('identity.account.enabled', true, { id: 'c2b' }),
          ]),
        ],
        activeExceptions: [
          {
            id: 'exc-1',
            subjectNodeId: 'id-1',
            justification: 'Break-glass account',
            expiresAt: '2026-12-31T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(result.state).toBe('SATISFIED');
    expect(result.subjectOutcomes.find((s) => s.nodeId === 'id-1')?.excepted).toBe(true);
  });
});

describe('assessControl — aggregation semantics', () => {
  function devices(states: (boolean | null)[]): SubjectFacts[] {
    return states.map((supported, i) => ({
      nodeId: `dev-${i}`,
      kind: 'Device',
      label: `Device ${i}`,
      attributes: {},
      claims:
        supported === null
          ? [claim('device.managed', true, { id: `m${i}` })]
          : [
              claim('device.managed', true, { id: `m${i}` }),
              claim('device.os.supported', supported, { id: `s${i}` }),
            ],
    }));
  }

  it('THRESHOLD reports SATISFIED at or above the threshold', () => {
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'device.os.supported',
        controlKey: 'device.os.supported',
        subjects: devices(Array(20).fill(true)),
      }),
    );
    expect(result.state).toBe('SATISFIED');
  });

  it('THRESHOLD reports PARTIALLY_SATISFIED below the threshold', () => {
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'device.os.supported',
        controlKey: 'device.os.supported',
        subjects: devices([...Array(18).fill(true), false, false]),
      }),
    );
    expect(result.state).toBe('PARTIALLY_SATISFIED');
  });

  it('unknown tolerance is checked before the pass/fail decision', () => {
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'device.os.supported',
        controlKey: 'device.os.supported',
        subjects: devices([...Array(19).fill(true), null]),
      }),
    );
    // 19/20 pass, which clears the 0.95 threshold, but one device is unknown and
    // the default tolerance is zero — so the honest answer is UNKNOWN.
    expect(result.state).toBe('UNKNOWN');
  });

  it('ALL fails as soon as one subject fails', () => {
    const result = assessControl(
      baseline,
      input({
        subjects: [
          identity('id-1', [
            claim('identity.mfa.enforced', true),
            claim('identity.account.enabled', true),
          ]),
          identity('id-2', [
            claim('identity.mfa.enforced', false, { id: 'c2a' }),
            claim('identity.account.enabled', true, { id: 'c2b' }),
          ]),
        ],
      }),
    );
    expect(result.state).toBe('NOT_SATISFIED');
  });
});

describe('assessControl — organisation-level rules', () => {
  it('evaluates a SINGLE rule against organisation claims', () => {
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'identity.admin.count_limited',
        controlKey: 'identity.admin.count_limited',
        organisationClaims: [claim('organisation.identity.admin_count', 3)],
      }),
    );
    expect(result.state).toBe('SATISFIED');
  });

  it('honours a control parameter override', () => {
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'identity.admin.count_limited',
        controlKey: 'identity.admin.count_limited',
        parameters: { maxAdministrators: 2 },
        organisationClaims: [claim('organisation.identity.admin_count', 3)],
      }),
    );
    expect(result.state).toBe('NOT_SATISFIED');
  });

  it('reports NO_EVIDENCE when no organisation claims exist at all', () => {
    const result = assessControl(
      baseline,
      input({
        ruleKey: 'identity.admin.count_limited',
        controlKey: 'identity.admin.count_limited',
      }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.unknownReason).toBe('NO_EVIDENCE');
  });
});

describe('ruleset integrity', () => {
  it('compiles every built-in ruleset', () => {
    // Iterating the registry rather than naming them keeps this honest as
    // rulesets are added: a new one that does not compile fails here rather
    // than at an MSP's first assessment against it.
    expect(BUILT_IN_RULESETS.length).toBeGreaterThanOrEqual(3);
    for (const definition of BUILT_IN_RULESETS) {
      expect(() => compileRuleset(definition)).not.toThrow();
    }
  });

  it('hashes deterministically across recompiles', () => {
    expect(compileRuleset(adericelBaselineV1).hash).toBe(compileRuleset(adericelBaselineV1).hash);
  });

  it('refuses to re-register a version with different content', () => {
    const reg = createRulesetRegistry([adericelBaselineV1]);
    const mutated = {
      ...adericelBaselineV1,
      rules: adericelBaselineV1.rules.map((r) => ({ ...r, severity: 'LOW' })),
    };
    expect(() => reg.register(mutated)).toThrow(/immutable/);
  });

  it('rejects a ruleset with duplicate rule keys', () => {
    expect(() =>
      compileRuleset({
        ...adericelBaselineV1,
        rules: [adericelBaselineV1.rules[0], adericelBaselineV1.rules[0]],
      }),
    ).toThrow(/duplicate rule key/);
  });

  it('gives every rule a failure title and description for explainability', () => {
    for (const definition of BUILT_IN_RULESETS) {
      for (const rule of compileRuleset(definition).rules) {
        expect(rule.failureTitle.length).toBeGreaterThan(0);
        expect(rule.failureDescription.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives every built-in ruleset a distinct key', () => {
    const keys = BUILT_IN_RULESETS.map((definition) => compileRuleset(definition).key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the ISO 27001 ruleset', () => {
  const iso = compileRuleset(iso27001V1);

  it('reports UNKNOWN for an organisational control with no evidence, rather than omitting it', () => {
    // The whole point. A control that cannot be determined from observed state
    // is included and honest, not excluded so that coverage looks complete.
    const rule = iso.rules.find((r) => r.key === 'iso.5.24.incident_management');
    expect(rule).toBeDefined();

    const result = assessControl(
      iso,
      input({
        controlKey: 'iso.5.24.incident_management',
        ruleKey: 'iso.5.24.incident_management',
        organisationClaims: [],
      }),
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.unknownReason).toBe('NO_EVIDENCE');
  });

  it('covers all four Annex A themes rather than only the technological one', () => {
    // A ruleset that only expresses what is easy to observe misrepresents the
    // standard as a technical checklist.
    const prefixes = new Set(iso.rules.map((rule) => rule.key.split('.')[1]));
    expect(prefixes).toContain('5'); // organisational
    expect(prefixes).toContain('6'); // people
    expect(prefixes).toContain('8'); // technological
  });

  it('bounds evidence age on every rule, so nothing is proven by a stale document', () => {
    for (const rule of iso.rules) {
      expect(rule.maxEvidenceAgeDays, `${rule.key} has no freshness bound`).not.toBeNull();
    }
  });
});

/**
 * Properties asserted over every rule in every shipped ruleset, rather than
 * over hand-picked examples.
 *
 * A case-by-case test proves the cases somebody thought of. These say something
 * about the whole surface, so a rule added next year inherits the guarantee
 * without anybody remembering to extend a list.
 */
describe('assessControl — invariants across every shipped rule', () => {
  const everyRule = BUILT_IN_RULESETS.flatMap((definition) => {
    const ruleset = compileRuleset(definition);
    return ruleset.rules.map((rule) => ({ ruleset, rule }));
  });

  it('has rules to quantify over', () => {
    expect(everyRule.length).toBeGreaterThan(20);
  });

  it('never reports SATISFIED when it has no facts at all', () => {
    const claimed: string[] = [];
    for (const { ruleset, rule } of everyRule) {
      // A subject exists and is in scope, but nothing whatsoever is known about
      // it. This is the state of a freshly connected tenant, and the state in
      // which an assurance product is most tempted to flatter its customer.
      const subjects =
        rule.subjectKinds.length === 0
          ? []
          : rule.subjectKinds.map((kind, index) => ({
              nodeId: `subject-${index}`,
              kind,
              label: `subject-${index}`,
              attributes: {},
              claims: [],
            }));
      const outcome = assessControl(
        ruleset,
        input({
          ruleKey: rule.key,
          controlKey: rule.key,
          subjects,
          organisationClaims: [],
          evidence: [],
          observedSubjectKinds: rule.subjectKinds,
        }),
      );
      if (outcome.state === 'SATISFIED' || outcome.state === 'PARTIALLY_SATISFIED') {
        claimed.push(`${ruleset.key}/${rule.key} -> ${outcome.state}`);
      }
    }
    expect(claimed).toEqual([]);
  });

  it('never reports NOT_APPLICABLE for an asset class it has never observed', () => {
    const excused: string[] = [];
    for (const { ruleset, rule } of everyRule) {
      if (rule.subjectKinds.length === 0) continue;
      const outcome = assessControl(
        ruleset,
        input({
          ruleKey: rule.key,
          controlKey: rule.key,
          subjects: [],
          evidence: [],
          observedSubjectKinds: [],
        }),
      );
      // Excusing itself from the denominator is how a tenant with no endpoint
      // collection at all scores better than one whose collection works.
      if (outcome.state !== 'UNKNOWN')
        excused.push(`${ruleset.key}/${rule.key} -> ${outcome.state}`);
    }
    expect(excused).toEqual([]);
  });

  it('states a reason exactly when, and only when, the answer is UNKNOWN', () => {
    const inconsistent: string[] = [];
    const scenarios = (rule: { key: string; subjectKinds: readonly string[] }) => [
      { subjects: [], organisationClaims: [], evidence: [], observedSubjectKinds: [] },
      {
        subjects: rule.subjectKinds.map((kind, i) => ({
          nodeId: `s-${i}`,
          kind,
          label: `s-${i}`,
          attributes: {},
          claims: [],
        })),
        organisationClaims: [],
        evidence: [],
        observedSubjectKinds: [...rule.subjectKinds],
      },
      {
        subjects: [],
        organisationClaims: [],
        evidence: [],
        observedSubjectKinds: [...rule.subjectKinds],
      },
    ];
    for (const { ruleset, rule } of everyRule) {
      for (const scenario of scenarios(rule)) {
        const outcome = assessControl(
          ruleset,
          input({ ruleKey: rule.key, controlKey: rule.key, ...scenario }),
        );
        const hasReason = outcome.unknownReason !== null;
        if (hasReason !== (outcome.state === 'UNKNOWN')) {
          inconsistent.push(
            `${ruleset.key}/${rule.key}: state ${outcome.state}, reason ${String(outcome.unknownReason)}`,
          );
        }
      }
    }
    expect(inconsistent).toEqual([]);
  });

  it('always explains itself, whatever it concludes', () => {
    const silent: string[] = [];
    for (const { ruleset, rule } of everyRule) {
      const outcome = assessControl(
        ruleset,
        input({
          ruleKey: rule.key,
          controlKey: rule.key,
          subjects: [],
          evidence: [],
          observedSubjectKinds: [...rule.subjectKinds],
        }),
      );
      // A determination a customer cannot read is not a determination they can
      // act on, challenge, or show an auditor.
      if (outcome.rationale.trim().length < 20) {
        silent.push(`${ruleset.key}/${rule.key}: "${outcome.rationale}"`);
      }
    }
    expect(silent).toEqual([]);
  });
});

describe('assessControl — SATISFIED is not reachable over unseen subjects', () => {
  it('does not report SATISFIED while any in-scope subject is unknown', () => {
    const outcome = assessControl(
      registry.get('adericel-baseline'),
      input({
        subjects: [
          identity('a', [claim('identity.mfa.enforced', true)]),
          identity('b', [claim('identity.mfa.enforced', true)]),
          // Present, in scope, and nothing known about it.
          identity('c', []),
        ],
      }),
    );
    expect(outcome.state).toBe('UNKNOWN');
    expect(outcome.unknownSubjects.map((s) => s.nodeId)).toEqual(['c']);
  });

  it('records which subjects it could not speak to, by name', () => {
    const outcome = assessControl(
      registry.get('adericel-baseline'),
      input({
        subjects: [
          identity('known-good', [claim('identity.mfa.enforced', true)]),
          identity('unseen-1', []),
          identity('unseen-2', []),
        ],
      }),
    );
    // Naming them is what makes the answer actionable: "go and look at these".
    expect(outcome.unknownSubjects.map((s) => s.nodeId).sort()).toEqual(['unseen-1', 'unseen-2']);
    expect(outcome.subjectOutcomes).toHaveLength(3);
  });

  it('ANY may report SATISFIED alongside unknowns, and this is deliberate', () => {
    // ANY asks whether at least one subject satisfies the control. One
    // confirmed pass settles that question, so unknowns elsewhere do not make
    // the answer uncertain. Recorded as a test so it is a decision rather than
    // an accident, and so a change to it has to be argued for.
    const ruleset = compileRuleset({
      key: 'test-any',
      version: '1.0.0',
      name: 'Any',
      engineVersion: '1.0.0',
      rules: [
        {
          key: 'any.rule',
          title: 'At least one identity enforces MFA',
          subjectKinds: ['Identity'],
          expression: {
            op: 'eq',
            left: { op: 'claim', predicate: 'identity.mfa.enforced' },
            right: { op: 'const', value: true },
          },
          aggregation: 'ANY',
          unknownTolerance: 1,
          failureTitle: 'No identity enforces MFA.',
          failureDescription: 'At least one identity must enforce MFA.',
        },
      ],
    });
    const outcome = assessControl(
      ruleset,
      input({
        ruleKey: 'any.rule',
        controlKey: 'any.rule',
        subjects: [identity('a', [claim('identity.mfa.enforced', true)]), identity('b', [])],
      }),
    );
    expect(outcome.state).toBe('SATISFIED');
    expect(outcome.unknownSubjects).toHaveLength(1);
  });
});

describe('assessControl — evidence provenance', () => {
  it('cites only the evidence behind the claims it actually relied on', () => {
    const outcome = assessControl(
      registry.get('adericel-baseline'),
      input({
        evidence: [evidence({ id: 'ev-used' }), evidence({ id: 'ev-unrelated' })],
        subjects: [
          identity('a', [
            claim('identity.mfa.enforced', true, { id: 'c-a', evidenceIds: ['ev-used'] }),
          ]),
        ],
      }),
    );
    expect(outcome.state).toBe('SATISFIED');
    expect(outcome.evidenceIds).toEqual(['ev-used']);
    expect(outcome.claimIds).toEqual(['c-a']);
  });

  it('cites a refused claim as consulted, and says in the reasoning why it was refused', () => {
    const outcome = assessControl(
      registry.get('adericel-baseline'),
      input({
        evidence: [evidence({ id: 'ev-ai' })],
        subjects: [
          identity('a', [
            claim('identity.mfa.enforced', true, {
              id: 'c-ai',
              origin: 'AI_SUGGESTED',
              status: 'CANDIDATE',
              evidenceIds: ['ev-ai'],
            }),
          ]),
        ],
      }),
    );
    // The lists are "what was consulted", not "what supported the answer". A
    // refused claim belongs in them, because hiding it would leave a customer
    // unable to see that Adericel looked at something and declined to use it —
    // and the reasoning must say so in words, not merely by omission.
    expect(outcome.state).toBe('UNKNOWN');
    expect(outcome.claimIds).toContain('c-ai');
    expect(outcome.evidenceIds).toContain('ev-ai');
    expect(outcome.subjectOutcomes[0]!.detail).toMatch(/AI-suggested/i);
    // And it emphatically did not count towards the determination.
    expect(outcome.unknownReason).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('carries the ruleset identity and input digest on every outcome', () => {
    for (const state of ['satisfied', 'unknown'] as const) {
      const outcome = assessControl(
        registry.get('adericel-baseline'),
        input({
          subjects: [
            identity('a', state === 'satisfied' ? [claim('identity.mfa.enforced', true)] : []),
          ],
        }),
      );
      expect(outcome.provenance.rulesetHash).toMatch(/^sha256:/);
      expect(outcome.provenance.inputDigest).toMatch(/^sha256:/);
      expect(outcome.provenance.engineVersion).toBe('1.0.0');
      expect(outcome.provenance.assessedAt).toBe(AS_OF);
    }
  });
});
