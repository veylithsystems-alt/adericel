import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_CAPABILITY,
  COMMERCIAL_STATES,
  COMMERCIAL_TRANSITIONS,
  assuranceImpactOf,
} from '@adericel/domain';
import {
  CONTAINMENT_LEVELS,
  CONTAINMENT_TRIGGERS,
  definitionOf,
  impairmentsFor,
} from '@adericel/containment';
import {
  assessControl,
  createRulesetRegistry,
  adericelBaselineV1,
  type ControlAssessmentInput,
} from '@adericel/truth-engine';

const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * Source with its comments removed.
 *
 * The checks below are about what the code does, not what it says about
 * itself. Both files explain the separation at length and name the other
 * model's vocabulary while doing it — which is the documentation working, not
 * a cascade. Scanning raw text would punish the explanation and reward its
 * absence.
 */
function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Commercial state and security containment are separate concerns.
 *
 * Contract v3.1 §16. They produce similar-looking outcomes — something stops
 * working — and conflating them is expensive in both directions:
 *
 *   - An unpaid invoice handled as a security event contains an estate that is
 *     not compromised. The customer loses observation, their assurance goes
 *     UNKNOWN, and Adericel has manufactured a security incident out of an
 *     accounts-receivable problem.
 *
 *   - A compromised credential handled as a commercial event bills a customer
 *     through an incident and leaves collection running against an integration
 *     nobody trusts.
 *
 * The separation is not a convention to be remembered. These tests assert it
 * structurally: the vocabularies do not overlap, neither module can produce the
 * other's type, and neither source file so much as names the other's values.
 */
describe('a commercial state is not a security state', () => {
  it('shares no name with a containment level or trigger', () => {
    const security = new Set<string>([
      ...CONTAINMENT_LEVELS.map(String),
      ...CONTAINMENT_TRIGGERS.map(String),
    ]);
    for (const state of COMMERCIAL_STATES) {
      expect(security.has(state)).toBe(false);
    }
  });

  it('has no function mapping one to the other, in either direction', () => {
    /**
     * The test that would have caught this being added later.
     *
     * A helper like `containmentForCommercialState` is how the separation dies:
     * it looks like a convenience, it is called from one place, and six months
     * later a suspended invoice contains an estate. Asserted over the source,
     * because a type-level check cannot see a function that does not exist yet.
     */
    const commercial = code('packages/domain/src/commercial.ts');
    const forbiddenInCommercial = [
      ...CONTAINMENT_LEVELS.map(String),
      ...CONTAINMENT_TRIGGERS.map(String),
      'definitionOf',
      'ContainmentLevel',
    ];
    for (const name of forbiddenInCommercial) {
      // `C0`–`C5` are short enough to appear inside an unrelated word, so the
      // match is on a whole token.
      expect(commercial).not.toMatch(new RegExp(`\\b${name}\\b`));
    }

    const containmentSources = [
      'packages/containment/src/level.ts',
      'packages/containment/src/trigger.ts',
      'packages/containment/src/authority.ts',
      'packages/containment/src/recovery.ts',
      'packages/containment/src/impairment.ts',
    ].map(code);

    for (const source of containmentSources) {
      for (const state of COMMERCIAL_STATES) {
        // ACTIVE and UNKNOWN are ordinary words elsewhere in the domain, so
        // only the states that could only mean the commercial model are
        // checked — the ones a cascade would actually have to name.
        if (state === 'ACTIVE' || state === 'UNKNOWN' || state === 'DRAFT') continue;
        expect(source).not.toMatch(new RegExp(`\\b${state}\\b`));
      }
      expect(source).not.toMatch(/\bsubscription\b/i);
      expect(source).not.toMatch(/\binvoice\b/i);
    }
  });

  it('refuses a commercial state where a containment level is expected', () => {
    // Types stop at the process boundary. A value arriving from a column or a
    // request body must be refused by name rather than returning undefined and
    // crashing a line later, which would read as a bug in containment rather
    // than as the category error it is.
    for (const state of COMMERCIAL_STATES) {
      expect(() => definitionOf(state as never)).toThrow(/not a containment level/i);
    }
  });

  it('impairs no predicate on commercial grounds', () => {
    /**
     * `impairmentsFor` is how a security state reaches the Truth Engine — it
     * turns containment into DEGRADED or BLOCKED predicates. If a commercial
     * state could produce an impairment, an unpaid invoice would turn a
     * customer's controls UNKNOWN, which is exactly the cascade §16 forbids.
     *
     * Containment's own entry point refuses a commercial state outright.
     */
    for (const state of COMMERCIAL_STATES) {
      expect(() =>
        impairmentsFor({
          level: state as never,
          predicates: ['identity.mfa.enforced'],
          since: '2026-09-16T00:00:00.000Z',
          reason: 'a commercial state must never reach here',
        }),
      ).toThrow(/not a containment level/i);
    }
  });
});

