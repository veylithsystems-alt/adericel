import { describe, expect, it } from 'vitest';
import {
  decideSovereignty,
  INFERENCE_PROVIDERS,
  isSovereign,
  MINIMUM_ACKNOWLEDGEMENT_LENGTH,
  profileOf,
  PROVIDER_PROFILES,
} from './sovereignty.js';

/**
 * Sovereignty, tested as a structural property rather than a preference.
 *
 * The claim these defend: a deployment cannot end up sending a customer's
 * documents outside the operator's infrastructure by accident, by omission, by
 * a default changing in a minor release, or by one person flipping one flag
 * without writing down what they understood.
 */

const ACKNOWLEDGEMENT =
  'Processed by Contoso Cloud Ltd in the United Kingdom under DPA 2024-11, approved by M. Rowe.';

describe('the local path is the default path', () => {
  it('defaults to no inference, which is a complete deployment', () => {
    const decision = decideSovereignty({ provider: 'none', externalAcknowledgement: '' });
    expect(decision.sovereign).toBe(true);
    expect(decision.acknowledgement).toBeNull();
  });

  it('treats a locally hosted model as sovereign, with nothing to acknowledge', () => {
    const decision = decideSovereignty({ provider: 'ollama', externalAcknowledgement: '' });
    expect(decision.sovereignty).toBe('LOCAL_NETWORK');
    expect(decision.sovereign).toBe(true);
    expect(decision.acknowledgement).toBeNull();
  });

  it('classifies every provider, so a new one cannot arrive unclassified', () => {
    for (const provider of INFERENCE_PROVIDERS) {
      const profile = profileOf(provider);
      expect(profile.provider).toBe(provider);
      expect(profile.meaning.length).toBeGreaterThan(40);
    }
    expect(Object.keys(PROVIDER_PROFILES).sort()).toEqual([...INFERENCE_PROVIDERS].sort());
  });

  it('names only providers it can actually build', () => {
    // The gap this replaces: the old config offered `anthropic` and no client
    // existed. A provider an operator can select and Adericel cannot construct
    // is a promise the repository does not keep.
    expect([...INFERENCE_PROVIDERS]).toEqual(['none', 'ollama', 'openai-compatible']);
  });
});

describe('leaving the operator’s infrastructure requires saying so', () => {
  it('refuses to start on an external provider with no acknowledgement', () => {
    expect(() =>
      decideSovereignty({ provider: 'openai-compatible', externalAcknowledgement: '' }),
    ).toThrow(/Adericel is local-first by design/);
  });

  it('refuses a one-word acknowledgement, because a checkbox is not a decision', () => {
    expect(() =>
      decideSovereignty({ provider: 'openai-compatible', externalAcknowledgement: 'yes' }),
    ).toThrow(/name the operator and the jurisdiction/);
  });

  it('refuses whitespace dressed up as an acknowledgement', () => {
    expect(() =>
      decideSovereignty({
        provider: 'openai-compatible',
        externalAcknowledgement: ' '.repeat(MINIMUM_ACKNOWLEDGEMENT_LENGTH + 10),
      }),
    ).toThrow();
  });

  it('records the acknowledgement verbatim when one is given', () => {
    const decision = decideSovereignty({
      provider: 'openai-compatible',
      externalAcknowledgement: ACKNOWLEDGEMENT,
    });
    expect(decision.sovereign).toBe(false);
    expect(decision.sovereignty).toBe('EXTERNAL');
    expect(decision.acknowledgement).toBe(ACKNOWLEDGEMENT);
  });

  it('classifies an OpenAI-protocol endpoint as external even though it may be local', () => {
    // The protocol says nothing about who runs the endpoint. Classifying by
    // protocol would let a vendor API in through a door labelled local; an
    // operator with their own GPU box writes one sentence and the
    // classification stays true for everybody who reads it afterwards.
    expect(profileOf('openai-compatible').sovereignty).toBe('EXTERNAL');
    expect(profileOf('openai-compatible').requiresAcknowledgement).toBe(true);
  });

  it('never marks an external class as sovereign', () => {
    expect(isSovereign('EXTERNAL')).toBe(false);
    expect(isSovereign('LOCAL_NETWORK')).toBe(true);
    expect(isSovereign('LOCAL_PROCESS')).toBe(true);
  });

  it('requires an acknowledgement for exactly the providers that leave the estate', () => {
    // The invariant, rather than a list that can drift: if data leaves, it is
    // acknowledged; if it does not, nothing is demanded of the operator.
    for (const provider of INFERENCE_PROVIDERS) {
      const profile = profileOf(provider);
      expect(profile.requiresAcknowledgement).toBe(!isSovereign(profile.sovereignty));
    }
  });
});
