import { describe, expect, it } from 'vitest';
import { CE_V3_3_REQUIREMENTS, ceObservationGaps, summariseCeCoverage } from '@adericel/policy';
import { cyberEssentialsV1 } from '@adericel/truth-engine';
import {
  googleWorkspaceManifest,
  microsoftEntraManifest,
  microsoftIntuneManifest,
  type ConnectorManifest,
} from '@adericel/integrations';

/**
 * The connectors whose predicates count toward Cyber Essentials coverage.
 *
 * Deliberately not the whole registry. `generic-http` declares whatever an
 * operator configures, `adericel-self` observes Adericel rather than a
 * customer, and `demo-fixture` supplies everything by construction — counting
 * any of the three would let the coverage figure be improved by connecting
 * nothing real.
 */
const CE_RELEVANT_MANIFESTS: readonly ConnectorManifest[] = [
  microsoftEntraManifest,
  microsoftIntuneManifest,
  googleWorkspaceManifest,
];

/**
 * The Cyber Essentials map, checked against the product rather than itself.
 *
 * `packages/policy` tests the map's internal integrity. This tests the two
 * claims it makes about the rest of the system, which are the ones that rot:
 *
 *   - every rule it cites exists in the ruleset, and
 *   - every predicate it claims to observe is actually declared by a connector.
 *
 * Without these the map becomes a document that describes a product Adericel
 * used to intend to build. An MSP reads it and plans around it.
 */

/** Every predicate the installed connectors declare they supply. */
function suppliedPredicates(): readonly string[] {
  return CE_RELEVANT_MANIFESTS.flatMap((manifest) =>
    (manifest.collect ?? []).flatMap((capability) => capability.predicates),
  );
}

describe('the map cites rules that exist', () => {
  it('names no rule the Cyber Essentials ruleset does not define', () => {
    const ruleKeys = new Set(cyberEssentialsV1.rules.map((rule) => rule.key));
    const dangling = CE_V3_3_REQUIREMENTS.filter(
      (requirement) => requirement.ruleKey !== null && !ruleKeys.has(requirement.ruleKey),
    ).map((requirement) => `${requirement.id} -> ${requirement.ruleKey}`);
    expect(dangling, 'requirements citing a rule that does not exist').toEqual([]);
  });

  it('leaves no rule out of the map', () => {
    /**
     * The other direction, and the one that catches drift.
     *
     * A rule nobody mapped is a rule whose contribution to Cyber Essentials
     * readiness nobody decided — it computes a state, shows up in aggregation,
     * and answers no stated requirement.
     */
    const mapped = new Set(
      CE_V3_3_REQUIREMENTS.map((requirement) => requirement.ruleKey).filter(
        (key): key is string => key !== null,
      ),
    );
    const unmapped = cyberEssentialsV1.rules
      .map((rule) => rule.key)
      .filter((key) => !mapped.has(key));
    expect(unmapped, 'rules that answer no mapped requirement').toEqual([]);
  });
});

describe('the map does not claim coverage the connectors cannot supply', () => {
  it('has a supplier for every predicate it says is observed', () => {
    /**
     * The claim that matters. `OBSERVED` means an MSP can stop thinking about
     * that requirement between assessments, and if no connector supplies the
     * predicate then the rule reads UNKNOWN forever while the map says covered.
     */
    const supplied = new Set(suppliedPredicates());
    const overclaimed = CE_V3_3_REQUIREMENTS.filter(
      (requirement) => requirement.observability === 'OBSERVED',
    ).flatMap((requirement) =>
      requirement.predicates
        .filter((predicate) => !supplied.has(predicate))
        .map((predicate) => `${requirement.id} needs ${predicate}`),
    );
    expect(overclaimed, 'OBSERVED requirements with no connector supplying them').toEqual([]);
  });

  it('reports the remaining gaps against the connectors that exist', () => {
    // Not an assertion about the number — that changes as connectors land.
    // An assertion that the calculation runs against the real manifests, so the
    // figure an MSP sees is about their deployment.
    const gaps = ceObservationGaps(suppliedPredicates());
    for (const gap of gaps) {
      expect(gap.missing.length).toBeGreaterThan(0);
      expect(CE_V3_3_REQUIREMENTS.map((r) => r.id)).toContain(gap.requirementId);
    }
  });

  it('states the coverage figure with its caveat attached', () => {
    const summary = summariseCeCoverage();
    expect(summary.continuousCoverage).toBeGreaterThan(0);
    expect(summary.continuousCoverage).toBeLessThanOrEqual(1);
    expect(summary.caveat.length).toBeGreaterThan(100);
  });
});

describe('no connector decides Cyber Essentials', () => {
  it('declares predicates without naming a scheme, a theme or a requirement', () => {
    /**
     * A connector supplies observations. Whether an observation satisfies a
     * Cyber Essentials requirement is the ruleset's business, and a connector
     * that knew about the scheme would be a connector that could be changed to
     * pass it.
     */
    for (const manifest of CE_RELEVANT_MANIFESTS) {
      for (const capability of manifest.collect ?? []) {
        for (const predicate of capability.predicates) {
          expect(predicate).not.toMatch(/cyber|essentials|\bce\b|iso|compliant/i);
        }
        expect(capability.key).not.toMatch(/cyber|essentials|compliant/i);
      }
    }
  });
});
