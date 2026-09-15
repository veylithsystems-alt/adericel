# ADR-0026: The Assurance Passport

**Status:** Accepted · **Date:** 2026-09-10

## Context

Everything Adericel does terminates in one question an organisation needs to
answer to somebody outside itself: _what is true about our security, and why
should you believe us?_

Until now the answer lived only inside the product. A customer could see their
assurance state on a screen they pay for, and had nothing to hand an insurer, a
client's security team, or a procurement reviewer. The graph, the evidence, the
determinations and the verification history existed and could not leave the
building.

The business brief names the Assurance Passport as both a product surface (§16)
and a source of defensibility (§49), and as the primitive the assurance network
is later built on (§17). It is also the artefact the customer journey (§15)
terminates in — without it that journey ends at "continuous monitoring" with
nothing to show anyone.

## Decision

**A passport is an issued, frozen, content-hashed record of the organisation's
assurance state at a stated instant, shareable with named third parties under
scoped, revocable, expiring grants, and verifiable by anyone holding a copy.**

### Issued, not rendered

Content is frozen and hashed at the moment of issue. A shared record whose
content changes afterwards is not a record: issuer and recipient would be
looking at different things while both believing they agreed. The live state is
separately available at all times; a passport is what was true at a stated
instant, and says which instant.

### It carries UNKNOWN

This is the property that makes the passport worth issuing, and the one under
constant pressure. Every incentive in an outward-facing document points towards
quietly omitting the controls you cannot determine. The passport therefore:

- is driven from `controls`, not from `assurance_states`, so a control never
  assessed appears as UNKNOWN rather than being absent — flattering an
  organisation by omission is the quietest way to lie;
- reports coverage (determined of in-scope) alongside every other figure,
  because a high satisfaction rate over a third of the estate is not a good
  result and presenting the two separately is how that gets misread;
- carries evidence age per control, because a satisfied control resting on a
  year-old observation is a different claim from one resting on yesterday's;
- distinguishes an executed action from a verified one, so remediation history
  cannot claim work that was never confirmed;
- states how to read itself, in the document: _"UNKNOWN is not a pass."_

A passport that could only say "compliant" would be the artefact this company
exists to replace.

### Verifiable by a third party

The content hash is over the canonical encoding of the record. A recipient who
was emailed a passport can confirm it is the one Adericel issued and has not
been edited since — including by the organisation it describes — through an
unauthenticated endpoint that answers about a hash and nothing else. No content
is returned and no organisation is named, so it cannot be used to enumerate
customers or read a record the caller was never given.

A hash identifies content, not a row: two issues of a genuinely identical record
carry the same hash by construction. Verification therefore aggregates, and the
content stands while any issue of it remains live.

### Sharing is granted, not guessed

Each share carries its own secret, audience label, expiry and disclosure level,
so a share to an insurer can be revoked without affecting one sent to a client.
Recipients are unauthenticated by necessity — an insurer will not hold an
Adericel account — so the token is the whole control and is stored only as a
keyed digest. Views are recorded, so the organisation can answer "who have we
sent our assurance record to, and who has looked?"

`REDACTED` is the default disclosure: finding severities and the controls they
belong to, without the subject names. A third party gets the shape of the
problem, not a map of where to attack.

### Withdrawal, never deletion

An organisation may withdraw a passport. It remains readable and is marked
withdrawn, and verification says so. Telling a recipient a record never existed
is indistinguishable from an organisation quietly disowning a statement it no
longer likes.

## Alternatives considered

**Generate on demand from live state.** Simpler, and it destroys the artefact's
purpose: the recipient could never be sure what they were shown, and the issuer
could never be held to it.

**A signed PDF.** Familiar to auditors and the wrong primitive: it cannot carry
structure a machine can check, cannot be revoked, and requires a key
infrastructure Adericel does not yet have. The content hash gets most of the
value now and is exactly what such a signature would later cover.

**Share the live dashboard read-only.** Makes the recipient's view depend on the
issuer's present state, so a record shared in March silently becomes a different
claim in April.

## Consequences

**Positive.** The customer has something to give the party asking. Adericel
becomes the thing that vouches, not merely the thing that measures — which is
the precondition for the assurance network in §17.

**Negative.** Storage grows with every issue, since content is retained
verbatim. Bounded in practice by how often an organisation issues, and pruning
would break verification for anything already shared, so retention is a policy
decision rather than a cleanup job.

## Security implications

All three tables carry `FORCE ROW LEVEL SECURITY` with the standard tenant
policy. Share tokens are high-entropy and stored as keyed digests under a
distinct prefix, so a share digest can never collide with an invitation or a
session. Unknown, revoked and expired links produce one message: a holder of a
link they should not have learns nothing from which it is. The public routes are
rate-limited more tightly than authenticated reads.

The redaction boundary is enforced when the share is resolved, not when it is
created, so changing a share's disclosure level cannot leak content that was
frozen at a higher level.

## Related decision: commercial anchors

The three plans from the business brief are seeded here — Assure £299, Protect
£599, Autonomous £999 — replacing a single placeholder plan. What matters
architecturally is not the numbers, which will move, but that the tiers are
defined by how much authority the customer delegates (tell me, help me, do it)
rather than by which dashboard features unlock.
