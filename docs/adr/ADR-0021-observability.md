# ADR-0021: Observability and correlation

**Status:** Accepted · **Date:** 2026-09-09

## Context

A single logical operation in Adericel crosses several processes: an API request
writes an outbox event, the worker delivers it to n8n, a workflow calls back into
the API, a connector reaches a vendor, and an assessment is written. When
something goes wrong, the question is always "what happened to _this_ thing",
and the answer must not require reading five logs and guessing at timestamps.

There is a second requirement that is unusual for this domain: Adericel must be
able to explain a conclusion, not merely trace a request. "Why is this control
UNKNOWN?" is a product feature, not an operational one, and it must be
answerable from recorded facts.

## Decision

**A correlation id travels with every operation, and the explanation is a domain
capability rather than a logging one.**

- Every request is assigned a correlation id, or adopts the client's, and it
  appears in every log line, every event, every audit entry and every outbox
  row it causes.
- Logs are structured JSON with a fixed envelope. Secret-bearing fields are
  redacted structurally, not by scanning formatted output (ADR-0019).
- The trace endpoint assembles everything under a correlation id. It also
  includes actions _referenced by_ events in that correlation, because
  correlation ids are per-request and an action proposed under an earlier
  request is exactly what someone tracing an execution is looking for. Without
  that, the trace answers a narrower question than the one being asked.
- `/health/live` reports process liveness; `/health/ready` checks the database
  and the object store, because a process that cannot reach its database is not
  ready no matter how alive it is.
- **Assessment explanation is not observability.** Why a control is in a state —
  which rule, which ruleset hash, which evidence, which subjects, which unknown
  reason — is stored on the assessment and served from the API. It survives log
  rotation, because a log-derived explanation expires and an assurance
  conclusion does not.

## Alternatives considered

**OpenTelemetry traces as the primary mechanism.** The right tool for
distributed request tracing and one Adericel should emit. Rejected as the
_primary_ mechanism because spans are sampled and expire, and the question here
is often asked months later about a specific organisation. Correlation ids in
durable rows answer that; traces do not. The two are complementary and the
correlation id is designed to be the trace id.

**A hosted observability platform as a dependency.** Rejected for the same
reason as ADR-0018: the first deployment is a VPS, and self-hosting MSPs may not
send telemetry to a third party. Structured JSON on stdout goes wherever the
operator already sends logs.

**Deriving explanation from logs.** Rejected. It makes the product's central
capability depend on log retention, and it is unavailable for the ten-month-old
assessment where it matters most.

**Metrics-first (Prometheus) with logs as an afterthought.** Metrics answer "how
many" and this domain's questions are almost all "which one". Metrics are
exported; they are not the primary interface.

## Consequences

- Log volume is higher than a terse format, and rotation is configured
  accordingly in the compose file.
- Every service boundary must propagate the correlation id explicitly. This is
  in the HTTP client, the outbox writer and the workflow templates, so it is not
  a per-call responsibility.
- The trace endpoint is a genuine support tool: "send me the correlation id" is
  a complete diagnostic request.

## Security implications

The trace endpoint returns operational data for one organisation and is
authorised like any other tenant resource. It is a read that crosses component
boundaries, which makes it exactly the endpoint an attacker would want, and it
is therefore scoped by the same middleware as everything else rather than by a
platform-level exemption.

Correlation ids are opaque and carry no information. Logs record identifiers,
states and durations — never evidence content, never credentials, never
assessment inputs.

## Operational implications

Dead-lettered outbox events and failed integration runs are the two signals that
matter most, and both are surfaced in the platform health view rather than only
in logs, because an operator running a £11-a-month VPS is not watching a
dashboard.

## Migration implications

Emitting OpenTelemetry is additive: the correlation id becomes the trace id and
existing rows remain joinable. Nothing recorded now becomes less useful.
