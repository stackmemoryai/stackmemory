/**
 * Skill Matcher — Stateless scoring engine
 * Port of skill-eval.cjs to TypeScript with zero DB dependencies.
 * Pure functions, unit-testable.
 */

import type {
  SkillRule,
  SkillMatch,
  MatchResult,
  MatcherConfig,
  ScoringWeights,
  DirectoryMapping,
  ConfidenceLevel,
} from './types.js';

/**
 * Extract file paths mentioned in a prompt
 */
export function extractFilePaths(prompt: string): string[] {
  const paths = new Set<string>();

  // Match explicit paths with extensions
  const extensionPattern =
    /(?:^|\s|["'`])([\w\-./]+\.(?:[tj]sx?|json|gql|ya?ml|md|sh))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = extensionPattern.exec(prompt)) !== null) {
    paths.add(match[1]);
  }

  // Match paths starting with common directories
  const dirPattern =
    /(?:^|\s|["'`])((?:src|app|components|screens|hooks|utils|services|navigation|graphql|localization|\.claude|\.github|\.maestro)\/[\w\-./]+)/gi;
  while ((match = dirPattern.exec(prompt)) !== null) {
    paths.add(match[1]);
  }

  // Match quoted paths
  const quotedPattern = /["'`]([\w\-./]+\/[\w\-./]+)["'`]/g;
  while ((match = quotedPattern.exec(prompt)) !== null) {
    paths.add(match[1]);
  }

  return Array.from(paths);
}

/**
 * Test a regex pattern against text
 */
function matchesPattern(text: string, pattern: string, flags = 'i'): boolean {
  try {
    return new RegExp(pattern, flags).test(text);
  } catch {
    return false;
  }
}

/**
 * Convert a simplified glob pattern to a regex and test against a file path
 */
export function matchesGlob(filePath: string, globPattern: string): boolean {
  const regexPattern = globPattern
    .replace(/\./g, '\\.')
    .replace(/\?/g, '<<<QUESTION>>>')
    .replace(/\*\*\//g, '<<<DOUBLESTARSLASH>>>')
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLESTARSLASH>>>/g, '(?:.*\\/)?')
    .replace(/<<<DOUBLESTAR>>>/g, '.*')
    .replace(/<<<QUESTION>>>/g, '.');

  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(filePath);
  } catch {
    return false;
  }
}

/**
 * Check if a file path matches a directory mapping and return the mapped skill name
 */
function matchDirectoryMapping(
  filePath: string,
  mappings: DirectoryMapping
): string | undefined {
  for (const [dir, skillName] of Object.entries(mappings)) {
    if (filePath === dir || filePath.startsWith(dir + '/')) {
      return skillName;
    }
  }
  return undefined;
}

/**
 * Evaluate a single skill rule against a prompt
 */
function evaluateSkill(
  skillName: string,
  skill: SkillRule,
  prompt: string,
  promptLower: string,
  filePaths: string[],
  scoring: ScoringWeights,
  directoryMappings: DirectoryMapping
): SkillMatch | undefined {
  const { triggers, excludePatterns = [], priority = 5 } = skill;

  let score = 0;
  const reasons: string[] = [];

  // Check exclude patterns first
  for (const excludePattern of excludePatterns) {
    if (matchesPattern(promptLower, excludePattern)) {
      return undefined;
    }
  }

  // 1. Keywords
  if (triggers.keywords) {
    for (const keyword of triggers.keywords) {
      if (promptLower.includes(keyword.toLowerCase())) {
        score += scoring.keyword;
        reasons.push(`keyword "${keyword}"`);
      }
    }
  }

  // 2. Keyword patterns (regex)
  if (triggers.keywordPatterns) {
    for (const pattern of triggers.keywordPatterns) {
      if (matchesPattern(promptLower, pattern)) {
        score += scoring.keywordPattern;
        reasons.push(`pattern /${pattern}/`);
      }
    }
  }

  // 3. Intent patterns (first match only)
  if (triggers.intentPatterns) {
    for (const pattern of triggers.intentPatterns) {
      if (matchesPattern(promptLower, pattern)) {
        score += scoring.intentPattern;
        reasons.push('intent detected');
        break;
      }
    }
  }

  // 4. Context patterns
  if (triggers.contextPatterns) {
    for (const pattern of triggers.contextPatterns) {
      if (promptLower.includes(pattern.toLowerCase())) {
        score += scoring.contextPattern;
        reasons.push(`context "${pattern}"`);
      }
    }
  }

  // 5. Path patterns
  if (triggers.pathPatterns && filePaths.length > 0) {
    for (const filePath of filePaths) {
      for (const pattern of triggers.pathPatterns) {
        if (matchesGlob(filePath, pattern)) {
          score += scoring.pathPattern;
          reasons.push(`path "${filePath}"`);
          break;
        }
      }
    }
  }

  // 6. Directory mappings
  if (filePaths.length > 0) {
    for (const filePath of filePaths) {
      const mappedSkill = matchDirectoryMapping(filePath, directoryMappings);
      if (mappedSkill === skillName) {
        score += scoring.directoryMatch;
        reasons.push('directory mapping');
        break;
      }
    }
  }

  // 7. Content patterns (code snippets — case-sensitive)
  if (triggers.contentPatterns) {
    for (const pattern of triggers.contentPatterns) {
      if (matchesPattern(prompt, pattern)) {
        score += scoring.contentPattern;
        reasons.push('code pattern detected');
        break;
      }
    }
  }

  if (score > 0) {
    return {
      name: skillName,
      score,
      reasons: [...new Set(reasons)],
      priority,
    };
  }

  return undefined;
}

/**
 * Resolve related skills that aren't already matched
 */
function getRelatedSkills(
  matches: SkillMatch[],
  rules: Record<string, SkillRule>
): string[] {
  const matchedNames = new Set(matches.map((m) => m.name));
  const related = new Set<string>();

  for (const m of matches) {
    const skill = rules[m.name];
    if (skill?.relatedSkills) {
      for (const relatedName of skill.relatedSkills) {
        if (!matchedNames.has(relatedName)) {
          related.add(relatedName);
        }
      }
    }
  }

  return Array.from(related);
}

/**
 * Format confidence level from a numeric score
 */
export function formatConfidence(
  score: number,
  minScore: number
): ConfidenceLevel {
  if (score >= minScore * 3) return 'HIGH';
  if (score >= minScore * 2) return 'MEDIUM';
  return 'LOW';
}

/**
 * Main matching function — pure, stateless, no side effects
 *
 * @param prompt - User's prompt text
 * @param rules - Skill rule definitions (keyed by skill name)
 * @param config - Matcher config (minConfidenceScore, maxSkillsToShow)
 * @param scoring - Per-match-type scoring weights
 * @param directoryMappings - Directory → skill name map
 * @returns MatchResult with sorted matches, file paths, and related skills
 */
export function matchPrompt(
  prompt: string,
  rules: Record<string, SkillRule>,
  config: MatcherConfig,
  scoring: ScoringWeights,
  directoryMappings: DirectoryMapping = {}
): MatchResult {
  const promptLower = prompt.toLowerCase();
  const filePaths = extractFilePaths(prompt);

  const matches: SkillMatch[] = [];
  for (const [name, skill] of Object.entries(rules)) {
    const m = evaluateSkill(
      name,
      skill,
      prompt,
      promptLower,
      filePaths,
      scoring,
      directoryMappings
    );
    if (m && m.score >= config.minConfidenceScore) {
      matches.push(m);
    }
  }

  // Sort by score desc, then priority desc
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.priority - a.priority;
  });

  const topMatches = matches.slice(0, config.maxSkillsToShow);
  const relatedSkills = getRelatedSkills(topMatches, rules);

  return { matches: topMatches, filePaths, relatedSkills };
}
