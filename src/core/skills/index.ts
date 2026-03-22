/**
 * Skills Module
 * Persistent agent learning, skill memory, and prompt matching
 */

export * from './types.js';
export * from './skill-storage.js';
export * from './skill-matcher.js';
export {
  SkillRegistry,
  getSkillRegistry,
  resetSkillRegistry,
} from './skill-registry.js';

import { getSkillRegistry } from './skill-registry.js';
import { matchPrompt as matchPromptFn } from './skill-matcher.js';
import type { MatchResult } from './types.js';

/**
 * Convenience: match a prompt using the singleton registry's rules, config, and mappings.
 * Returns empty result if no rules are loaded.
 */
export function matchPromptFromRegistry(prompt: string): MatchResult {
  const registry = getSkillRegistry();
  const rules = registry.getAllRules();
  const { config, scoring } = registry.getMatcherConfig();
  const mappings = registry.getDirectoryMappings();
  return matchPromptFn(prompt, rules, config, scoring, mappings);
}
