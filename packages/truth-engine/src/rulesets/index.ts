import { createRulesetRegistry, type RulesetRegistry } from '../ruleset.js';
import { adericelBaselineV1 } from './adericel-baseline.js';
import { cyberEssentialsV1 } from './cyber-essentials.js';
import { iso27001V1 } from './iso-27001.js';

export { adericelBaselineV1, cyberEssentialsV1, iso27001V1 };

export const BUILT_IN_RULESETS: readonly unknown[] = [
  adericelBaselineV1,
  cyberEssentialsV1,
  iso27001V1,
];

/** Registry containing every ruleset shipped with this build of the engine. */
export function createBuiltInRegistry(): RulesetRegistry {
  return createRulesetRegistry(BUILT_IN_RULESETS);
}
