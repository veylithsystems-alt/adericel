# Adericel brand

**Brand Pack v1.0 — 08 Sep 2026.** The authoritative sheet is
[`adericel-brand-pack-v1.0.png`](./adericel-brand-pack-v1.0.png). This document
records the parts the product implements, and why several of them are
architectural constraints rather than styling preferences.

`TRUTH / EVIDENCE / ASSURANCE`

## Colour

| Token     | Hex                   | Use                                     |
| --------- | --------------------- | --------------------------------------- |
| Ink       | `#14181F`             | Text, headings, icons — ~60% of surface |
| Slate     | `#5A6270`             | Secondary text, rules — ~20%            |
| Paper     | `#FBFBF9`             | Background — ~10%                       |
| Rule      | `#DCDDD8`             | Borders, dividers                       |
| Proven    | `#1E5540`             | Assurance state: satisfied              |
| Failing   | `#A33326`             | Assurance state: not satisfied          |
| Exception | `#D08B2F`             | Assurance state: authorised deviation   |
| Unknown   | diagonal hatch in Ink | Assurance state: not determinable       |

State colour is ~10% of any surface. Colour carries meaning here, so spending it
on decoration devalues it.

## Unknown has no colour

Every other assurance state gets a fill. Unknown gets a **diagonal hatch in
Ink** — a texture, not a hue.

This is deliberate and it is enforced in `apps/web/src/styles/tokens.css`. Any
colour chosen for Unknown would place it on the good-to-bad axis: green-ish
reads as "probably fine", amber reads as "mildly bad", grey reads as
"unimportant". Unknown is none of those. It means Adericel does not hold
sufficient trustworthy evidence to say, which is a distinct kind of fact and
frequently the most urgent one on the page. The hatch says "no reading here"
rather than "a poor reading".

## No percentage scores

The brand pack lists "show percentage scores" under DON'T, and the data model
enforces the same rule from the other end.

`packages/domain/src/assurance.ts` deliberately exposes satisfaction and
coverage as two separate numbers and provides no function that combines them.
An organisation with 100% satisfaction across 10% coverage and one with 10%
satisfaction across 100% coverage are not comparable, and a single percentage
renders them identical. The UI shows counts and states; where a proportion is
genuinely meaningful it is labelled with its denominator.

## Assurance state vocabulary

The domain model and the interface use different words on purpose. The domain
needs precision for rules and audit; the interface needs language an MSP
engineer can scan at speed. The mapping is in
`apps/web/src/lib/assurance-presentation.ts` and is the only place it exists.

| Domain state          | UI label       | Treatment                 |
| --------------------- | -------------- | ------------------------- |
| `SATISFIED`           | Proven         | Proven green              |
| `NOT_SATISFIED`       | Failing        | Failing red               |
| `PARTIALLY_SATISFIED` | Partial        | Exception amber, outlined |
| `EXCEPTED`            | Exception      | Exception amber           |
| `UNKNOWN`             | Unknown        | Ink hatch                 |
| `NOT_APPLICABLE`      | Not applicable | Slate, de-emphasised      |

## Typography

- **Inter** — SemiBold for headings (H1 24/1.3, H2 18/1.4, H3 16/1.5), Regular
  for body (16/1.55, small 14/1.5, meta 12/1.4).
- **IBM Plex Mono** — data, identifiers, hashes, timestamps (14/1.4, small 12/1.4).

Monospace for data is functional: evidence hashes, correlation ids and ruleset
versions are compared by eye during an investigation, and a proportional face
makes that materially harder.

## Navigation

The primary navigation follows the assurance chain rather than a feature list:

`ASSURANCE / FIX / PROOF / CHANGE / ASK`

- **Assurance** — what is true now, and what is unknown
- **Fix** — findings and the action centre
- **Proof** — evidence and its provenance
- **Change** — what moved, and why
- **Ask** — explore the graph and query the record

## Don't

Gradients, shadows, generic SaaS component styling, percentage scores,
decorative imagery, overused colour, inconsistent spacing.
