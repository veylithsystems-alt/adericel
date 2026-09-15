# ADR-0017: No single assurance score

**Status:** Accepted · **Date:** 2026-09-09

## Context

Every competing product has a number. Buyers ask for one, boards want one, and
it makes an excellent slide. It is also the single most misleading artefact in
the category, and the brief prohibits it.

The reason is arithmetic, not taste. A score has to combine two things that are
not commensurable: how much of the organisation Adericel can actually see
(**coverage**) and how much of what it can see is in order (**satisfaction of
known**). An organisation with two controls checked and both passing scores
100%. An organisation with two hundred controls checked and one hundred and
ninety-eight passing scores 99%. The first organisation knows almost nothing
about itself. The number says it is doing better.

Any weighting that combines them makes UNKNOWN into a quantity, and the whole
point of ADR-0003 is that UNKNOWN is not a quantity on the same axis as pass and
fail.

## Decision

**Coverage and satisfaction are reported as separate dimensions, and no function
in the codebase combines them.**

`summarise()` in `packages/domain/src/assurance.ts` returns both, plus the count
of each state. There is deliberately no `overallScore()`, no weighting
parameter, and no place a future developer can add one without this ADR being
visible in the diff.

The interface presents the pair with the counts, and where an organisation has
many UNKNOWN controls and no findings it says so in words: this is not a clean
bill of health.

Where a rollup is genuinely needed — an MSP looking at eighty organisations at
once — the rollup is a **distribution**, not an average. The portfolio view
shows how many organisations have findings, how many have significant unknown
coverage, and which. Sorting a portfolio requires an ordering, and the ordering
used is "worst known state first, then least covered", which is a sort key and
never rendered as a number.

## Alternatives considered

**A score with the composition exposed on hover.** The brief permits a summary
score if it exposes its composition and preserves UNKNOWN. Rejected on the
grounds that the number is what gets copied into the board pack and the
composition is what gets left behind. If a figure will be quoted without its
qualification, do not produce the figure.

**Separate coverage and satisfaction percentages, both shown.** This is
essentially what is done, with one difference: satisfaction is expressed as
"n of m known controls" rather than as a percentage. A percentage invites
comparison across organisations with different denominators, which is the same
error one level down.

**A maturity level (1–5) instead of a percentage.** Same failure in a different
costume, plus it implies a progression Adericel has not measured.

## Consequences

- Sales conversations are harder. This is a real commercial cost, taken
  knowingly, and the compensating argument is that "we will tell you what we do
  not know" is a genuine differentiator to a buyer who has been burnt.
- Reports and exports carry both dimensions. A customer who wants a single
  number can compute one; Adericel will not have computed it for them, and their
  own denominator will be visible in what they built it from.
- Trend over time is shown per dimension. Coverage improving while satisfaction
  falls is a normal and important pattern — you are finding real problems — and
  a combined score would hide it exactly when it matters most.

## Security implications

The security consequence of a single score is complacency: a good number ends
the conversation. Two numbers, one of which says "we can only see 40% of this
estate", do not.

## Operational implications

None directly. The absence is enforced by review and by this record, not by a
test — a test that asserts a function does not exist is theatre.

## Migration implications

Adding a score later would be trivial in code and would supersede this ADR.
That is the intended barrier: it should require an explicit decision recorded
against this one, not a helpful pull request.
