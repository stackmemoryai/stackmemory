/**
 * Skill Integration Test — Golden test: seed rules, match prompts, verify parity with CJS
 *
 * Tests that the TypeScript matcher produces the same results as skill-eval.cjs
 * when given the same rules and prompts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillRegistry } from '../skill-registry.js';
import { matchPrompt } from '../skill-matcher.js';
import type { SkillRulesFile } from '../types.js';

let tmpDir: string;
let registry: SkillRegistry;
let rulesFile: SkillRulesFile;

// Load the actual skill-rules.json used by the CJS hook
const RULES_PATH = path.resolve(
  __dirname,
  '../../../../.claude/hooks/skill-rules.json'
);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-integration-'));
  registry = new SkillRegistry(path.join(tmpDir, 'skills.db'));

  if (fs.existsSync(RULES_PATH)) {
    rulesFile = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
    registry.seedFromRulesJson(rulesFile);
  } else {
    // Fallback minimal rules for CI where .claude/ may not exist
    rulesFile = {
      version: '2.0',
      config: {
        minConfidenceScore: 3,
        showMatchReasons: true,
        maxSkillsToShow: 5,
      },
      scoring: {
        keyword: 2,
        keywordPattern: 3,
        pathPattern: 4,
        directoryMatch: 5,
        intentPattern: 4,
        contentPattern: 3,
        contextPattern: 2,
      },
      directoryMappings: { 'src/core': 'frame-management' },
      skills: {
        'frame-management': {
          description: 'Frame management',
          priority: 9,
          triggers: {
            keywords: ['frame', 'stack', 'context'],
            keywordPatterns: ['\\bframe\\b'],
            pathPatterns: ['**/frame-*.ts'],
            contentPatterns: ['FrameManager'],
          },
          relatedSkills: ['context-bridge'],
        },
        'linear-integration': {
          description: 'Linear integration',
          priority: 8,
          triggers: {
            keywords: ['linear', 'issue', 'sync'],
            keywordPatterns: ['\\blinear\\b'],
          },
        },
        'testing-patterns': {
          description: 'Testing patterns',
          priority: 7,
          triggers: {
            keywords: ['test', 'jest', 'spec'],
            keywordPatterns: ['\\btest\\b'],
            pathPatterns: ['**/*.test.ts'],
          },
        },
      },
    };
    registry.seedFromRulesJson(rulesFile);
  }
});

afterEach(() => {
  registry.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Golden tests: TS matcher parity with CJS', () => {
  function matchWithRegistry(prompt: string) {
    const rules = registry.getAllRules();
    const { config, scoring } = registry.getMatcherConfig();
    const mappings = registry.getDirectoryMappings();
    return matchPrompt(prompt, rules, config, scoring, mappings);
  }

  it('frame management prompt matches frame-management skill', () => {
    const result = matchWithRegistry(
      'Fix the frame manager to handle nested contexts'
    );
    const names = result.matches.map((m) => m.name);
    expect(names).toContain('frame-management');
  });

  it('linear sync prompt matches linear-integration skill', () => {
    const result = matchWithRegistry(
      'Sync the linear issues and update tracking'
    );
    const names = result.matches.map((m) => m.name);
    expect(names).toContain('linear-integration');
  });

  it('test file path triggers testing-patterns', () => {
    const result = matchWithRegistry(
      'Fix src/core/skills/__tests__/skill-matcher.test.ts'
    );
    const names = result.matches.map((m) => m.name);
    expect(names).toContain('testing-patterns');
  });

  it('directory mapping triggers frame-management from src/core path', () => {
    const result = matchWithRegistry('Edit src/core/context/frame-manager.ts');
    const frameMatch = result.matches.find(
      (m) => m.name === 'frame-management'
    );
    expect(frameMatch).toBeDefined();
  });

  it('unrelated prompt returns no matches', () => {
    const result = matchWithRegistry('How is the weather today?');
    expect(result.matches).toEqual([]);
  });

  it('results are sorted by score descending', () => {
    const result = matchWithRegistry('frame linear test sync context issue');
    for (let i = 1; i < result.matches.length; i++) {
      const prev = result.matches[i - 1];
      const curr = result.matches[i];
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
  });

  it('related skills are resolved', () => {
    const result = matchWithRegistry('Push frame onto the stack');
    if (result.matches.some((m) => m.name === 'frame-management')) {
      expect(result.relatedSkills).toContain('context-bridge');
    }
  });

  it('file paths are extracted and reported', () => {
    const result = matchWithRegistry(
      'Check src/core/frame-manager.ts for bugs'
    );
    expect(result.filePaths).toContain('src/core/frame-manager.ts');
  });
});

describe('End-to-end: seed → store skill → match → query', () => {
  it('full workflow', () => {
    // 1. Registry is already seeded from beforeEach

    // 2. Create a skill
    const skill = registry.createSkill({
      content: 'Always validate frame depth before push',
      category: 'pitfall',
      priority: 'high',
      tags: ['frames'],
      tool: 'frame-manager',
      source: 'correction',
    });
    expect(skill.id).toBeDefined();

    // 3. Match a prompt
    const rules = registry.getAllRules();
    const { config, scoring } = registry.getMatcherConfig();
    const mappings = registry.getDirectoryMappings();
    const result = matchPrompt(
      'Fix the frame manager depth validation',
      rules,
      config,
      scoring,
      mappings
    );
    expect(result.matches.length).toBeGreaterThan(0);

    // 4. Query skills related to the match
    const relevant = registry.getRelevantSkills({ tool: 'frame-manager' });
    expect(
      relevant.some((s) => s.content.includes('validate frame depth'))
    ).toBe(true);

    // 5. Validate the skill
    const validated = registry.validateSkill(skill.id);
    expect(validated!.validatedCount).toBe(1);
  });
});
