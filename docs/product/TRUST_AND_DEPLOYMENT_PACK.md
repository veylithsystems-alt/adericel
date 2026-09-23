# Adericel Trust and Deployment Pack

The thirteen questions a UK MSP and their client will ask before they put a
single customer's estate into this product — answered, with the place in the
system where each answer is enforced.

This is a customer-facing document. Everything in it is a position the code
holds, and where a position is weaker than it sounds, this document says so:
an answer that oversells is worth less than no answer, because the customer
finds out at the worst possible moment.

---

## 1. Where is customer data stored?

Wherever you put it. Adericel is self-hosted by design: one PostgreSQL 16
database, object storage you provide, on infrastructure you control. There is
no Adericel-operated cloud that customer data flows to, because there is no
component that phones home.

Sized to run alongside PostgreSQL, Redis, n8n and a local model on a single
16 GB VPS. The working, including what that machine will not do, is in
[`docs/operations/vps-sizing.md`](../operations/vps-sizing.md).

## 2. Who can access it?

Three surfaces, and the boundaries are enforced twice — by information class
and by grant scope, independently.

The consequence that matters: **a Veylith platform administrator has no
standing access to any customer's assurance data or personal data.** A platform
grant is honoured on neither Adericel surface. This is not a policy; it is the
surface model, and `tests/security/information-boundary.test.ts` proves it.

Support that genuinely needs it uses break-glass: four hours maximum, a
justification of substance, a second factor required even in an emergency, the
MSP told at the time rather than from an audit log later, visible in the
client's own audit trail, unextendable at any layer, and reviewed afterwards
whether or not it turned out to be warranted. It cannot confer authority over
who can reach the estate, and it grants only the permissions actually asked
for — grants carry an attenuation the database refuses to widen.

[ADR-0031](../adr/ADR-0031-three-surfaces.md),
[ADR-0046](../adr/ADR-0046-break-glass-and-grant-attenuation.md).

## 3. Can the MSP run it in its own environment?

Yes, and that is the intended deployment.

`docker build --target product` builds an image with Veylith's own operating
layer — the autonomy gate, the exception queue, the business ledger, the
commercial pipeline — **removed**. `pnpm db:migrate:product` leaves those
tables out of your database entirely. `ADERICEL_COMPANY_LAYER` defaults to off,
so an unset flag means a customer deployment.

There is no static import path from the product to the company layer, which
means a product build genuinely does not load it rather than merely not calling
it. [ADR-0049](../adr/ADR-0049-product-and-company-layers.md).

## 4. What happens if Adericel fails?

Three different failures, three different answers:

**The process stops.** The database is the single source of truth. Restart and
the position is exactly as it was — there is no in-memory state that matters.
Assessments are deterministic and replayable from their recorded inputs.

**A connector stops.** Controls that depended on it go DEGRADED, not
NOT_SATISFIED. A broken source is not a failing control, and Adericel says
which it is. [ADR-0043](../adr/ADR-0043-degraded-and-blocked.md).

**Veylith stops existing.** You hold the source, the database and the
migrations. The product runs without any Veylith service, and the company layer
is not required. This is a real question for a single-founder supplier and
deserves the honest answer: the code is yours to run, and nothing in it calls
home.

## 5. Can evidence be exported?

Yes, in full, at any time, in every commercial state including `TERMINATED`.

No commercial state withholds an organisation's own assurance record. Holding a
client's compliance record hostage over an invoice is not a commercial lever.
Enforced across all ten states and tested.
[ADR-0047](../adr/ADR-0047-commercial-is-not-security.md).

## 6. How are backups tested?

CI proves backup **and restore**, not backup alone. A backup nobody has
restored is a file, not a recovery plan.

Honestly stated limitation: corruption detection is unproven, and the four
distinct claims §30 asks for — backup succeeded, restore succeeded, service
recovered, business recovered — are not yet separated. Tracked as an open item
in the residual-risk register rather than glossed over.

## 7. How are customer and MSP tenants separated?

Two independent layers, because one is a single point of failure:

1. Application code resolves organisation access from the authenticated
   principal's grants. A caller-supplied tenant identifier is never sufficient.
2. PostgreSQL row-level security with `FORCE ROW LEVEL SECURITY` enforces the
   same boundary underneath, so a bug in the first layer does not become a
   breach.

The application **refuses to start** if row-level security is not actually in
force. A test sweeps every table carrying an `organisation_id` and fails if any
is unprotected — that sweep has caught a real unprotected table, which is why
it exists. [ADR-0007](../adr/ADR-0007-tenant-isolation.md).

## 8. What subprocessors are used?

In the default deployment: **none.**

`INFERENCE_PROVIDER=none` is the default and is a complete deployment. Billing
via Stripe is optional and provider-neutral — the interface is replaceable and
a manual provider ships alongside it. There is no analytics, no telemetry
endpoint, no error-reporting service, and no component that makes an outbound
call you did not configure.

