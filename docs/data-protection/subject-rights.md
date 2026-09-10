# Answering a request from a person

Who answers depends on whose data it is, and the difference is not
administrative — it decides who is lawfully able to act.

## The first question: controller or processor

**If the person has an Adericel login, or was invited to one, or Veylith
approached them** — Veylith is the controller and answers directly.

**If the person is inside a customer's estate** — an account Adericel observed
through a connector — the customer is the controller. Veylith cannot lawfully
decide what happens to that data and does not try. The request is passed to the
customer within five working days, with an offer to help them answer it, and the
person is told who now holds their request.

## What is answered, and how

### Access (Article 15) and portability (Article 20)

A customer organisation can export everything Adericel holds about it at any
time, through `GET /v1/organisations/{id}/export`, in structured JSON. That is
the portability right, and it works before, during and after offboarding — a
customer who has left can still take their record.

The export declares its own completeness. Where a table exceeded the per-table
row cap it says so, names the table, and reports `complete: false` with the true
row count. A truncated export that reported success would be the same failure as
a control marked PASS on evidence nobody read.

For an individual, an access request is answered from the audit trail and the
identity record. There is no self-serve individual export yet; it is assembled by
hand from the register. Stated plainly because it is a gap: the data is all
identifiable from the register, but a person has to run the queries.

### Erasure (Article 17)

Two different requests wear the same word, and Adericel keeps them apart.

**A customer asks for their organisation to be erased.** Available after closure,
never before — leaving and being erased are different decisions, and conflating
them would destroy the record of a customer who only meant to stop paying. The
sequence is enforced by the database, not by convention:

1. Offboarding begins. Assurance stops immediately: nothing further is observed
   or asserted about an estate Adericel no longer watches.
2. A complete export is handed over. Closure is refused without it.
3. Access is revoked and connector credentials destroyed.
4. The organisation is closed.
5. Erasure is requested, with a stated reason and a name against it.
6. Erasure is executed.

What is destroyed: every row in every tenant table — evidence, claims, graph,
findings, actions, assessments, audit trail, integrations. The service counts
every tenant table again afterwards and reports `INCOMPLETE`, naming the tables,
if anything survived. It does not report success without checking.

What is kept: a tombstone carrying the organisation id, slug, owning MSP,
closure date, and the hash of the export handed over. No name, no contact, no
evidence. It exists so a former customer can still prove they were a customer,
and so the bundle they hold can be checked against what Veylith says it gave
them years later. Aggregate accounting records are kept under Veylith's own
legal obligation, with the organisation reference cleared.

**An individual asks Veylith to erase them.** Their credentials, sessions, second
factors, recovery codes, outstanding invitations and abandoned signups are
deleted. Their authority is revoked immediately. Their identity record is
pseudonymised.

Their decisions are not deleted, and the refusal is stated to them rather than
quietly applied. An approval this person gave to change a customer's production
estate is _the customer's_ record: destroying it would remove the customer's
ability to show who authorised a change to their systems. It is retained under
Article 17(3)(e) — establishing, exercising and defending legal claims — with the
person's name replaced by a stable pseudonym and their address and user agent
removed. The same person still reads as the same person across the trail, which
is what makes it a trail.

The report returned by an erasure says `deleted`, `pseudonymised` and `retained`
as three separate lists, and never moves an item between them. Calling
pseudonymisation deletion would be the same class of untruth as calling an
unverified control PASS.

### Rectification (Article 16)

A user can correct their own name and address in the product. Data observed
inside a customer's estate is corrected at source: Adericel records what a
connector saw, and changing the record without changing the estate would make
the record wrong on purpose. Where two sources disagree, both claims are marked
DISPUTED and no rule reads either (ADR-0029) — which is the honest answer, not a
guess at which one is right.

### Restriction (Article 18) and objection (Article 21)

Restriction is available by suspending an account, which stops all processing of
that person's data except storage. Objection applies to the outreach data held
under legitimate interests, and is honoured immediately and permanently: the
contact is deleted, not flagged.

### Automated decision-making (Article 22)

Not applicable. Adericel makes determinations about controls, not about people,
and every change to a person's account above autonomy level 0 requires an
approval from a human being that no automation can give.

## Timescales

One calendar month from receipt, extendable by two further months for complex
requests with an explanation given inside the first month. A request passed to a
customer as controller is passed within five working days, and the clock is
theirs from that point.

## Refusing a request

A refusal is always explained, always cites the provision relied on, and always
tells the person they may complain to the Information Commissioner's Office. A
request is never quietly ignored or answered with less than was asked for
without saying so.
