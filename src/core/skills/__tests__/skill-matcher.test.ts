/**
 * Skill Matcher — Pure scoring engine tests (no DB)
 */

import { describe, it, expect } from 'vitest';
import {
  extractFilePaths,
  matchesGlob,
  matchPrompt,
  formatConfidence,
} from '../skill-matcher.js';
import type { SkillRule, MatcherConfig, ScoringWeights } from '../types.js';

const defaultConfig: MatcherConfig = {
  minConfidenceScore: 3,
  showMatchReasons: true,
  maxSkillsToShow: 5,
};

const defaultScoring: ScoringWeights = {
  keyword: 2,
  keywordPattern: 3,
  pathPattern: 4,
  directoryMatch: 5,
  intentPattern: 4,
  contentPattern: 3,
  contextPattern: 2,
};

describe('extractFilePaths', () => {
  it('extracts paths with extensions', () => {
    const paths = extractFilePaths(
      'Fix the bug in src/core/skills/types.ts please'
    );
    expect(paths).toContain('src/core/skills/types.ts');
  });

  it('extracts paths from common directories', () => {
    const paths = extractFilePaths('Look at src/integrations/mcp/server');
    expect(paths).toContain('src/integrations/mcp/server');
  });

  it('extracts quoted paths', () => {
    const paths = extractFilePaths('Open "hooks/skill-eval"');
    expect(paths).toContain('hooks/skill-eval');
  });

  it('returns empty for no paths', () => {
    expect(extractFilePaths('Hello world')).toEqual([]);
  });

  it('deduplicates paths', () => {
    const paths = extractFilePaths('src/core/types.ts and src/core/types.ts');
    const typesCount = paths.filter((p) => p === 'src/core/types.ts').length;
    expect(typesCount).toBe(1);
  });
});

describe('matchesGlob', () => {
  it('matches ** wildcards', () => {
    expect(matchesGlob('src/core/frame-manager.ts', '**/frame-*.ts')).toBe(
      true
    );
  });

  it('matches * wildcard', () => {
    expect(matchesGlob('src/core/context/index.ts', '**/context/*.ts')).toBe(
      true
    );
  });

  it('rejects non-matching paths', () => {
    expect(matchesGlob('src/cli/index.ts', '**/mcp/**')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesGlob('SRC/Core/Frame.ts', '**/frame.ts')).toBe(true);
  });
});

describe('formatConfidence', () => {
  it('returns HIGH for 3x min score', () => {
    expect(formatConfidence(9, 3)).toBe('HIGH');
  });

  it('returns MEDIUM for 2x min score', () => {
    expect(formatConfidence(6, 3)).toBe('MEDIUM');
  });

  it('returns LOW below 2x', () => {
    expect(formatConfidence(4, 3)).toBe('LOW');
  });
});

describe('matchPrompt', () => {
  const rules: Record<string, SkillRule> = {
    'frame-management': {
      description: 'Frame stack management',
      priority: 9,
      triggers: {
        keywords: ['frame', 'stack', 'context'],
        keywordPatterns: ['\\bframe\\b'],
        pathPatterns: ['**/frame-*.ts'],
        intentPatterns: ['(?:manage|handle).*(?:frame|context)'],
        contentPatterns: ['FrameManager'],
      },
      relatedSkills: ['context-bridge'],
    },
    'linear-integration': {
      description: 'Linear API integration',
      priority: 8,
      triggers: {
        keywords: ['linear', 'issue', 'sync'],
        keywordPatterns: ['\\blinear\\b'],
      },
    },
  };

  const mappings = { 'src/core': 'frame-management' };

  it('matches on keyword', () => {
    const result = matchPrompt(
      'I need to push a frame onto the stack',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].name).toBe('frame-management');
  });

  it('includes related skills', () => {
    const result = matchPrompt(
      'manage the frame context please',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    expect(result.relatedSkills).toContain('context-bridge');
  });

  it('matches on file path', () => {
    const result = matchPrompt(
      'Look at src/core/frame-manager.ts',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    const frameMatch = result.matches.find(
      (m) => m.name === 'frame-management'
    );
    expect(frameMatch).toBeDefined();
    expect(frameMatch!.reasons.some((r) => r.includes('path'))).toBe(true);
  });

  it('matches on directory mapping', () => {
    const result = matchPrompt(
      'Look at src/core/index.ts',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    const frameMatch = result.matches.find(
      (m) => m.name === 'frame-management'
    );
    expect(frameMatch).toBeDefined();
    expect(frameMatch!.reasons).toContain('directory mapping');
  });

  it('returns empty for unrelated prompt', () => {
    const result = matchPrompt(
      'What is the weather today?',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    expect(result.matches).toEqual([]);
  });

  it('filters below minConfidenceScore', () => {
    const strictConfig = { ...defaultConfig, minConfidenceScore: 100 };
    const result = matchPrompt(
      'frame stack context',
      rules,
      strictConfig,
      defaultScoring,
      mappings
    );
    expect(result.matches).toEqual([]);
  });

  it('respects maxSkillsToShow', () => {
    const limitConfig = { ...defaultConfig, maxSkillsToShow: 1 };
    const result = matchPrompt(
      'frame linear sync issue',
      rules,
      limitConfig,
      defaultScoring,
      mappings
    );
    expect(result.matches.length).toBeLessThanOrEqual(1);
  });

  it('respects excludePatterns', () => {
    const rulesWithExclude: Record<string, SkillRule> = {
      docs: {
        description: 'Docs',
        priority: 5,
        triggers: { keywords: ['document'] },
        excludePatterns: ['no docs'],
      },
    };
    const result = matchPrompt(
      'no docs needed, just document something',
      rulesWithExclude,
      { ...defaultConfig, minConfidenceScore: 1 },
      defaultScoring
    );
    expect(result.matches).toEqual([]);
  });

  it('sorts by score descending', () => {
    const result = matchPrompt(
      'frame stack context FrameManager linear',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    if (result.matches.length >= 2) {
      expect(result.matches[0].score).toBeGreaterThanOrEqual(
        result.matches[1].score
      );
    }
  });

  it('matches content patterns (case-sensitive code)', () => {
    const result = matchPrompt(
      'Use the FrameManager to push frames',
      rules,
      defaultConfig,
      defaultScoring,
      mappings
    );
    const frameMatch = result.matches.find(
      (m) => m.name === 'frame-management'
    );
    expect(frameMatch).toBeDefined();
    expect(frameMatch!.reasons.some((r) => r.includes('code pattern'))).toBe(
      true
    );
  });
});
