import { z } from 'zod';
import type { InferenceClient, InferenceProvenance, InferenceRefusal } from './contract.js';

/**
 * Grounded extraction: every proposed fact must quote the document.
 *
 * THE PROBLEM WITH EXTRACTION
 *
 * A model reading a supplier's Cyber Essentials certificate will happily return
 * an expiry date. Sometimes the date is on the certificate. Sometimes the model
 * has produced a plausible date because a plausible date is what the shape asks
 * for, and "2027-01-31" is indistinguishable from "2027-01-31" whichever way it
 * arrived. A reviewer confirming a hundred of these will not open a hundred
 * PDFs, and the one they do not open is the one that was invented.
 *
 * THE FIX THAT IS NOT A FIX
 *
 * Confidence scores. A model's confidence is not calibrated to whether it made
 * something up, and ADR-0004 already refuses to let one become an assurance
 * state. A number that looks like rigour and is not is worse than nothing.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Every extracted value must come with the verbatim span of the document it was
 * read from — and Adericel checks that the span actually appears in the
 * document. That check is mechanical, deterministic, and needs no model:
 * `document.includes(quote)`. A fabricated citation is caught by string search.
 *
 * This does not make the extraction correct. A model can quote a real sentence
 * and draw the wrong conclusion from it, and this catches none of that. What it
 * catches is the failure mode that matters at scale — a value with no basis in
 * the document at all — and it gives the reviewer the sentence to look at, so
 * confirming becomes a two-second check rather than a five-minute read.
 *
 * An ungrounded field is dropped. Not flagged, not scored: dropped, with the
 * drop recorded. A value that cannot show where it came from has not earned a
 * person's attention.
 */

export const groundedValueSchema = z
  .object({
    /** The extracted value, as it should be recorded. Null when absent. */
    value: z.string().nullable(),
    /**
     * The exact text from the document this was read from.
     *
     * Verbatim, not paraphrased. A paraphrase cannot be checked against the
     * source, which is the entire point.
     */
    quote: z.string().nullable(),
  })
  .strict();

export type GroundedValue = z.infer<typeof groundedValueSchema>;

export const GROUNDING_OUTCOMES = [
  /** The value quotes text that is genuinely in the document. */
  'GROUNDED',
  /** The model reported the document does not contain this. Believed. */
  'ABSENT',
  /**
   * The model returned a value whose quote is not in the document.
   *
   * The interesting case. Dropped, and counted — a model producing these
   * regularly is a model this deployment should stop using, and that is a fact
   * an operator can only act on if somebody counted.
   */
  'UNGROUNDED',
  /** A value with no quote offered at all. Dropped for the same reason. */
  'UNCITED',
] as const;
export type GroundingOutcome = (typeof GROUNDING_OUTCOMES)[number];

export interface GroundedField {
  readonly field: string;
  readonly outcome: GroundingOutcome;
  /** Present only when GROUNDED. There is no other way to reach a value. */
  readonly value: string | null;
  readonly quote: string | null;
}

/**
 * Normalise whitespace before checking a quote against the document.
 *
 * A model reproducing a line from a PDF will differ in line breaks and runs of
 * spaces, because that is what PDF text extraction does to a document. Treating
 * that as fabrication would drop almost every genuine citation and teach
 * everybody to ignore the check.
 *
 * Only whitespace is normalised. Characters, digits and word order are compared
 * exactly: those are what a fabrication would get wrong.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The shortest quote that means anything. */
const MINIMUM_QUOTE_CHARS = 8;

export function groundField(
  field: string,
  document: string,
  candidate: GroundedValue,
): GroundedField {
  if (candidate.value === null) {
    return { field, outcome: 'ABSENT', value: null, quote: null };
  }
  if (candidate.quote === null || candidate.quote.trim().length < MINIMUM_QUOTE_CHARS) {
    // A two-character "quote" matches almost any document and grounds nothing.
    return { field, outcome: 'UNCITED', value: null, quote: null };
  }
  if (!normalise(document).includes(normalise(candidate.quote))) {
    return { field, outcome: 'UNGROUNDED', value: null, quote: candidate.quote };
  }
  return { field, outcome: 'GROUNDED', value: candidate.value, quote: candidate.quote };
}

export interface ExtractionProposal {
  /** Always AI_SUGGESTED / CANDIDATE downstream. There is no other path. */
  readonly fields: readonly GroundedField[];
  readonly provenance: InferenceProvenance;
  /** How many fields were dropped for failing to cite the document. */
  readonly ungrounded: number;
  readonly standing: string;
}

export interface ExtractionRefused {
  readonly status: 'REFUSED';
  readonly reason: InferenceRefusal;
  readonly detail: string;
  readonly provenance: InferenceProvenance;
}

export type ExtractionOutcome =
  (ExtractionProposal & { readonly status: 'PROPOSED' }) | ExtractionRefused;

export interface FieldSpec {
  readonly field: string;
  /** What to look for, in the words a person would use. */
  readonly describe: string;
}

/**
 * Ask a model to read a document and propose grounded facts.
 *
 * Returns proposals. It cannot return a claim, an assurance state, or anything
 * a rule could consume — the type has no field that could hold one, and the
 * caller turns these into CANDIDATE claims that a person confirms (ADR-0004).
 */
export async function extractGrounded(
  client: InferenceClient,
  input: {
    readonly document: string;
    readonly fields: readonly FieldSpec[];
    readonly documentKind: string;
  },
): Promise<ExtractionOutcome> {
  const properties: Record<string, unknown> = {};
  for (const spec of input.fields) {
    properties[spec.field] = {
      type: 'object',
      properties: {
        value: { type: ['string', 'null'], description: spec.describe },
        quote: {
          type: ['string', 'null'],
          description:
            'The exact text from the document this value was read from, copied character for ' +
            'character. Null if the document does not contain it.',
        },
      },
      required: ['value', 'quote'],
      additionalProperties: false,
    };
  }

  const shape: Record<string, typeof groundedValueSchema> = {};
  for (const spec of input.fields) shape[spec.field] = groundedValueSchema;
  const schema = z.object(shape).strict();

  const instruction = [
    `You are reading a ${input.documentKind}. For each requested field, return the value and`,
    'the exact text from the document you read it from, copied character for character.',
    '',
    'If the document does not state something, return null for both the value and the quote.',
    'A null is a useful answer. An invented date on a certificate is not: somebody will act on',
    'it, and they will not open the document to check, because you gave them a value.',
    '',
    'Do not paraphrase the quote. Do not summarise it. Do not construct one from several places',
    'in the document. Copy a contiguous span. Anything else will be discarded.',
  ].join('\n');

  const result = await client.infer({
    task: 'EVIDENCE_EXTRACTION',
    instruction,
    document: input.document,
    schema,
    jsonSchema: {
      type: 'object',
      properties,
      required: input.fields.map((spec) => spec.field),
      additionalProperties: false,
    },
  });

  if (result.status === 'REFUSED') {
    return {
      status: 'REFUSED',
      reason: result.reason,
      detail: result.detail,
      provenance: result.provenance,
    };
  }

  const fields = input.fields.map((spec) =>
    groundField(spec.field, input.document, result.value[spec.field] as GroundedValue),
  );

  return {
    status: 'PROPOSED',
    fields,
    provenance: result.provenance,
    ungrounded: fields.filter((f) => f.outcome === 'UNGROUNDED' || f.outcome === 'UNCITED').length,
    standing: result.standing,
  };
}
