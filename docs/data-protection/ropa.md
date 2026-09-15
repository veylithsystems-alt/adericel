# Record of processing activities

UK GDPR Article 30. Veylith Systems Ltd, operating Adericel.

The authoritative version of the table below is
`packages/domain/src/personal-data.ts`, which the retention sweep runs from and
which `tests/security/personal-data.test.ts` checks against the live database on
every run. This document exists so a person can read it; the code exists so it
cannot quietly become untrue.

## Controller and contact

|                          |                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller               | Veylith Systems Ltd (England and Wales)                                                                                                                                                                            |
| Data protection contact  | `privacy@veylith.com`                                                                                                                                                                                              |
| Representative in the EU | None. Veylith does not offer services to EU data subjects at present; if that changes, Article 27 applies and a representative must be appointed.                                                                  |
| DPO                      | Not appointed. Veylith does not carry out large-scale systematic monitoring of individuals, nor process special category data at scale, so Article 37 does not require one. Reconsider on reaching material scale. |

## Processing as controller

People whose data Veylith decides the purpose for.

| Data subjects                                                | Categories of data                                                                                | Purpose                                                           | Lawful basis                                                                                                               | Retention                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Users of Adericel (MSP staff, customer staff, Veylith staff) | Name, work email address, password hash, second-factor secrets, session addresses and user agents | Authenticate the person, and attribute the decisions they make    | Contract (Art. 6(1)(b))                                                                                                    | Account data while the account is active; session addresses 90 days after expiry |
| People invited to Adericel who never accept                  | Work email address                                                                                | Deliver and honour an invitation                                  | Contract, pre-contractual steps (Art. 6(1)(b))                                                                             | 90 days past invitation expiry, then deleted                                     |
| People who begin a self-serve signup                         | Name, work email, originating address                                                             | Complete the signup, resist automated abuse of the form           | Contract, pre-contractual steps (Art. 6(1)(b))                                                                             | 90 days if never completed, then deleted                                         |
| MSP billing contacts                                         | Work email address                                                                                | Billing, incident and service notices                             | Contract (Art. 6(1)(b))                                                                                                    | While the contract is live                                                       |
| Business contacts at prospective MSP customers               | Name, work email, company                                                                         | Approach an MSP about Adericel; remember not to approach it twice | Legitimate interests (Art. 6(1)(f)) — B2B outreach to a named role at a business, with an objection route in every message | 730 days without engagement, then deleted                                        |

**Legitimate interests balancing, in one line, for the only entry that relies on
it:** the interest is Veylith finding customers; the data is a work contact at a
business, never a consumer; the impact on the person is one email they can stop
with a word; the alternative — buying larger lists and mailing more people — is
worse for them. Recorded here so the assessment exists rather than being assumed.

## Processing as processor

Data inside a customer's estate. The customer, or the MSP acting for them, is
the controller. Veylith processes on documented instructions, which are the
product's configuration: which connectors are enabled and which frameworks are
assessed.

| Data subjects                                              | Categories of data                                                                                                                              | Purpose                                                                                              | Retention                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A customer's staff, contractors and service accounts       | Account identifiers, mailbox and device names, whether a second factor is enrolled, whether a disk is encrypted, when an account last signed in | Determine whether a security control is satisfied, from observed facts rather than from an assertion | Observations: 400 days maximum, and less where the customer sets it lower. Claims, graph and evidence: until the organisation is erased |
| A customer's staff who use Adericel                        | Who proposed, approved, executed and verified each change to the customer's estate                                                              | Evidence that a change was authorised, by whom, under what policy                                    | 7 years (limitation period for a contractual claim, plus margin). Network addresses within it: 400 days                                 |
| Third parties a customer shares an Assurance Passport with | Address and user agent of whoever opened the shared record                                                                                      | Tell the customer who has seen what they shared, which is what makes a share revocable               | 400 days, then pseudonymised                                                                                                            |

**No special category data.** Adericel observes the security posture of an
estate, not the people in it. It holds no health, biometric, political, racial,
religious, trade union or sexual orientation data, and does not infer any. The
register marks every entry `specialCategory: false` and a test fails if one is
ever set true, because that change would alter the lawful basis, require a DPIA,
and change the contract.

**No automated decision-making with legal or similarly significant effect.**
Adericel determines whether a control is satisfied. It does not make decisions
about people. Where it proposes a change that affects a person's account — for
example requiring a second factor — the change is proposed to a human and, above
autonomy level 0, executed only after a human approval that no automation may
give (ADR-0015).

**No use of customer data for model training.** Stated as a term in the DPA and
true of the code: there is no path from tenant data to any model, and the AI
boundary refuses to let a model output become an assurance determination
(ADR-0019).

## Security measures (Article 32)

Summarised; the detail is in `docs/security/threat-model.md`.

- Tenant isolation enforced by PostgreSQL row level security with
  `FORCE ROW LEVEL SECURITY`, not by application queries. Proved by
  `tests/tenancy/isolation.test.ts`, which attempts cross-tenant reads and
  writes and requires them to fail.
- Three information boundaries with no standing route between them (ADR-0031),
  so operating the platform conveys no access to customer data.
- Connector credentials sealed with AES-256-GCM envelope encryption, per
  organisation, with the integration id as additional authenticated data, in a
  table no tenant transaction can reach.
- Second factor required for every approval; approval refused to any principal
  that is not a human being.
- Complete, append-only audit trail including refusals, recording the surface
  each request was served through.
- Backups verified by restore in the test suite, not by the backup completing.
