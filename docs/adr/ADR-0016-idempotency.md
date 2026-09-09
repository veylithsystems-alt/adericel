# ADR-0016: Exactly-once external effects

**Status:** Accepted · **Date:** 2026-09-09

## Context

Adericel's event delivery is at-least-once by design (ADR-0011), n8n retries on
failure, and operators press buttons twice when a page is slow. Every one of
those paths can deliver the same instruction to execute an action more than
once.

Executing a remediation twice is usually harmless and occasionally is not —
disabling an account that a colleague re-enabled in between, sending a second
notification to a customer, revoking a session that was legitimately
re-established. "Usually harmless" is not a property to build on.

## Decision

**Every operation with an external effect is keyed, and a repeat of a key
returns the original result rather than performing the operation again.**

- Mutating API endpoints accept an idempotency key. Actions derive one
  deterministically from the proposal when the caller supplies none, so the
  protection exists even for callers that do not know about it
  (`packages/actions/src/action-service.ts`).
- Keys are stored per organisation with the response that was produced. A repeat
  within the retention window replays that response with the original status
  code.
- A key reused with a _different_ request body is a conflict
  (`IDEMPOTENCY_CONFLICT`, HTTP 409), not a silent replay. Two different
  operations sharing a key is a caller bug, and returning the wrong one is worse
  than failing.
- The key is claimed in the same transaction as the effect it guards, so a
  crash between claiming and performing cannot leave a key recorded for work
  that did not happen.
- Connector executions carry the action id to the vendor where the vendor
  supports a client token, so deduplication extends past Adericel's boundary
  where it can.

## Alternatives considered

**Rely on the state machine alone.** The transition table already prevents
executing an action twice: `EXECUTED` cannot go back to `EXECUTING`. That covers
the action path and nothing else — not proposals, not notifications, not
collections. Necessary, not sufficient.

**Deduplicate on request body hash without a key.** Rejected: two legitimately
identical requests (disable this account, then re-disable it after someone
re-enabled it) are indistinguishable from a retry. The key is what carries the
caller's intent.

**Exactly-once delivery from a message broker.** Does not exist across a
transactional boundary. The industry-standard answer is at-least-once delivery
plus idempotent consumers, which is what this is.

## Consequences

- Callers that retry are safe by default; callers that supply their own key get
  precise control.
- `idempotency_keys` grows and is pruned on a retention window. The window is a
  real trade-off: too short and a delayed retry re-executes, too long and the
  table is large. It is set well beyond the maximum outbox backoff.
- A stale key can replay a response that no longer reflects current state — the
  action may have progressed since. The replayed response is the one that was
  produced at the time, which is the correct semantics for a retry and is
  documented as such in the API.
- One debugging episode during development looked exactly like "execute
  succeeded before approval". It was an idempotency replay of an earlier 201 for
  an action that had since been approved — the mechanism working correctly, and
  a reminder that replayed responses need to be legible as replays.

## Security implications

Keys are scoped per organisation. A key from one tenant cannot collide with, or
replay the response of, another tenant's request — the lookup is on
`(organisation_id, idempotency_key)`, and the table is under row-level security
regardless.

Stored responses may contain data the original caller was authorised to see. A
replay is only served to a principal authorised for that organisation now, not
on the strength of holding the key.

## Operational implications

The retention window is the one setting that couples this to the outbox: it must
exceed the maximum retry backoff, or a dead-lettered event replayed by an
operator will execute a second time. Both values live in configuration and the
relationship is documented next to them.

## Migration implications

Adding idempotency to an endpoint that lacks it is backward compatible —
existing callers simply do not send a key and get today's behaviour, with a
derived key where one can be derived.
