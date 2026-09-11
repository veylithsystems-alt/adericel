# ADR-0031: Three surfaces, and no standing route between them

**Status:** Accepted · **Date:** 2026-09-10

## Context

Adericel is a product. Veylith Systems is the company that operates it. Until
now the repository knew that in its schemas — `adericel` for tenant data,
`veylith` for company data — and in its route paths, but authority did not know
it at all.

There were three populations and one authorisation model:

- **Veylith's own staff**, running the company: its processes, its exception
  queue, its autonomy maturity, its commercial pipeline.
- **MSP operators**, running assurance across a portfolio of client
  organisations they are contracted to serve.
- **A client organisation's own staff**, looking at their own assurance state.

Scope resolution ran platform → MSP → organisation, and a `PLATFORM` grant
short-circuited it. `PLATFORM_ADMIN` holds every permission, so in practice
Veylith held permanent, silent, unlogged-as-unusual read and write access to
every customer's evidence, findings, actions and audit trail. Nothing in the
codebase relied on it; the whole test suite passed once it was removed. It was
there because scope resolution had never been asked whose question it was
answering.

Three further gaps sat underneath it:

- `/v1/system/health` and `/v1/system/outbox` required a session and checked no
  permission, so any customer could read the platform's queue depth.
- A `grants` row naming a role from another scope conveyed that role's
  permissions anyway. `PLATFORM_ADMIN` written against one organisation would
  have granted every organisation permission there is.
- `/v1/auth/me` flattened every role on every grant into one permission list,
  which overstated what the session could actually do — and the web app decides
  what to render from it.

## Decision

**Three surfaces. Each admits one class of information and honours grants of
exactly one scope. Nothing crosses without an act somebody performed.**

| Surface            | Scope honoured | Reads                                                        | Breadth          |
| ------------------ | -------------- | ------------------------------------------------------------ | ---------------- |
| `VEYLITH_INTERNAL` | `PLATFORM`     | `COMPANY_OPERATIONS`, `PLATFORM_ADMINISTRATION`              | The company      |
| `ADERICEL_MSP`     | `MSP`          | `MSP_PORTFOLIO`, `TENANT_ASSURANCE`, `TENANT_ADMINISTRATION` | A portfolio      |
| `ADERICEL_CLIENT`  | `ORGANISATION` | `TENANT_ASSURANCE`, `TENANT_ADMINISTRATION`                  | One organisation |

Every permission is classified into exactly one information class
(`packages/domain/src/surface.ts`). Every route is assigned its surfaces before
the handler runs (`apps/api/src/surfaces.ts`). `authorise()` then refuses twice,
independently, before it looks at a grant:

1. if the permission's class is not one the surface discloses, and
2. by considering only grants whose scope type is the surface's own.

An unclassified route resolves to no surface, and a question asked with no
surface is refused. Adding a route without deciding its boundary produces a
route that does not work, rather than one that works too well.

Two consequences are the point of the whole exercise.

**Veylith has no standing access to customer data.** A platform administrator
holding every permission the company has cannot read one control, one piece of
evidence, one finding or one audit line belonging to a customer. This is the
correct commercial posture, the correct security posture, and — since almost
everything Adericel holds about a customer's people is personal data — the
correct data-protection posture. Support that genuinely requires customer data
is obtained by issuing an expiring `ORGANISATION` or `MSP` grant: a deliberate,
attributable, time-bounded act that appears in the audit trail, rather than a
permanent capability nobody can see being exercised.

**A client cannot see the MSP above it.** No client organisation can learn who
else its MSP serves, what the MSP is charged, how large its book is, or what its
baselines look like. The MSP's commercial position is `MSP_PORTFOLIO`, and the
client surface does not read that class at all.

Alongside this:

- Roles are valid only in the scopes where they mean something
  (`ROLES_VALID_IN_SCOPE`). A role written against the wrong scope conveys
  nothing rather than conveying everything.
- Every audit record carries the surface that served the request, so an
  investigation can tell a read that arrived through an MSP's delegated
  authority from one made by the organisation's own staff. That is not
  recoverable from the actor alone.
- `/v1/auth/me` reports the surfaces a session occupies and what each one
  permits, computed the same way the enforcement is. The web app renders from
  that, so it never offers a door that will not open.

## Alternatives considered

**Keep platform override, add logging.** The usual answer: leave the access and
watch it. It fails the standard this product is held to — a control that
depends on somebody reading a log afterwards is a detection, not a boundary, and
"we could see everything but promised to look at the record later" is not
something to tell a customer whose staff data is involved.

**Three separate deployments.** Genuinely stronger isolation, and wrong for the
size of the company. It would triple the operational surface Veylith has to run
correctly with one person, and the failure mode it prevents — a bug in scope
resolution — is prevented instead by making scope resolution too simple to get
wrong: one scope per surface, decided by the route, checked twice.

**Filter in the UI.** Not a boundary. The API is the product.

## Consequences

A Veylith operator investigating a customer's problem must issue themselves an
expiring grant first, and that grant is visible. This is friction, and it is
deliberate: it is the difference between "Veylith staff can read your estate"
and "a named person read your estate on this date, for one hour, and here is the
record."

The three surfaces are now a structural property rather than a convention. A
route added to the wrong path prefix lands on the wrong surface and is refused,
which is loud. A route added to no known prefix is refused entirely, which is
louder. `tests/security/information-boundary.test.ts` proves the walls with live
HTTP requests from real signed-in sessions on the wrong side of each one, and
locks the matrix so widening a surface is a visible edit.

The break-glass grant is currently issued by direct database access. That is
honest but not good enough for long: it should become a route on the internal
control room with a stated reason, a maximum duration, and a notification to the
customer. Until it does, this ADR's guarantee rests on Veylith having no route
that issues it silently — which is true, and is checked.
