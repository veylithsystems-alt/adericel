import { type z } from 'zod';
import type { SovereigntyClass, InferenceProvider } from './sovereignty.js';

/**
 * The inference contract.
 *
 * Every call into a model in Adericel goes through this shape, and the shape is
 * built around three refusals.
 *
 * REFUSAL, NEVER A GUESS. A model that is unreachable, slow, or returns
 * something unparseable produces a REFUSED outcome naming what happened. It
 * never produces an empty result, because an empty result reads as "nothing
 * found in the document" and that is a different and much more dangerous
 * statement than "Adericel could not read the document".
 *
 * A PROPOSAL, NEVER A CONCLUSION. There is no outcome in this file that can
 * become an assurance state. The strongest thing inference can produce is a
 * structured value that something downstream turns into a CANDIDATE claim for a
 * person to confirm (ADR-0004). That is enforced in the domain model and in the
 * Truth Engine, and this layer is built so as not to tempt anybody.
 *
 * THE DOCUMENT IS HOSTILE. Adericel reads documents supplied by suppliers,
 * customers and whoever emailed the customer. Any of them may contain text
 * addressed to the model rather than to a reader. Containment is structural:
 * the output is constrained to a schema, anything outside it is dropped, and
 * the strongest thing an injected instruction can achieve is a candidate claim
 * that a human reads before confirming.
 */

export const INFERENCE_TASKS = [
  /** Pull structured facts out of a document — certificate dates, scope. */
  'EVIDENCE_EXTRACTION',
  /** Split a questionnaire into questions. Never answers one (ADR-0034). */
  'QUESTION_SEGMENTATION',
  /** Propose what a question is asking. A person decides if it is right. */
  'QUESTION_INTERPRETATION',
  /** Summarise a finding for a human reader. Changes no state. */
  'NARRATIVE_SUMMARY',
] as const;
export type InferenceTask = (typeof INFERENCE_TASKS)[number];

export const INFERENCE_REFUSALS = [
  /** No provider configured. The honest, default answer. */
  'NOT_CONFIGURED',
  /** The model could not be reached, or the host refused the connection. */
  'MODEL_UNAVAILABLE',
  /** The named model is not present on the host. */
  'MODEL_NOT_PULLED',
  /** The call exceeded its deadline and was abandoned. */
  'TIMED_OUT',
  /** The response was not JSON, or was truncated mid-value. */
  'UNPARSEABLE_OUTPUT',
  /**
   * The response parsed but did not match the requested schema.
   *
   * Reported separately from UNPARSEABLE_OUTPUT because it is the signature of
   * a document trying to talk to the model: valid JSON carrying fields nobody
   * asked for.
   */
  'SCHEMA_VIOLATION',
  /** The document exceeds what this task will send to a model. */
  'DOCUMENT_TOO_LARGE',
  /** The provider answered with an error status. */
  'PROVIDER_ERROR',
] as const;
export type InferenceRefusal = (typeof INFERENCE_REFUSALS)[number];

/**
 * What produced a value, recorded alongside it.
 *
 * A candidate claim that a person is asked to confirm has to be traceable to
 * the exact thing that proposed it. "The AI suggested it" is not traceable;
 * this is. It also makes a bad model identifiable after the fact: if a
 * particular build of a particular model produced claims that kept being
 * rejected, the record says so.
 */
export interface InferenceProvenance {
  readonly task: InferenceTask;
  readonly provider: InferenceProvider;
  readonly sovereignty: SovereigntyClass;
  /** Whether the data stayed on infrastructure the operator controls. */
  readonly sovereign: boolean;
  readonly model: string;
  /**
   * The provider's own identifier for the exact weights, where it gives one.
   *
   * Null when the provider will not say. Null rather than the model name
   * repeated: a name is not a digest, and recording one as though it were would
   * make an unreproducible call look reproducible.
   */
  readonly modelDigest: string | null;
  /** Content hash of the exact prompt sent. The prompt itself is not stored. */
  readonly promptHash: string;
  /** Content hash of the raw response, before parsing. */
  readonly responseHash: string | null;
  readonly requestedAt: string;
  readonly durationMs: number;
  /**
   * Whether the call was made with settings that should reproduce.
   *
   * Temperature zero and a fixed seed. "Should" is doing real work in that
   * sentence: inference on a GPU is not bit-reproducible across driver
   * versions, batch sizes or hardware, and claiming determinism here would be
   * claiming something this code cannot deliver. It means the request asked for
   * the reproducible settings, not that the answer is guaranteed identical.
   */
  readonly settingsReproducible: boolean;
}

export interface InferenceProduced<T> {
  readonly status: 'PRODUCED';
  readonly value: T;
  readonly provenance: InferenceProvenance;
  /**
   * What this is and is not.
   *
   * Carried on the successful path deliberately. The failure path explains
   * itself; the success path is where somebody is tempted to treat the output
   * as an answer.
   */
  readonly standing: string;
}

export interface InferenceRefused {
  readonly status: 'REFUSED';
  readonly reason: InferenceRefusal;
  readonly detail: string;
  readonly provenance: InferenceProvenance;
}

export type InferenceOutcome<T> = InferenceProduced<T> | InferenceRefused;

/**
 * The sentence that travels with every produced value.
 *
 * One string, used everywhere, so it cannot drift into something softer in the
 * part of the interface somebody is actually reading.
 */
export const PROPOSAL_STANDING =
  'A model proposed this from the document. It is a candidate for a person to confirm, not a ' +
  'determination. Nothing in Adericel will treat it as evidence of anything until somebody ' +
  'named has read it against the source.';

export interface InferenceRequest<T> {
  readonly task: InferenceTask;
  /**
   * The instruction. Written by Adericel, never by a document or a user.
   *
   * Kept separate from the document for a reason that is the whole containment
   * design: the system text is trusted and the document is not, and a single
   * concatenated string makes that distinction unrecoverable.
   */
  readonly instruction: string;
  /**
   * The untrusted material. May contain anything, including text addressed to
   * the model.
   */
  readonly document: string;
  /** The only shape an answer may take. Anything else is a SCHEMA_VIOLATION. */
  readonly schema: z.ZodType<T>;
  /** The same shape, as JSON Schema, for providers that constrain decoding. */
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens?: number;
}

/**
 * A provider Adericel can ask.
 *
 * Deliberately narrow: one call, structured output, no streaming, no tool use,
 * no conversation. A model in this product reads something and returns a shape.
 * Anything broader would be building an agent, and the authority model
 * (ADR-0004, ADR-0014, ADR-0015) says there is no agent here.
 */
export interface InferenceClient {
  readonly provider: InferenceProvider;
  readonly sovereignty: SovereigntyClass;
  readonly model: string;
  /** Whether this client can do anything at all. False for the null client. */
  readonly available: boolean;
  infer<T>(request: InferenceRequest<T>): Promise<InferenceOutcome<T>>;
  /** Reachability, for the health endpoint. Never throws. */
  probe(): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  readonly reachable: boolean;
  readonly modelPresent: boolean;
  readonly detail: string;
  readonly checkedAt: string;
}
