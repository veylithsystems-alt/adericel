# ADR-0046: Break-glass, and grants that mean what they say

**Status:** Accepted · **Date:** 2026-09-16

## Context

Contract v3.1 §28 forbids permanent privileged access and hidden admin routes.
§29 requires that Veylith support access be explicit, scoped, time-limited and
attributable. The surface model (ADR-0031) already delivers the hard half of
that: a Veylith platform grant is honoured on no Adericel surface, so a platform
administrator has **no standing access** to any customer's assurance data.

That is correct, and it left a gap. When a customer's estate is genuinely on
fire and every control is reading UNKNOWN, an operator needs in. With no route
in the product, they use the database — unattributed, unscoped, untimed, and
invisible to the customer it concerns. The forbidden back door arrives by
omission rather than design, which is the usual way.

ADR-0045 gave Veylith a governed way to _restrict_. This is the governed way to
_reach in_.

## Decision

**Emergency access is an ordinary grant with an expiry, a reason, and an
audience.**

A break-glass grant IS a grant: same table, same expiry, same resolution path,
same row-level security. A parallel authority mechanism would be a second place
where access is decided, and the second place is the one that gets forgotten in
a review. `break_glass_grants` records _why_ the grant exists and what must
happen afterwards; the grant itself does the work.

Six properties, each enforced rather than intended:

| Property               | How it is enforced                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Scoped to one org      | `scope_type = 'ORGANISATION'`, one `scope_id`, resolved through the ordinary path            |
| Time-limited           | `CHECK (expires_at <= opened_at + interval '4 hours')`, and a trigger refusing any extension |
| Justified              | `CHECK (length(trim(justification)) >= 30)` in the database, 30 chars in the domain          |
| Attributable           | `opened_by` and `opened_by_label`, append-only                                               |
| Visible to the subject | RLS policy admits the organisation's own scope — the customer sees every use on them         |
| Announced to the MSP   | Notification at the time of opening, recorded as un-notified if it fails                     |

**A second factor is required, even in an emergency.** Everything else about
break-glass is designed to be easy to use at 3am, because a control that is hard
to use in an emergency gets bypassed and the bypass has no controls at all. This
is the one exception: break-glass is precisely what a stolen session would be
used for, and a password alone opening a customer's estate turns any credential
theft into a tenancy breach.

**It cannot confer authority.** `org:member:manage`, `msp:member:manage`,
`platform:admin` and `org:action:execute` are refused outright. Emergency access
is for understanding an estate, not for changing who can reach it afterwards or
for executing against the customer's own systems. Granting authority under
emergency authority is how temporary access becomes permanent, in one step, with
a plausible reason.

## The part that was wrong, and what it forced

The first implementation issued `roles = ['BREAK_GLASS']` and recorded the
requested permissions in a column nothing read. An operator asking for
`org:read` would have silently received everything BREAK_GLASS carries —
including writing claims and evidence into the customer's estate. The
`permissions` list was a record of what somebody typed, not a statement of what
they got, and the two diverged in exactly the situation where the difference
matters.

Fixing it in the break-glass service alone would have put a second permission
check outside the authority model. So the narrowing went where authority is
actually decided:

**`grants.attenuated_to` — an optional narrowing on any grant.**

The roles set the ceiling. When `attenuated_to` is present, the grant conveys
only the intersection of the roles' permissions with that list. Three properties
follow, and all three are proved by mutation:

1. It can only subtract. A permission named in the narrowing that the roles do
   not carry is conveyed by neither — an attenuation is never a route to
   acquiring something the role did not have.
2. Empty means nothing, not everything. "Somebody asked for a narrowing and
   named nothing" reads as nothing; the alternative is a falsy-empty-array bug
   that hands over the full role in precisely the case where care was taken.
3. It lives in `conveys()`, so it applies on every scope. An implementation per
   branch would have missed one.

`NULL` means no narrowing, which is every grant written before now and almost
every grant written after. A database trigger refuses to widen an existing
narrowing or to drop it back to the full role: an attenuation that can be lifted
by an `UPDATE` is not an attenuation, it is a note.

## Also fixed while proving it

- **The mandatory second window.** `grants_unique_live` permits one live grant
  per principal per scope, and expiry is not revocation — an expired row still
  has `revoked_at IS NULL`. An operator whose window ran out mid-incident would
  have hit a unique violation and a 500 on the attempt to open another, which is
  the documented next step. Expired grants are now retired on open; a still-live
  one is answered with a 409 that says what to do, rather than swept aside,
  because silently replacing live emergency access would lose the record of the
  first one.

- **A vacuous baseline.** The test asserting that break-glass "actually confers
  the access it promises" read 403-before/200-after while an earlier test's grant
  was still live. The 403 it expected never happened. It now closes everything
  first, through the product's own route.

## Consequences

Veylith still holds no standing authority over any customer. What it now has is
a door that is loud: it announces itself to the MSP at the time, appears in the
customer's own audit trail, expires on its own, cannot be extended at any layer,
and is reviewed whether or not it turned out to have been warranted.

Grant attenuation is a general facility. Break-glass is simply the first caller
that needed it; delegated MSP access and just-in-time support grants are the
obvious next ones.

## Evidence

- `packages/domain/src/break-glass.ts` — authorisation rules, forbidden
  permissions, the four-hour ceiling.
- `packages/domain/src/authz.ts` — `Grant.attenuatedTo` and `conveys()`.
- `database/migrations/0029_break_glass.sql` — the table, the append-only
  trigger, `grants.attenuated_to` and the narrowing-only trigger.
- `packages/domain/src/authz.test.ts` — 6 attenuation properties. Removing the
  narrowing check fails 3; turning the intersection into a union fails 4.
- `tests/e2e/break-glass.test.ts` — 16 tests end to end. Making the auth layer
  ignore `attenuated_to` fails exactly one, by name.

Closes RR-061.
