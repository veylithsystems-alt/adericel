# Architecture Decision Records

Every consequential architectural decision in Adericel is recorded here. An ADR
explains what was decided, what else was considered, and — most importantly —
what the decision costs, because a decision recorded without its consequences is
just an assertion.

The format is deliberately uniform: Context, Decision, Alternatives considered,
Consequences, Security implications, Operational implications, Migration
implications.

| ADR                                                                 | Title                                                             | Status   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [0001](./ADR-0001-assurance-graph-canonical-domain-model.md)        | Assurance Graph as canonical domain model                         | Accepted |
| [0002](./ADR-0002-truth-engine-boundary.md)                         | The Truth Engine boundary                                         | Accepted |
| [0003](./ADR-0003-unknown-as-first-class-state.md)                  | UNKNOWN as a first-class assurance state                          | Accepted |
| [0004](./ADR-0004-ai-truth-separation.md)                           | AI is separated from truth                                        | Accepted |
| [0005](./ADR-0005-rules-as-data.md)                                 | Rules are data, not code                                          | Accepted |
| [0006](./ADR-0006-postgresql.md)                                    | PostgreSQL as the single primary store                            | Accepted |
| [0007](./ADR-0007-tenant-isolation.md)                              | Defence-in-depth tenant isolation                                 | Accepted |
| [0008](./ADR-0008-authentication-authorisation.md)                  | Identity carries no authority                                     | Accepted |
| [0009](./ADR-0009-evidence-architecture.md)                         | Evidence is append-only with explicit validity                    | Accepted |
| [0010](./ADR-0010-temporal-model.md)                                | Distinct temporal dimensions                                      | Accepted |
| [0011](./ADR-0011-event-model-outbox.md)                            | Transactional outbox for domain events                            | Accepted |
| [0012](./ADR-0012-n8n-role.md)                                      | n8n orchestrates; it does not decide                              | Accepted |
| [0013](./ADR-0013-integration-architecture.md)                      | One connector contract for every integration                      | Accepted |
| [0014](./ADR-0014-action-architecture.md)                           | Explicit action lifecycle with mandatory verification             | Accepted |
| [0015](./ADR-0015-approval-four-eyes.md)                            | Four-eyes control is structural                                   | Accepted |
| [0016](./ADR-0016-idempotency.md)                                   | At-most-once external effects                                     | Accepted |
| [0017](./ADR-0017-no-single-score.md)                               | No single assurance score                                         | Accepted |
| [0018](./ADR-0018-deployment.md)                                    | Self-hosted, container-first deployment                           | Accepted |
| [0019](./ADR-0019-secrets.md)                                       | Secret handling and credential sealing                            | Accepted |
| [0020](./ADR-0020-backup-dr.md)                                     | Backup and disaster recovery                                      | Accepted |
| [0021](./ADR-0021-observability.md)                                 | Observability and correlation                                     | Accepted |
| [0022](./ADR-0022-typescript-monorepo.md)                           | TypeScript monorepo                                               | Accepted |
| [0023](./ADR-0023-recorded-assessment-inputs.md)                    | Assessments record the facts they ran on                          | Accepted |
| [0024](./ADR-0024-approval-binds-to-the-request.md)                 | An approval authorises one specific request                       | Accepted |
| [0025](./ADR-0025-self-serve-onboarding.md)                         | Self-serve onboarding, honest on the first screen                 | Accepted |
| [0026](./ADR-0026-assurance-passport.md)                            | The Assurance Passport                                            | Accepted |
| [0027](./ADR-0027-billing-lapse.md)                                 | Billing lapse: stop asserting, keep the record                    | Accepted |
| [0028](./ADR-0028-connector-manifests-and-capability-resolution.md) | Connectors declare capability in canonical predicates             | Accepted |
| [0029](./ADR-0029-source-conflict.md)                               | When two systems disagree, Adericel does not choose               | Accepted |
| [0030](./ADR-0030-offboarding.md)                                   | A customer leaves with their record                               | Accepted |
| [0031](./ADR-0031-three-surfaces.md)                                | Three surfaces, and no standing route between them                | Accepted |
| [0032](./ADR-0032-erasure-and-retention.md)                         | Erasure means erasure                                             | Accepted |
| [0033](./ADR-0033-proof-of-value.md)                                | Adericel counts what it did; the MSP prices it                    | Accepted |
| [0034](./ADR-0034-answer-is-a-determination.md)                     | A questionnaire answer is a determination                         | Accepted |
| [0035](./ADR-0035-interpretations-are-artefacts.md)                 | Interpretations are confirmed, versioned artefacts                | Accepted |
| [0036](./ADR-0036-no-silent-yes.md)                                 | No silent yes                                                     | Accepted |
| [0037](./ADR-0037-question-bank-boundary.md)                        | The bank holds questions, never answers                           | Accepted |
| [0038](./ADR-0038-post-submission-watch.md)                         | A submitted answer keeps being checked                            | Accepted |
| [0039](./ADR-0039-the-loop-is-an-object.md)                         | The loop is a recorded object                                     | Accepted |
| [0040](./ADR-0040-signed-passport-interchange.md)                   | A Passport is signed, and the signature is what a stranger checks | Accepted |
| [0041](./ADR-0041-sovereign-inference.md)                           | Inference is local first, and leaving requires an author          | Accepted |
| [0042](./ADR-0042-msp-only-distribution.md)                         | Every organisation belongs to an MSP                              | Accepted |
| [0043](./ADR-0043-degraded-and-blocked.md)                          | A broken source is not an unknown                                 | Accepted |

## Writing a new ADR

Copy the structure of an existing one. Number sequentially. An ADR is written
when the decision is made, not afterwards — the value is in capturing the
alternatives while they are still live options rather than reconstructing them
once the choice looks inevitable.

A decision is "consequential" if reversing it later would require changing more
than one package, would require a data migration, or would change what Adericel
is willing to assert.
