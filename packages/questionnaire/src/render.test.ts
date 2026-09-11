import { describe, expect, it } from 'vitest';
import {
  ANSWER_STATES,
  combineAnswerStates,
  mayRenderAsBarePositive,
  SENDER_TYPES,
  type AnswerDetermination,
} from './answer.js';
import {
  ALL_FORMATS,
  isBarePositive,
  renderAnswer,
  SENDER_POLICIES,
  templateFor,
} from './render.js';
import { checkConsistency } from './consistency.js';
import {
  defaultReading,
  detectAbsoluteWords,
  detectTimeWindow,
  isExportable,
} from './interpretation.js';

/**
 * The property the whole product rests on.
 *
 * ADR-0036: an answer whose determination is not SUPPORTED is never rendered as
 * an unqualified positive, in any output format, under any sender policy, by
 * any renderer.
 *
 * Not "should not" — cannot. This is a property test over the cross-product of
 * every state, every format and every sender policy, and it fails the build.
 * Care is not a control.
 */

function determination(overrides: Partial<AnswerDetermination> = {}): AnswerDetermination {
  return {
    state: 'SUPPORTED',
    reason: 'Multi-factor authentication is enforced.',
    exceptions: [],
    subjectsInScope: 49,
    subjectsSatisfying: 49,
    evidenceIds: ['e1'],
    oldestEvidenceAgeHours: 6,
    rulesetHash: 'sha256:abc',
    inputDigest: 'sha256:def',
    determinedAt: '2026-09-11T09:00:00.000Z',
    ...overrides,
  };
}

const QUALIFIED = determination({
  state: 'QUALIFIED',
  reason: 'Multi-factor authentication is enforced for most accounts.',
  subjectsSatisfying: 47,
  exceptions: [
    {
      subject: 'j.smith@client.example',
      reason: 'policy Directors-Legacy',
      since: '2026-06-03T00:00:00.000Z',
    },
    {
      subject: 'a.patel@client.example',
      reason: 'policy Directors-Legacy',
      since: '2026-06-03T00:00:00.000Z',
    },
  ],
});

describe('no silent yes', () => {
  it('never renders a non-SUPPORTED state as an unqualified positive, anywhere', () => {
    const offenders: string[] = [];

    for (const state of ANSWER_STATES) {
      if (state === 'SUPPORTED') continue;
      for (const senderType of SENDER_TYPES) {
        for (const format of ALL_FORMATS) {
          const subject =
            state === 'QUALIFIED'
              ? { ...QUALIFIED, state }
              : determination({
                  state,
                  exceptions: state === 'NOT_MET' ? QUALIFIED.exceptions : [],
                  subjectsSatisfying: state === 'NOT_MET' ? 0 : 49,
                });
          const rendered = renderAnswer(subject, format, SENDER_POLICIES[senderType]);
          if (isBarePositive(rendered.value)) {
            offenders.push(`${state} / ${senderType} / ${format} -> "${rendered.value}"`);
          }
        }
      }
    }

    // 5 states x 6 senders x 7 formats = 210 combinations, every one checked.
    expect(offenders).toEqual([]);
  });

  it('lets SUPPORTED say yes, because otherwise the engine is useless', () => {
    const rendered = renderAnswer(determination(), 'YES_NO', SENDER_POLICIES.INSURER);
    expect(rendered.value).toBe('Yes');
    expect(rendered.requiresHumanDecision).toBe(false);
  });

  it('permits a bare positive from exactly one state', () => {
    const permitted = ANSWER_STATES.filter(mayRenderAsBarePositive);
    // ATTESTED is deliberately excluded: a person's word is a different kind of
    // claim from an observation and a reader is entitled to know which.
    expect(permitted).toEqual(['SUPPORTED']);
  });

  it('puts the exceptions before the position, because that is where disputes start', () => {
    const template = templateFor(QUALIFIED, SENDER_POLICIES.CUSTOMER_DUE_DILIGENCE);
    expect(template.comment).toMatch(/^Exceptions:/);
    expect(template.comment).toContain('j.smith@client.example');
    expect(template.comment).toContain('Directors-Legacy');
    expect(template.comment).toContain('47 of 49');
  });

  it('answers an insurer more conservatively than a supplier questionnaire', () => {
    const insurer = renderAnswer(QUALIFIED, 'YES_NO_COMMENT', SENDER_POLICIES.INSURER);
    const supplier = renderAnswer(
      QUALIFIED,
      'YES_NO_COMMENT',
      SENDER_POLICIES.CUSTOMER_DUE_DILIGENCE,
    );
    // On a form whose answers form the basis of a contract, "yes with
    // exceptions" is still read as "yes" by anybody skimming.
    expect(insurer.value).toBe('No');
    expect(supplier.value).toBe('Yes, with exceptions');
    // Both must carry the exceptions.
    expect(insurer.comment).toContain('j.smith@client.example');
    expect(supplier.comment).toContain('j.smith@client.example');
  });

  it('refuses to choose when the form cannot carry the honest answer', () => {
    const rendered = renderAnswer(QUALIFIED, 'YES_NO', SENDER_POLICIES.INSURER);
    expect(rendered.requiresHumanDecision).toBe(true);
    expect(rendered.humanDecisionReason).toContain('A person must decide');
    // And it enters the conservative value while waiting.
    expect(rendered.value).toBe('No');
  });

  it('leaves a numeric field blank rather than guessing a zero', () => {
    const rendered = renderAnswer(
      determination({ state: 'UNKNOWN' }),
      'NUMBER',
      SENDER_POLICIES.INSURER,
    );
    expect(rendered.value).toBe('');
    expect(rendered.requiresHumanDecision).toBe(true);
  });
});

