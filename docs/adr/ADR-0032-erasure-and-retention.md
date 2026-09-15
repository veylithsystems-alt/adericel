# ADR-0032: Erasure means erasure, and pseudonymisation is never called deletion

**Status:** Accepted · **Date:** 2026-09-10

## Context

Migration 0021 added `erasure_requested_at` and `erasure_completed_at` to
`organisations`, with a comment describing an erasure process deliberately
separate from closure. Nothing in `apps/` or `packages/` referenced either
column. Grep returned zero results.

A column that names a capability nobody implemented is the exact failure this
product exists to refuse. It is a record asserting something that was never
done — the schema equivalent of a control marked PASS on evidence nobody read.
The same audit found no retention enforcement anywhere: no `retain_until`, no
purge past a period, nothing measuring the age of a session address or an audit
row. Personal data was accumulating with no ceiling and no schedule.

There was also no record of processing. UK GDPR Article 30 requires one, and the
normal form — a spreadsheet — is wrong within a month of being written, because
nothing fails when a migration adds a column and nobody updates the document.

## Decision

**The record of processing is code, the retention sweep runs from it, and
erasure reports what it actually did.**

### The register

`packages/domain/src/personal-data.ts` declares every table and column holding
personal data, whose data it is, whether Veylith is controller or processor, the
purpose, the lawful basis, the retention period with its reasoning, and what
erasure does to it.

`tests/security/personal-data.test.ts` holds it against the live database in
both directions:

- every entry must name a table and columns that exist;
- every column in the schema whose name suggests personal data must be declared
  or explicitly exonerated with a reason.

A migration that adds an email column and forgets the register fails the build.
The register cannot silently go stale, which is the only property that makes an
Article 30 record worth having.

`docs/data-protection/retention.md` publishes the schedule, and a documentation
test fails if a period the code enforces is missing from it.

### Retention

The `sweep-retention` job runs nightly from the same constant. Two treatments,
never blurred:

- `DELETE` — the row goes.
- `PSEUDONYMISE` — the row stays, the identifying columns are set to null,
  because destroying the row would destroy a record somebody else is entitled
  to: an audit entry, an approval, the fact a shared passport was opened.

Each sweep writes what it did to `retention_runs`. "Addresses are removed after
thirteen months" is answerable with evidence rather than with the policy that
says so.

A customer may shorten a period. Nobody may lengthen one: observation retention
is configurable per organisation, and the sweep enforces the register's ceiling
regardless of the setting.

### Organisation erasure

Available only after closure, which already requires a complete export. Leaving
and being erased are different decisions, and conflating them would destroy the
record of a customer who only meant to stop paying. The database enforces the
ordering with a check constraint rather than trusting the service to observe it.

The cascade declared on `organisations` does the destruction. Then every tenant
table is counted again, and the outcome is `ERASED` only if nothing survived. If
anything did, the report is `INCOMPLETE`, names the tables, records the residual
counts, and the route answers 207 rather than 200. Erasure that reports success
without checking is the same class of claim as an assessment that never read its
evidence.

A tombstone survives: organisation id, slug, owning MSP, closure date, and the
hash of the export handed over. No name, no contact, no evidence. It exists so a
former customer can prove they were a customer, and so the bundle they hold can
be checked against what Veylith says it gave them. A test asserts the tombstone
table has no `name`, `contact_email`, `payload` or `settings` column, because a
tombstone carrying the customer's name would be a record of the customer, which
is the thing that was just erased.

### Subject erasure

Credentials, sessions, second factors, recovery codes, outstanding invitations
and abandoned signups are deleted. Authority is revoked. The identity record is
pseudonymised.

The record of approvals the person gave is not deleted, and **the refusal is
stated to them rather than quietly applied**. That record belongs to the customer
whose estate was changed: destroying it would remove their ability to show who
authorised a change to their systems. Retained under Article 17(3)(e), with the
name replaced by a stable pseudonym and the address removed, so the same person
still reads as the same person across the trail — which is what makes it a trail.

The report returns `deleted`, `pseudonymised` and `retained` as three separate
lists and never moves an item between them. A test asserts the register never
describes a pseudonymised entry as deleted. This is the same discipline as
UNVERIFIED never becoming PASS, applied to the one place where the person least
able to check is the one being told.

## Two defects this uncovered

**A closed organisation was locked out of the entire API.** `requireOrganisation`
refused every route for a closed organisation, which meant the customer's own
export was unreachable the moment they left — and made erasure, whose
precondition is closure, impossible to request at all. Now opted in per route
(`allowClosed`), never per permission, so the exception stays visible where it
applies: the export, the offboarding status, and the three erasure routes.

**`lapse-overdue-subscriptions` was never scheduled.** It had a handler and a
test that invoked it by hand, and nothing registered it with the scheduler. In
production the billing lifecycle's only time-driven lever was never being
pulled: a subscription whose payment failed and whose provider then went quiet
would never have lapsed. `tests/unit/scheduled-jobs.test.ts` now fails if any job
type is neither scheduled nor explicitly declared on-demand.

## Alternatives considered

**Keep the register as a document.** It is what almost everyone does, and it is
why almost every Article 30 record is wrong. A document has no failing test.

**Delete the audit trail on subject erasure.** Cleaner-looking, and it would
destroy the customer's evidence of who authorised changes to their production
systems in order to satisfy a request from the person who authorised them. The
lawful answer and the right answer agree here.

**Report erasure as complete without verifying.** The cascade is declared; it
should work. "Should work" is the phrase this product is built to distrust, and
a verification that costs one query per table is not a cost worth saving on the
one operation that cannot be undone.

## Consequences

Erasure is real and irreversible, and there is now a route that destroys a
customer's entire record. It requires `org:manage` on a closed organisation, a
stated reason, and a prior export the database refuses to skip — and it writes
its audit entry before it runs, because afterwards there is no tenant context to
write into.

What remains undone is named in `docs/data-protection/README.md` rather than
left to be discovered: no DPIA, no ICO registration, no solicitor review of the
terms, and a break-glass grant still issued by direct database access.
