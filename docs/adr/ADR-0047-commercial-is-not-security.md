# ADR-0047: A commercial state is not a security state

**Status:** Accepted · **Date:** 2026-09-16

## Context

Contract v3.1 §16 requires a ten-state commercial model, and requires that
commercial restriction never becomes security containment.

The repository had five states — `TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED`,
`CANCELLED` — doing both jobs at once. `SUSPENDED` in particular meant whatever
the reader assumed: an unpaid invoice to the finance side, a compromised tenant
to the security side. ADR-0045 already flagged the hazard in migration 0028,
where `organisations.status = 'SUSPENDED'` carried both meanings.

The confusion is expensive in both directions, and the directions are not
symmetric:

- An unpaid invoice handled as a security event **contains** an estate that is
  not compromised. Observation stops, the customer's controls go UNKNOWN, and
  Adericel has manufactured a security incident out of an accounts-receivable
  problem — then reported it to the customer as an assurance failure.
- A compromised credential handled as a commercial event bills a customer
  through an incident and, far worse, leaves collection running against an
  integration nobody trusts.

## Decision

**Ten states, one enum, and no function between the two models.**

| State                    | Collect | Assess | New commitments | Charged |
| ------------------------ | ------- | ------ | --------------- | ------- |
| `DRAFT`                  | no      | no     | no              | no      |
| `TRIAL`                  | yes     | yes    | yes             | no      |
| `ACTIVE`                 | yes     | yes    | yes             | yes     |
| `PAST_DUE`               | yes     | yes    | yes             | yes     |
| `PAYMENT_PLAN`           | yes     | yes    | no              | yes     |
| `COMMERCIAL_RESTRICTION` | yes     | yes    | no              | yes     |
| `COMMERCIAL_SUSPENSION`  | no      | no     | no              | no      |
| `TERMINATED`             | no      | no     | no              | no      |
| `ARCHIVED`               | no      | no     | no              | no      |
| `UNKNOWN`                | **yes** | yes    | no              | no      |

`SUSPENDED` became `COMMERCIAL_SUSPENSION` and `CANCELLED` became `TERMINATED`.
The rename is the decision, not tidying: the new names say which kind of state
they are, so the next person to read a status column cannot make the mistake
that prompted this.

There is one enum. `SubscriptionStatus` **is** `CommercialState`. Two
vocabularies for one fact would have needed a mapping, and the mapping is where
the separation would quietly have died.

## The two invariants

**No commercial state withholds an organisation's own assurance record.** Every
row of `COMMERCIAL_CAPABILITY` sets `readOwnRecord: true` and
`exportOwnRecord: true`, written out ten times so that removing it from one is a
visible edit rather than a missing case. A customer who stops paying stops
receiving new assurance; they never stop being able to read and export what they
already proved. Holding a compliance record hostage over an invoice is not a
commercial lever, it is a reason to be sued.

**Billing is never assurance truth.** `assuranceImpactOf()` exists to be the
only answer to "what does the commercial state do to assurance", so the answer
is in one place and testable. It returns `changesAnyOutcome: false` for every
state and deliberately has no assurance state in its return type. A suspended
customer's last assessment said what it said and goes on saying it; what changes
is that nothing new is decided, which the record states as a fact about
freshness.

## Two rows worth defending

**`PAST_DUE` is byte-for-byte identical to `ACTIVE`.** A late invoice is a fact
about an account. Turning it into a service change on day one is how a finance
problem becomes an assurance problem, and a test asserts the two capability rows
are equal so that "just a small restriction while they're late" is a visible
change to this ADR rather than a one-line edit.

**`UNKNOWN` keeps everything running.** An outage at a payment processor is not
evidence that a customer has stopped paying. Resolving UNKNOWN to unpaid by
default would turn one provider incident into an assurance incident for every
customer at once. It restricts new chargeable commitments — which cost money to
serve and can wait — and changes nothing else. This is the same discipline the
Truth Engine applies: UNKNOWN is a statement that the answer is not known, never
a synonym for the bad answer.

## How the separation is enforced

Not by convention. `tests/security/commercial-separation.test.ts` asserts:

1. No commercial state shares a name with a containment level or trigger.
2. Neither module's **source** names the other's vocabulary — comments stripped,
   because both files explain the separation at length and that is the
   documentation working, not a cascade. This catches a
   `containmentForCommercialState` helper being added later, which is exactly
   how this dies: it looks like a convenience, it is called from one place, and
   six months later an unpaid invoice contains an estate.
3. `definitionOf()` and `impairmentsFor()` refuse a commercial state by name.
   `impairmentsFor` is how a security state reaches the Truth Engine, so a
   commercial state producing an impairment would be the cascade itself.
4. No billing field appears anywhere in `ControlAssessmentInput`. A field nobody
   reads today is still a field.

`definitionOf()` was changed to refuse rather than return `undefined`. Types stop
at the process boundary; without the guard, a commercial state arriving from a
column crashed a line later on a property read, which reads as a bug in
containment rather than as the category error it is.

## Attribution and the audience

A commercial move is a decision about somebody's business, and the person who
explains it six months later is rarely the one who made it. So:

- `commercial_transitions` is append-only, like the containment and break-glass
  records. A history that can be rewritten answers no question worth asking.
- A reason of at least twenty characters is required, in the database as well as
  the domain. Somebody reads it while a customer is on the phone.
- Anything that stops assurance being maintained requires the customer to have
  been told **first**. They plan around this, and finding out from a dashboard
  is not being told.
- A billing provider cannot set `COMMERCIAL_RESTRICTION` or
  `COMMERCIAL_SUSPENSION`, refused at two layers. A webhook is a fact about a
  payment; restricting a relationship is a decision somebody has to make.
- The organisation sees transitions that concern it, through its own RLS scope.
  It is their business being restricted, and "ask your MSP" is not an answer
  when the record exists and names them.
- Transitions are applied with `WHERE status = $from` rather than
  read-then-write. Two operators acting on the same account during a dunning
  conversation is not hypothetical, and the loser of that race must not have
  their transition recorded against a state the account had already left.

## Consequences

Nothing withdraws a customer's record. Nothing about money can reach the Truth
Engine. The two ways the product can stop doing something — because an estate is
unsafe, and because an account is unpaid — are now separate types, separate
tables, separate routes and separate authority, and the thing that would join
them is the thing a test refuses.

## Evidence

- `packages/domain/src/commercial.ts` — the ten states, the capability table,
  the transition table, `assuranceImpactOf`.
- `database/migrations/0030_commercial_states.sql` — the rename, the constraint,
  `commercial_transitions`, its append-only trigger and RLS policy.
- `packages/domain/src/commercial.test.ts` — 15 property tests.
- `tests/security/commercial-separation.test.ts` — 8 structural tests. Adding a
  `containmentForCommercialState` helper fails exactly one; adding a
  `subscriptionStatus` field to `ControlAssessmentInput` fails exactly one.
- `tests/e2e/commercial-states.test.ts` — 11 end to end. Dropping the
  subscription-ownership check fails exactly one; removing the
  customer-notification gate fails two, by name.

Closes E1 and E2 from the v3.1 gap report.
