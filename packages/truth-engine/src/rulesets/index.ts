import { createRulesetRegistry, type RulesetRegistry } from '../ruleset.js';
import { adericelBaselineV1 } from './adericel-baseline.js';
import { cyberEssentialsV1 } from './cyber-essentials.js';

export { adericelBaselineV1, cyberEssentialsV1 };

export const BUILT_IN_RULESETS: readonly unknown[] = [adericelBaselineV1, cyberEssentialsV1];

/** Registry containing every ruleset shipped with this build of the engine. */
export function createBuiltInRegistry(): RulesetRegistry {
  return createRulesetRegistry(BUILT_IN_RULESETS);
}
