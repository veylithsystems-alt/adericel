# ADR-0005: Rules are data, not code

**Status:** Accepted · **Date:** 2026-09-09

## Context

A control rule expresses something like "every privileged account has phishing-
resistant multi-factor authentication". That has to be evaluated, versioned,
hashed, shipped to customers, and — years later, in a dispute — replayed exactly
as it was.

The obvious implementation is a TypeScript function per rule. It is also the
one that quietly breaks the guarantee the product sells. If a rule is a
function, the ruleset hash covers the rule's _parameters_ but not its
_behaviour_: a code change alters what the rule does while the recorded hash
stays the same, and every historical assessment silently becomes
unreproducible. Nobody notices, because nothing fails.

## Decision

**A rule is a serialisable expression tree, evaluated by an interpreter in the
Truth Engine.**

The expression language, in `packages/policy/src/policy.ts` and evaluated by
`packages/truth-engine/src/engine.ts`, is deliberately not Turing-complete. It
has:

- attribute access on subjects and their claims,
- comparison and set membership,
- three-valued `and` / `or` / `not` (Kleene, per ADR-0003),
- quantification over the subjects in scope (`all`, `any`, `none`, `count`),
- literal values.

It has no loops, no recursion, no function definition, no I/O, and no way to
observe the current time. Every expression terminates, and evaluating one twice
with the same input gives the same answer.

Because the rule _is_ data, the canonical serialisation of a ruleset
(`packages/shared/src/canonical.ts`) hashes to a `contentHash` that genuinely
covers behaviour. Two assessments carrying the same ruleset hash were produced
by the same logic — not by logic that happened to have the same name.

## Alternatives considered

**Rules as TypeScript functions.** Fastest to write, best editor support, and
fatal for reproducibility as described above. Rejected on the grounds that the
whole product is a claim about defensible assessment.

**Embedded general-purpose scripting (Lua, QuickJS, CEL).** CEL was the closest
call: it is total, sandboxed, and well specified. It was rejected because it
brings its own type system that does not include UNKNOWN, so three-valued logic
would have to be simulated on top of two-valued primitives — exactly the
conflation ADR-0003 exists to prevent. A rule engine whose base logic disagrees
with the domain's logic is a permanent source of subtle wrongness.

**Rego / OPA.** A mature policy language with real deployment history. Rejected
for the same reason plus operational weight: a separate process to run, version
and secure, for a language whose partial-evaluation semantics are a poor match
for "distinguish not-applicable from never-observed".

## Consequences

- Authoring a rule is more constrained than writing code. Some genuinely
  complex controls need a new expression node rather than a clever function,
  which is a deliberate friction: adding a node is a reviewed change to the
  language, and the language is small enough to review.
- The interpreter is a single, heavily tested component — 32 engine tests and 9
  Kleene tests — rather than test coverage spread across dozens of rule
  functions of varying quality.
- Rulesets can be authored, diffed and reviewed by people who do not write
  TypeScript, and shipped without a deployment.
- Debugging is worse than a stack trace. Mitigated by evaluation returning a
  reason and the contributing subjects, not just a state.

## Security implications

An expression tree submitted by a user is untrusted input executing inside the
Truth Engine. Totality is what makes that safe: there is no construct that can
loop, allocate unboundedly, read a file, or reach the network. Quantifiers are
bounded by the subject set, which is already bounded by the tenant scope. A
malicious ruleset can produce a wrong answer for the tenant that authored it;
it cannot consume the process or reach another tenant's data.

## Operational implications

Ruleset changes are content-addressed and versioned, so rolling one back is
publishing the previous hash rather than a deployment. Assessments record the
hash they used, so "which rule produced this?" is answerable from a row.

## Migration implications

Adding an expression node is backward compatible: old rulesets do not use it and
hash identically. Changing the _meaning_ of an existing node is not, and must be
a new node with a new name — the old one stays so historical assessments remain
replayable. This is the cost of the guarantee, and it is deliberate.
