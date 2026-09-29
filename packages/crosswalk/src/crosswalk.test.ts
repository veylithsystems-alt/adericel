import { describe, expect, it } from 'vitest';
import {
  CROSSWALK_CONFIDENCE,
  CROSSWALK_PROVENANCE,
  CROSSWALK_RELATIONS,
  EVIDENCE_BEARING_RELATIONS,
  RELATION_MEANING,
  SYMMETRIC_RELATIONS,
  crosswalkCoverage,
  crosswalkProblems,
  crosswalkSchema,
  isUsable,
  readableInReverse,
  reverseOf,
  setProblems,
  stateFromCrosswalks,
  type Crosswalk,
} from './index.js';

/**
 * Framework crosswalks.
 *
 * Contract v3.2 requires them and constrains them in one sentence: "One
 * observation may satisfy multiple controls, but the system must never imply
 * equivalence where the underlying requirements differ."
 *
 * Two properties carry this file, and the second is the more important:
 *
 *   1. A crosswalk is **directed**. A symmetric pair is an equivalence claim,
 *      and almost no two requirements in two real schemes are equivalent.
 *   2. A crosswalk **never determines anything**. It says where evidence may
 *      already exist. The Truth Engine still decides, over the destination
 *      requirement's own controls and the organisation's own observations.
 *
 * The commercially attractive feature — "answer ISO 27001 automatically from
 * your Cyber Essentials evidence" — is the one that would make the product
 * worthless, because every determination would then rest on somebody's opinion
 * about two paragraphs of prose.
 */

function crosswalk(overrides: Partial<Crosswalk> = {}): Crosswalk {
  return crosswalkSchema.parse({
    key: 'ce-3.2:access.mfa_on_cloud_services->iso-27001:A.5.17',
    sourceFrameworkKey: 'cyber-essentials',
    sourceFrameworkVersion: '3.2',
    sourceRequirementKey: 'access.mfa_on_cloud_services',
    destinationFrameworkKey: 'iso-27001',
    destinationFrameworkVersion: '2022',
    destinationRequirementKey: 'A.5.17',
    relation: 'PARTIALLY_SATISFIES',
    rationale:
      'Cyber Essentials requires multi-factor authentication on cloud services; A.5.17 governs ' +
      'authentication information across the whole estate, including on-premises systems and ' +
      'secret handling, which Cyber Essentials does not reach.',
    confidence: 'HIGH',
    confidenceBecause:
      'Both requirement texts were read side by side and the remainder was identified.',
    appliesWhen: 'Always, for any organisation using cloud services.',
    provenance: 'NAMED_PERSON',
    provenanceDetail: 'Mapped by the Veylith assurance lead.',
    assertedAt: '2026-09-29',
    confirmedBy: null,
    ...overrides,
  });
}

describe('a crosswalk is directed', () => {
  it('names a relation for every way two requirements can relate', () => {
    expect(CROSSWALK_RELATIONS).toHaveLength(6);
    for (const relation of CROSSWALK_RELATIONS) {
      expect(RELATION_MEANING[relation].length, relation).toBeGreaterThan(60);
    }
  });

  it('treats only genuinely symmetric relations as readable in reverse', () => {
    expect([...SYMMETRIC_RELATIONS]).toEqual(['EQUIVALENT', 'CONFLICTS', 'UNRELATED']);
    // SATISFIES reversed is not SATISFIES, and PARTIALLY_SATISFIES reversed is
    // not anything: A going some way towards B implies nothing about B.
    expect(readableInReverse('SATISFIES')).toBe(false);
    expect(readableInReverse('PARTIALLY_SATISFIES')).toBe(false);
    expect(readableInReverse('SUPPORTS')).toBe(false);
  });

  it('refuses to flip a directed crosswalk', () => {
    /**
     * The defect a mapping table has by existing.
     *
     * A caller wanting "what maps to this requirement" must query for
     * crosswalks whose destination it is. Flipping the ones whose source it is
     * turns a partial contribution into a claim nobody made.
     */
    expect(reverseOf(crosswalk({ relation: 'PARTIALLY_SATISFIES' }))).toBeNull();
    expect(reverseOf(crosswalk({ relation: 'SATISFIES' }))).toBeNull();
    expect(reverseOf(crosswalk({ relation: 'SUPPORTS' }))).toBeNull();
  });

  it('flips a conflict, because a conflict is mutual', () => {
    const reversed = reverseOf(crosswalk({ relation: 'CONFLICTS' }));
    expect(reversed).not.toBeNull();
    expect(reversed?.sourceRequirementKey).toBe('A.5.17');
    expect(reversed?.destinationRequirementKey).toBe('access.mfa_on_cloud_services');
  });
});

