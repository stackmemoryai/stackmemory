/**
 * Tests for Claude Skills
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HandoffSkill,
  CheckpointSkill,
  ArchaeologistSkill,
  ClaudeSkillsManager,
  type SkillContext,
} from '../claude-skills.js';
import { DualStackManager } from '../../core/context/dual-stack-manager.js';
import { FrameHandoffManager } from '../../core/context/frame-handoff-manager.js';
import { ContextRetriever } from '../../core/retrieval/context-retriever.js';
import { SQLiteAdapter } from '../../core/database/sqlite-adapter.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the logger
vi.mock('../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

describe('Claude Skills', () => {
  let context: SkillContext;
  let mockDualStackManager: Partial<DualStackManager>;
  let mockHandoffManager: Partial<FrameHandoffManager>;
  let mockContextRetriever: Partial<ContextRetriever>;
  let mockDatabase: Partial<SQLiteAdapter>;
  let tempDir: string;

  beforeEach(() => {
    // Create temp directory for tests
    tempDir = path.join(os.tmpdir(), `claude-skills-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Create mock objects
    mockDualStackManager = {
      getActiveStack: vi.fn().mockReturnValue({
        getAllFrames: vi.fn().mockResolvedValue([
          {
            frameId: 'frame1',
            name: 'Test Frame 1',
            state: 'completed',
            type: 'task',
            inputs: { test: 'data' },
            outputs: [{ type: 'result', content: 'Success' }],
            digest_deterministic: { summary: 'Completed task' },
          },
          {
            frameId: 'frame2',
            name: 'Test Frame 2',
            state: 'active',
            type: 'implementation',
            inputs: { tests: 'pending' },
            outputs: [{ type: 'error', content: 'Test error' }],
          },
        ]),
        getFrame: vi.fn().mockImplementation((id) => {
          if (id === 'frame1') {
            return {
              frameId: 'frame1',
              name: 'Test Frame 1',
              state: 'completed',
              type: 'task',
              digest_deterministic: { summary: 'Completed task' },
            };
          }
          return {
            frameId: 'frame2',
            name: 'Test Frame 2',
            state: 'active',
            outputs: [{ type: 'error', content: 'Test error' }],
          };
        }),
      }),
      getCurrentContext: vi.fn().mockReturnValue({
        type: 'individual',
        stackId: 'individual-test',
        projectId: 'test-project',
        ownerId: 'test-user',
      }),
      getAvailableStacks: vi.fn().mockResolvedValue([
        { stackId: 'individual-test', type: 'individual' },
        { stackId: 'shared-team-123', type: 'shared' },
      ]),
      createSharedStack: vi.fn().mockResolvedValue('shared-team-456'),
      switchToStack: vi.fn().mockResolvedValue(undefined),
    };

    mockHandoffManager = {
      initiateHandoff: vi.fn().mockResolvedValue('handoff-test-123'),
      getUserNotifications: vi.fn().mockResolvedValue([]),
    };

    mockContextRetriever = {
      retrieve: vi.fn().mockResolvedValue([
        {
          frameId: 'historical-1',
          score: 0.9,
          timestamp: new Date().toISOString(),
          content: 'Historical context about authentication decision',
        },
        {
          frameId: 'historical-2',
          score: 0.7,
          timestamp: new Date(Date.now() - 86400000).toISOString(),
          content: 'Refactoring the database layer',
        },
      ]),
    };

    mockDatabase = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    context = {
      projectId: 'test-project',
      userId: 'test-user',
      dualStackManager: mockDualStackManager as DualStackManager,
      handoffManager: mockHandoffManager as FrameHandoffManager,
      contextRetriever: mockContextRetriever as ContextRetriever,
      database: mockDatabase as SQLiteAdapter,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('HandoffSkill', () => {
    it('should execute handoff with auto-detected frames', async () => {
      const skill = new HandoffSkill(context);
      const result = await skill.execute('teammate', 'Feature complete', {
        priority: 'high',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Handoff initiated to @teammate');
      expect(result.data?.handoffId).toBe('handoff-test-123');
      expect(result.data?.frameCount).toBe(2); // Both frames (completed + error frame)
      expect(result.data?.priority).toBe('high');
      expect(mockHandoffManager.initiateHandoff).toHaveBeenCalled();
    });

    it('should handle specific frames', async () => {
      const skill = new HandoffSkill(context);
      const result = await skill.execute('teammate', 'Please review', {
        frames: ['frame1', 'frame2'],
        autoDetect: false,
      });

      expect(result.success).toBe(true);
      expect(result.data?.frameCount).toBe(2);
    });

    it('should generate action items', async () => {
      const skill = new HandoffSkill(context);
      const result = await skill.execute('teammate', 'Review needed');

      expect(result.data?.actionItems).toBeDefined();
      expect(result.data?.actionItems).toContain(
        'Resolve error in Test Frame 2'
      );
      // Frame 2 is type 'implementation' so should trigger test writing action
      expect(result.data?.actionItems.length).toBeGreaterThanOrEqual(1);
    });

    it('should fail when no frames to handoff', async () => {
      mockDualStackManager.getActiveStack = vi.fn().mockReturnValue({
        getAllFrames: vi.fn().mockResolvedValue([]),
      });

      const skill = new HandoffSkill(context);
      const result = await skill.execute('teammate', 'Nothing to handoff', {
        autoDetect: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('No frames to handoff');
    });
  });

  describe('CheckpointSkill', () => {
    let checkpointSkill: CheckpointSkill;

    beforeEach(() => {
      // Override checkpoint directory for tests
      checkpointSkill = new CheckpointSkill(context);
      (checkpointSkill as any).checkpointDir = tempDir;
    });

    it('should create a checkpoint', async () => {
      const result = await checkpointSkill.create('Before major refactor');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Checkpoint created');
      expect(result.data?.checkpointId).toMatch(/^checkpoint-\d+-\w+$/);
      expect(result.data?.frameCount).toBe(2);

      // Verify file was created
      const files = fs.readdirSync(tempDir);
      expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    });

    it('should create checkpoint with file backups', async () => {
      // Create test file
      const testFile = path.join(tempDir, 'test.txt');
      fs.writeFileSync(testFile, 'test content');

      const result = await checkpointSkill.create('With files', {
        includeFiles: [testFile],
      });

      expect(result.success).toBe(true);

      // Verify file backup exists
      const checkpointId = result.data?.checkpointId;
      const filesDir = path.join(tempDir, checkpointId, 'files');
      expect(fs.existsSync(filesDir)).toBe(true);
      expect(fs.existsSync(path.join(filesDir, 'test.txt'))).toBe(true);
    });

    it('should detect risky operations', async () => {
      mockDualStackManager.getActiveStack = vi.fn().mockReturnValue({
        getAllFrames: vi.fn().mockResolvedValue([
          {
            frameId: 'frame-risky',
            name: 'Database migration',
            state: 'active',
            inputs: { command: 'npm run migrate' },
          },
        ]),
      });

      const result = await checkpointSkill.create('Risky operation', {
        autoDetectRisky: true,
      });

      expect(result.success).toBe(true);

      // Load checkpoint and verify metadata
      const files = fs.readdirSync(tempDir);
      const checkpointFile = files.find((f: any) => f.endsWith('.json'));
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(tempDir, checkpointFile!), 'utf-8')
      );

      expect(checkpoint.metadata.riskyOperation).toBe(true);
      expect(checkpoint.metadata.autoCheckpoint).toBe(true);
    });

    it('should list checkpoints', async () => {
      // Create multiple checkpoints
      await checkpointSkill.create('First checkpoint');
      await checkpointSkill.create('Second checkpoint');

      const result = await checkpointSkill.list();

      expect(result.success).toBe(true);
      expect(result.data?.length).toBe(2);
      // The order depends on timestamp which might be the same in tests
      const descriptions = result.data?.map((d: any) => d.description);
      expect(descriptions).toContain('First checkpoint');
      expect(descriptions).toContain('Second checkpoint');
    });

    it('should restore checkpoint', async () => {
      const createResult = await checkpointSkill.create('Test checkpoint');
      const checkpointId = createResult.data?.checkpointId;

      const restoreResult = await checkpointSkill.restore(checkpointId!);

      expect(restoreResult.success).toBe(true);
      expect(restoreResult.message).toContain('Restored to checkpoint');
      expect(mockDualStackManager.switchToStack).toHaveBeenCalled();
    });

    it('should diff two checkpoints', async () => {
      // Create first checkpoint
      const cp1 = await checkpointSkill.create('First');

      // Modify mock to return different frames
      mockDualStackManager.getActiveStack = vi.fn().mockReturnValue({
        getAllFrames: vi.fn().mockResolvedValue([
          {
            frameId: 'frame1',
            name: 'Test Frame 1',
            state: 'completed',
          },
          {
            frameId: 'frame3',
            name: 'New Frame',
            state: 'active',
          },
        ]),
      });

      // Create second checkpoint
      const cp2 = await checkpointSkill.create('Second');

      const diffResult = await checkpointSkill.diff(
        cp1.data!.checkpointId,
        cp2.data!.checkpointId
      );

      expect(diffResult.success).toBe(true);
      expect(diffResult.data?.newFrames).toBe(1); // frame3
      expect(diffResult.data?.removedFrames).toBe(1); // frame2
    });
  });

  describe('ArchaeologistSkill', () => {
    it('should dig through historical context', async () => {
      const skill = new ArchaeologistSkill(context);
      const result = await skill.dig('authentication', {
        depth: '30days',
        patterns: true,
        decisions: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.totalResults).toBe(2);
      expect(mockContextRetriever.retrieve).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'authentication',
          projectId: 'test-project',
        })
      );
    });

    it('should extract patterns from results', async () => {
      mockContextRetriever.retrieve = vi.fn().mockResolvedValue([
        {
          frameId: 'f1',
          score: 0.9,
          timestamp: new Date().toISOString(),
          content: 'Refactoring the authentication module',
        },
        {
          frameId: 'f2',
          score: 0.8,
          timestamp: new Date().toISOString(),
          content: 'Fixed bug in login flow',
        },
        {
          frameId: 'f3',
          score: 0.7,
          timestamp: new Date().toISOString(),
          content: 'Refactoring database queries',
        },
      ]);

      const skill = new ArchaeologistSkill(context);
      const result = await skill.dig('test', {
        patterns: true,
      });

      expect(result.data?.patterns).toHaveLength(2);
      expect(result.data?.patterns[0].name).toBe('Refactoring');
      expect(result.data?.patterns[0].count).toBe(2);
      expect(result.data?.patterns[1].name).toBe('Debugging');
      expect(result.data?.patterns[1].count).toBe(1);
    });

    it('should extract decisions', async () => {
      mockContextRetriever.retrieve = vi.fn().mockResolvedValue([
        {
          frameId: 'f1',
          score: 0.9,
          timestamp: new Date().toISOString(),
          content:
            'We decided to use JWT for authentication. This provides better security.',
        },
        {
          frameId: 'f2',
          score: 0.8,
          timestamp: new Date().toISOString(),
          content:
            'The team chose PostgreSQL over MongoDB for better ACID compliance.',
        },
      ]);

      const skill = new ArchaeologistSkill(context);
      const result = await skill.dig('architecture', {
        decisions: true,
      });

      expect(result.data?.decisions).toHaveLength(2);
      expect(result.data?.decisions[0].decision).toContain(
        'decided to use JWT'
      );
      expect(result.data?.decisions[1].decision).toContain('chose PostgreSQL');
    });

    it('should generate timeline', async () => {
      const now = Date.now();
      mockContextRetriever.retrieve = vi.fn().mockResolvedValue([
        {
          frameId: 'f1',
          timestamp: new Date(now).toISOString(),
          content: 'Today activity 1',
        },
        {
          frameId: 'f2',
          timestamp: new Date(now).toISOString(),
          content: 'Today activity 2',
        },
        {
          frameId: 'f3',
          timestamp: new Date(now - 86400000).toISOString(),
          content: 'Yesterday activity',
        },
      ]);

      const skill = new ArchaeologistSkill(context);
      const result = await skill.dig('test', {
        timeline: true,
      });

      expect(result.data?.timeline).toHaveLength(2);
      expect(result.data?.timeline[0].itemCount).toBe(2); // Today
      expect(result.data?.timeline[1].itemCount).toBe(1); // Yesterday
    });

    it('should parse different depth formats', async () => {
      const skill = new ArchaeologistSkill(context);

      await skill.dig('test', { depth: '7days' });
      await skill.dig('test', { depth: '2weeks' });
      await skill.dig('test', { depth: '3months' });
      await skill.dig('test', { depth: 'all' });

      expect(mockContextRetriever.retrieve).toHaveBeenCalledTimes(4);
    });
  });

  describe('ClaudeSkillsManager', () => {
    it('should execute handoff skill', async () => {
      const manager = new ClaudeSkillsManager(context);
      const result = await manager.executeSkill(
        'handoff',
        ['user2', 'Test message'],
        {
          priority: 'high',
        }
      );

      expect(result.success).toBe(true);
      expect(result.data?.handoffId).toBe('handoff-test-123');
    });

    it('should execute checkpoint create', async () => {
      const manager = new ClaudeSkillsManager(context);
      // Override checkpoint dir
      (manager as any).checkpointSkill.checkpointDir = tempDir;

      const result = await manager.executeSkill('checkpoint', [
        'create',
        'Test checkpoint',
      ]);

      expect(result.success).toBe(true);
      expect(result.data?.checkpointId).toBeDefined();
    });

    it('should execute dig skill', async () => {
      const manager = new ClaudeSkillsManager(context);
      const result = await manager.executeSkill('dig', ['test query'], {
        depth: '30days',
      });

      expect(result.success).toBe(true);
      expect(result.data?.totalResults).toBe(2);
    });

    it('should return error for unknown skill', async () => {
      const manager = new ClaudeSkillsManager(context);
      const result = await manager.executeSkill('unknown', ['test']);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown skill');
    });

    it('should get available skills', () => {
      const manager = new ClaudeSkillsManager(context);
      const skills = manager.getAvailableSkills();

      expect(skills).toEqual([
        'handoff',
        'checkpoint',
        'dig',
        'dashboard',
        'api',
        'spec',
        'agent',
      ]);
    });

    it('should get skill help', () => {
      const manager = new ClaudeSkillsManager(context);

      const handoffHelp = manager.getSkillHelp('handoff');
      expect(handoffHelp).toContain('/handoff @user');

      const checkpointHelp = manager.getSkillHelp('checkpoint');
      expect(checkpointHelp).toContain('/checkpoint create');

      const digHelp = manager.getSkillHelp('dig');
      expect(digHelp).toContain('/dig "query"');
    });
  });
});
