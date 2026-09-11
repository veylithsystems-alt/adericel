# ADR-0023: Assessments record the facts they ran on

**Status:** Accepted · **Date:** 2026-09-10

## Context

ADR-0002 makes the Truth Engine pure so that a determination can be reproduced.
ADR-0010 keeps history rather than mutating it. Both are necessary for the
product's central claim — _we can still tell you, later, why we said that_ —
and neither is sufficient on its own.

Until now an assessment recorded its engine version, ruleset key, version and
hash, the evidence and claim identifiers it consulted, and an `input_digest`
over everything that influenced the outcome. It did not record the inputs.

A digest is one-way. It can confirm that a candidate set of facts is the set
that produced a determination; it cannot reconstruct them. So `replay` did the
only thing available to it: rebuild the engine's input from the live graph and
stamp it with the historical timestamp.

That is not replay. Claims are stored as one live row per (subject, predicate) —
a re-collection supersedes the previous row rather than accumulating — so the
first time a scheduled collection ran, the rebuilt input stopped matching the
recorded digest. `replay` then reported, truthfully, that the inputs had
changed, and was thereafter permanently unable to answer the question it exists
to answer. An auditor asking why a control was satisfied on 14 March would have
been told that the data has moved on.

The failure was invisible because nothing broke. The endpoint returned 200, the
UI rendered a result, and the result was honest about its own uselessness.

## Decision

**Every control assessment records the exact input the engine was given, and
replay re-derives the determination from that record rather than from current
data.**

- `assessment_inputs` holds the snapshot, content-addressed by
  `(organisation_id, input_digest)`. It is written inside the same transaction
  as the assessment row, so an assessment can never exist without the facts
  that produced it.
- The snapshot is written once and never updated. A repeated digest increments
  `use_count` and touches `last_used_at`. Since an unchanged estate reassessed
  nightly produces the same digest by construction, the steady state writes no
  new snapshot bytes, and a later write can never rewrite the basis of an
  earlier determination.
- Replay parses the snapshot through a schema before the engine sees it. A
  corrupt or truncated row must fail loudly, not arrive as "we hold no facts
  about this", which would turn a storage fault into an apparent finding about
  a customer's security.
- Replay verifies the recorded **ruleset hash**, not just its key and version.
  Published versions are meant to be immutable; if the content under a version
  has changed, replaying under the substitute would produce a plausible answer
  to a different question. That case is refused and named.
- Replay recomputes the digest from the snapshot and compares it with the
  digest stored on the assessment row. The two live in different tables, so a
  match is a proof of integrity rather than a re-read of a single value. An
  altered snapshot reports `DIGEST_MISMATCH`.
- In every failure case — mismatch, unparseable, not recorded, ruleset changed
  — **no determination is offered.** `replayedState` is null. A plausible
  answer to the wrong question is worse than no answer.

## Alternatives considered

**Temporal reconstruction from the claims table.** Superseded claims are
retained, so a live-at-time-T view could in principle be rebuilt from
`asserted_at` and the `supersedes_claim_id` chain. Rejected: claims carry no
`superseded_at`, and `REJECTED` and `WITHDRAWN` transitions carry no timestamp
at all, so the reconstruction would be an inference. An inference is exactly
what must not sit underneath an audit answer, and it would silently degrade
rather than fail.

**A snapshot column on `assessments`.** Simpler, and rejected because it puts a
large blob on the table every portfolio read scans, and stores an identical
copy for every unchanged reassessment. Content addressing gets the same
guarantee at a fraction of the volume.

**Recording only the evidence and claim identifiers.** Already done, and
insufficient: the rows those identifiers point at are themselves mutable, so
the citation survives while the cited content does not.

## Consequences

**Positive.** A historical determination is defensible from its own record,
indefinitely, regardless of what the estate has done since. Tampering with a
stored snapshot is detectable rather than merely unlikely. A ruleset that has
been edited in place is caught rather than silently substituted.

**Negative.** Storage grows with the number of _distinct_ input states, and a
volatile estate produces more of them. Snapshot volume is proportional to the
subjects and claims a rule consults, which is bounded by the rule's declared
predicates rather than by tenant size, but it is not free.

**Accepted trade-off.** The alternative is a product that records answers it
cannot defend. Retention of snapshots is an operational policy question — how
long an assessment must stay replayable is a customer and framework decision —
and the schema supports pruning by `last_used_at` without touching the
assessment history itself. Assessments made before this change replay as
`NOT_RECORDED` and say so plainly.

## Security implications

The snapshot contains the same facts as the claims and evidence it was derived
from, under the same tenant policy: `assessment_inputs` carries
`FORCE ROW LEVEL SECURITY` and the standard `tenant_visible` policy, so it is
covered by the structural test that fails when any table with an
`organisation_id` lacks one.

Digest verification makes the record self-checking. Someone with write access
to the database can still alter a determination, but they can no longer alter
the facts underneath it without the mismatch being visible on the next replay —
and altering both consistently requires forging a SHA-256 preimage.

## Operational implications

`replay` no longer depends on the current state of the graph, so it is safe to
run against a restored backup or a read replica. The distinction between the
integrity questions is now explicit in the response: `snapshotIntegrity`
answers "are these the facts?" and `rulesetIntegrity` answers "is this the same
rule?", and either can fail independently.
