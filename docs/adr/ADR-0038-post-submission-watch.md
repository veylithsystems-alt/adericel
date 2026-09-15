# ADR-0038: A submitted answer keeps being checked

**Status:** Accepted · **Date:** 2026-09-11

## Context

Every other product in this market finishes at send. The form goes out, the
answers are filed, and the next time anybody looks is next year's renewal.

But the answer was a statement about the state of a system, and systems change.
A "yes, MFA is enforced on all accounts" that was true on 3 September stops
being true the moment somebody grants an exemption on 14 October. The client
does not know, the MSP does not know, and the insurer is holding a statement
that is now false.

The Cyber Essentials director declaration now covers maintaining compliance
throughout the certification period, not merely at the point of assessment. The
same logic applies with more force to an insurance contract.

## Decision

**Every submitted answer is watched. When a submitted SUPPORTED answer stops
being SUPPORTED, the MSP is told what changed, when, which submissions are
affected and which senders hold them.**

An `AnswerWatch` binds the submission's requirement to the live estate. The
existing assessment scheduling re-evaluates it; drift raises an alert naming the
submission, the recipient and the change. In insurance mode the watch is on by
default and alerts within 24 hours.

At renewal the next form is pre-filled and every answer that has changed since
last year is highlighted — which is the renewal conversation an MSP would
otherwise have to reconstruct from memory.

What Adericel does **not** do: contact the insurer, amend the submission, or
decide whether the change is material. It tells the MSP, with the evidence, and
the MSP decides whether to fix it or to tell the broker. That is a judgement
with contractual consequences and it belongs to a person.

## Consequences

This is the feature that makes the product a subscription rather than a tool.
A questionnaire generator is used four times a year; a watch on what you told
your insurer runs continuously and is worth paying for between forms.

It also creates an obligation. Once an MSP is told that a submitted answer has
drifted, they know. A product that surfaces this is more useful and less
comfortable than one that does not, and that is the correct trade for something
sold on being truthful.

The measured figures are drift events detected and time to alert. No claim is
made about insurance outcomes: whether a drift would have affected a claim is
not a question Adericel can answer, and saying otherwise would be the kind of
overstatement ADR-0036 exists to prevent.
