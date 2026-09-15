# ADR-0041: Inference is local first, and leaving requires an author

**Status:** Accepted · **Date:** 2026-09-15

## Context

Adericel reads documents on behalf of MSPs' customers: penetration test
reports, supplier certificates, insurance questionnaires, policy documents.
These are among the most sensitive things a small organisation owns, and they
are handed to Adericel precisely because the organisation cannot assess them
itself.

Before this decision the repository was in an incoherent state, and it is worth
recording exactly how, because the shape of the mistake is common.

`docker-compose.yml` shipped an Ollama service with a tuned memory budget and a
documented VPS sizing. The n8n export had an extraction branch gated on
`ADERICEL_AI_EXTRACTION_ENABLED`. `.env.example` had `OLLAMA_CPUS`. The
configuration schema offered `provider: 'none' | 'anthropic'`.

And there was no inference code in the repository at all.

So the infrastructure was sovereign, the documentation was sovereign, and the
one provider an operator could actually name in configuration was a US-hosted
API — for a client that did not exist. Nobody had decided this. It is what
happens when a capability is configured for before it is built: the placeholder
becomes the design.

ADR-0004 already governs what a model may do (propose, never conclude). It does
not govern where the model runs, and "where" is the question an MSP's customer's
solicitor asks first.

## Decision

**Inference is local first, and that is a structural property of the code rather
than a default anybody can drift away from.**

1. **Every provider is classified by where the data goes.** `LOCAL_PROCESS`,
   `LOCAL_NETWORK`, `EXTERNAL`. The classification is exhaustive over the
   provider enum and a test asserts it, so a new provider cannot arrive
   unclassified.

2. **The default is `none`, and `none` is a complete deployment.** Not a
   crippled tier. Because a model may only ever produce a candidate claim a
   person confirms, no assurance determination depends on inference existing.

3. **`ollama` is the intended provider.** A model on hardware the operator
   controls, reached over a network they control.

4. **An external provider does not start without a written acknowledgement**
   naming the operator and the jurisdiction. Not a boolean, not a checkbox: a
   sentence, at least forty characters, recorded verbatim and reported at
   `/v1/system/data-processing`. A deployment that has pointed itself outside
   the operator's infrastructure without saying so does not boot.

5. **`openai-compatible` is classified `EXTERNAL` even though it is the protocol
   a self-hosted vLLM speaks.** The protocol says nothing about who operates the
   endpoint. Classifying by protocol would let a vendor API in through a door
   labelled local.

6. **`anthropic` was removed from the provider enum.** Adericel does not
   implement a client for it, and a provider an operator can select and the
   system cannot construct is a promise the repository does not keep. Anyone who
   genuinely needs a hosted model reaches it through `openai-compatible`, with
   the acknowledgement gate, which is the honest route.

7. **A model is asked one narrow question and returns a shape.** One call,
   structured output, no streaming, no tool use, no conversation, no retries.
   Anything broader would be building an agent, and the authority model says
   there is no agent here.

8. **Refusal, never a guess.** An unreachable, slow or misbehaving model
   produces a refusal naming what happened. It never produces an empty result,
   because an empty result reads as "nothing found in the document" and that is
   a completely different statement from "Adericel could not read the document".

9. **Extraction is grounded.** Every proposed value must quote the document
   verbatim, and Adericel checks the quote actually appears there. An ungrounded
   value is dropped, not scored.

## On grounding, and why not confidence

The obvious design is a confidence score per field. It is rejected for the same
reason ADR-0004 rejects confidence thresholds: a model's confidence is not
calibrated to whether it invented something, and a number that looks like rigour
and is not is worse than no number, because somebody will sort by it.

Grounding is checkable without a model. `document.includes(quote)`, after
normalising whitespace, because PDF text extraction mangles line breaks and
treating that as fabrication would drop every genuine citation and teach
everybody to ignore the check. Characters and digits are compared exactly —
those are what a fabrication gets wrong.

This does not make an extraction correct. A model can quote a real sentence and
draw the wrong conclusion from it, and grounding catches none of that. What it
catches is the failure that matters at scale: a value with no basis in the
document at all. And it hands the reviewer the sentence, which turns confirming
a supplier certificate from a five-minute read into a two-second check — which
is what makes the human confirmation bottleneck in ADR-0004 survivable at a
hundred customers.

## On prompt injection

The document is hostile input. A supplier certificate can contain text addressed
to the model, and the party who wrote it has every incentive.

Containment is structural, in this order of strength:

1. **The output is grammar-constrained** to a JSON schema with
   `additionalProperties: false`. Prose is not reachable from the grammar.
2. **The output is validated against the schema again** after decoding, because
   not every server implements constrained decoding faithfully. A response
   carrying fields nobody asked for is refused with a distinct reason —
   `SCHEMA_VIOLATION` — because valid JSON with extra keys is the signature of a
   document that has been talking to the model.
3. **Ungrounded values are dropped**, so an injected instruction that produces a
   confident value still has to have quoted the document to reach a person.
4. **The strongest possible outcome is a candidate claim** a named person reads
   against the source before confirming (ADR-0004).
5. **And only then**, a preamble telling the model the document is data. It is
   listed last on purpose. Prompts are advice, and a security design resting on
   advice rests on the good manners of an adversary's document.

The untrusted text is fenced with a nonce derived from the document's own hash —
unpredictable to whoever wrote it, so the fence cannot be closed from inside —
and kept in a separate message from the instruction, because one concatenated
string makes trusted and untrusted text indistinguishable.

## Consequences

**Positive.** An MSP can answer "where does our data go" with a URL. The default
deployment sends nothing anywhere. A UK SME's penetration test report can be
read without leaving the building, and the operator can prove it.

**Positive.** Adericel runs on a £40/month VPS with an 8B model at Q4, which is
the deployment an MSP will actually buy.

**Negative, and real.** An 8B model on CPU is meaningfully worse at extraction
than a frontier model, and slower — hence the two-minute default timeout.
Grounding mitigates the quality gap by catching fabrication rather than by
improving the model, and the refusal model means a struggling deployment says so
instead of degrading quietly. But an operator who wants better extraction has a
genuine trade-off to make, and this ADR makes them make it deliberately rather
than by accepting a default.

**Negative.** Two client implementations to maintain rather than one.

**Accepted trade-off.** The alternative is a product whose sovereignty story is
a paragraph in a PDF, sold to an industry that has learned to discount
paragraphs in PDFs.

## Alternatives considered

**A single hosted provider, with a self-hosted option later.** Faster, and the
option never arrives — it becomes the enterprise tier, and the SMEs this product
is for do not get it. Rejected.

**Classify `openai-compatible` by whether the URL is private.** Attractive, and
wrong in both directions: a private URL can be a tunnel, and a public one can be
the operator's own colocated box. A classification that guesses is worse than
one that asks, because this is the field somebody will cite to a solicitor.

**Make the acknowledgement a boolean.** Rejected. A checkbox is not a decision
anybody made, and there is nobody to ask afterwards what they understood.

**Let the model fill gaps when the document is unclear.** Rejected outright. An
invented date on a certificate is worse than no date, because somebody will act
on it without opening the document — they have a value, so why would they?
