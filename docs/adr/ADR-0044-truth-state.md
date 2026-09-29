# ADR-0044: How firmly we know it, separately from what we concluded

**Status:** Accepted · **Date:** 2026-09-15

## Context

Contract v3.1 §6 requires a truth-state vocabulary — `OBSERVED`, `VERIFIED`,
`DERIVED`, `INTERPRETED`, `ASSUMED`, `TARGET`, `UNKNOWN` — distinct from
assurance state.

The repository had fragments. Claim origins included `VERIFICATION_DERIVED` and
`AI_SUGGESTED`; collection methods included `DERIVED`. Nothing said, in one
place, what kind of truth a given assertion was.

The gap showed in the Assurance Passport. A control satisfied on a re-observed
API reading and one satisfied on a director's word were the same assurance
state, rendered identically. An insurer reading the Passport could not weigh one
against the other, because the Passport reported the conclusion and hid its
footing.

## Decision

**Truth state is derived from existing vocabulary, never stored alongside it.**

`truthStateOfClaim(origin, status)` is the single mapping. It is a `Record` over
`CLAIM_ORIGINS`, not a switch with a default, so adding an origin without
deciding its truth kind is a compile error rather than a silent fall-through.

| Origin                                            | Truth state   |
| ------------------------------------------------- | ------------- |
| `DETERMINISTIC_NORMALISATION`                     | `OBSERVED`    |
| `INTEGRATION_ASSERTED`                            | `OBSERVED`    |
| `VERIFICATION_DERIVED`                            | `VERIFIED`    |
| `HUMAN_ASSERTED`                                  | `ASSUMED`     |
| `AI_SUGGESTED` (unconfirmed)                      | `INTERPRETED` |
| `AI_SUGGESTED` (confirmed)                        | `ASSUMED`     |
| any withdrawn/rejected/superseded/disputed status | `UNKNOWN`     |

The Passport reports it per control, as the **weakest** truth state behind that
control.

## Why derived rather than stored

A stored truth state would be a second field describing the same thing as claim
origin. Two fields describing one thing is how they drift, and the one that
drifts is the one somebody quotes to an auditor. Deriving it means the Passport
and the claim record cannot disagree, because there is only one fact.

## Why a human attestation is ASSUMED, not OBSERVED

The judgement most worth defending here.

A person saying something is evidence of what they believe. It is not evidence
of what is true: they may be mistaken, working from memory, or describing intent
rather than configuration. For a control no API exposes it is often the only
thing available, and Adericel uses it — it simply does not claim to have seen
what it was told.

This has a consequence that had to be accepted rather than engineered away.
`HUMAN_ASSERTED` claims _are_ rule-eligible, so a control can be `SATISFIED` on
a truth state that is not authoritative. Refusing them would make every control
without an API permanently `UNKNOWN`, which is worse and less honest. The
resolution is disclosure: the Passport reports the truth state so a recipient
can weigh it themselves. A test records the combination so the trade-off cannot
be quietly forgotten.

## Why a confirmed AI claim is ASSUMED and not OBSERVED

Confirmation is a named person reading the claim against its source and
accepting it. That act turns somebody's reading into somebody's assertion — an
assumption with an owner. It does not turn it into an observation, because
nobody observed anything; a model read a document and a human agreed.

Promoting it to `OBSERVED` would let a document plus a click manufacture the
strongest truth state Adericel has.

## Why the Passport reports the weakest

A control resting on one API observation and one human attestation is only as
firm as the attestation. Reporting `OBSERVED` because an observation was among
the inputs would tell a recipient the conclusion is better founded than it is.

## Two mechanisms, one boundary

`isRuleEligible` already enforces the AI/truth boundary (ADR-0004). This adds a
vocabulary that describes the same boundary, and two mechanisms describing one
boundary can disagree — whereupon whichever a reader checks looks authoritative.

A test iterates every origin/status combination and asserts that everything
mapping to `INTERPRETED` is also refused by `isRuleEligible`. They cannot drift
apart without failing.

## Consequences

**Positive.** An insurer, auditor or procurement team reading a Passport can
tell an observation from an assertion, which is the difference between a
document they can rely on and one they must take on trust.

**Positive.** No schema change, no migration, no second source of truth.

**Negative.** `TARGET` is defined and nothing produces it. It belongs to
remediation planning — "this is the state we intend" — which does not exist yet.
Defining it now costs nothing and means the vocabulary will not need widening
again when it arrives.

**Negative.** The `HUMAN_ASSERTED → ASSUMED` mapping is a judgement, not a fact.
An MSP who considers a signed director's attestation stronger than an API
reading would disagree, and they would not be obviously wrong. It is recorded
here so the disagreement is with a decision rather than with an accident.