describe('compound questions', () => {
  it('makes one UNKNOWN part make the whole answer UNKNOWN', () => {
    expect(combineAnswerStates(['SUPPORTED', 'UNKNOWN'])).toBe('UNKNOWN');
  });

  it('lets a demonstrated failure outrank an unknown', () => {
    // A known failure is more informative. Rendering "we cannot tell" when one
    // half demonstrably fails would understate the position.
    expect(combineAnswerStates(['UNKNOWN', 'NOT_MET'])).toBe('NOT_MET');
  });

  it('carries exceptions up through the compound', () => {
    expect(combineAnswerStates(['SUPPORTED', 'QUALIFIED'])).toBe('QUALIFIED');
  });

  it('lets the weaker provenance govern a partly attested answer', () => {
    // A reader must not be told the whole thing was observed when half of it
    // was asserted.
    expect(combineAnswerStates(['SUPPORTED', 'ATTESTED'])).toBe('ATTESTED');
  });

  it('treats an all-N/A compound as N/A rather than dragging it down', () => {
    expect(combineAnswerStates(['NOT_APPLICABLE', 'NOT_APPLICABLE'])).toBe('NOT_APPLICABLE');
    expect(combineAnswerStates(['NOT_APPLICABLE', 'SUPPORTED'])).toBe('SUPPORTED');
  });

  it('answers UNKNOWN when there is nothing to combine', () => {
    expect(combineAnswerStates([])).toBe('UNKNOWN');
  });
});

