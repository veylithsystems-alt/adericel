# Adericel brand

**Brand Pack v1.2 — asset-production and source-of-truth specification.**
Supersedes v1.1 where stated. The v1.1 raster sheet is retained at
[`adericel-brand-pack-v1.1.png`](./adericel-brand-pack-v1.1.png) as the visual
reference; v1.2 is a text specification and is the authority on tokens, asset
requirements and provenance.

`TRUTH / EVIDENCE / ASSURANCE`

v1.2 does not redesign anything. The direction from v1.1 stands —
**ink + paper + precision** — and the distinctive idea stays intact:

```
PROVEN  →  UNKNOWN  →  PROVEN
████       ░░░░        ████
```

Adericel should not look like a cybersecurity company. It should look like an
authoritative system.

## The source-of-truth rule

v1.2 §2 separates three things that are routinely conflated, and the separation
is the point of the whole document:

|                   | What it governs                                                          | Where it lives                  |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------- |
| **Specification** | Colour, type, semantics, spacing, usage, asset requirements              | This document and the v1.2 text |
| **Vector master** | Mark geometry, outlined wordmark geometry, proportions, path coordinates | **Not yet supplied**            |
| **Derivatives**   | Every application, favicon, app-icon and distribution asset              | `brand/`, generated             |

> ### Geometry status: PROVISIONAL
>
> The official vector master has not been supplied. The bar coordinates in
> [`scripts/build-brand-assets.ts`](../../../scripts/build-brand-assets.ts) are
> **reconstructed from the v1.1 raster sheet**. Per §29 they are provisional and
> reference only, and are not described anywhere as official, final, canonical
> or source artwork.
>
> When the master arrives: replace `MARK_BARS` and `FAVICON_BARS`, flip
> `geometry_status` in [`brand/brand-source.yml`](../../../brand/brand-source.yml)
> to `authoritative`, regenerate, validate, commit. **Nothing else changes** —
> §5 calls it a geometry substitution rather than a second redesign, and the
> pipeline is built so that is literally true.

## Colour

The canonical token block is v1.2 §22, copied verbatim into
[`tokens.css`](../../../apps/web/src/styles/tokens.css). Nothing in the
interface reads a raw hex.

### Brand colours — the identity

| Token | Value     | RGB             |
| ----- | --------- | --------------- |
| Ink   | `#14181F` | 20 / 24 / 31    |
| Paper | `#FBFBF9` | 251 / 251 / 249 |
| Slate | `#5A6270` | 90 / 98 / 112   |

### Assurance state colours — not brand colours

| State     | Token           | Value             | RGB           |
| --------- | --------------- | ----------------- | ------------- |
| Proven    | `--c-proven`    | `#1E5540`         | 30 / 85 / 64  |
| Failing   | `--c-failing`   | `#A33326`         | 163 / 51 / 38 |
| Exception | `--c-exception` | `#96601A`         | 150 / 96 / 26 |
| Unknown   | —               | ink/paper + hatch | —             |

Structural: `--c-rule` is `#DCDDD8`.

**Green is not Adericel's brand colour. Green means PROVEN.** State colour
communicates actual assurance state and nothing else — not navigation, not
buttons, not headings, not decoration, not the app icon. Spend it elsewhere and
the one place it carries meaning stops carrying it.

### Corrected in v1.2

The v1.1 design-token panel printed an eight-character string for
`--c-exception` that is not a valid hex colour. The authoritative value is
`#96601A`, matching the swatch's RGB 150 96 26. The malformed string is banned
from the repository and a test enforces its absence — which is why it is
described here rather than quoted.

`--c-rule` also returns to `#DCDDD8`, the value in the v1.2 canonical block.

## Unknown has no colour

Every other state gets a fill. Unknown gets a hatch — a texture, not a hue.

This is semantic, not stylistic. Unknown means _the system cannot currently
establish the state from sufficient authoritative evidence_. A hue would place
it on the good-to-bad axis, and it is not on that axis. Amber reads "nearly
fine"; red reads "failing"; grey reads "unimportant". The hatch reads _no
reading here_, which is the truth.

v1.2 §10 forbids replacing it with a yellow warning, a red failure, a warning
icon, or a traffic-light reading. Every other product in this category does one
of those, and it is the single decision separating a system of record from a
dashboard.

The hatch is defined once — angle, line width, pitch — and reused by the state
tag, the count bar and the mark, so the three cannot drift apart.

## Typography

