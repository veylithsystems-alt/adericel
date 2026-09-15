# ADR-0035: Interpretations are confirmed, versioned artefacts

**Status:** Accepted · **Date:** 2026-09-11

## Context

"Is MFA enforced for all remote access?" is not one question. It is at least
four, depending on what the reader takes _all_ and _remote access_ to mean:
every account or every human account; interactive sign-in or any authentication;
including break-glass accounts; including service principals.

A retrieval tool never has to decide, because it is matching text to text. An
engine that determines an answer from observed state must decide, and the
decision changes the answer.

Left implicit, that decision lives inside whichever model call happened to run,
is invisible to the person signing the form, and can change silently between one
renewal and the next.

## Decision

**Every question is turned into a written interpretation, shown to a person,
confirmed by that person, versioned, and stored. Nothing derived from an
unconfirmed interpretation can be exported.**

An interpretation records:

- the requirement expression, over canonical predicates;
- the scope (all users, remote access only, administrative accounts);
- the time window ("within the last 14 days");
- strictness flags for absolute words;
- its origin — `BANK_MATCHED`, `HUMAN_ASSERTED` or `AI_SUGGESTED`;
- its status — `CANDIDATE` or `CONFIRMED` — and its version.

**Absolute words default to the strictest reasonable reading.** _All_, _every_,
_always_, _within 14 days_ produce a strict interpretation unless a person
deliberately relaxes it. The asymmetry is deliberate: a strict reading produces
QUALIFIED where a loose one produces SUPPORTED, and the cost of the first error
is an unnecessary conversation while the cost of the second is a repudiated
insurance claim.

Resolution order when interpreting a question: exact fingerprint match to the
shared bank, then the organisation's own prior confirmed interpretation, then a
semantic match to the bank, then a model proposal. The first three need no model
call.

## Consequences

The first time an MSP sees a form there is confirmation work. Bank matches can
be confirmed in bulk, and every subsequent client receiving the same form
inherits the confirmed interpretations. The second insurer form of the renewal
season costs a fraction of the first, and the fifteenth costs almost nothing.

A confirmed interpretation is an auditable artefact. When an answer is disputed
a year later, "what did you take this question to mean, and who decided that"
has a recorded answer with a name and a date on it.

Changing an interpretation creates a new version rather than editing the old
one. Submissions reference the version they used, so a past submission never
silently re-reads under a new meaning.