describe('the consistency checker', () => {
  const templated = 'Enforced for 47 of 49 accounts. Exceptions: two named directors.';

  it('rejects "all" when exceptions exist', () => {
    const result = checkConsistency(
      'Multi-factor authentication is enforced on all user accounts.',
      QUALIFIED,
      templated,
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('UNIVERSAL_CLAIM_WITH_EXCEPTIONS');
    expect(result.replacement).toBe(templated);
  });

  it('rejects a bare yes for a non-SUPPORTED state', () => {
    const result = checkConsistency('Yes', QUALIFIED, templated);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('BARE_POSITIVE_FOR_NON_SUPPORTED');
  });

  it('rejects an assertion while the state is UNKNOWN', () => {
    const result = checkConsistency(
      'Endpoint protection is installed and enabled across the estate.',
      determination({ state: 'UNKNOWN', reason: 'no evidence' }),
      templated,
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('ASSERTION_WHILE_UNKNOWN');
  });

  it('rejects a partial answer that does not mention it is partial', () => {
    const result = checkConsistency(
      'Multi-factor authentication is enforced.',
      QUALIFIED,
      templated,
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('EXCEPTIONS_OMITTED');
  });

  it('rejects an attested answer dressed as an observation', () => {
    const result = checkConsistency(
      'An incident response plan is in place and has been exercised.',
      determination({ state: 'ATTESTED' }),
      templated,
    );
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('ATTESTATION_PRESENTED_AS_OBSERVATION');
  });

  it('accepts honest phrasing that names the exceptions', () => {
    const result = checkConsistency(
      'Enforced for 47 of 49 accounts, with the exception of two directors excluded by policy.',
      QUALIFIED,
      templated,
    );
    expect(result.accepted).toBe(true);
    expect(result.replacement).toBeNull();
  });

  it('accepts a confident phrasing when the determination is confident', () => {
    const result = checkConsistency(
      'Multi-factor authentication is enforced on all 49 user accounts.',
      determination(),
      templated,
    );
    expect(result.accepted).toBe(true);
  });
});

describe('interpretation', () => {
  it('treats absolute wording as strict by default', () => {
    const reading = defaultReading('Is MFA enforced for all remote access at all times?');
    expect(reading.strict).toBe(true);
    expect(reading.absoluteWords).toContain('all');
    expect(reading.absoluteWords).toContain('at all times');
  });

  it('does not invent strictness where the question is not absolute', () => {
    expect(defaultReading('Do you use multi-factor authentication?').strict).toBe(false);
  });

  it('reads a time window out of the wording', () => {
    expect(detectTimeWindow('Are critical patches applied within 14 days?')).toEqual({
      days: 14,
      sourcePhrase: 'within 14 days',
    });
    expect(detectTimeWindow('Is backup tested annually?')?.days).toBe(365);
    expect(detectTimeWindow('Do you have a firewall?')).toBeNull();
  });

  it('finds every absolute word it claims to', () => {
    expect(detectAbsoluteWords('Every device is fully encrypted, without exception')).toEqual(
      expect.arrayContaining(['every', 'fully', 'without exception']),
    );
  });

  it('refuses to export an unconfirmed interpretation', () => {
    // The one place hostile text in a questionnaire could reach. The worst an
    // injection achieves is a wrong proposal awaiting a human's confirmation.
    const base = {
      id: 'i1',
      questionId: 'q1',
      expression: {},
      scope: 'ALL_USERS' as const,
      strict: true,
      absoluteWords: ['all'],
      timeWindow: null,
      version: 1,
      statement: 'MFA enforced on every human account',
      confirmedBy: null,
      confirmedAt: null,
    };
    expect(isExportable({ ...base, origin: 'AI_SUGGESTED', status: 'CANDIDATE' })).toBe(false);
    expect(isExportable({ ...base, origin: 'BANK_MATCHED', status: 'CANDIDATE' })).toBe(false);
    expect(isExportable({ ...base, origin: 'AI_SUGGESTED', status: 'CONFIRMED' })).toBe(true);
  });
});

describe('sender policies', () => {
  it('requires four eyes wherever the answer forms the basis of a contract', () => {
    expect(SENDER_POLICIES.INSURER.requiresFourEyes).toBe(true);
    expect(SENDER_POLICIES.BROKER.requiresFourEyes).toBe(true);
  });

  it('watches insurance answers after submission by default', () => {
    expect(SENDER_POLICIES.INSURER.watchAfterSubmission).toBe(true);
  });

  it('defines a policy for every sender type', () => {
    for (const senderType of SENDER_TYPES) {
      expect(SENDER_POLICIES[senderType], senderType).toBeDefined();
      expect(SENDER_POLICIES[senderType].senderType).toBe(senderType);
    }
  });
});
