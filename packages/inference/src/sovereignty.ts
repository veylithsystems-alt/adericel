import { z } from 'zod';

/**
 * Where an organisation's data goes when Adericel asks a model a question.
 *
 * This is the first thing the inference layer establishes, before a provider,
 * before a model, before a prompt — because it is the only property of an
 * inference call that an organisation cannot undo after the fact. A prompt can
 * be rewritten and a model can be swapped. A document that has left the country
 * has left the country.
 *
 * Adericel's principle is local first. Not "local supported", not "local
 * available in the enterprise tier": the default path runs on hardware the
 * operator controls, and anything else is a deliberate, named, documented
 * departure from it.
 *
 * The principle is encoded here rather than written in a README because a
 * principle that lives in a README is a principle until the first inconvenient
 * Tuesday.
 *
 * WHAT THIS IS NOT
 *
 * It is not a compliance claim. Classifying a provider as LOCAL_PROCESS does
 * not make a deployment GDPR compliant, and nothing in this file should ever be
 * quoted as though it did. It records one fact — where the bytes go — which is
 * an input to that question and not an answer to it.
 */

export const SOVEREIGNTY_CLASSES = [
  /**
   * The model runs inside this process. Nothing crosses a socket.
   *
   * Reserved for in-process inference. Adericel does not currently ship such a
   * provider; the class exists so that adding one does not require rewriting
   * the classification, and so that LOCAL_NETWORK is not quietly described as
   * the strongest thing available.
   */
  'LOCAL_PROCESS',
  /**
   * The model runs on infrastructure the operator controls, reached over a
   * network they control. An Ollama container on the same host, or a GPU box in
   * the same rack.
   *
   * This is Adericel's default and the case the product is designed around.
   */
  'LOCAL_NETWORK',
  /**
   * A third party operates the model. The organisation's data leaves the
   * operator's infrastructure entirely.
   *
   * Supported, because an MSP may have a customer who has signed a data
   * processing agreement with a hyperscaler and wants the better model. Never
   * default, never implicit, and never reachable without a separate written
   * acknowledgement naming the jurisdiction.
   */
  'EXTERNAL',
] as const;

export type SovereigntyClass = (typeof SOVEREIGNTY_CLASSES)[number];
export const sovereigntyClassSchema = z.enum(SOVEREIGNTY_CLASSES);

/** True when the operator's own infrastructure holds the data throughout. */
export function isSovereign(classification: SovereigntyClass): boolean {
  return classification === 'LOCAL_PROCESS' || classification === 'LOCAL_NETWORK';
}

export const INFERENCE_PROVIDERS = ['none', 'ollama', 'openai-compatible'] as const;
export type InferenceProvider = (typeof INFERENCE_PROVIDERS)[number];
export const inferenceProviderSchema = z.enum(INFERENCE_PROVIDERS);

export interface ProviderProfile {
  readonly provider: InferenceProvider;
  readonly sovereignty: SovereigntyClass;
  /** What an operator is actually choosing, in a sentence they can act on. */
  readonly meaning: string;
  /**
   * Whether reaching this provider requires a separate acknowledgement.
   *
   * True for anything that removes data from the operator's control. The
   * acknowledgement is not a checkbox with a warning beside it: start-up
   * refuses without it, and it must name the jurisdiction, because an operator
   * who cannot name where the data is going has not made the decision they are
   * being asked to make.
   */
  readonly requiresAcknowledgement: boolean;
}

/**
 * What each provider means for the data.
 *
 * `openai-compatible` is deliberately classified EXTERNAL despite being the
 * protocol a self-hosted vLLM or llama.cpp server speaks. The protocol says
 * nothing about who operates the endpoint — the same client talks to a box in
 * your rack and to a vendor's API — so classifying it by protocol would let an
 * external service in through a door labelled local. An operator running their
 * own OpenAI-compatible server declares it explicitly, and the acknowledgement
 * they write names their own infrastructure, which costs them one line and
 * keeps the classification honest for everybody else.
 */
