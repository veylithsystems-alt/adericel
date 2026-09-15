# Subprocessors

Every third party that can touch customer data, what it touches, and where.

This list is short by design. Adericel is a self-hosted product: it runs on
infrastructure the customer or the MSP chooses, with a PostgreSQL database
nobody else holds. Most of the sprawl that makes a subprocessor list long in
this market — a hosted analytics vendor, a session replay tool, a support widget
that reads the page, a customer data platform — does not exist here, and its
absence is a decision rather than an oversight.

## Current subprocessors

| Subprocessor                                   | What it processes                                                                                                  | Where                                                                           | Necessary because                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The hosting provider chosen for the deployment | Everything, at rest and in memory                                                                                  | Wherever the deployment is provisioned; UK or EU for Veylith-operated instances | The software has to run somewhere. Named per deployment, because self-hosted customers choose their own                        |
| Stripe Payments UK Ltd                         | Billing contact email, company name, payment details. **No customer estate data, no assurance data, no evidence.** | UK/EU, with Stripe's own transfer safeguards                                    | Taking money. Only engaged when `BILLING_PROVIDER=stripe`; a deployment that bills by invoice engages nobody                   |
| The configured outbound email service          | Recipient address and message body for verification, invitation and notification emails                            | Per deployment                                                                  | Delivering an email somebody asked for. Configurable; a deployment can use its own SMTP relay and engage no third party at all |

## Not subprocessors, and why that is worth stating

- **No analytics, telemetry or session replay vendor.** The product sends
  nothing about how it is used to anyone.
- **No AI provider by default.** The AI layer is off unless `AI_ENABLED` is set,
  and the deployment target is a local Ollama instance. Where a hosted model is
  configured instead, that provider becomes a subprocessor and must be added
  here — and it still cannot become authoritative: a model output can never
  become an assurance determination (ADR-0019).
- **No customer data used for model training, by anybody, ever.** A term of the
  DPA and a property of the code: there is no path from tenant data to any
  training process.
- **Veylith itself holds no standing access.** Veylith staff cannot read a
  customer's data without an expiring grant issued as a deliberate, attributable
  act (ADR-0031). This is not a policy about what staff will refrain from doing;
  it is enforced in the authorisation layer and proved by
  `tests/security/information-boundary.test.ts`.

## Changing this list

A new subprocessor is notified to customers at least 30 days before it begins
processing, with the right to object. If a customer objects and no reasonable
alternative exists, they may terminate and take their complete record with them
— which the export and offboarding flow makes real rather than aspirational.
