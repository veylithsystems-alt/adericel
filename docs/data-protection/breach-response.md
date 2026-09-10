# Personal data breach response

UK GDPR Articles 33 and 34. Seventy-two hours from becoming aware, not from
being certain.

The single most common failure in a small company is not the breach. It is the
week that passes while somebody decides whether it counts as one. This runbook
exists so that decision has already been made.

## The rule that starts the clock

**Awareness is a reasonable degree of certainty that a security incident has
occurred which led to personal data being compromised.** Not proof. Not root
cause. If you are asking whether the clock has started, it has started.

Record the time of awareness immediately, in writing, before doing anything
else. That timestamp is the one fact that cannot be reconstructed later.

## Hour 0 to 1: contain and record

1. **Record the time of awareness** and who became aware.
2. **Open an operational exception** in the Veylith internal control room, class
   `SECURITY`. It is the case file; everything below hangs off it.
3. **Contain.** Revoke the credential, disable the account, take the connector
   offline. Containment beats investigation — an ongoing breach is a worse
   problem than an incompletely understood one.
4. **Do not delete anything.** Not logs, not sessions, not the compromised
   account. The audit trail is append-only and the retention sweep will not
   touch anything inside its window, but nobody should be tidying up during an
   incident regardless.

## Hour 1 to 8: establish scope

The questions, in the order they can actually be answered:

- **Which surface?** The audit trail records the surface every request was
  served through. A compromised MSP session and a compromised platform session
  have entirely different blast radii, and the record says which.
- **Which organisations?** Row level security means a session reaches only what
  its grants allow. `audit_log`, filtered by actor and time, is the definitive
  list of what was actually read — not what could have been.
- **Which categories of data?** Cross-reference the tables touched against
  `docs/data-protection/ropa.md`. That mapping is what the notification needs.
- **How many people?** An estimate with a stated basis, not a guess presented as
  a count. "At least 340, possibly up to 1,200, because X" is a usable answer.
  "Approximately 1,000" without a basis is not.

Write what is not yet known as explicitly as what is. An incident report that
implies more certainty than exists is the same failure this product refuses
everywhere else.

## By hour 72: notify the ICO

Required unless the breach is unlikely to result in a risk to people's rights
and freedoms. **If in doubt, notify.** The report may be incomplete; Article
33(4) allows information in phases, and a partial report inside 72 hours is
lawful where a complete report at day five is not.

The report must carry:

- the nature of the breach, the categories of data, and the approximate numbers
  of people and records;
- the data protection contact;
- the likely consequences;
- the measures taken or proposed, including mitigation.

If notification is later than 72 hours it must be accompanied by the reasons for
the delay. "We were still investigating" is not one of them.

**Where Veylith is the processor**, the obligation is different and faster:
notify the affected customer _without undue delay_, and give them what they need
to make their own Article 33 report. Veylith does not report to the ICO on a
customer's behalf, and does not decide for them whether their breach is
notifiable.

## Notifying the people affected

Required where the breach is likely to result in a **high** risk to their rights
and freedoms, without undue delay.

Say what happened, what it means for them, and what they should do. In plain
language, not in the language of an incident report. Do not minimise, do not
lead with what was not affected, and do not describe an actual compromise as a
"potential" one.

Not required where the data was encrypted such that it remains unintelligible,
where subsequent measures have removed the high risk, or where individual
notification would be disproportionate — in which case a public communication is
required instead.

## Afterwards

Every breach is recorded, whether or not it was notified, including the reasoning
for not notifying. Article 33(5) requires that record and the ICO can ask for it.
A decision not to notify that was never written down is indistinguishable from
never having considered it.

The operational exception closes only when the record is complete and the cause
is fixed — not when the incident stops being visible.

## What is not in place

- **No cyber insurance.** Should be in place before the first customer with a
  material estate.
- **This runbook has not been exercised.** A backup that has never been restored
  is not proven, and neither is an incident process nobody has walked through.
  It should be rehearsed against a scenario before it is needed for real.