describe('the seven things every crosswalk preserves', () => {
  it('requires all seven, with no defaults', () => {
    // Contract v3.2: source framework, destination framework, mapping
    // rationale, confidence, applicability, version and provenance. A default
    // is how six of the seven stop being supplied.
    const required = [
      'sourceFrameworkKey',
      'destinationFrameworkKey',
      'rationale',
      'confidence',
      'appliesWhen',
      'sourceFrameworkVersion',
      'destinationFrameworkVersion',
      'provenance',
    ] as const;
    for (const field of required) {
      const { [field]: _omitted, ...rest } = crosswalk();
      expect(crosswalkSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('refuses a rationale too short to defend', () => {
    // "Similar" is the mapping table this model exists to replace.
    expect(crosswalkSchema.safeParse({ ...crosswalk(), rationale: 'Similar' }).success).toBe(false);
  });

  it('bands confidence rather than scoring it', () => {
    // A figure like 0.85 would be quoted as though somebody could say what
    // distinguishes it from 0.8. Nobody can.
    expect([...CROSSWALK_CONFIDENCE]).toEqual(['HIGH', 'MODERATE', 'LOW', 'UNKNOWN']);
    expect(crosswalkSchema.safeParse({ ...crosswalk(), confidence: 0.85 }).success).toBe(false);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    // Strict, so an import carrying `equivalent: true` fails loudly instead of
    // being silently dropped.
    expect(crosswalkSchema.safeParse({ ...crosswalk(), equivalent: true }).success).toBe(false);
  });
});

describe('what makes a crosswalk misleading rather than incomplete', () => {
  it('holds EQUIVALENT to a higher standard, because it reads both ways', () => {
    const careless = crosswalkProblems(
      crosswalk({
        relation: 'EQUIVALENT',
        rationale: 'These two requirements both concern multi-factor authentication on accounts.',
      }),
    );
    expect(careless.join(' ')).toMatch(/scope, evidence and threshold/);
  });

  it('accepts EQUIVALENT when the rationale does the work', () => {
    const careful = crosswalkProblems(
      crosswalk({
        relation: 'EQUIVALENT',
        confidence: 'HIGH',
        rationale:
          'Identical in scope (all interactive accounts on the same estate), in evidence (the ' +
          'same directory export satisfies both), and in threshold (both require every account ' +
          'without exception).',
      }),
    );
    expect(careful).toEqual([]);
  });

  it('refuses a tentative EQUIVALENT as a contradiction', () => {
    const problems = crosswalkProblems(
      crosswalk({
        relation: 'EQUIVALENT',
        confidence: 'LOW',
        rationale:
          'Same scope, same evidence, same threshold as far as could be established from the ' +
          'published texts.',
      }),
    );
    expect(problems.join(' ')).toMatch(/cannot be asserted tentatively/);
  });

  it('will not let an unassessed mapping bear evidence', () => {
    for (const relation of EVIDENCE_BEARING_RELATIONS) {
      const problems = crosswalkProblems(
        crosswalk({
          relation,
          confidence: 'UNKNOWN',
          rationale:
            'Recorded from a third-party mapping spreadsheet without reading either requirement ' +
            'text, which is exactly the provenance this check exists for.',
        }),
      );
      expect(problems.join(' '), relation).toMatch(/may not bear evidence|cannot be asserted/);
    }
  });

  it('refuses a crosswalk from a framework to itself at the same version', () => {
    const problems = crosswalkProblems(
      crosswalk({
        destinationFrameworkKey: 'cyber-essentials',
        destinationFrameworkVersion: '3.2',
        destinationRequirementKey: 'access.mfa_on_admin_accounts',
      }),
    );
    expect(problems.join(' ')).toMatch(/requirement hierarchy/);
  });

  it('allows a crosswalk between two versions of one framework', () => {
    // A scheme revision is exactly what a crosswalk is for.
    const problems = crosswalkProblems(
      crosswalk({
        destinationFrameworkKey: 'cyber-essentials',
        destinationFrameworkVersion: '3.3',
        destinationRequirementKey: 'access.mfa_on_cloud_services',
      }),
    );
    expect(problems).toEqual([]);
  });

  it('catches one directed pair asserted twice with different relations', () => {
    const problems = setProblems([
      crosswalk({ key: 'pair-one', relation: 'SATISFIES' }),
      crosswalk({ key: 'pair-two', relation: 'SUPPORTS' }),
    ]);
    expect(problems.map((p) => p.key)).toEqual(['pair-two']);
    expect(problems[0]?.problems.join(' ')).toMatch(/would decide what Adericel claims/);
  });
});

describe('a model may propose a crosswalk and may not act on one', () => {
  it('names the provenances a crosswalk can have', () => {
    expect([...CROSSWALK_PROVENANCE]).toEqual([
      'SCHEME_PUBLISHED',
      'NAMED_PERSON',
      'DERIVED_FROM_PUBLISHED',
      'AI_SUGGESTED',
    ]);
  });

  it('refuses to use an unconfirmed AI-suggested crosswalk', () => {
    const suggested = crosswalk({ provenance: 'AI_SUGGESTED', confirmedBy: null });
    expect(isUsable(suggested)).toBe(false);

    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [suggested],
    );
    expect(coverage.leads).toEqual([]);
    expect(coverage.excluded[0]?.because).toMatch(/not confirmed by a person/);
  });

  it('uses it once a named person confirms it', () => {
    const confirmed = crosswalk({
      provenance: 'AI_SUGGESTED',
      confirmedBy: 'The Veylith assurance lead',
    });
    expect(isUsable(confirmed)).toBe(true);
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [confirmed],
    );
    expect(coverage.leads).toHaveLength(1);
  });

  it('treats a scheme-published crosswalk as usable without confirmation', () => {
    expect(isUsable(crosswalk({ provenance: 'SCHEME_PUBLISHED' }))).toBe(true);
  });
});

describe('a crosswalk never determines anything', () => {
  it('returns UNKNOWN whatever the crosswalks say, including EQUIVALENT', () => {
    /**
     * The invariant of the package.
     *
     * The function exists so the refusal is a thing in the codebase rather than
     * an absence somebody has to notice, and so a future caller reaching for
     * "what does the crosswalk make this" finds the reason instead of writing
     * the join themselves.
     */
    const equivalent = crosswalk({
      relation: 'EQUIVALENT',
      confidence: 'HIGH',
      rationale: 'Identical scope, identical evidence, identical threshold.',
    });
    const outcome = stateFromCrosswalks([equivalent, equivalent, equivalent]);
    expect(outcome.state).toBe('UNKNOWN');
    expect(outcome.because).toMatch(/never establishes an assurance state/);
    expect(outcome.because).toMatch(/observes nothing about this organisation/);
  });

  it('carries a null contribution on every coverage result', () => {
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [crosswalk()],
    );
    expect(coverage.contributesState).toBeNull();
    expect(coverage.statement).toMatch(/None of them determines it/);
  });

  it('says on every single lead that it does not determine the requirement', () => {
    // Identical on all of them by design: a caveat that appears once at the top
    // of a list is a caveat that gets truncated in a table cell.
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [
        crosswalk({ key: 'lead-mfa', sourceRequirementKey: 'access.mfa_on_cloud_services' }),
        crosswalk({ key: 'lead-admin', sourceRequirementKey: 'access.admin_separation' }),
      ],
    );
    expect(coverage.leads).toHaveLength(2);
    for (const lead of coverage.leads) {
      expect(lead.doesNotDetermine).toMatch(/still comes from the Truth Engine/);
    }
  });
});

