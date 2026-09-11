# Data protection

Veylith Systems Ltd operates Adericel. This directory is the data protection
position: what is held, why, on what basis, for how long, and what happens when
somebody asks for it to stop.

Two things about it are unusual, and both are deliberate.

**The record of processing is code.** `packages/domain/src/personal-data.ts` is
the register, and `tests/security/personal-data.test.ts` holds it against the
live database in both directions on every run. A migration that adds a column
holding personal data and does not declare it fails the build. A register entry
naming a column that no longer exists fails the build. The published retention
schedule in `retention.md` is generated from the same constant the retention
sweep runs from, so a schedule and a codebase cannot disagree.

**Nothing here claims more than the code does.** Where a right is limited, the
limit is stated. Where data is pseudonymised rather than deleted, it says
pseudonymised. Where something is not yet built, it says so and names what would
have to change.

## The documents

| Document                                     | What it is                                           |
| -------------------------------------------- | ---------------------------------------------------- |
| [`ropa.md`](./ropa.md)                       | Record of processing activities (UK GDPR Article 30) |
| [`retention.md`](./retention.md)             | Retention schedule, and how it is enforced           |
| [`subject-rights.md`](./subject-rights.md)   | How a request from a person is answered, and by whom |
| [`subprocessors.md`](./subprocessors.md)     | Every third party that can touch customer data       |
| [`dpa.md`](./dpa.md)                         | The processing terms Veylith offers its customers    |
| [`privacy-notice.md`](./privacy-notice.md)   | For people whose data Veylith holds as controller    |
| [`breach-response.md`](./breach-response.md) | What happens in the 72 hours after a breach          |
| [`transfers.md`](./transfers.md)             | Where data is, and where it is not                   |

## Who is what

The distinction decides who answers a request, and it is not cosmetic.

**Veylith is a controller** for people who have an Adericel login, for business
contacts it approaches, and for its own staff. It decides why it holds that data
and answers requests about it directly.

**Veylith is a processor** for everything inside a customer's estate: the
accounts, devices, mailboxes and people that connectors observe. The customer —
or the MSP acting for them — is the controller. A person inside a customer's
estate who asks Veylith about their data is directed to that customer, and
Veylith assists rather than answering.

The one structural fact that makes this credible rather than a paragraph:
**Veylith staff have no standing access to any customer's data.** A platform
administrator holding every permission the company has cannot read a customer's
controls, evidence, findings, actions or audit trail. Access requires an
expiring grant issued as a deliberate, attributable act. This is enforced by the
three-surface boundary (ADR-0031) and proved by
`tests/security/information-boundary.test.ts`.

## What is not done

Stated here rather than left to be discovered:

- **No DPIA has been carried out.** One is not automatically required for this
  processing, but it should exist before the first customer with a large estate.
- **No ICO registration.** Required before Veylith processes personal data as a
  controller in the UK, and it is a fee and a form, not a project.
- **The break-glass grant is issued by direct database access.** Honest, and not
  good enough for long: it should be a route on the internal control room with a
  reason, a maximum duration, and a notification to the customer.
- **These documents have not been reviewed by a solicitor.** They are written to
  be accurate about what the software does. Whether they are sufficient as
  contract terms is a question for somebody qualified to answer it.
