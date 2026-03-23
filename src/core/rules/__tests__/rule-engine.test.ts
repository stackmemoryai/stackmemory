/**
 * Tests for the rules engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleEngine } from '../rule-engine.js';
import { RuleStore } from '../rule-store.js';
import { BUILT_IN_RULES, matchesScope } from '../built-in-rules.js';
import type { RuleContext, RuleDefinition } from '../types.js';

function makeContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    trigger: 'on-demand',
    files: [],
    content: new Map(),
    commitMessage: '',
    projectRoot: '/tmp/test-project',
    ...overrides,
  };
}

describe('RuleStore', () => {
  let db: Database.Database;
  let store: RuleStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new RuleStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates table on construction', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='rules'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it('upserts and retrieves rules', () => {
    store.upsert({
      id: 'test-rule',
      name: 'Test',
      description: 'A test rule',
      trigger_type: 'lint',
      severity: 'warn',
      scope: '**/*',
      enabled: 1,
      builtin: 0,
    });
    const rule = store.getById('test-rule');
    expect(rule).toBeDefined();
    expect(rule!.name).toBe('Test');
    expect(rule!.enabled).toBe(1);
  });

  it('seeds builtins with INSERT OR IGNORE', () => {
    store.seedBuiltins([
      {
        id: 'builtin-1',
        name: 'B1',
        description: '',
        trigger_type: 'lint',
        severity: 'warn',
        scope: '**/*',
        enabled: 1,
        builtin: 1,
      },
    ]);
    // Seed again — should not duplicate
    store.seedBuiltins([
      {
        id: 'builtin-1',
        name: 'B1 updated',
        description: '',
        trigger_type: 'lint',
        severity: 'warn',
        scope: '**/*',
        enabled: 1,
        builtin: 1,
      },
    ]);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('B1'); // not updated
  });

  it('enables and disables rules', () => {
    store.upsert({
      id: 'toggle',
      name: 'Toggle',
      description: '',
      trigger_type: 'lint',
      severity: 'warn',
      scope: '**/*',
      enabled: 1,
      builtin: 0,
    });
    store.setEnabled('toggle', false);
    expect(store.getById('toggle')!.enabled).toBe(0);
    expect(store.getEnabled()).toHaveLength(0);

    store.setEnabled('toggle', true);
    expect(store.getById('toggle')!.enabled).toBe(1);
  });

  it('filters by trigger', () => {
    store.upsert({
      id: 'r1',
      name: 'R1',
      description: '',
      trigger_type: 'lint',
      severity: 'warn',
      scope: '**/*',
      enabled: 1,
      builtin: 0,
    });
    store.upsert({
      id: 'r2',
      name: 'R2',
      description: '',
      trigger_type: 'commit',
      severity: 'warn',
      scope: '**/*',
      enabled: 1,
      builtin: 0,
    });
    expect(store.getByTrigger('lint')).toHaveLength(1);
    expect(store.getByTrigger('commit')).toHaveLength(1);
  });

  it('deletes rules', () => {
    store.upsert({
      id: 'del',
      name: 'Del',
      description: '',
      trigger_type: 'lint',
      severity: 'warn',
      scope: '**/*',
      enabled: 1,
      builtin: 0,
    });
    expect(store.delete('del')).toBe(true);
    expect(store.getById('del')).toBeUndefined();
    expect(store.delete('nonexistent')).toBe(false);
  });
});

describe('RuleEngine', () => {
  let db: Database.Database;
  let engine: RuleEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new RuleEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds built-in rules on construction', () => {
    const rules = engine.listRules();
    expect(rules.length).toBe(BUILT_IN_RULES.length);
    for (const builtin of BUILT_IN_RULES) {
      expect(rules.find((r) => r.id === builtin.id)).toBeDefined();
    }
  });

  it('registers custom rules', () => {
    const custom: RuleDefinition = {
      id: 'custom-1',
      name: 'Custom',
      description: 'test',
      trigger: 'on-demand',
      severity: 'warn',
      scope: '**/*',
      enabled: true,
      builtin: false,
      check: () => ({ passed: true, violations: [] }),
    };
    engine.registerRule(custom);
    const rules = engine.listRules();
    expect(rules.find((r) => r.id === 'custom-1')).toBeDefined();
  });

  it('skips disabled rules', () => {
    engine.disableRule('no-coauthor');
    const ctx = makeContext({
      trigger: 'commit',
      commitMessage: 'test\nCo-Authored-By: someone',
    });
    const result = engine.evaluate(ctx);
    expect(result.passed).toBe(true);
  });
});

