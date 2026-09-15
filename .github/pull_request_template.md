## What this changes

<!-- One or two sentences. What is different after this is merged? -->

## Why

<!-- The problem, not the solution. If it fixes a defect, what was the failure? -->

## Checks

- [ ] `pnpm verify` passes (lint, typecheck, full test suite)
- [ ] `pnpm n8n:validate` passes, if the export or the API it calls changed

## Questions this repository asks of every change

Answer only the ones that apply. "Not applicable" is a fine answer; silence is
not, because these are the things that are expensive to discover later.

- **Truth.** Does this change what Adericel is willing to assert? If so, is
  there an ADR?
- **UNKNOWN.** Is there any path where missing or stale data now resolves to
  something other than UNKNOWN?
- **Tenancy.** Does this add a table, a query, or a route that touches tenant
  data? Is it covered by row-level security and by a test?
- **Authority.** Does this change who can do what? Does anything now let a
  non-human principal approve?
- **History.** Does this update or delete a row that was previously append-only?
- **Verification.** If this executes something externally, does it verify by
  re-observation rather than by trusting a response?
