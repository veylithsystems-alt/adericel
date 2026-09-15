# ADR-0004: AI is separated from truth

**Status:** Accepted · **Date:** 2026-09-09

## Context

Language models are genuinely useful here: reading a penetration test report,
mapping a supplier's control descriptions onto a framework, summarising a
finding. They are also confidently wrong, non-deterministic, and manipulable by
the very documents Adericel is asked to read.

An organisation's assurance record cannot rest on that.

## Decision

**AI may propose. It may never conclude.**

Enforced structurally, in four places rather than by convention:

1. **Claim origin.** A claim derived from a model is recorded with
   `origin: AI_SUGGESTED` and `status: CANDIDATE`.
2. **Engine refusal.** `isRuleEligible` in the domain model refuses an
   unconfirmed AI claim, and the Truth Engine calls it for every claim it
   resolves. A rule cannot consume one, whatever the caller intended.
3. **API refusal.** The claims endpoint rejects an `AI_SUGGESTED` claim
   submitted as `CONFIRMED`. Confirmation is a separate, audited operation.
4. **Human confirmation only.** The confirm endpoint requires a signed-in user.
   An API key or a workflow cannot promote its own output into truth.

Extraction confidence is stored, but it describes the extraction only. There is
no path in the codebase that converts it into an assurance state, and
ADR-0017 forbids presenting it as one.

## Alternatives considered

**Trust AI output above a confidence threshold.** Rejected. A model's confidence
is not calibrated to whether an organisation is secure, and a threshold would
encode a false equivalence in a single constant that would then be tuned by
whoever found it inconvenient.

**Use AI only for summarisation, never extraction.** Simpler and safe. Rejected
as leaving real value unclaimed: extracting supplier assurance dates from a
certificate is genuinely useful, and is safe once the output is a candidate.

**Let AI propose remediations directly.** Rejected. It may propose; the policy
engine decides whether the proposal may run and a human decides whether it does.
That chain is in ADR-0014 and ADR-0015.

## Consequences

**Positive.** Adericel works completely with AI disabled — it is off by default.
Prompt injection in a customer document cannot alter an assurance state, because
the strongest thing an injected instruction can achieve is a candidate claim
that a person will read before confirming.

**Negative.** Human confirmation is a bottleneck, and an MSP wanting to process
a hundred supplier certificates will feel it.

**Accepted trade-off.** The bottleneck is the product working correctly. A
faster path would be a path by which a model's mistake becomes an
organisation's official security record.

## Security implications

Treats all model output as untrusted input, in line with the threat model's
prompt-injection and poisoned-document entries. The blast radius of a successful
injection is one candidate claim awaiting review.

## Operational implications

Candidate claims accumulate if nobody reviews them. The document processing
workflow notifies on extraction, and the claims view surfaces candidates, but an
organisation that ignores them simply gets no benefit from extraction — it does
not get a wrong answer.

## Migration implications

None. `origin` and `status` are on the claims table from the first migration.
