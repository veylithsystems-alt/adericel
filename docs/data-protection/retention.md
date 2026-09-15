# Retention schedule

Every period here is declared in `packages/domain/src/personal-data.ts` and
enforced by the `sweep-retention` job, which runs nightly and reads from that
same constant. There is no second copy of these decisions for the two to
disagree about.

Each sweep writes what it did to `retention_runs`: which entry, which treatment,
the cutoff, and how many rows. So "addresses are removed after thirteen months"
is answerable with evidence rather than with the policy that says so.

## The periods

| What                                    | Kept for                         | Then                                  | Why this period                                                                                                                                                                         |
| --------------------------------------- | -------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User accounts (name, email)             | While the account is active      | Pseudonymised on erasure              | An account that no longer exists cannot sign in; the attribution left in the audit trail is held under its own rule                                                                     |
| MSP billing contact                     | While the contract is live       | Pseudonymised on erasure              | Needed for as long as there is a contract to service                                                                                                                                    |
| Session addresses and user agents       | 90 days past session expiry      | Deleted                               | Long enough to investigate an account compromise reported late; short enough that a location history does not accumulate                                                                |
| Second-factor challenge records         | 90 days                          | Deleted                               | Useful to an investigation, not a history                                                                                                                                               |
| Audit trail — who decided what          | 7 years (2555 days)              | Deleted                               | The ordinary limitation period for a contractual claim in England and Wales, plus a margin. This is the record a customer or an insurer needs if a decision is later disputed           |
| Audit trail — addresses and user agents | 400 days                         | Set to null; the entry survives       | Thirteen months covers an annual audit cycle and a breach found a year late. Who decided is the part that matters seven years on; where they were sitting is not                        |
| Approval addresses                      | 400 days                         | Set to null; the approval survives    | The approval and the approver stay with the action. The address is only useful while an incident could still be under investigation                                                     |
| Assurance Passport view records         | 400 days                         | Addresses and user agents set to null | A customer needs to know an insurer opened their passport this renewal. They do not need a permanent log of a third party                                                               |
| Invitations                             | 90 days past expiry              | Deleted                               | An expired invitation has done its work or failed; keeping the address of somebody who never accepted is holding data about a person who never became a user                            |
| Incomplete signups                      | 90 days                          | Deleted                               | An abandoned form. Ninety days lets somebody return to a verification email they ignored                                                                                                |
| Prospect contacts                       | 730 days without engagement      | Deleted                               | After two years, holding a named person's details for a conversation that never happened is not a legitimate interest                                                                   |
| Observations of a customer's estate     | 400 days maximum                 | Deleted                               | Superseded observations are pruned sooner by the per-organisation purge. The ceiling exists so a full annual cycle can be replayed and an assessment re-derived from the inputs it used |
| Claims, graph, evidence                 | Until the organisation is erased | Deleted                               | These are the customer's record. They stop being held when the customer says so, not on a timer                                                                                         |

## Two rules that hold across all of it

**A customer can shorten a period. Nobody can lengthen one.** Observation
retention is configurable per organisation, and the sweep enforces the
register's ceiling regardless of what the setting says.

**Deletion and pseudonymisation are never confused.** The schedule says which
one, the code does that one, and the record of the sweep says which one it did.
A row that still exists in a re-identifiable form has not been deleted, and this
document will not say it has.
