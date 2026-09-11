# ADR-0036: No silent yes

**Status:** Accepted · **Date:** 2026-09-11

## Context

This is the single most important property of the questionnaire engine, and the
one most likely to be eroded by a reasonable-sounding request.

A form asks "Is multi-factor authentication enforced on all user accounts?" and
offers a Yes/No dropdown. The estate says 47 of 49 accounts, with two directors
exempted by a named policy since 3 June 2026. The determination is QUALIFIED.

Every pressure in the room pushes toward "Yes":

- the form only accepts Yes or No;
- the client wants the cover;
- the preparer is on their eleventh form this week;
- "it's basically yes";
- a competitor's tool would have said yes without mentioning it.

And "Yes" on an insurance proposal form is a statement of fact forming the basis
of the contract. The two exemptions are precisely the accounts an attacker would
target and precisely what an insurer would examine after a claim.

## Decision

**An answer whose determination is not SUPPORTED is never rendered as an
unqualified positive, in any output format, under any configuration, by any
renderer.**

Not "should not". Cannot: it is a property test over the cross-product of every
answer state, every renderer and every sender-type policy, and it fails the
build rather than relying on care (see `packages/questionnaire`).

The rules per state:

| State          | May render as                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| SUPPORTED      | The positive form, optionally with an evidence reference                                                                        |
| NOT_MET        | The negative form, with the reason                                                                                              |
| QUALIFIED      | Never a bare positive. "Yes, with exceptions" plus the exceptions, or the negative plus the partial position, per sender policy |
| UNKNOWN        | Never a bare positive. Routed to a person, who may supply evidence or attest                                                    |
| ATTESTED       | The attester's answer, marked internally as attested rather than observed                                                       |
| NOT_APPLICABLE | "N/A" with the recorded reason                                                                                                  |

**Where a form offers only Yes and No and has no comment field**, the engine
does not choose. It flags the question as requiring a human decision and
records which way that person went. A format constraint is not a licence to
overstate; it is a reason to involve someone.

**Exceptions come before the answer**, not in a footnote. "MFA is enforced for
47 of 49 accounts. Exceptions: two named accounts, excluded by policy
Directors-Legacy since 3 June 2026." That ordering is deliberate: exceptions are
exactly where disputes arise, so they are what the preparer reads first.

**Where a model phrases a free-text answer**, a deterministic checker compares
the phrasing against the determination before the rendering is saved. Phrasing
that asserts more than the state supports — "all" when exceptions exist, "yes"
when the state is UNKNOWN — is rejected and replaced with the templated wording.
Templates exist for every state, so a model is never required.

## Consequences

Adericel will sometimes produce a worse-looking form than a competitor would.
The client's answer will say "yes, with two exceptions" where another tool says
"yes". That is the product.

The structural metric that must always be zero is the **silent-yes rate**:
submitted answers rendered as an unqualified positive whose determination was
not SUPPORTED. It is reported alongside every other measure, and a non-zero
value is a defect, not a threshold.

If a customer asks for a configuration flag to disable this, the answer is no,
and this record is why.
