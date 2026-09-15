# ADR-0037: The shared question bank holds questions, never answers

**Status:** Accepted · **Date:** 2026-09-11

## Context

The compounding advantage in this product is not the parser or the model. It is
a growing, curated map from real UK questionnaire wording to confirmed, testable
requirements. A competitor can buy a better model tomorrow. It cannot buy three
years of confirmed insurer and supplier form mappings.

That map is only valuable if it is shared across tenants — which is exactly the
shape of thing that leaks customer data if the boundary is drawn carelessly.

## Decision

**The bank holds question text, form fingerprints and interpretation
expressions. It never holds answers, determinations, evidence, organisation
names, or anything derived from a tenant's estate.**

How it grows: when a preparer confirms an interpretation it is recorded against
that question's fingerprint _for that organisation_. When the same fingerprint
has been confirmed with the same expression by three independent MSPs it becomes
a bank candidate. A Veylith curator approves it into the shared bank, on
`VEYLITH_INTERNAL`, reading only the shared tables. From then on every tenant
gets a deterministic match with no model call.

The boundary is enforced structurally, not by review: a test asserts that no
write path into the bank tables reads any tenant-scoped table, and that bank
rows contain no organisation identifier. Bank tables are platform-scope under
row-level security like every other shared table.

Curation is a human act on the internal surface. Three confirmations make a
candidate; they do not make an entry.

## What is unresolved

Question text arrives from the client's own customers and from insurers. It may
be copyrighted or confidential, and reusing it across tenants may need
permission. The bank stores only normalised wording, and an opt-out per MSP is
designed in from the start — but this needs a solicitor's answer before the
shared bank is switched on, and it is recorded in the brief's outside-answers
list rather than assumed.

Until that answer arrives, interpretations are reused **within** an MSP only.
That is still most of the value — the same insurer form across fifteen clients —
and it needs no permission from anybody.

## Consequences

Every MSP that joins makes every other MSP faster. None of the retrieval tools
have that, because their libraries belong to one customer each.

The network effect is on question wording, which is public-ish and shared, and
never on answers, which are private and never shared. Anyone who reads this
record can check which side of the line a proposed feature falls on.
