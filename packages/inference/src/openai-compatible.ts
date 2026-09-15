import { contentHash, type Clock } from '@adericel/shared';
import {
  PROPOSAL_STANDING,
  type InferenceClient,
  type InferenceOutcome,
  type InferenceProvenance,
  type InferenceRefusal,
  type InferenceRequest,
  type ProviderHealth,
} from './contract.js';
import { profileOf } from './sovereignty.js';
import { CONTAINMENT_PREAMBLE_TEXT, MAX_DOCUMENT_CHARS } from './ollama.js';

/**
 * An endpoint speaking the OpenAI chat protocol.
 *
 * This exists to give an operator MORE sovereign options, not fewer. vLLM,
 * llama.cpp's server, LM Studio and several UK-hosted GPU providers all speak
 * it, so an MSP who has outgrown a CPU container can move to their own GPU box
 * without Adericel needing a new client.
 *
 * It is classified EXTERNAL anyway, and that is deliberate. The protocol says
 * nothing about who operates the endpoint: the same client reaches a machine in
 * your rack and a vendor's API in another jurisdiction. Classifying by protocol
 * would let an external service in through a door labelled local. An operator
 * running their own server writes one sentence naming their own infrastructure,
 * and the classification stays true for everybody who reads it afterwards.
 */

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly clock: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly seed?: number;
}

interface ChatResponse {
  readonly choices?: { readonly message?: { readonly content?: unknown } }[];
  readonly model?: unknown;
}

export function createOpenAiCompatibleClient(options: OpenAiCompatibleOptions): InferenceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const profile = profileOf('openai-compatible');

  const provenance = (
    task: InferenceRequest<unknown>['task'],
    promptHash: string,
    responseHash: string | null,
    requestedAt: string,
    durationMs: number,
    modelDigest: string | null,
  ): InferenceProvenance => ({
    task,
    provider: 'openai-compatible',
    sovereignty: profile.sovereignty,
    // False even when the endpoint is the operator's own machine. Adericel
    // cannot tell the difference, and a provenance record that guesses is worse
    // than one that under-claims — this is the field somebody will cite to a
    // customer's solicitor.
    sovereign: false,
    model: options.model,
    modelDigest,
    promptHash,
    responseHash,
    requestedAt,
    durationMs,
    settingsReproducible: true,
  });

  async function infer<T>(request: InferenceRequest<T>): Promise<InferenceOutcome<T>> {
    const requestedAt = options.clock.nowIso();
    const startedMs = options.clock.nowEpochMs();

    const refuse = (
      reason: InferenceRefusal,
      detail: string,
      promptHash: string,
      responseHash: string | null = null,
    ): InferenceOutcome<T> => ({
      status: 'REFUSED',
      reason,
      detail,
      provenance: provenance(
        request.task,
        promptHash,
        responseHash,
        requestedAt,
        options.clock.nowEpochMs() - startedMs,
        null,
      ),
    });

    if (request.document.length > MAX_DOCUMENT_CHARS) {
      return refuse(
        'DOCUMENT_TOO_LARGE',
        `The document is ${request.document.length} characters and this task sends at most ` +
          `${MAX_DOCUMENT_CHARS}. It has not been truncated.`,
        contentHash({ oversize: request.document.length }),
      );
    }

    const nonce = contentHash(request.document).slice(-16);
    const body = {
      model: options.model,
      temperature: 0,
      seed: options.seed ?? 0,
      max_tokens: request.maxOutputTokens ?? options.maxOutputTokens,
      // Structured Outputs. Servers that do not implement it fall back to
      // best-effort JSON, which is why the schema is validated again below
      // rather than trusted because it was requested.
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'adericel_response', strict: true, schema: request.jsonSchema },
      },
      messages: [
        { role: 'system', content: `${CONTAINMENT_PREAMBLE_TEXT}\n\n${request.instruction}` },
        {
          role: 'user',
          content:
            `<<<UNTRUSTED-DOCUMENT ${nonce}>>>\n${request.document}\n` +
            `<<<END-UNTRUSTED-DOCUMENT ${nonce}>>>`,
        },
      ],
    };

    const promptHash = contentHash(body);

    let response: Response;
    try {
      response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === '' ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return refuse(
          'TIMED_OUT',
          `The endpoint did not answer within ${options.requestTimeoutMs}ms.`,
          promptHash,
        );
      }
      return refuse('MODEL_UNAVAILABLE', `Could not reach the endpoint at ${base}.`, promptHash);
    }

    if (!response.ok) {
      return refuse(
        'PROVIDER_ERROR',
        `The endpoint answered ${response.status}. No text from the response body is repeated ` +
          "here: it is outside Adericel's control and may contain anything.",
        promptHash,
      );
    }

    let raw: string;
    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        return refuse(
          'UNPARSEABLE_OUTPUT',
          'The endpoint returned no message content.',
          promptHash,
        );
      }
      raw = content;
    } catch {
      return refuse(
        'UNPARSEABLE_OUTPUT',
        'The endpoint returned a body that is not JSON.',
        promptHash,
      );
    }

    const responseHash = contentHash(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return refuse(
        'UNPARSEABLE_OUTPUT',
        'The model returned something that is not JSON.',
        promptHash,
        responseHash,
      );
    }

    const validated = request.schema.safeParse(parsed);
    if (!validated.success) {
      return refuse(
        'SCHEMA_VIOLATION',
        'The model returned JSON that does not match the requested shape, so nothing has been ' +
          `proposed. First problem: ${validated.error.issues[0]?.message ?? 'unknown'}.`,
        promptHash,
        responseHash,
      );
    }

    return {
      status: 'PRODUCED',
      value: validated.data,
      standing: PROPOSAL_STANDING,
      provenance: provenance(
        request.task,
        promptHash,
        responseHash,
        requestedAt,
        options.clock.nowEpochMs() - startedMs,
        typeof payload.model === 'string' ? payload.model : null,
      ),
    };
  }

  async function probe(): Promise<ProviderHealth> {
    const checkedAt = options.clock.nowIso();
    try {
      const response = await fetchImpl(`${base}/models`, {
        headers: options.apiKey === '' ? {} : { authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          reachable: false,
          modelPresent: false,
          detail: `The endpoint answered ${response.status}.`,
          checkedAt,
        };
      }
      const body = (await response.json()) as { data?: { id?: unknown }[] };
      const ids = (body.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');
      const present = ids.includes(options.model);
      return {
        reachable: true,
        modelPresent: present,
        // Not every compliant server lists models, so absence is reported as
        // "could not confirm" rather than as "missing". Reporting a working
        // deployment as broken teaches operators to ignore the health page.
        detail: present
          ? `"${options.model}" is offered by the endpoint.`
          : ids.length === 0
            ? 'The endpoint is reachable but lists no models, so the model could not be ' +
              'confirmed. Not every compliant server implements the listing.'
            : `The endpoint is reachable but does not list "${options.model}".`,
        checkedAt,
      };
    } catch {
      return {
        reachable: false,
        modelPresent: false,
        detail: `Could not reach the endpoint at ${base}.`,
        checkedAt,
      };
    }
  }

  return {
    provider: 'openai-compatible',
    sovereignty: profile.sovereignty,
    model: options.model,
    available: true,
    infer,
    probe,
  };
}
