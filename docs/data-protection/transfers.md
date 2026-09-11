# International transfers

## Where the data is

Adericel is self-hosted. The database, the object storage and the application
run wherever the deployment was provisioned, and that is the only place customer
data lives at rest. For instances Veylith operates, that is the United Kingdom
or the European Economic Area, and it is stated in the order form for each
customer rather than left to a general assurance.

There is no shared multi-tenant analytics warehouse, no replica in another
region, and no vendor that receives a copy of the assurance record.

## Transfers that can occur

| Transfer                                                         | Safeguard                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| To the hosting provider's region                                 | None needed for a UK or EEA region. A customer who provisions elsewhere makes that choice as controller |
| To Stripe, for billing contact and payment data                  | Stripe's own transfer mechanism. No customer estate or assurance data is sent                           |
| To the configured email service, for messages somebody asked for | Depends on the service chosen. A deployment using its own relay transfers to nobody                     |

## Connector egress

Adericel reaches out to a customer's own systems to observe them — Microsoft
365, Google Workspace, and the others. That traffic goes to the customer's own
tenant, in whatever region the customer's own provider holds it. Veylith is not
a party to where a customer chose to run Microsoft 365.

Outbound connector traffic is constrained: private address ranges, link-local
addresses and cloud metadata endpoints are refused at connect time, after DNS
resolution rather than before, so a hostname that resolves to an internal
address cannot be used to reach one (ADR-0018).

## What is not claimed

Veylith does not claim adequacy decisions or standard contractual clauses it has
not executed. Where a customer needs a specific transfer mechanism in place, it
is a term to agree in the DPA, not something to assume from this page.
