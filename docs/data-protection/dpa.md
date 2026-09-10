# Data processing terms

The processing terms Veylith Systems Ltd offers customers of Adericel, under
Article 28 UK GDPR. This is the substance; it becomes binding when incorporated
into a signed agreement.

**This has not been reviewed by a solicitor.** It is written to be accurate about
what the software does. Whether it is sufficient as contract terms is a question
for somebody qualified to answer it, and a customer should have their own
adviser read it.

## 1. Roles

The customer is the controller. Where an MSP operates Adericel on behalf of its
own clients, the MSP is the processor for its clients and Veylith is the
sub-processor; the MSP's own agreement with its clients governs that layer.
Veylith is the processor, and processes only on documented instructions.

**The documented instructions are the product's configuration**: which
connectors the customer enables, which frameworks it assesses against, and which
actions it authorises. That is a real definition rather than a formula — nothing
is processed that the customer's configuration did not ask for.

## 2. Subject matter and duration

Subject matter: determining, recording, explaining and verifying the state of
security controls across the customer's estate.

Duration: for as long as the agreement is live, and thereafter only as set out
in clause 9.

## 3. Nature of the processing

Collection of observations from systems the customer connects; derivation of
claims and control determinations from those observations; retention of evidence
supporting each determination; proposal, authorisation and execution of
remediating changes where the customer has authorised them; production of an
Assurance Passport where the customer chooses to share one.

## 4. Categories of data and data subjects

Account identifiers, mailbox and device names, device and account security
attributes, sign-in recency, and the identity of the customer's own staff who
use Adericel. Data subjects are the customer's staff, contractors and service
accounts.

**No special category data is processed.** If the customer's configuration would
cause special category data to be collected, that is outside these terms and must
be agreed separately.

## 5. Veylith's obligations

Veylith shall:

1. process only on the customer's documented instructions, and tell the customer
   if an instruction appears to infringe data protection law;
2. ensure everyone authorised to process is bound by confidentiality;
3. implement the measures in clause 6;
4. engage no sub-processor without 30 days' notice and a right to object
   (clause 7);
5. assist the customer with subject requests, with security, with breach
   notification and, where required, with a data protection impact assessment;
6. make available what is needed to demonstrate compliance, and submit to audit
   (clause 8);
7. at the end of the agreement, delete or return the data as set out in
   clause 9.

## 6. Security measures

Not a list of intentions. Each of these is enforced in the software and has a
test that fails if it stops being true.

- **Tenant isolation** enforced by PostgreSQL row level security with
  `FORCE ROW LEVEL SECURITY`, so a cross-tenant read fails at the database even
  if an application query is wrong. Proved by attempting one.
- **No standing access by Veylith staff.** A Veylith administrator holding every
  permission the company has cannot read the customer's controls, evidence,
  findings, actions or audit trail. Access requires an expiring grant issued as
  a deliberate act that appears in the audit trail.
- **Credentials sealed** with AES-256-GCM envelope encryption under a
  per-organisation data key, with the integration id as additional authenticated
  data, in a table no tenant transaction can reach.
- **Second factor required** for every approval, and approval refused to any
  principal that is not a human being — so there is no configuration in which
  Adericel approves its own actions.
- **Complete audit trail**, append-only, including refusals, recording which
  information boundary served each request.
- **Encryption in transit** for all connector traffic, with private and
  link-local addresses and cloud metadata endpoints refused at connect time.
- **Backups verified by restore**, not by the backup completing.

## 7. Sub-processors

The current list is at `docs/data-protection/subprocessors.md`. A new
sub-processor is notified at least 30 days before it begins processing. If the
customer objects on reasonable data protection grounds and no alternative is
available, the customer may terminate and take their complete record with them.

## 8. Audit

Veylith shall make available the information necessary to demonstrate compliance
with this clause, and allow and contribute to audits by the customer or an
auditor the customer appoints, on reasonable notice and no more than once a year
except after a breach.

Because Adericel is self-hosted, most of what an audit would want is already in
the customer's possession: the database, the audit trail, and the source of the
determinations. The Assurance Passport is designed to answer the same question
without an audit at all.

## 9. Deletion and return

On termination, at the customer's choice:

- **Return.** A complete export, in structured JSON, of everything held. It
  declares its own completeness and names any table it could not fully include.
- **Deletion.** Erasure of every row in every table belonging to the
  organisation. Veylith verifies afterwards by counting, and reports the
  erasure as incomplete — naming the tables — if anything survived.

An export is taken before anything is destroyed, and closure is refused without
one. What is retained after erasure: a tombstone carrying the organisation id,
slug, owning MSP, closure date and the hash of the export handed over. No name,
no contact, no evidence. It exists so the customer can prove they were a
customer and check the bundle they hold against what Veylith says it gave them.
Aggregate accounting records are retained under Veylith's own legal obligation,
with the organisation reference cleared.

## 10. Terms Veylith commits to that are not required by Article 28

Stated because a customer should not have to ask.

1. **Customer data is never used to train any model**, by Veylith or by anybody
   else. There is no path from tenant data to any training process.
2. **No model output ever becomes an assurance determination.** Where Adericel
   uses a language model it is to explain, summarise or draft — never to decide.
   A determination always traces to observed evidence and a published ruleset.
3. **UNKNOWN is never converted to a pass.** Where Adericel cannot see
   something, it says so and says why. It does not infer, assume, or default to
   satisfied. This is the product's central commitment and it is what the
   customer is actually buying.
4. **The customer can shorten any retention period. Nobody can lengthen one**
   beyond the published schedule.
