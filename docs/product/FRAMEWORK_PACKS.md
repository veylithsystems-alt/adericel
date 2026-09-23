# Framework packs, and what they are careful not to claim

A framework pack maps a published framework onto Adericel's canonical
predicates, so an MSP can maintain continuous readiness between assessments
rather than rebuilding a position from scratch each time somebody asks.

Packs are **versioned data**, not code. The ruleset hash covers the behaviour,
not only the parameters, which is what makes an assessment replayable: the same
hash and the same input digest return the same answer next year and in a
dispute.

## The sentence that governs every pack

**Using a framework pack is not certification, and is not legal compliance.**

Adericel is not a certification body, not an assessor, and not a legal adviser.
A pack expresses what a framework asks for in terms Adericel can observe. What
it produces is a position on evidence, which is a genuinely useful thing and a
different thing from a certificate.

No screen, export, report or API response in Adericel says "compliant",
"certified" or "GDPR compliant". There is no field to write it in. This is not
a style guide — it is enforced, because the fastest way to destroy a compliance
product's credibility is to have asserted something a regulator later reads.

## What a pack reports, always

Eight things travel with every assessment a pack produces. None is optional,
and a pack cannot be published without them:

| Reported                   | Why it is mandatory                                                            |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Evidence observed**      | What was actually seen, with its source and its timestamp.                     |
| **Evidence missing**       | What the rule needed and did not get, named per predicate.                     |
| **Evidence stale**         | What was seen, and is now too old for this control to rely on.                 |
| **Control state**          | One of the determinate states, or UNKNOWN / DEGRADED / BLOCKED. Never a score. |
| **Scope**                  | Which parts of the estate the position covers, and which it does not.          |
| **Ruleset version**        | The version and the hash, so the position can be replayed.                     |
| **Human confirmation**     | Who confirmed what, where a person's assertion carries the control.            |
| **Assessment limitations** | What this pack cannot see at all, stated rather than omitted.                  |

The last row is the one that separates an honest pack from a marketing one. A
pack that lists what it covers and stays silent on what it cannot observe
invites the reader to assume the silence is coverage.

## Packs

### Cyber Essentials (technical controls)

**Status:** implemented, with the gap measured and published.

`packages/policy/src/cyber-essentials-v3-3.ts` maps 27 requirements across the
five technical control themes. Every requirement carries an honest
observability verdict, and two of the four verdicts are refusals:

- **OBSERVED** — a connector supplies every predicate the requirement needs.
- **PARTIAL** — some predicates arrive; the requirement cannot be decided.
- **ATTESTED_ONLY** — no connector can see this. A person must assert it. This
  is a gap a future connector closes.
- **NOT_OBSERVABLE** — _nothing in a cloud API could establish it, ever._ No API
  reports whether a member of staff has written their password on a note.

The distinction between the last two is deliberate and is tested. Collapsing
them would either promise coverage that will never arrive, or write off work
that is genuinely doable.

Coverage is reported as a fraction with a caveat attached that is never
detachable: it counts requirements Adericel observes end to end, and it is
explicitly **not a readiness figure, not a certification position, and not a
percentage of Cyber Essentials achieved**.

The requirement paraphrases carry a `sourceChecked` flag which is `false`
everywhere. Before any of this is shown to a customer it must be reconciled
against the published IASME requirements document. §37 forbids a compliance
claim merely because documentation exists — and that applies to Adericel's own
documentation first.

### Cyber Essentials Plus preparation

**Status:** not built. Named here so its absence is visible.

CE Plus is a hands-on technical audit of a sample of devices. Adericel can
help an MSP arrive at it with a known position — which devices are in scope,
which are patched, which are encrypted — and cannot perform any part of the
audit. A pack claiming otherwise would be selling assessment services.

### ISO 27001 (evidence mapping)

**Status:** ruleset implemented (`iso-27001-2022`).

ISO 27001 certification rests on a management system, not on technical
controls. Adericel maps Annex A controls it can observe and is explicit that
the clauses — leadership, planning, internal audit, management review — are
outside what any system observes. An MSP using this pack gets continuous
evidence for part of Annex A and no opinion at all about the management system.

### Customer security questionnaire mapping

**Status:** implemented as the questionnaire pipeline.

Insurer and procurement questionnaires, mapped onto the same evidence base. The
governing rule is `no silent yes` ([ADR-0036](../adr/ADR-0036-no-silent-yes.md)):
an answer that cannot be supported is never rendered as a bare positive. A
question Adericel cannot answer from evidence comes back as UNKNOWN with what
would resolve it, not as a confident "Yes".

### Supplier assurance profiles

**Status:** partial. Supplier predicates exist; the profile does not.

The natural extension of the Passport: an MSP's client proves its own position
to a customer, and assesses its own suppliers with the same machinery. The
Passport already exports as an independently verifiable signed envelope, which
is the hard half.

### Contractual security-control packs

**Status:** supported by construction, no pack shipped.

Rules are data, so a contractual schedule — "the supplier shall enforce
multi-factor authentication on all remote access" — becomes a ruleset like any
other. What Adericel will not do is interpret a contract: somebody decides what
a clause requires, and Adericel observes whether it holds.

## Why a pack can never be the whole answer

A framework pack reports on what Adericel observes. Every pack therefore
inherits the coverage of the connectors underneath it, and a pack cannot
observe its way past a missing connector.

This is stated in every pack rather than left for a customer to discover,
because the alternative is an MSP presenting a position to an assessor and
finding out in the room that a third of it rested on nothing.
