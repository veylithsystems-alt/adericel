# The commercial boundary between Adericel and Veylith Systems

Adericel is the product. Veylith Systems Ltd is the company that builds and
operates it. They are not the same system, they are not the same deployment,
and the separation is enforced in code rather than promised in a contract.

This document states the boundary for product and sales conversations. The
engineering is [ADR-0049](../adr/ADR-0049-product-and-company-layers.md).

## The six positions

**1. Adericel core can be customer-deployed independently.**

`docker build --target product` builds an image with the company layer's
compiled output removed. `pnpm db:migrate:product` leaves the company schema
out of the database entirely. `ADERICEL_COMPANY_LAYER` defaults to off, so an
unset flag means a customer deployment.

Verified: a clean database migrated as product carries 77 Adericel tables, no
`veylith` schema, and no company migration in the ledger.

**2. Veylith's commercial pipeline is not required.**

There is no static import path from the product to the company layer. It is
reached through a dynamic import inside a branch on the configuration flag,
which means a product build genuinely does not load it — rather than merely not
calling it. A static import would put it in the module graph of every
deployment, and a bundler, an SBOM and a vulnerability scan would all correctly
report it as part of the product.

Two tests hold that line: one asserts no static import exists anywhere outside
the company layer's own module, and one asserts every dynamic import of it sits
behind the flag. A dynamic import nothing decides about is the same dependency
with extra steps.

**3. Veylith company memory is not exposed to customers.**

The autonomy gate, the exception queue, the business ledger and the commercial
pipeline serve Veylith's own control room. On a product deployment those routes
are **not registered at all** — absent, not refused. There is nothing to probe
and nothing for a later change to accidentally open.

**4. Customer data is not used to operate other products.**

There is no shared model, no pooled dataset, no cross-tenant aggregate, and no
telemetry endpoint. The default deployment makes no outbound call you did not
configure. `INFERENCE_PROVIDER=none` is the default and is a complete
deployment — no model participates in any assurance determination at any
setting.

Where a deployment does enable document reading, the intended path is a model
on your own hardware. Moving a customer's documents outside infrastructure the
operator controls **refuses to start** without a written acknowledgement naming
the operator and the jurisdiction.

**5. Customer tenancy and evidence remain isolated.**

Two independent layers: application-code authorisation resolved from grants,
and PostgreSQL row-level security with `FORCE`. The application refuses to
start if row-level security is not actually in force.

Evidence describes the client and belongs to them. The MSP holds the credential
because they administer the estate — that is custody, not ownership. Veylith
reads none of it, on any surface, in any state.

**6. Any managed-service layer is optional and separately contracted.**

If Veylith ever operates Adericel on an MSP's behalf, that is a distinct
service under a distinct agreement. The gate for it exists and is **granted to
nobody**: the direct-support entitlement table ships empty, and a test asserts
there is no `INSERT` into it anywhere in the application.

Built because §22 requires an entitlement gate regardless, and shipped closed
so the MSP sees a system that structurally cannot talk to their customer behind
their back. When the first agreement is signed, enabling it is a reviewed code
change rather than a path that was already sitting there.

## Why this is a commercial advantage, not just hygiene

An MSP putting forty clients' estates into a supplier's product is taking on
that supplier's risk. The questions they ask are about control: can we run it
ourselves, can we leave with our data, can you see our clients' information,
what happens to us if you fail.

Most vendors answer those with a contract. Adericel answers them with a build
target, a migration flag, a test that fails if the boundary is crossed, and a
document generated from the system rather than written about it.

That is harder to replicate than a clause, and it is checkable — an MSP's own
engineer can read the Dockerfile, run the product migration against an empty
database, and see for themselves.

## One thing this boundary does not yet cover

A database migrated before ADR-0049 already carries the `veylith` schema, and
nothing removes it. There are no customer installs yet, so no customer database
holds it — but the migration that drops it is destructive and deserves a real
install to test against rather than being written blind.

Tracked as an open item in the
[residual-risk register](../audit/RESIDUAL_RISK_REGISTER.md), to be closed
before the first customer self-hosts.
