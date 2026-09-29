# The controlling contract

Adericel is built to the **MASTER PRODUCT, ENGINEERING, OPERATING, SUPPORT &
BUILD CONTRACT**, issued by Veylith Systems. The contract is the authority; this
directory holds what the repository needs in order to be audited against it.

## `v3.2-extracted.txt`

A text extraction of the v3.2 PDF, kept so that a claim in this repository can
be traced to the words it rests on. It is not the contract — the PDF is.

## Seven passages are incomplete in the contract itself

**This was first recorded here as an extraction failure, and that was wrong.**
The document was re-examined with a positional extractor that decodes composite
fonts and reassembles lines by coordinate. The result is the same in these seven
places, and the file was then examined directly:

- it contains **no images** (no `/Subtype/Image` object anywhere),
- it contains **no form XObjects**,
- it contains **no vector drawing** (zero curve operators on any of the 22
  pages),
- and there are **no text fragments** at the coordinates in question.

Between "The fundamental Adericel loop is:" at y=287 and "Every major subsystem
must reinforce this loop." at y=218 there is a single empty paragraph — a 27pt
gap, not the space a diagram would occupy. Nothing was lost in reading the file.
The passages are empty in the document.

| Where                                                             | What is absent                                   |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| §3.6 VERIFY, "The authoritative lifecycle is:"                    | Everything after the first bullet, `-OBSERVE`.   |
| "The fundamental Adericel loop is:"                               | The loop.                                        |
| "Action authority follows:"                                       | The authority progression.                       |
| "Adericel is distributed through:"                                | The distribution model.                          |
| "Support lifecycle:"                                              | The support stages.                              |
| "Adericel should progressively own:"                              | Everything after the word `memory`.              |
| "Every material determination must preserve appropriate lineage:" | The lineage chain.                               |
| "The ultimate Adericel test is:"                                  | The sentence stops mid-clause at "and what the". |

**Nothing in this repository may be built from a guess at those.** Where a
missing item was needed it is recorded as an open risk rather than inferred: the
contract itself forbids presenting an assumption as an implemented capability,
and that applies most sharply to assumptions about the contract. See RR-075.

If the Word original has these lists, exporting it again would supply them. As
the PDF stands they are not there to read.

## What changed from v3.1 to v3.2, as it affects the build

v3.2 is a principle-and-lifecycle contract rather than a numbered-section one.
Three changes had direct engineering consequences, each now built:

1. **The ten completion conditions are stated.** v3.1's audit counted them; v3.2
   names them. They are modelled in
   [`release-gate.ts`](../../packages/domain/src/release-gate.ts).
2. **Four headline states** — `PROVEN`, `FAILING`, `EXCEPTION`, `UNKNOWN` — are
   required as the outward vocabulary, alongside the richer internal lattice.
   Mapped in [`assurance.ts`](../../packages/domain/src/assurance.ts).
3. **Ten provenance truth states**, three of which the repository did not carry:
   `DEGRADED`, `BLOCKED`, `FAILED`. Added to
   [`truth-state.ts`](../../packages/domain/src/truth-state.ts).

The gap report for v3.2 is
[`ADERICEL_V3.2_CONTRACT_GAP_REPORT.md`](../audit/ADERICEL_V3.2_CONTRACT_GAP_REPORT.md).
