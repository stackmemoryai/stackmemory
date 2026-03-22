/**
 * Skill Registry — SQLite CRUD tests with temp dirs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillRegistry } from '../skill-registry.js';
import type { SkillRulesFile } from '../types.js';

let tmpDir: string;
let registry: SkillRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-'));
  registry = new SkillRegistry(path.join(tmpDir, 'skills.db'));
});

afterEach(() => {
  registry.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Skill CRUD', () => {
  it('creates and retrieves a skill', () => {
    const skill = registry.createSkill({
      content: 'Always use .js extensions in ESM imports',
      category: 'pitfall',
      priority: 'high',
      tags: ['esm', 'imports'],
      source: 'correction',
    });

    expect(skill.id).toBeDefined();
    expect(skill.content).toBe('Always use .js extensions in ESM imports');
    expect(skill.category).toBe('pitfall');
    expect(skill.priority).toBe('high');
    expect(skill.tags).toEqual(['esm', 'imports']);

    const retrieved = registry.getSkill(skill.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(skill.id);
  });

  it('updates a skill', () => {
    const skill = registry.createSkill({
      content: 'Original content',
      category: 'pattern',
      source: 'observation',
    });

    const updated = registry.updateSkill({
      id: skill.id,
      content: 'Updated content',
      priority: 'critical',
    });

    expect(updated).toBeDefined();
    expect(updated!.content).toBe('Updated content');
    expect(updated!.priority).toBe('critical');
  });

  it('validates a skill (increments count)', () => {
    const skill = registry.createSkill({
      content: 'Test skill',
      category: 'tool',
      source: 'explicit',
    });

    expect(skill.validatedCount).toBe(0);

    const v1 = registry.validateSkill(skill.id);
    expect(v1!.validatedCount).toBe(1);
    expect(v1!.lastValidated).toBeDefined();

    const v2 = registry.validateSkill(skill.id);
    expect(v2!.validatedCount).toBe(2);
  });

  it('deletes a skill', () => {
    const skill = registry.createSkill({
      content: 'To delete',
      category: 'tool',
      source: 'observation',
    });

    expect(registry.deleteSkill(skill.id)).toBe(true);
    expect(registry.getSkill(skill.id)).toBeUndefined();
    expect(registry.deleteSkill(skill.id)).toBe(false);
  });

  it('returns undefined for non-existent skill', () => {
    expect(registry.getSkill('non-existent-id')).toBeUndefined();
    expect(registry.updateSkill({ id: 'non-existent' })).toBeUndefined();
    expect(registry.validateSkill('non-existent')).toBeUndefined();
  });
});

describe('Skill Queries', () => {
  beforeEach(() => {
    registry.createSkill({
      content: 'Critical correction',
      category: 'correction',
      priority: 'critical',
      tool: 'eslint',
      tags: ['lint'],
      source: 'correction',
    });
    registry.createSkill({
      content: 'Low pattern',
      category: 'pattern',
      priority: 'low',
      source: 'observation',
    });
    registry.createSkill({
      content: 'Medium workflow',
      category: 'workflow',
      priority: 'medium',
      tool: 'eslint',
      source: 'observation',
    });
  });

  it('queries by category', () => {
    const results = registry.querySkills({
      categories: ['correction'],
      limit: 50,
      offset: 0,
      sortBy: 'priority',
      sortOrder: 'desc',
    });
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('correction');
  });

  it('queries by tool', () => {
    const results = registry.querySkills({
      tool: 'eslint',
      limit: 50,
      offset: 0,
      sortBy: 'priority',
      sortOrder: 'desc',
    });
    expect(results).toHaveLength(2);
  });

  it('queries with limit', () => {
    const results = registry.querySkills({
      limit: 1,
      offset: 0,
      sortBy: 'priority',
      sortOrder: 'desc',
    });
    expect(results).toHaveLength(1);
  });

  it('getRelevantSkills returns critical and tool-specific', () => {
    const results = registry.getRelevantSkills({ tool: 'eslint' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    const priorities = results.map((s) => s.priority);
    expect(priorities).toContain('critical');
  });
});

describe('Skill Rules CRUD', () => {
  it('upserts and retrieves a rule', () => {
    registry.upsertRule('test-rule', {
      description: 'A test rule',
      priority: 7,
      triggers: { keywords: ['test'] },
    });

    const rule = registry.getRule('test-rule');
    expect(rule).toBeDefined();
    expect(rule!.description).toBe('A test rule');
    expect(rule!.triggers.keywords).toEqual(['test']);
  });

  it('getAllRules returns all', () => {
    registry.upsertRule('r1', {
      description: 'Rule 1',
      priority: 5,
      triggers: {},
    });
    registry.upsertRule('r2', {
      description: 'Rule 2',
      priority: 3,
      triggers: {},
    });

    const all = registry.getAllRules();
    expect(Object.keys(all)).toHaveLength(2);
  });

  it('deletes a rule', () => {
    registry.upsertRule('to-delete', {
      description: 'Delete me',
      priority: 1,
      triggers: {},
    });
    expect(registry.deleteRule('to-delete')).toBe(true);
    expect(registry.getRule('to-delete')).toBeUndefined();
  });
});

describe('Directory Mappings', () => {
  it('sets and retrieves mappings', () => {
    registry.setDirectoryMapping('src/core', 'frame-management');
    registry.setDirectoryMapping('src/cli', 'cli-commands');

    const mappings = registry.getDirectoryMappings();
    expect(mappings['src/core']).toBe('frame-management');
    expect(mappings['src/cli']).toBe('cli-commands');
  });
});

describe('Matcher Config', () => {
  it('returns defaults when not set', () => {
    const { config, scoring } = registry.getMatcherConfig();
    expect(config.minConfidenceScore).toBe(3);
    expect(scoring.keyword).toBe(2);
  });

  it('persists config', () => {
    registry.setMatcherConfig(
      { minConfidenceScore: 5, showMatchReasons: false, maxSkillsToShow: 3 },
      {
        keyword: 10,
        keywordPattern: 10,
        pathPattern: 10,
        directoryMatch: 10,
        intentPattern: 10,
        contentPattern: 10,
        contextPattern: 10,
      }
    );
    const { config, scoring } = registry.getMatcherConfig();
    expect(config.minConfidenceScore).toBe(5);
    expect(config.showMatchReasons).toBe(false);
    expect(scoring.keyword).toBe(10);
  });
});

describe('Journal', () => {
  it('creates and retrieves journal entries', () => {
    const entry = registry.createJournalEntry(
      'session-1',
      'decision',
      'Use SQLite',
      'Decided to use SQLite over Redis',
      { file: 'skill-registry.ts' }
    );

    expect(entry.id).toBeDefined();
    expect(entry.type).toBe('decision');

    const entries = registry.getSessionJournal('session-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Use SQLite');
  });

  it('promotes journal entry to skill', () => {
    const entry = registry.createJournalEntry(
      'session-2',
      'correction',
      'Add .js extensions',
      'Always add .js to ESM imports'
    );

    const skill = registry.promoteToSkill(entry.id, 'pitfall', 'high');
    expect(skill).toBeDefined();
    expect(skill!.content).toBe('Always add .js to ESM imports');
    expect(skill!.category).toBe('pitfall');
  });
});

describe('Session Management', () => {
  it('starts and ends a session', () => {
    registry.startSession('s1');

    registry.createJournalEntry('s1', 'correction', 'Fix A', 'Fixed A');
    registry.createJournalEntry('s1', 'decision', 'Choose B', 'Chose B');

    const summary = registry.endSession('s1');
    expect(summary).toBeDefined();
    expect(summary!.entriesCount).toBe(2);
    expect(summary!.correctionsCount).toBe(1);
    expect(summary!.decisionsCount).toBe(1);
    expect(summary!.endedAt).toBeDefined();
  });

  it('returns undefined for non-existent session', () => {
    expect(registry.endSession('nope')).toBeUndefined();
    expect(registry.getSessionSummary('nope')).toBeUndefined();
  });
});

describe('Metrics', () => {
  it('returns metrics', () => {
    registry.createSkill({
      content: 'S1',
      category: 'tool',
      source: 'observation',
    });
    registry.createSkill({
      content: 'S2',
      category: 'tool',
      source: 'observation',
    });
    registry.upsertRule('r1', {
      description: 'R1',
      priority: 5,
      triggers: {},
    });

    const metrics = registry.getMetrics();
    expect(metrics.skillsTotal).toBe(2);
    expect(metrics.skillsByCategory['tool']).toBe(2);
    expect(metrics.rulesTotal).toBe(1);
  });
});

describe('seedFromRulesJson', () => {
  it('seeds rules, config, and mappings', () => {
    const rulesFile: SkillRulesFile = {
      version: '2.0',
      config: {
        minConfidenceScore: 5,
        showMatchReasons: true,
        maxSkillsToShow: 3,
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
      directoryMappings: {
        'src/core': 'frame-management',
      },
      skills: {
        'frame-management': {
          description: 'Frame management',
          priority: 9,
          triggers: { keywords: ['frame'] },
          relatedSkills: ['context-bridge'],
        },
      },
    };

    registry.seedFromRulesJson(rulesFile);

    const rules = registry.getAllRules();
    expect(Object.keys(rules)).toHaveLength(1);
    expect(rules['frame-management'].priority).toBe(9);

    const mappings = registry.getDirectoryMappings();
    expect(mappings['src/core']).toBe('frame-management');

    const { config } = registry.getMatcherConfig();
    expect(config.minConfidenceScore).toBe(5);
  });
});
