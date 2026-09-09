# ADR-0002: The Truth Engine boundary

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel's product claim is that it can be trusted to say what is true about an
organisation's security posture, explain why, and reproduce that determination
later. Everything else — dashboards, workflows, integrations, reports — is
presentation of, or input to, that claim.

The risk is dilution. Assessment logic tends to leak: a special case in an API
handler, a threshold in a UI component, a "quick fix" in an n8n Code node.
Each one is individually reasonable and collectively fatal, because the answer
to "why does it say that?" stops being answerable.

## Decision

**The Truth Engine is a pure library with no I/O, and it is the only component
permitted to determine an assurance state.**

Concretely, `packages/truth-engine`:

- imports nothing that performs I/O — no database client, no HTTP client, no
  filesystem, no clock;
- receives `asOfIso` as an input rather than reading the time;
- returns a determination plus the reasoning that produced it;
- has no dependency on the API, the worker, n8n, or the UI.

Impurity lives in `packages/actions/src/assessment-service.ts`, which gathers
facts, calls the engine, and persists what came back.

## Alternatives considered

**Assessment inside the API handlers.** Fewer moving parts, and the first
version would have been quicker. Rejected because the engine could then never be
tested without a database, replay would be impossible, and the boundary would
erode one handler at a time.

**A rules service over HTTP.** Attractive for language independence. Rejected as
premature: it buys nothing Adericel needs today, adds a network hop inside the
assessment path, and makes replay depend on a second deployment being at the
right version. The library boundary can become a service later without changing
its callers, because the interface is already a pure function.

**Assessment in n8n.** Genuinely tempting — it looks like fast iteration.
Rejected as the worst option available: a workflow edit would silently change
what an organisation believes to be true, with no version, no hash, no test and
no replay.

## Consequences

**Positive.** The engine is testable with no infrastructure at all, which is why
its test suite runs in milliseconds and covers the aggregation lattice
exhaustively. Determinations are reproducible. The boundary is enforceable in
review: a diff that adds an import to the truth-engine package is visible.

**Negative.** Callers must assemble the input, which is more code than reading
from a database mid-assessment. Adding a rule that needs a new class of fact
requires touching the assembly layer as well as the ruleset.

**Accepted trade-off.** The assembly code is the price of the property that
matters most: that a determination made a year ago can still be explained.

## Security implications

The engine cannot exfiltrate data, because it cannot perform I/O. It cannot be
influenced by anything except its declared inputs, which closes off a class of
attack where a malicious integration or document alters the evaluation path
rather than the data.

## Operational implications

The engine version is recorded on every assessment. An engine upgrade that
changed a determination would be visible as a state change with an unchanged
input digest — which the replay endpoint reports as an engine defect rather than
a posture change.

## Migration implications

None yet. Should the engine become a service, `assessControl` becomes an async
call and the assessment service is the only caller that changes.