export const PROVIDER_PROFILES: Readonly<Record<InferenceProvider, ProviderProfile>> = {
  none: {
    provider: 'none',
    sovereignty: 'LOCAL_PROCESS',
    meaning:
      'No inference. Adericel is fully functional: AI only ever proposes candidate claims a ' +
      'person must confirm, so nothing in the assurance chain depends on it.',
    requiresAcknowledgement: false,
  },
  ollama: {
    provider: 'ollama',
    sovereignty: 'LOCAL_NETWORK',
    meaning:
      'A model running on infrastructure you control. Documents stay on your hardware. This is ' +
      'the default and the case Adericel is designed around.',
    requiresAcknowledgement: false,
  },
  'openai-compatible': {
    provider: 'openai-compatible',
    sovereignty: 'EXTERNAL',
    meaning:
      'An endpoint speaking the OpenAI protocol — vLLM, llama.cpp, LM Studio, or a hosted ' +
      'vendor. The protocol does not say who runs it, so Adericel treats it as external until ' +
      'you say otherwise in writing, including when the endpoint is your own GPU box. One line ' +
      'of configuration, and the classification stays honest for everybody else.',
    requiresAcknowledgement: true,
  },
};

export function profileOf(provider: InferenceProvider): ProviderProfile {
  return PROVIDER_PROFILES[provider];
}

export interface SovereigntyDecision {
  readonly provider: InferenceProvider;
  readonly sovereignty: SovereigntyClass;
  readonly sovereign: boolean;
  /**
   * The operator's written acknowledgement, for an external provider.
   *
   * Recorded so that "who decided this, and what did they say they understood"
   * is answerable from the deployment rather than from somebody's memory.
   */
  readonly acknowledgement: string | null;
  readonly meaning: string;
}

/**
 * Establish what a configured provider means, refusing an unacknowledged
 * departure from local inference.
 *
 * Called at start-up. A deployment that has pointed itself at an external model
 * without saying so does not boot — which is a worse afternoon for one operator
 * and a much better outcome than a hundred MSP customers' documents leaving the
 * country because a default changed in a minor release.
 */
export function decideSovereignty(input: {
  readonly provider: InferenceProvider;
  readonly externalAcknowledgement: string;
}): SovereigntyDecision {
  const profile = profileOf(input.provider);
  const acknowledgement = input.externalAcknowledgement.trim();

  if (profile.requiresAcknowledgement) {
    if (acknowledgement === '') {
      throw new Error(
        `Refusing to start: INFERENCE_PROVIDER=${input.provider} sends your customers' ` +
          'documents outside infrastructure you control, and no acknowledgement was given. ' +
          'Adericel is local-first by design. Either set INFERENCE_PROVIDER=ollama and run the ' +
          'model on your own hardware, or set INFERENCE_EXTERNAL_ACKNOWLEDGEMENT to a sentence ' +
          'naming the operator and the jurisdiction the data will be processed in. The sentence ' +
          'is recorded and reported; it exists so the decision has an author.',
      );
    }
    if (acknowledgement.length < MINIMUM_ACKNOWLEDGEMENT_LENGTH) {
      // A one-word acknowledgement is a checkbox, and a checkbox is not a
      // decision anybody made. The length is not security; it is the smallest
      // thing that forces a sentence rather than "yes".
      throw new Error(
        'Refusing to start: INFERENCE_EXTERNAL_ACKNOWLEDGEMENT must name the operator and the ' +
          `jurisdiction your customers' data will be processed in (at least ` +
          `${MINIMUM_ACKNOWLEDGEMENT_LENGTH} characters). It is recorded verbatim and shown ` +
          'wherever the provider is reported.',
      );
    }
  }

  return {
    provider: input.provider,
    sovereignty: profile.sovereignty,
    sovereign: isSovereign(profile.sovereignty),
    acknowledgement: profile.requiresAcknowledgement ? acknowledgement : null,
    meaning: profile.meaning,
  };
}

export const MINIMUM_ACKNOWLEDGEMENT_LENGTH = 40;
