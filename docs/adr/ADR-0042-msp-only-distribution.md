# ADR-0042: Every organisation belongs to an MSP

**Status:** Accepted · **Date:** 2026-09-15 · **Supersedes in part:** ADR-0025

## Context

Contract v3.0 §2 states that Adericel is distributed through MSPs and only
through MSPs, and §37 forbids building anything whose purpose is to acquire the
MSP's customer directly.

The repository contained two paths that did exactly that.

**The signup path.** `POST /v1/signup` is public and unauthenticated. Its
schema carried `accountKind: z.enum(['MSP', 'DIRECT'])`, and a `DIRECT` signup
provisioned an organisation with a null `msp_id` and an organisation-scoped
owner. A small business could sign up for Adericel without an MSP existing
anywhere in the chain.

**The platform path.** `POST /v1/organisations` passed `mspId: null` and
described itself in its own comment as creating a "direct (non-MSP)
organisation".

Both were correct under ADR-0025 and the brief that produced it. §0 of the v3.0
contract is explicit that this does not make them correct now.

This is a commercial constraint with a security shape. An organisation with no
MSP is a customer relationship Veylith holds directly, and the product is sold
on the promise that it holds none. An MSP's technical reviewer who finds a code
path by which their supplier can sell to their customer has found a reason not
to buy, and they will be right.

## Decision

**Every organisation belongs to an MSP. There is no other shape, at any layer.**

1. **`accountKind` is removed from the signup schema**, and the schema is
   `.strict()`. A client still sending `DIRECT` gets a validation error, not an
   MSP account it did not ask for.
2. **Every signup creates an MSP.** The branch is gone, not defaulted.
3. **`POST /v1/organisations` requires `mspId`.** A platform administrator
   provisioning on an MSP's behalf still provisions under that MSP.
4. **`organisations.msp_id` is `NOT NULL`.** The rule holds even if application
   code regresses.
5. **`signups.account_kind` is constrained to `'MSP'`.** The column is retained
   so historical rows stay readable.
6. **Veylith is its own MSP** for Adericel's self-assurance organisation.

## Why removal rather than a feature flag

A flag leaves the capability in the codebase. "We are able to sell around you
and promise not to" is a weaker answer than "we cannot", and the person who
decides which answer they received is the MSP's technical reviewer reading the
source, not the salesperson saying the sentence.

## Why the migration refuses rather than repairs

`0026_msp_only_distribution.sql` raises an exception if any organisation has no
MSP, naming the count and the query to find them. It does not delete the rows,
invent an MSP to hold them, or skip the constraint.

An MSP-less organisation is a real customer relationship that somebody has to
decide what to do with. A migration is not where that decision gets made, and a
migration that quietly disposes of customer records to satisfy a constraint is a
worse failure than the one it is fixing.

This refusal fired on first run, against the development database, and caught
Adericel's own self-assurance organisation. That is the mechanism working.

## On strictness, and a thing it caught

Making the schema `.strict()` was not cosmetic. Zod strips unknown keys by
default, so before this change a client sending `accountKind: 'DIRECT'` would
have received an **MSP account with no indication that it asked for something
else**. Silently giving a caller a different thing from the one they requested
is worse than refusing — they would go on believing a direct account existed.

A test written to assert the refusal is what surfaced it.

Strictness also revealed that an existing test was posting a `password` field to
`/v1/signup` which had never been read by anything. It was silently discarded,
and had been for the life of the endpoint.

## Consequences

**Positive.** The channel-conflict objection is answerable with source rather
than with a promise. The constraint is enforced at four layers: schema, service,
route and database.

**Positive.** One account shape instead of two removes a branch from signup,
provisioning, onboarding tasks and notification templates.

**Negative, and deliberate.** Direct revenue from a small business that wants
Adericel without an MSP is now impossible rather than merely discouraged. That
is the point of the decision, and reversing it is a product choice requiring a
contract amendment, not a rollback.

**Negative.** Organisation-scoped owners are no longer produced by self-serve
signup. They still exist and are still supported — an MSP creates one for a
customer who should see only their own estate — but they must be granted by
somebody with the authority to grant them, which is the correct shape anyway.

**Migration risk.** A deployment holding MSP-less organisations will not migrate
until an operator resolves them. Given `main` currently holds no deployment,
the real-world blast radius today is zero.
