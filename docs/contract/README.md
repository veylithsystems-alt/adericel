# The controlling contract

Adericel is built to the **MASTER PRODUCT, ENGINEERING, OPERATING, SUPPORT &
BUILD CONTRACT**, issued by Veylith Systems. The contract is the authority; this
directory holds what the repository needs in order to be audited against it.

## `v3.2-extracted.txt`

A **lossy text extraction** of the v3.2 PDF, kept so that a claim in this
repository can be traced to the words it rests on.

It is not the contract. The PDF is the contract. Specifically, this extraction
is missing every diagram, and the contract uses diagrams for several
load-bearing lists. The following are known to be incomplete here:

| Where                                | What is missing                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| §3.6 VERIFY                          | The authoritative execution lifecycle. Only `OBSERVE` survives; the rest of the sequence was a diagram. |
| "The fundamental Adericel loop"      | The loop itself.                                                                                        |
| "Action authority follows:"          | The autonomy/authority progression.                                                                     |
| "Adericel is distributed through:"   | The distribution model.                                                                                 |
| "Support lifecycle:"                 | The support stages.                                                                                     |
| "Adericel should progressively own:" | All but the word `memory`.                                                                              |
| Evidence lineage                     | The lineage chain under "Every material determination must preserve appropriate lineage".               |
| The ultimate test                    | Truncated at "and what the".                                                                            |

**Nothing in this repository may be built from a guess at those.** Where a
missing item was needed, it is recorded as an open risk rather than inferred —
the contract itself forbids presenting an assumption as an implemented
capability, and that applies most sharply to assumptions about the contract.

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
