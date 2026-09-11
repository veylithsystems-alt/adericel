import { describe, expect, it } from 'vitest';
import { BUILT_IN_RULESETS, compileRuleset } from '@adericel/truth-engine';
import { buildConnectorRegistry } from '@adericel/integrations';

/**
 * Every remediation a ruleset offers must be performable.
 *
 * A rule that proposes `identity.mfa.enforce` when the connectors expose
 * `identity.mfa.require` is a promise the product cannot keep, and it is only
 * discovered when an operator clicks the button — at which point the failure is
 * in front of a customer rather than in front of a developer.
 *
 * This check lives here rather than in the truth-engine package on purpose. The
 * engine must not know that connectors exist (ADR-0002): a dependency in that
 * direction would let vendor detail leak into the thing that decides truth. So
 * the invariant is asserted from outside, where both are visible.
 *
 * It derives the permitted set from the registry rather than restating it,
 * because a hardcoded list drifts and then quietly asserts nothing.
 */

const performableActionTypes = new Set(
  buildConnectorRegistry({
    egressPolicy: { allowlist: [], blockPrivate: false },
    allowDemoConnectors: true,
  })
    .registry.list()
    .flatMap((connector) => connector.capabilities.map((capability) => capability.actionType)),
);

describe('ruleset remediations', () => {
  it('has connectors that expose capabilities at all', () => {
    // Without this, an empty registry would make every assertion below vacuous.
    expect(performableActionTypes.size).toBeGreaterThan(3);
  });

  for (const definition of BUILT_IN_RULESETS) {
    const ruleset = compileRuleset(definition);

    it(`names only performable actions in ${ruleset.key}`, () => {
      const offered = ruleset.rules
        .filter((rule) => rule.remediation !== null)
        .map((rule) => ({ rule: rule.key, actionType: rule.remediation!.actionType }));

      const unperformable = offered.filter(
        (entry) => !performableActionTypes.has(entry.actionType),
      );
      expect(
        unperformable,
        `these rules propose actions no connector can perform: ${JSON.stringify(unperformable)}`,
      ).toEqual([]);
    });

    it(`does not propose a destructive remediation without saying why in ${ruleset.key}`, () => {
      for (const rule of ruleset.rules) {
        if (!rule.remediation) continue;
        // The rationale is shown to the person being asked to approve a change
        // to someone else's production estate. An empty one makes the approval
        // a rubber stamp.
        expect(rule.remediation.rationale.length, `${rule.key}`).toBeGreaterThan(10);
      }
    });
  }
});
