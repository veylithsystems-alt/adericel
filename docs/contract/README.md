# The controlling contract

Adericel is built to the **MASTER PRODUCT, ENGINEERING, OPERATING, SUPPORT &
BUILD CONTRACT v3.2**, issued by Veylith Systems. The contract is the authority;
this directory holds what the repository needs in order to be audited against it.

## `v3.2-extracted.txt`

The contract's text, extracted with `pdfjs-dist` against the supplied PDF. It is
not the contract — the PDF is — but it is faithful, and a claim in this
repository can be traced to the words it rests on.

## A correction worth reading before you trust anything here

This file twice recorded that eight passages of the contract were **missing**.
Both records were wrong, and the second was worse than the first.

The sequence:

1. A hand-rolled extractor read the document and produced nothing where eight
   lists should have been. This was recorded as "the diagrams did not extract".
2. A second, better hand-rolled extractor — decoding composite fonts and
   grouping by coordinate — produced the same nothing. The file was then
   examined directly: no images, no form XObjects, no vector drawing. From that,
   this file concluded the passages were **empty in the document itself**, and
   the risk register was changed to say so.
3. `pdfjs-dist` read all eight without difficulty.

**The document was always complete.** The failure was in the reader, and the
second conclusion — "your contract has blanks in it" — was a stronger claim
than the evidence supported, made on the strength of a tool that had already
failed once. Absence of a signal in an instrument is not absence of the thing.

The lesson is recorded here rather than quietly fixed, because this repository
exists to refuse exactly that inference in its customers' systems: `UNKNOWN`
means the instrument did not establish it, never that the thing is not there.

## The eight passages, as the contract states them

| Where                                    | Content                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| §3.6 VERIFY, the authoritative lifecycle | `INTENT → POLICY → AUTHORISATION → RISK → ACTION → RE-OBSERVE → VERIFY → EVIDENCE`                          |
| The fundamental Adericel loop            | `OBSERVE → UNDERSTAND → ASSESS → DECIDE → ACT → VERIFY → PROVE → REMEMBER → IMPROVE`                        |
| Evidence lineage                         | `claim → control → rule → observation → source → evidence → timestamp → integrity`                          |
| Action authority                         | `Intent → Policy → Authorisation → Risk → Action → Verification → Evidence`                                 |
| Distribution                             | `Veylith/Adericel → MSP → MSP customer organisation`                                                        |
| Support lifecycle                        | `RECEIVED → TRIAGED → INVESTIGATING → ACTION_REQUIRED → VERIFICATION_PENDING → RESOLVED → CLOSED`           |
| What Adericel should progressively own   | `observation → truth → evidence → assurance → policy → action → verification → memory`                      |
| The ultimate test                        | Complete: "…what remains unresolved, and what the organisation's assurance state was at any point in time?" |

## What changed from v3.1 to v3.2, as it affects the build

Three changes had direct engineering consequences, each built:

1. **The ten completion conditions are stated.** v3.1's audit counted them; v3.2
   names them. Modelled in
   [`release-gate.ts`](../../packages/domain/src/release-gate.ts).
2. **Four headline states** — `PROVEN`, `FAILING`, `EXCEPTION`, `UNKNOWN` —
   required as the outward vocabulary, alongside the richer internal lattice.
   Mapped in [`assurance.ts`](../../packages/domain/src/assurance.ts).
3. **Ten provenance truth states**, three of which the repository did not carry:
   `DEGRADED`, `BLOCKED`, `FAILED`. Added to
   [`truth-state.ts`](../../packages/domain/src/truth-state.ts).

The gap report is
[`ADERICEL_V3.2_CONTRACT_GAP_REPORT.md`](../audit/ADERICEL_V3.2_CONTRACT_GAP_REPORT.md).