describe('billing is never assurance truth', () => {
  it('changes no assurance outcome, at any commercial state', () => {
    for (const state of COMMERCIAL_STATES) {
      expect(assuranceImpactOf(state).changesAnyOutcome).toBe(false);
    }
  });

  it('has no billing field anywhere in what the Truth Engine is given', () => {
    /**
     * Contract v3.1 §16, E4. The engine decides from claims, evidence,
     * exceptions and predicate impairment. If a commercial field could reach
     * `ControlAssessmentInput`, somebody would eventually read it.
     *
     * Asserted over the interface's own source rather than a constructed
     * value, because a field nobody sets today is still a field.
     */
    const engine = code('packages/truth-engine/src/engine.ts');
    const input = engine.slice(
      engine.indexOf('export interface ControlAssessmentInput'),
      engine.indexOf('export interface ControlAssessmentInput') + 4000,
    );
    const declaration = input.slice(0, input.indexOf('\n}\n') + 3);

    for (const forbidden of [
      'subscription',
      'billing',
      'plan',
      'invoice',
      'payment',
      'entitlement',
      'commercial',
      'price',
      'tier',
    ]) {
      expect(declaration.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('decides the same thing whatever the account is doing', () => {
    /**
     * The behavioural half. The engine is a pure function of its input, and no
     * commercial field is in that input — so this asserts what that means in
     * practice: the same facts decide the same way, and there is no argument
     * through which an account's position could change the answer.
     */
    const baseline = createRulesetRegistry([adericelBaselineV1]).get('adericel-baseline');
    const input: ControlAssessmentInput = {
      organisationId: 'org-commercial',
      controlId: 'ctl-1',
      controlKey: 'identity.mfa.enforced',
      ruleKey: 'identity.mfa.enforced',
      parameters: {},
      asOfIso: '2026-09-16T00:00:00.000Z',
      subjects: [],
      organisationClaims: [],
      evidence: [],
      activeExceptions: [],
      observedSubjectKinds: ['Identity'],
      impairments: [],
    };

    // One call per commercial state there is. The state cannot be passed in at
    // all, which is the point: the only way to vary the answer is to vary the
    // facts, and the digest proves the input was identical each time.
    const first = assessControl(baseline, input);
    for (const state of COMMERCIAL_STATES) {
      expect(COMMERCIAL_CAPABILITY[state].readOwnRecord).toBe(true);
      const again = assessControl(baseline, input);
      expect(again.state).toBe(first.state);
      expect(again.provenance.inputDigest).toBe(first.provenance.inputDigest);
    }
  });
});

describe('the transition table is total and closed', () => {
  it('names every state on both sides', () => {
    for (const state of COMMERCIAL_STATES) {
      expect(COMMERCIAL_TRANSITIONS[state]).toBeDefined();
      for (const target of COMMERCIAL_TRANSITIONS[state]) {
        expect(COMMERCIAL_STATES).toContain(target);
      }
    }
  });
});
