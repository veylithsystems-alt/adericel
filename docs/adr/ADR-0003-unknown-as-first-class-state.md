# ADR-0003: UNKNOWN as a first-class assurance state

**Status:** Accepted · **Date:** 2026-09-09

## Context

Every compliance and posture product must decide what to do when it lacks
evidence. The overwhelmingly common choice is to treat absence as a pass, or to
quietly exclude the item from the denominator. Both produce a green dashboard
for an organisation nobody has actually looked at.

This is not a display problem. It is a modelling problem, and it has to be
solved in the type system and the aggregation algebra or it will be solved
wrongly at every call site.

## Decision

**UNKNOWN is a value in the assurance state lattice, and it propagates.**

The rules, in `packages/domain/src/assurance.ts` and enforced by the engine:

1. UNKNOWN is not secure, insecure, compliant or non-compliant. It means
   Adericel does not hold sufficient trustworthy evidence to say.
2. Aggregation never reports SATISFIED while any in-scope child is UNKNOWN.
3. A known failure outranks an unknown — NOT_SATISFIED wins the aggregation —
   because a proven failure is a stronger and more actionable fact.
4. An empty set of children aggregates to UNKNOWN, not SATISFIED. Nothing proves
   nothing.
5. A rule whose subject kind has **never been observed** reports UNKNOWN, not
   NOT_APPLICABLE. "We know there are no devices" and "we have never looked at
   devices" are different facts, and only the first is out of scope.
6. Every UNKNOWN carries a reason, because "no integration connected" and "the
   evidence contradicts itself" demand completely different responses.

The evaluation logic uses three-valued Kleene logic rather than booleans, so an
unknown input yields an unknown conclusion unless the other operands settle the
question independently.

## Alternatives considered

**Absence is a failure.** Safer than treating it as a pass, and initially
appealing. Rejected because it is equally untrue and operationally worse: an
MSP onboarding a customer would see a wall of red that says nothing about the
customer, and would learn to ignore red.

**A separate "coverage" metric alongside a boolean state.** This is what most
products do. Rejected because coverage is then a report rather than a
constraint: the state still says "pass", and the state is what people act on.

**A confidence score per control.** Rejected outright, and separately in
ADR-0017. A number between 0 and 1 invites exactly the conflation the product
exists to prevent.

## Consequences

**Positive.** Adericel can be trusted, because it will say when it does not
know. Rule 5 in particular means an organisation with no endpoint collection
cannot look better than one where collection works and found a problem.

**Negative.** A new customer's first assurance view is largely unknown, which is
commercially uncomfortable — a competitor's product will show green on the same
data. The onboarding workflow and the interface both address this by explaining
what unknown means rather than hiding it.

**Accepted trade-off.** Being honest on day one is the entire proposition. A
product that told a comfortable lie at onboarding would have nothing to sell
afterwards.

## Security implications

Directly mitigates the most consequential failure mode this product could have:
an organisation believing it is secure because a system that could not see
anything said so.

## Operational implications

Unknown counts are a primary operational signal. An unknown is usually
Adericel's problem — a failed collection, stale evidence — rather than the
customer's, and the portfolio view says so explicitly.

## Migration implications

None. The state is present from the first migration and cannot be added later
without re-evaluating every historical assessment.