describe('what the coverage view tells an operator', () => {
  it('orders leads by how much they actually buy', () => {
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [
        crosswalk({ key: 'lead-supports', relation: 'SUPPORTS', sourceRequirementKey: 'req.a' }),
        crosswalk({ key: 'lead-satisfies', relation: 'SATISFIES', sourceRequirementKey: 'req.b' }),
        crosswalk({
          key: 'lead-partial',
          relation: 'PARTIALLY_SATISFIES',
          sourceRequirementKey: 'req.c',
        }),
      ],
    );
    expect(coverage.leads.map((l) => l.relation)).toEqual([
      'SATISFIES',
      'PARTIALLY_SATISFIES',
      'SUPPORTS',
    ]);
  });

  it('warns that a partial mapping leaves a remainder', () => {
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [crosswalk({ relation: 'PARTIALLY_SATISFIES' })],
    );
    expect(coverage.leads[0]?.worthLookingBecause).toMatch(/Expect a remainder/);
  });

  it('surfaces a conflict as a decision for the organisation, not as a lead', () => {
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [
        crosswalk({
          key: 'clash-passwords',
          relation: 'CONFLICTS',
          rationale:
            'One scheme requires a password minimum of twelve characters with no expiry; the ' +
            'other mandates ninety-day rotation, and rotation is what the first forbids.',
        }),
      ],
    );
    expect(coverage.leads).toEqual([]);
    expect(coverage.conflicts).toHaveLength(1);
    expect(coverage.statement).toMatch(/conflict with it/);
    expect(coverage.statement).toMatch(/decision for the organisation/);
  });

  it('distinguishes "nobody looked" from "somebody looked and there is nothing"', () => {
    /**
     * The whole point of UNRELATED.
     *
     * Without it, an empty result means either that no crosswalk exists or that
     * somebody assessed the pair and found no relationship — and those lead to
     * completely different work.
     */
    const nobodyLooked = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.9.9' },
      [],
    );
    expect(nobodyLooked.leads).toEqual([]);
    expect(nobodyLooked.excluded).toEqual([]);

    const somebodyLooked = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [
        crosswalk({
          relation: 'UNRELATED',
          confidence: 'HIGH',
          rationale:
            'Read both requirement texts in full; the Cyber Essentials condition concerns device ' +
            'firewalls and A.5.17 concerns authentication information. No relationship.',
        }),
      ],
    );
    expect(somebodyLooked.leads).toEqual([]);
    expect(somebodyLooked.excluded[0]?.because).toMatch(/finding rather than a gap/);
  });

  it('tells an operator plainly when nothing helps', () => {
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.9.9' },
      [],
    );
    expect(coverage.statement).toMatch(/established on its own evidence/);
  });

  it('ignores a crosswalk aimed at a different version of the destination', () => {
    // A scheme revision can change a requirement's substance, so a mapping to
    // the 2013 edition must not silently answer the 2022 one.
    const coverage = crosswalkCoverage(
      { frameworkKey: 'iso-27001', frameworkVersion: '2022', requirementKey: 'A.5.17' },
      [crosswalk({ destinationFrameworkVersion: '2013' })],
    );
    expect(coverage.leads).toEqual([]);
  });
});