`GET /v1/system/data-processing` reports where this deployment sends data. It
is deliberately readable by a customer, because it is the answer to the question
their solicitor asks.

## 9. How does local inference work?

A model on your own hardware, via Ollama, in the same compose stack.

Sovereignty is a classification the code enforces, not a preference in a
document. Every provider is classed by where the data goes, the classification
is exhaustive over the provider list and tested, and anything that would move a
customer's documents outside infrastructure you control **refuses to start**
without a written acknowledgement naming the operator and the jurisdiction —
not a checkbox, a sentence, recorded verbatim and reported at
`/v1/system/data-processing`.

Extraction is grounded: every proposed value must quote the document, and
Adericel checks the quote is actually there. A value that cannot show where it
came from is dropped before anyone sees it — because a reviewer confirming a
hundred supplier certificates will not open a hundred PDFs, and the one they do
not open is the one that was invented.

## 10. Can external inference be disabled?

It is disabled unless you deliberately enable it, and enabling it requires a
written acknowledgement rather than a configuration value.

More importantly: **no model participates in any assurance determination at any
setting.** An AI-derived claim is created with provenance `AI_SUGGESTED`, and
`isRuleEligible()` refuses to hand it to the Truth Engine until a named human
has confirmed it. There is no flag that changes this. Turning AI off entirely
changes suggestion quality and nothing else.

[ADR-0004](../adr/ADR-0004-ai-truth-separation.md),
[ADR-0041](../adr/ADR-0041-sovereign-inference.md).

## 11. What happens when data is unknown or stale?

It says so, and then it helps you fix it.

`UNKNOWN` is a first-class state. It never resolves to secure, insecure,
compliant or non-compliant — it propagates through evaluation, aggregation, the
API and onto the screen, where it is drawn as a diagonal hatch rather than a
colour, because a colour is an opinion.

An organisation with twenty-one unknown controls and zero findings does not
have a clean bill of health, and Adericel says so in those words.

Stale is distinct from unknown, and both are distinct from a broken source.
Every material unknown carries eight things: why it is unknown, what evidence
would resolve it, who can provide that evidence, how material it is, what
happens if it stays unresolved, which kind of gap it is, the next recommended
action, and how many control assessments resolving it would make decidable.

That last figure is a count over your assurance graph — never a probability and
never a confidence percentage, because those would be fabrications dressed as
precision.

## 12. How are incidents reported?

A security concern reaches Veylith security directly, whoever raises it — the
one exception to MSP-first routing, because if the platform is what is
compromised then routing through the MSP costs time and may route through an
affected party. Raising it discloses no estate data; reaching an estate still
requires break-glass.

Containment gives a governed way to restrict: six levels, authority earned per
level, and **no level at any severity withholds an organisation's own assurance
record.** Containment stops Adericel doing things; it does not stop customers
knowing things. [ADR-0045](../adr/ADR-0045-governed-containment.md).

Honestly stated limitation: containment has no automatic triggers yet. It works
when somebody notices. Tracked in the residual-risk register.

## 13. How is the service exited?

The client leaves with their record.

- Full export at any time, in every commercial state.
- The Assurance Passport exports as a detached-signed envelope a recipient
  verifies on their own machine, with no Adericel account and no network call.
  The envelope format and canonicalisation are documented in
  [`schemas/`](../../schemas), so verification can be reimplemented in about
  twenty lines against any standard Ed25519 library. Verification that only
  works with the vendor's tool is not independent verification.
- Erasure means erasure: a deletion request removes the data rather than
  flagging it. What remains is the audit record that it happened.
- Retention is a policy per organisation, because the obligation belongs to the
  client and their regulator, not to Adericel's defaults.

[ADR-0030](../adr/ADR-0030-offboarding.md),
[ADR-0032](../adr/ADR-0032-erasure-and-retention.md),
[ADR-0040](../adr/ADR-0040-signed-passport-interchange.md).

---

## What this pack does not claim

Recorded here because a trust document that lists only strengths is a sales
document:

- **Adericel is not a certification body.** A framework pack is not
  certification and is not legal compliance. See
  [FRAMEWORK_PACKS.md](./FRAMEWORK_PACKS.md).
- **Corruption detection in backups is unproven**, and the four recovery claims
  are not yet separated.
- **Containment has no automatic triggers.** It is an operator capability.
- **Proactive support has no producer yet.** The routing exists; nothing raises
  a case from connector health.
- **Cyber Essentials requirement paraphrases have not been checked** against the
  published scheme document by a person.
- **No customer has run this in production.** Every claim here is about what the
  code does and what the tests prove, not about operational history, because
  there is none.

The full list, with impact and mitigation for each, is the
[residual-risk register](../audit/RESIDUAL_RISK_REGISTER.md). It is maintained
because §38 requires that known limitations never be hidden merely because they
make the product look less mature.