| Role | Face          | Weights         | Use                                                                   |
| ---- | ------------- | --------------- | --------------------------------------------------------------------- |
| UI   | Inter         | 400 / 500 / 600 | Interface, headings, body, navigation, ordinary numbers               |
| Data | IBM Plex Mono | 400 / 500       | Evidence ids, hashes, correlation ids, provenance, technical metadata |

Plex Mono is **not** the general application font. It is for data that gets
compared character by character.

**Both faces are bundled, not fetched.** This was a correctness fix, not a
preference: the production CSP sets `font-src 'self'`, so the previous Google
Fonts link meant every deployed instance rendered in a system fallback and said
nothing about it. It also removes a request to a third party that would tell
them who is using their security tooling and when, and it means a self-hosted
instance behind a restrictive proxy renders correctly.

## Application assets vs distribution assets

v1.2 §25 makes this distinction mandatory, and it decides how the wordmark is
drawn.

**Application.** The app bundles Inter, so the in-product lockup composes the
mark and live text. It stays selectable, scales with the interface, and needs no
special handling.

**Distribution.** Anything going into a deck, a PDF, a partner's design tool or
a marketing asset must be self-contained. A recipient without Inter would
otherwise get the wordmark silently re-set in Arial. So the generated lockups in
`brand/logo/` carry the wordmark as **outlined vector path geometry**, extracted
from the Inter SemiBold binary — real glyph outlines, not a trace of a picture
of them. No `<text>` element, no font dependency, and a test enforces it.

## The mark

Three ascending slanted bars: solid, hatched, solid.

Four variants, all from the same geometry:

| Asset          | Ground | Mark  | Middle bar |
| -------------- | ------ | ----- | ---------- |
| `*-light`      | paper  | ink   | hatched    |
| `*-dark`       | ink    | paper | hatched    |
| `*-mono-dark`  | any    | ink   | solid      |
| `*-mono-light` | any    | paper | solid      |

The mono variants draw the middle bar **solid**. At one colour the hatch fills
in and reads as a muddy block, which is why separate mono assets exist rather
than leaving it to chance.

## The favicon is a designed derivative

v1.2 §14: the three-element master is too complex at very small sizes, and the
favicon must be a dedicated simplified derivative rather than the master scaled
down.

The derivative is **two solid bars with a deliberate gap**. At 16 pixels a
5-unit hatch pitch is finer than the pixel grid — it aliases into a grey smear
that reads as a rendering fault rather than as texture, and the three-bar
silhouette closes into a block. The simplification moves the semantic from
texture to negative space: two bars with a gap still say established / gap /
established at a size where no texture survives.

Verified legible at 16, 32 and 48.

## Minimum sizes

Full lockup 120px · mark 24px · favicon 16px. Below these, use the appropriate
derivative rather than shrinking the master. Minimum clear space is 1X, where X
is the height of the mark's primary geometric unit — to be derived exactly from
the vector master when it arrives.

## Building

```bash
pnpm brand:build      # regenerate every derivative
pnpm test:unit        # brand validation
```

The pipeline is:

```
geometry + tokens → vectors → small-scale derivatives → raster exports
                  → manifest with SHA-256 per asset → commit
```

SVG is the canonical production representation. **PNG is an export and never a
source of truth.** The builder is deterministic: identical inputs produce
byte-identical output, and a test proves it by running the build twice and
comparing hashes.

Provenance is recorded in
[`brand/brand-source.yml`](../../../brand/brand-source.yml) — geometry source,
geometry status, every token, and a SHA-256 for each generated asset.

## Automated validation

Per v1.2 §28, enforced in
[`tests/unit/brand-tokens.test.ts`](../../../tests/unit/brand-tokens.test.ts):

- Every canonical colour matches the specification; the malformed exception
  string appears nowhere in the repository.
- Green is absent from the mark and from every non-state context.
- Unknown carries no hue.
- SVGs are genuine vectors: valid XML, explicit `viewBox`, no embedded raster,
  no base64 payloads, no external references.
- Distribution lockups contain no `<text>`.
- Every required file in the §17 structure exists, under canonical names —
  `logo-black`, `logo-white`, `logo-green`, `logo-final` are rejected.
- The build is deterministic across runs.
- No shadows; no gradients other than the hatch.

## Do not

Straight from §24, each enforced by the absence of the mechanism rather than by
review: no green as a brand colour, no green app icon, no state colour as
decoration, no gradients, no gloss, no generic SaaS card styling, no
cybersecurity clichés — shields, locks, circuit boards — no AI sparkles, no
warning-state Unknown, no decorative ticks beside Proven or warning triangles
beside Failing. The state tag is the state; an icon repeating it adds nothing
and invites the traffic-light reading the whole system rejects.