describe('Built-in rules', () => {
  let db: Database.Database;
  let engine: RuleEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new RuleEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('no-coauthor', () => {
    it('passes on clean commit message', () => {
      const result = engine.evaluate(
        makeContext({
          trigger: 'commit',
          commitMessage: 'feat: add new feature',
        })
      );
      expect(result.passed).toBe(true);
    });

    it('fails on Co-Authored-By', () => {
      const result = engine.evaluate(
        makeContext({
          trigger: 'commit',
          commitMessage: 'feat: thing\n\nCo-Authored-By: bot <bot@x.com>',
        })
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]!.ruleId).toBe('no-coauthor');
    });
  });

  describe('no-jest-globals', () => {
    it('detects @jest/globals import', () => {
      const content = new Map<string, string>();
      content.set(
        'src/utils/__tests__/helper.test.ts',
        "import { describe, it } from '@jest/globals';\n"
      );
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/utils/__tests__/helper.test.ts'],
          content,
        })
      );
      expect(result.passed).toBe(false);
      expect(result.violations[0]!.ruleId).toBe('no-jest-globals');
    });

    it('passes on clean test file', () => {
      const content = new Map<string, string>();
      content.set(
        'src/utils/__tests__/helper.test.ts',
        "describe('helper', () => { it('works', () => {}) });\n"
      );
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/utils/__tests__/helper.test.ts'],
          content,
        })
      );
      const jestViolations = result.violations.filter(
        (v) => v.ruleId === 'no-jest-globals'
      );
      expect(jestViolations).toHaveLength(0);
    });
  });

  describe('catch-no-underscore', () => {
    it('catches underscore-prefixed catch variable', () => {
      const content = new Map<string, string>();
      content.set(
        'src/utils/helper.ts',
        'try { foo() } catch (_err) { log() }\n'
      );
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/utils/helper.ts'],
          content,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'catch-no-underscore'
      );
      expect(violations).toHaveLength(1);
    });

    it('passes on empty catch', () => {
      const content = new Map<string, string>();
      content.set('src/utils/helper.ts', 'try { foo() } catch { log() }\n');
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/utils/helper.ts'],
          content,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'catch-no-underscore'
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('return-dont-throw', () => {
    it('warns on throw in service code', () => {
      const content = new Map<string, string>();
      content.set(
        'src/services/user.ts',
        'function getUser() { throw new Error("not found"); }\n'
      );
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/services/user.ts'],
          content,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'return-dont-throw'
      );
      expect(violations).toHaveLength(1);
    });

    it('skips middleware and error files', () => {
      const content = new Map<string, string>();
      content.set(
        'src/middleware/auth.ts',
        'throw new Error("unauthorized");\n'
      );
      content.set('src/errors/custom.ts', 'throw new Error("custom");\n');
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/middleware/auth.ts', 'src/errors/custom.ts'],
          content,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'return-dont-throw'
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('migration-sequential', () => {
    it('detects gaps in migration numbering', () => {
      const files = [
        'src/db/migrations/001_init.sql',
        'src/db/migrations/002_users.sql',
        'src/db/migrations/005_recipes.sql',
      ];
      const result = engine.evaluateAll(
        makeContext({
          trigger: 'on-demand',
          files,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'migration-sequential'
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]!.message).toContain('002');
      expect(violations[0]!.message).toContain('005');
    });

    it('passes on sequential migrations', () => {
      const files = [
        'src/db/migrations/001_init.sql',
        'src/db/migrations/002_users.sql',
        'src/db/migrations/003_recipes.sql',
      ];
      const result = engine.evaluateAll(
        makeContext({
          trigger: 'on-demand',
          files,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'migration-sequential'
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('mock-lifecycle', () => {
    it('warns when clearAllMocks without re-setup', () => {
      const content = new Map<string, string>();
      content.set(
        'src/services/__tests__/user.test.ts',
        `
beforeEach(() => {
  jest.clearAllMocks();
});

describe('getUser', () => {
  it('returns user', () => {});
});
`
      );
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/services/__tests__/user.test.ts'],
          content,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'mock-lifecycle'
      );
      expect(violations).toHaveLength(1);
    });

    it('passes when mocks are re-set after clear', () => {
      const content = new Map<string, string>();
      content.set(
        'src/services/__tests__/user.test.ts',
        `
beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockReturnValue([]);
});
`
      );
      const result = engine.evaluate(
        makeContext({
          trigger: 'lint',
          files: ['src/services/__tests__/user.test.ts'],
          content,
        })
      );
      const violations = result.violations.filter(
        (v) => v.ruleId === 'mock-lifecycle'
      );
      expect(violations).toHaveLength(0);
    });
  });
});

describe('matchesScope', () => {
  it('matches wildcard', () => {
    expect(matchesScope('anything.ts', '*')).toBe(true);
    expect(matchesScope('deep/path/file.ts', '**/*')).toBe(true);
  });

  it('matches extension patterns', () => {
    expect(matchesScope('src/foo.test.ts', 'src/**/*.test.{ts,js}')).toBe(true);
    expect(matchesScope('src/deep/bar.test.js', 'src/**/*.test.{ts,js}')).toBe(
      true
    );
    expect(matchesScope('src/foo.ts', 'src/**/*.test.{ts,js}')).toBe(false);
  });

  it('matches migration patterns', () => {
    expect(
      matchesScope('db/migrations/001_init.sql', '**/migrations/*.sql')
    ).toBe(true);
    expect(
      matchesScope('src/db/migrations/002.sql', '**/migrations/*.sql')
    ).toBe(true);
  });
});
