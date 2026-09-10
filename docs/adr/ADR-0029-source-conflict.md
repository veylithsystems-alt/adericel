# ADR-0029: When two systems disagree, Adericel does not choose

**Status:** Accepted · **Date:** 2026-09-10

## Context

Adericel keeps one live claim per (subject, predicate). A newer assertion
supersedes the older one, which is exactly right when a single source
re-observes a fact: repeated collection converges rather than accumulating.

It is a silent falsification when two sources disagree.

```
Intune says   laptop-17  encrypted = true
The RMM says  laptop-17  encrypted = false
```

Whichever collection ran last won. Nothing anywhere recorded that the question
had been contested. Adericel would then have told a customer — and, through an
Assurance Passport, their insurer — that a device was encrypted on the strength
of a coin toss between two systems that flatly contradicted each other.

This was not a hypothetical. It was the behaviour, and it was invisible: no
error, no warning, no record. The unique index that guarantees the engine always
has one current value to read is the same index that made the second source
overwrite the first without trace.

## Decision

**An unresolved disagreement withholds the claim.**

Claims now record the integration that produced them, which is what makes two
positions comparable at all. When a second source contradicts the first, the
outcome is one of four:

- **AGREED** — they say the same thing. Two independent systems agreeing is
  itself worth recording, and any disagreement previously open is closed.
- **RESOLVED_BY_AUTHORITY** — the organisation has configured which source is
  authoritative *for this predicate*. Per-predicate, because the system that
  best knows endpoint patch state is rarely the one that best knows identity
  state, and a single global hierarchy would be wrong for one of them.
- **RESOLVED_BY_FRESHNESS** — one source observed materially more recently than
  the others, by a margin the organisation configured.
- **UNRESOLVED** — nothing settles it. Both claims become `DISPUTED`, no rule
  reads either, and every control resting on the predicate reports `UNKNOWN`
  with the disagreement as its reason.

**Recency is not authority.** The freshness window is undefined by default, so
recency never settles a disagreement unless a person has explicitly said it may,
and then only past a margin they chose. A wrong answer collected a minute ago is
still wrong, and a customer would rightly object to five minutes of scheduling
difference deciding what Adericel believed about their estate.

**No connector may assert its own authority.** Authority is organisation
configuration. A connector that could declare itself authoritative would be
deciding assurance truth, which is the one thing the whole adapter boundary
exists to keep it away from.

Detection lives inside `claims.assert` — the single funnel every claim passes
through — so there is no path that can bypass it.

## Consequences

A contested control becomes UNKNOWN where it previously read as a confident
PASS or FAIL. That is a *worse-looking* product and a more truthful one, and it
is the whole point of UNKNOWN being first-class (§8).

Conflicts are closed, never deleted, when sources agree again. That a control
was contested last quarter is part of the record an auditor is entitled to.

A disagreement persisting across ten collection runs is one fact, not ten.

The organisation gets a lever: naming an authoritative source per predicate, or
a freshness margin, turns a withheld claim into a readable one — with the
disagreement still recorded, so the resolution is visible rather than assumed.
