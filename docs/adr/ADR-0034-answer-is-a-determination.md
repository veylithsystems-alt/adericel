# ADR-0034: A questionnaire answer is a Truth Engine determination

**Status:** Accepted · **Date:** 2026-09-11

## Context

An MSP's clients receive security questionnaires: insurer proposal and renewal
forms, supplier due-diligence spreadsheets, tender security sections, the Cyber
Essentials question set. The MSP answers most of them, and the manual job is the
one already in the value package's task catalogue as `enquiry.answer` —
somebody stops what they are doing and assembles an answer from whatever the
file currently holds.

Every product in this market treats that as a retrieval problem: find the
closest past answer or the relevant uploaded document, adapt the wording, cite
the source. Accuracy is then measured as agreement with the content library.
Conveyor reports over 95% answer accuracy on that basis.

That measure is of consistency, not of truth. If last year's answer was "yes,
MFA on all accounts" and two directors have since been exempted, a library tool
reproduces the wrong answer accurately and confidently.

On a cyber insurance proposal form, that wrong answer is the basis of the
contract. A misstatement can leave the client uninsured at the moment they need
to claim, and incomplete MFA is repeatedly cited as a leading cause of disputed
cyber claims.

## Decision

**The answer to a questionnaire question is produced by the Truth Engine
evaluating a requirement against confirmed claims, exactly as a control is
assessed today. A language model may read the question. It may never decide the
answer.**

Concretely:

- A question is turned into an **interpretation**: a requirement expression over
  canonical predicates, with a scope, a time window and strictness flags
  (ADR-0035).
- The interpretation is evaluated by the same engine, against the same claims,
  producing the same states, with the same provenance as any control assessment
  (ADR-0002, ADR-0004).
- The result carries the ruleset hash, the input digest and the evidence
  references, so it replays (ADR-0023).

A model's only jobs are to split a document into questions and to _propose_ what
a question means. Both outputs are candidates requiring human confirmation
before anything derived from them can be exported.

## What this costs

It is slower to set up than retrieval. A retrieval tool answers a novel
questionnaire immediately and badly; this one needs interpretations confirmed
the first time a form is seen, and then answers every subsequent instance of
that form deterministically and without a model call at all.

It also answers fewer questions. A question about something Adericel does not
observe cannot be determined, and the honest output is UNKNOWN routed to a
person rather than a plausible paragraph. A tool that always produces an answer
is not better at this; it is worse in a way that is invisible until a claim is
disputed.

## Consequences

The engine works with AI switched off. Known forms match deterministically to
the question bank; novel questions can be mapped by hand. AI makes it faster,
never possible — which also means an AI outage degrades throughput rather than
correctness.

The marketing line follows from the architecture rather than being asserted over
it: **other tools make your answers consistent; Adericel makes them true.**

No accuracy percentage will be published. An accuracy figure measured against
past answers would be a measure of the thing this decision rejects, and there is
no honest denominator for the thing it does.
