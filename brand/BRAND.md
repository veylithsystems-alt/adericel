# Adericel brand

**Brand Pack v1.1 — 08 Sep 2026.** The authoritative sheet is
[`adericel-brand-pack-v1.1.png`](./adericel-brand-pack-v1.1.png). This document
records what the product implements and why several of these are architectural
constraints rather than styling preferences.

`TRUTH / EVIDENCE / ASSURANCE`

## What changed from v1.0

Two values moved, and both are in the code:

| Token     | v1.0      | v1.1      |
| --------- | --------- | --------- |
| Rule      | `#DCDDD8` | `#DCDBD8` |
| Exception | `#D08B2F` | `#96601A` |

Exception is the substantive one. The v1.0 value was a light amber that sat
close enough to a warning yellow to be read as one; `#96601A` is a dark ochre
that reads as a deliberate, authorised deviation rather than an alert. That
matters because the pack separately forbids turning Unknown into warning yellow,
and an Exception that looked like a warning would have reintroduced the same
confusion one state along.

## Colour

Defined once in [`apps/web/src/styles/tokens.css`](../../../apps/web/src/styles/tokens.css)
as the `--c-*` block, copied verbatim from the pack so it can be checked against
the sheet line by line. Nothing in the interface reads a raw hex.

| Token     | Hex                   | Use                                       |
| --------- | --------------------- | ----------------------------------------- |
| Ink       | `#14181F`             | Text, headings, controls, dark surfaces   |
| Paper     | `#FBFBF9`             | Application background, documents         |
| Slate     | `#5A6270`             | Secondary text, metadata, rules           |
| Rule      | `#DCDBD8`             | Borders, dividers                         |
| Proven    | `#1E5540`             | State: evidence establishes the state     |
| Failing   | `#A33326`             | State: evidence does not satisfy          |
| Exception | `#96601A`             | State: authorised, time-bounded deviation |
| Unknown   | diagonal hatch in Ink | State: insufficient evidence to say       |

**The ratio is a rule, not a guideline.** 80–90% of any surface is the brand
system — ink, paper, slate. 10–20% is state colour, and state colour is used for
nothing but state. Spend the state palette on a button, a chart series or a
decorative accent and the one place it carries meaning stops carrying it.

The pack lists using green as a brand colour, and building a green app icon, as
explicit DON'Ts. Green means _proven_. A green brand is a brand that has spent
its most meaningful colour on saying nothing.

> **Note on the pack's token block.** The design-token panel on the sheet shows
> `--c-exception: #966601A`, which is seven hex digits and cannot be a colour.
> The swatch beside it gives `RGB 150 96 26`, which is `#96601A`, and that is
> what the code uses. Worth correcting on the sheet at v1.2.

## Unknown has no colour

Every other assurance state gets a fill. Unknown gets a **diagonal hatch** — a
texture, not a hue.

This is not a stylistic choice and it is not negotiable. A hue would place
Unknown somewhere on the good-to-bad axis, and Unknown is not on that axis: it
means Adericel does not hold enough trustworthy evidence to say. Amber would
read as "nearly fine". Red would read as "failing". Grey would read as
"unimportant". The hatch reads as _no reading here_, which is the truth.

The pack's DON'T list makes the same point from the other direction: **do not
turn unknown into warning yellow.** Every other product in this category does,
and it is the single decision that separates a system of record from a
dashboard.

The hatch is defined once — angle, line width and pitch as tokens — and reused
by the state tag, the count bar, the mark and the favicon, so those four cannot
drift apart.

## Typography

| Role    | Face          | Weights     | Use                                         |
| ------- | ------------- | ----------- | ------------------------------------------- |
| Primary | Inter         | 400/500/600 | Headings, body, UI, navigation              |
| Data    | IBM Plex Mono | 400/500     | Hashes, ids, timestamps, technical metadata |

**Both faces are bundled, not fetched.** This is a correctness fix, not a
preference. The production Content-Security-Policy sets `font-src 'self'`, so
the previous Google Fonts link meant the whole interface rendered in a system
fallback and said nothing about it — the brand was silently not applied in the
only deployment that matters.

There are two further reasons it stays that way. A request to `fonts.gstatic.com`
from a customer's browser tells a third party who is using their security
tooling and when, which is a telemetry leak a security-conscious MSP will find.
And a self-hosted deployment behind a restrictive proxy has no route to an
external font host at all.

Plex Mono is for data that must be compared character by character: a content
hash, a control key, a correlation id. Prose never uses it.

## The mark

Three ascending slanted bars. Two solid; the middle one hatched with the same
diagonal as the Unknown state.

The mark says what the product says — some of what we know is established, some
of it honestly is not, and the second part is drawn rather than hidden. It is
the only logo in this category that admits to a gap.

Four variants ship, matching the pack:

| Asset          | Ground | Mark  | Middle bar |
| -------------- | ------ | ----- | ---------- |
| `*-light`      | paper  | ink   | hatched    |
| `*-dark`       | ink    | paper | hatched    |
| `*-mono-dark`  | any    | ink   | solid      |
| `*-mono-light` | any    | slate | solid      |

The mono variants draw the middle bar **solid**. At one colour and small sizes
the hatch fills in and reads as a muddy block, which is worse than an honest
solid — which is why the pack ships separate mono assets rather than leaving it
to chance.

Minimum sizes: 120px full lockup, 24px mark, 16px favicon. Minimum clear space
is one mark-height on every side.

## Building the assets

```bash
pnpm brand:build
```

Generates [`brand/`](../../../brand) (the distributable structure) and
`apps/web/public/brand/` (what the application serves) from one set of
coordinates and one set of tokens, in
[`scripts/build-brand-assets.ts`](../../../scripts/build-brand-assets.ts).

They are generated rather than hand-exported and committed for the reason the
hatch tokens are shared: the moment the mark's hatch, the Unknown chip's hatch
and the favicon's hatch are maintained separately, they drift, and the thing
that should read as one idea reads as three.

**Two honest limits.** The bar geometry is reconstructed from the v1.1 sheet,
which is a raster; when the official vector exists it replaces five path strings
and nothing else in the pipeline depends on the reconstruction. And the full
lockup SVG references Inter by name rather than embedding outlines — correct for
the application, which bundles the face, and **not** correct for an asset going
into somebody else's deck or email signature. Outline the text for those.

## No score, anywhere

The pack lists percentage security scores as a DON'T, and the product has no
function that could produce one. Coverage and satisfaction are reported as
separate figures with their denominators visible, and there is no code path that
combines them. See [ADR-0017](../../adr/ADR-0017-no-single-score.md).

## What the interface does not do

Straight from the pack's DON'T column, and each is enforced by the absence of
the mechanism rather than by review:

- **No shadows and no gradients.** Rules separate; nothing is raised. A shadow
  implies a card floating above the page, which is the generic SaaS card system
  the pack rules out.
- **No state colour as decoration.** No coloured buttons, no coloured chart
  series that do not encode state.
- **No oversized badges.** A tag that dominates its row competes with the thing
  it describes.
- **No decorative icons duplicating the state system.** State is the state tag,
  not a tick and a warning triangle beside it.
