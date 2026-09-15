import type { Clock } from '@adericel/shared';
import {
  PROPOSAL_STANDING,
  type InferenceClient,
  type InferenceOutcome,
  type InferenceRequest,
  type ProviderHealth,
} from './contract.js';
import { createOllamaClient } from './ollama.js';
import { createOpenAiCompatibleClient } from './openai-compatible.js';
import {
  decideSovereignty,
  profileOf,
  type InferenceProvider,
  type SovereigntyDecision,
} from './sovereignty.js';

/**
 * Building the inference client, with the sovereignty decision made first.
 *
 * The order matters. `decideSovereignty` runs before any client is constructed,
 * so a deployment that has pointed itself outside the operator's infrastructure
 * without saying so fails here, at start-up, rather than on the first document
 * somebody uploads.
 */

export interface InferenceConfig {
  readonly provider: InferenceProvider;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly externalAcknowledgement: string;
}

/**
 * The client for a deployment with no inference configured.
 *
 * Not a stub and not a silent no-op. It refuses every call with
 * NOT_CONFIGURED, so a caller receives a refusal it must handle rather than an
 * empty array it will render as "nothing found in this document".
 *
 * That distinction is the difference between "we did not look" and "we looked
 * and there was nothing", and an assurance product that blurs it is the
 * product this one exists to replace.
 */
export function createNullClient(clock: Clock): InferenceClient {
  const refuse = <T>(request: InferenceRequest<T>): InferenceOutcome<T> => ({
    status: 'REFUSED',
    reason: 'NOT_CONFIGURED',
    detail:
      'No inference provider is configured, so Adericel has proposed nothing. This is the ' +
      'default and it is not a fault: AI only ever proposes candidate claims a person must ' +
      'confirm, and every assurance determination works without it.',
    provenance: {
      task: request.task,
      provider: 'none',
      sovereignty: 'LOCAL_PROCESS',
      sovereign: true,
      model: 'none',
      modelDigest: null,
      promptHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      responseHash: null,
      requestedAt: clock.nowIso(),
      durationMs: 0,
      settingsReproducible: true,
    },
  });

  return {
    provider: 'none',
    sovereignty: 'LOCAL_PROCESS',
    model: 'none',
    available: false,
    infer: <T>(request: InferenceRequest<T>) => Promise.resolve(refuse(request)),
    probe: (): Promise<ProviderHealth> =>
      Promise.resolve({
        reachable: true,
        modelPresent: false,
        detail:
          'No inference provider is configured. Nothing is wrong: Adericel is fully functional ' +
          'without one.',
        checkedAt: clock.nowIso(),
      }),
  };
}

export interface InferenceRuntime {
  readonly client: InferenceClient;
  readonly sovereignty: SovereigntyDecision;
}

export function createInferenceRuntime(
  config: InferenceConfig,
  clock: Clock,
  fetchImpl?: typeof fetch,
): InferenceRuntime {
  // First, and before anything is constructed. An unacknowledged external
  // provider throws here and the process does not start.
  const sovereignty = decideSovereignty({
    provider: config.provider,
    externalAcknowledgement: config.externalAcknowledgement,
  });

  if (config.provider === 'none') {
    return { client: createNullClient(clock), sovereignty };
  }

  const shared = {
    model: config.model,
    requestTimeoutMs: config.requestTimeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    clock,
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  if (config.provider === 'ollama') {
    return {
      client: createOllamaClient({ ...shared, baseUrl: config.baseUrl }),
      sovereignty,
    };
  }

  return {
    client: createOpenAiCompatibleClient({
      ...shared,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    }),
    sovereignty,
  };
}

/**
 * What may be said publicly about how this deployment does inference.
 *
 * An MSP is asked "where does our data go" by every customer with a lawyer, and
 * today the answer is a conversation. This makes it a field they can point at.
 *
 * It names the provider, the class, the model and the operator's own
 * acknowledgement — and no endpoint, no key, no prompt, no document. A
 * base URL can name an internal host, and an internal hostname is a small gift
 * to somebody mapping the estate.
 */
export function describeInference(runtime: InferenceRuntime): {
  provider: InferenceProvider;
  sovereignty: string;
  sovereign: boolean;
  model: string;
  enabled: boolean;
  meaning: string;
  acknowledgement: string | null;
  standing: string;
} {
  return {
    provider: runtime.sovereignty.provider,
    sovereignty: runtime.sovereignty.sovereignty,
    sovereign: runtime.sovereignty.sovereign,
    model: runtime.client.model,
    enabled: runtime.client.available,
    meaning: profileOf(runtime.sovereignty.provider).meaning,
    acknowledgement: runtime.sovereignty.acknowledgement,
    standing: PROPOSAL_STANDING,
  };
}
