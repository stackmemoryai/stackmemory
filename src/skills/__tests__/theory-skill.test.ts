/**
 * Tests for TheorySkill
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { SkillContext } from '../claude-skills.js';

// We test against a real temp directory with git init
let tmpDir: string;
let originalCwd: string;

// Mock logger
vi.mock('../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeContext(overrides?: Partial<SkillContext>): SkillContext {
  return {
    projectId: 'test-project',
    userId: 'test-user',
    dualStackManager: {} as any,
    handoffManager: {} as any,
    contextRetriever: {} as any,
    database: {} as any,
    ...overrides,
  };
}

describe('TheorySkill', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'theory-test-'));
    originalCwd = process.cwd();
    // Initialize a git repo so getGitRoot() works
    execSync('git init', { cwd: tmpDir, timeout: 5000 });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Dynamic import to pick up mocks correctly
  async function getTheorySkill() {
    // Clear module cache to pick up fresh cwd
    const mod = await import('../theory-skill.js');
    return mod.TheorySkill;
  }

  it('init creates THEORY.MD with sections', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const result = skill.init('Build context-aware memory for AI agents');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Created THEORY.MD');
    expect(result.data?.sections).toHaveLength(5);

    // File should exist
    const content = fs.readFileSync(path.join(tmpDir, 'THEORY.MD'), 'utf-8');
    expect(content).toContain('## Problem');
    expect(content).toContain('Build context-aware memory for AI agents');
    expect(content).toContain('## Operating Theory');
    expect(content).toContain('## Strategy');
    expect(content).toContain('## Key Discoveries');
    expect(content).toContain('## Open Questions');
  });

  it('init rejects empty problem statement', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const result = skill.init('');
    expect(result.success).toBe(false);
    expect(result.message).toContain('problem statement is required');
  });

  it('init refuses if THEORY.MD already exists', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    fs.writeFileSync(path.join(tmpDir, 'THEORY.MD'), '# existing');

    const result = skill.init('New problem');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already exists');
  });

  it('show returns content when THEORY.MD exists', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const testContent = '# THEORY.MD\n\nSome theory content here.';
    fs.writeFileSync(path.join(tmpDir, 'THEORY.MD'), testContent);

    const result = skill.show();
    expect(result.success).toBe(true);
    expect(result.message).toBe(testContent);
    expect(result.data?.length).toBe(testContent.length);
  });

  it('show returns error when no THEORY.MD', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const result = skill.show();
    expect(result.success).toBe(false);
    expect(result.message).toContain('No THEORY.MD found');
  });

  it('update validates and writes content', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    // Content must be > 100 chars
    const content =
      '# THEORY.MD\n\n## Problem\n\nWe need to build a context-aware memory system that preserves agent state across sessions and enables efficient retrieval.';

    const result = skill.update(content);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Updated THEORY.MD');

    const written = fs.readFileSync(path.join(tmpDir, 'THEORY.MD'), 'utf-8');
    expect(written).toBe(content);
  });

  it('update rejects too-short content', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const result = skill.update('too short');
    expect(result.success).toBe(false);
    expect(result.message).toContain('too short');
  });

  it('update warns on checkboxes', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const content =
      '# THEORY.MD\n\n## Problem\n\nBuild a thing.\n\n- [x] Done\n- [ ] Not done\n\nLots more text here to get past the minimum length requirement which is one hundred characters.';

    const result = skill.update(content);
    expect(result.success).toBe(true);
    expect(result.data?.warnings).toContainEqual(
      expect.stringContaining('checkboxes')
    );
  });

  it('update warns on dates', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const content =
      '# THEORY.MD\n\n## Problem\n\nBuild a thing.\n\n2024-01-15: Added feature X\n\nLots more text here to get past the minimum length requirement which is one hundred characters exactly.';

    const result = skill.update(content);
    expect(result.success).toBe(true);
    expect(result.data?.warnings).toContainEqual(
      expect.stringContaining('dates')
    );
  });

  it('update records frame event when frameManager available', async () => {
    const TheorySkill = await getTheorySkill();
    const mockFrameManager = {
      createFrame: vi.fn().mockReturnValue('frame-123'),
      addEvent: vi.fn().mockReturnValue('event-123'),
      closeFrame: vi.fn(),
    };

    const skill = new TheorySkill(
      makeContext({ frameManager: mockFrameManager as any })
    );

    const content =
      '# THEORY.MD\n\n## Problem\n\nWe need context-aware memory for AI agents that persists across sessions and supports efficient semantic retrieval.';

    skill.update(content);

    expect(mockFrameManager.createFrame).toHaveBeenCalledWith(
      'write',
      'theory-update',
      expect.objectContaining({ source: 'THEORY.MD' })
    );
    expect(mockFrameManager.addEvent).toHaveBeenCalledWith(
      'artifact',
      expect.objectContaining({ type: 'theory-update' }),
      'frame-123'
    );
    expect(mockFrameManager.closeFrame).toHaveBeenCalledWith(
      'frame-123',
      expect.objectContaining({ theory_updated: true })
    );
  });

  it('status reports metadata when THEORY.MD exists', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    // Create via init
    skill.init('Test problem for status check');

    const result = skill.status();
    expect(result.success).toBe(true);
    expect(result.data?.exists).toBe(true);
    expect(result.data?.lineCount).toBeGreaterThan(0);
    expect(result.data?.sections).toContain('## Problem');
    expect(result.data?.totalSections).toBe(5);
    expect(result.data?.lastModified).toBeDefined();
  });

  it('status reports not found when no THEORY.MD', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    const result = skill.status();
    expect(result.success).toBe(true);
    expect(result.data?.exists).toBe(false);
  });

  it('git root detection works', async () => {
    const TheorySkill = await getTheorySkill();
    const skill = new TheorySkill(makeContext());

    // The skill should find the git root (our tmpDir)
    skill.init('Git root test');

    expect(fs.existsSync(path.join(tmpDir, 'THEORY.MD'))).toBe(true);
  });
});
