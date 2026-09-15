# ADR-0025: Onboarding is self-serve, and honest on the first screen

**Status:** Accepted · **Date:** 2026-09-10

## Context

Adericel could assess, decide, act and verify. It could not be bought.

Every route required an authenticated principal. No route created a user. No
table recorded an intention to sign up. Every tenant that had ever existed was
created by a test fixture or a seed script. There was no signup, no invitation,
no email, and therefore no path by which an MSP or a business could become a
customer without somebody at Adericel running SQL for them.

That is not a missing feature. It is the difference between a product and a
professional-services engagement wearing software's clothes, and it decides the
unit economics of the company.

There is a second problem, more specific to this product. Onboarding a
compliance tool usually ends on a dashboard showing zero findings, which reads
as "you are fine" when it means "nobody has looked". Adericel exists to refuse
exactly that claim. So the first screen is both the moment the product is most
likely to be misread and the moment it can most cheaply explain itself.

## Decision

**Signup is self-serve and unattended, for both shapes of customer, and the
first thing it shows is the truth.**

### The flow

`POST /v1/signup` → verification link → `POST /v1/signup/complete` → account
created, tenant provisioned, person signed in, trial started.

Two account kinds, one flow: `MSP` (an operator who will onboard organisations
of their own) and `DIRECT` (one business assuring itself). They differ only in
what provisioning creates at the end.

### Rules that hold throughout

- **The caller never learns whether an address is registered.** Signup is
  unauthenticated, so any difference between a new address, a known address and
  one with a pending signup is a customer-list oracle. One response, always.
- **The caller never chooses their own authority.** Roles, MSP membership and
  organisation are decided here or by an inviter. An invitation the recipient
  can amend is self-service privilege escalation.
- **A token is shown once and stored as a keyed digest**, like the API keys and
  refresh tokens it sits beside. Spent, unknown and expired tokens produce one
  message; distinguishing them tells the holder of a stolen link which it is.
- **The account is created or it is not.** A user with no organisation is a
  support ticket the customer has to raise before they can do anything.
- **A trial starts at signup.** Without one, a self-serve operator completes
  onboarding and is refused at the first thing they try — creating a customer —
  with "no active subscription". Onboarding that completes and then blocks is
  worse than onboarding that fails, because the customer has already concluded
  the product works.

### The first screen tells the truth

A new tenant gets a full set of controls and every one of them reads UNKNOWN.
The signup response says so in words, and so does the verification email, before
the customer can misread it:

> Adericel has not observed your estate yet, so it will not say anything about
> it. Connect a source and the determinations begin.

This required a fix to the assurance endpoint, which read from
`assurance_states` and therefore returned an **empty** control list for a tenant
that had never been assessed. An empty page is read as "nothing wrong" — the
same claim a green dashboard makes, only quieter. It now reads from `controls`
and reports anything never assessed as UNKNOWN with reason `NO_EVIDENCE`.

### The onboarding ledger

`onboarding_tasks` records the path to the first evidence-backed answer, ordered,
with each step saying what it unlocks rather than what it is. Two properties
matter:

- **Tasks are completed by observation, never by ticking.** Each is decided by a
  query against real state, so the ledger is self-correcting: an integration
  later disconnected reopens its task. A checklist that can be ticked without
  the underlying fact being true is a worse lie than no checklist.
- **A step whose prerequisite is unmet is BLOCKED, not PENDING.** Nobody is
  asked to collect evidence before connecting a source.

The ledger also surfaces the single most commercially damaging fact about a
one-person tenant, rather than leaving it to be discovered three weeks later:
**with one person in the account, no change can ever be authorised.** The
proposer may never be the approver, so a single-user tenant can assess and
propose and then stop. `canAuthoriseChange` says so on every read.

### Delivery is a real channel, or the deployment does not start

A deployment that accepts signups and writes their verification links to a log
file has not onboarded anybody; it has collected addresses and lost them. The
log driver reports itself as unable to reach a person, and production start-up
refuses it, alongside a missing endpoint, a missing token, or a `from` address
still on the development placeholder domain.

## Alternatives considered

**Sales-led onboarding.** Correct for enterprise, fatal for the MSP segment
Adericel is built for: an operator evaluating tooling for forty customers will
not book a call to see whether it works.

**Signup without email verification.** Faster, and it makes the account
takeover trivial: anyone can claim any address and receive an organisation.

**Let the first user self-approve until a second joins.** Tempting, because a
one-person tenant is otherwise half a product. Rejected outright: it would make
four-eyes control a default rather than an invariant, and the exception would
outlive the reason for it. The honest answer is to say plainly what is blocked
and why, and make inviting the second person the step that unblocks it.

## Consequences

**Positive.** Adericel can acquire a customer unattended, in either shape. The
time from an email address to an evidence-backed determination is bounded by how
long a collection takes, not by anybody's calendar.

**Negative.** Self-serve signup is an abuse surface: it creates rows, sends mail
and provisions tenants for an unauthenticated caller. Mitigated by hard rate
limits on the signup and verification routes specifically, one live signup per
address, and a trial with a hard organisation limit — not eliminated. Abuse
monitoring is a follow-on, not something this ADR claims to have solved.

## Security implications

`signups` follows the nullable RLS pattern from ADR-0007: a pending row has no
`organisation_id` and is visible only under platform scope; once complete it
names the organisation it created. Adding the table without a policy was caught
first by the structural tenancy test and then by the start-up guard, which
refused to boot — which is what both were built to do.

`org:exception:approve` and `org:action:approve` remain human-only, so an
invitation cannot mint a machine principal that approves. `PLATFORM_ADMIN` is
not grantable by invitation at any scope, and roles are checked against the
scope they are being granted at, so an MSP-scoped invitation cannot confer
organisation-level approval authority across a whole portfolio.

Separately, `users.mfa_enrolled` had never been written by anything since the
first migration. Authorisation reads the factor table directly and was never
affected, but the column silently disagreed with reality and was waiting for
something to trust it. It is now maintained at enrolment, and the onboarding
ledger reads the factor table rather than the flag.
