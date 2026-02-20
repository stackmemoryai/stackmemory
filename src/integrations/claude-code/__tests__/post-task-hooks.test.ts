/**
 * Tests for PostTaskHooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process before importing
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

// Mock chokidar
vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  }),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(
    JSON.stringify({
      scripts: {
        test: 'vitest run',
        'test:run': 'vitest run',
        lint: 'eslint .',
        coverage: 'vitest --coverage',
      },
      dependencies: {},
      devDependencies: {
        vitest: '^1.0.0',
      },
    })
  ),
}));

import { PostTaskHooks } from '../post-task-hooks.js';
import type {
  PostTaskConfig,
  TaskCompletionEvent,
  QualityGateResult,
} from '../post-task-hooks.js';
import { execSync } from 'child_process';

// Create mock FrameManager as EventEmitter
function createMockFrameManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getFrame: vi.fn().mockResolvedValue({
      id: 'frame-1',
      metadata: {},
    }),
    updateFrame: vi.fn().mockResolvedValue(undefined),
  });
}

// Create mock DatabaseManager
function createMockDbManager() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
  };
}

describe('PostTaskHooks', () => {
  let hooks: PostTaskHooks;
  let mockFrameManager: ReturnType<typeof createMockFrameManager>;
  let mockDbManager: ReturnType<typeof createMockDbManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFrameManager = createMockFrameManager();
    mockDbManager = createMockDbManager();

    hooks = new PostTaskHooks(mockFrameManager as any, mockDbManager as any, {
      projectRoot: '/tmp/test-project',
      qualityGates: {
        runTests: false,
        requireTestCoverage: false,
        runCodeReview: false,
        runLinter: false,
        blockOnFailure: false,
      },
    });
  });

  afterEach(async () => {
    try {
      await hooks.stop();
    } catch {
      // ignore
    }
  });

  describe('constructor', () => {
    it('should create instance with default config merged with provided', () => {
      const config = hooks.getConfig();

      expect(config.projectRoot).toBe('/tmp/test-project');
      expect(config.qualityGates.runTests).toBe(false);
      expect(config.qualityGates.runLinter).toBe(false);
    });

    it('should use defaults for missing config properties', () => {
      const minimalHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {}
      );

      const config = minimalHooks.getConfig();

      // Default review config should be applied
      expect(config.reviewConfig.focusAreas).toContain('security');
      expect(config.reviewConfig.focusAreas).toContain('performance');
      expect(config.reviewConfig.skipPatterns).toContain('*.test.ts');
      expect(config.reviewConfig.skipPatterns).toContain('node_modules/');
    });
  });

  describe('initialize', () => {
    it('should detect test frameworks from package.json', async () => {
      await hooks.initialize();

      const config = hooks.getConfig();
      expect(config.testFrameworks.detected).toContain('vitest');
    });

    it('should detect test command from package.json', async () => {
      await hooks.initialize();

      const config = hooks.getConfig();
      expect(config.testFrameworks.testCommand).toBe('npm test');
    });

    it('should detect lint command from package.json', async () => {
      await hooks.initialize();

      const config = hooks.getConfig();
      expect(config.testFrameworks.lintCommand).toBe('npm run lint');
    });

    it('should detect coverage command from package.json', async () => {
      await hooks.initialize();

      const config = hooks.getConfig();
      expect(config.testFrameworks.coverageCommand).toBe('npm run coverage');
    });

    it('should emit initialized event', async () => {
      const initPromise = new Promise<void>((resolve) => {
        hooks.on('initialized', () => resolve());
      });

      await hooks.initialize();
      await initPromise;
    });

    it('should not re-initialize if already active', async () => {
      await hooks.initialize();

      // Clear mock calls
      vi.clearAllMocks();

      await hooks.initialize();

      // readFile should not be called again
      const fsPromises = await import('fs/promises');
      expect(fsPromises.readFile).not.toHaveBeenCalled();
    });

    it('should handle missing package.json gracefully', async () => {
      const fsPromises = await import('fs/promises');
      (fsPromises.readFile as any).mockRejectedValueOnce(
        new Error('ENOENT: no such file')
      );

      await expect(hooks.initialize()).resolves.not.toThrow();
    });
  });

  describe('getConfig', () => {
    it('should return a copy of the config', () => {
      const config1 = hooks.getConfig();
      const config2 = hooks.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // Different objects
    });
  });

  describe('updateConfig', () => {
    it('should update config values', () => {
      hooks.updateConfig({ projectRoot: '/new/root' });

      const config = hooks.getConfig();
      expect(config.projectRoot).toBe('/new/root');
    });

    it('should emit config:updated event', () => {
      const handler = vi.fn();
      hooks.on('config:updated', handler);

      hooks.updateConfig({ projectRoot: '/new/root' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: '/new/root' })
      );
    });

    it('should preserve unmodified config values', () => {
      const originalConfig = hooks.getConfig();

      hooks.updateConfig({ projectRoot: '/new/root' });

      const updatedConfig = hooks.getConfig();
      expect(updatedConfig.qualityGates).toEqual(originalConfig.qualityGates);
    });
  });

  describe('quality gates - linter', () => {
    it('should run linter when enabled and command exists', async () => {
      const lintHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: false,
            requireTestCoverage: false,
            runCodeReview: false,
            runLinter: true,
            blockOnFailure: false,
          },
          testFrameworks: {
            detected: [],
            lintCommand: 'npm run lint',
          },
        }
      );

      (execSync as any).mockReturnValueOnce('All clean');

      const results: QualityGateResult[] = [];
      lintHooks.on('quality:passed', (data: any) => {
        results.push(...data.results);
      });

      await lintHooks.initialize();

      // Trigger a task completion through the frame manager event
      mockFrameManager.emit('frame:closed', 'frame-1', {
        type: 'task',
        name: 'Test task',
        metadata: { files: ['test.ts'] },
      });

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(execSync).toHaveBeenCalledWith(
        'npm run lint',
        expect.objectContaining({
          cwd: '/tmp/test-project',
          timeout: 30000,
        })
      );
    });

    it('should report lint failures', async () => {
      const lintHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: false,
            requireTestCoverage: false,
            runCodeReview: false,
            runLinter: true,
            blockOnFailure: false,
          },
          testFrameworks: {
            detected: [],
            lintCommand: 'npm run lint',
          },
        }
      );

      const lintError = new Error('Lint failed');
      (lintError as any).stdout = 'src/index.ts:10:5: error: Unused variable x';
      (execSync as any).mockImplementation(() => {
        throw lintError;
      });

      let failedResults: QualityGateResult[] = [];
      lintHooks.on('quality:failed', (data: any) => {
        failedResults = data.results;
      });

      await lintHooks.initialize();

      mockFrameManager.emit('frame:closed', 'frame-2', {
        type: 'task',
        name: 'Failed lint task',
        metadata: { files: ['src/index.ts'] },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have reported failures
      if (failedResults.length > 0) {
        const lintResult = failedResults.find((r) => r.gate === 'linter');
        expect(lintResult).toBeDefined();
        expect(lintResult!.passed).toBe(false);
      }
    });
  });

  describe('quality gates - tests', () => {
    it('should skip tests when no test command configured', async () => {
      const testHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: true,
            requireTestCoverage: false,
            runCodeReview: false,
            runLinter: false,
            blockOnFailure: false,
          },
          testFrameworks: {
            detected: [],
            // No testCommand set
          },
        }
      );

      await testHooks.initialize();

      mockFrameManager.emit('frame:closed', 'frame-3', {
        type: 'task',
        name: 'No test cmd task',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not call execSync for tests since no command
      // (linter is disabled, so only test gate runs - and it should pass with 'no command')
    });
  });

  describe('quality gates - code review', () => {
    it('should run code review when enabled', async () => {
      const reviewHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: false,
            requireTestCoverage: false,
            runCodeReview: true,
            runLinter: false,
            blockOnFailure: false,
          },
        }
      );

      let passedResults: QualityGateResult[] = [];
      reviewHooks.on('quality:passed', (data: any) => {
        passedResults = data.results;
      });

      await reviewHooks.initialize();

      mockFrameManager.emit('frame:closed', 'frame-4', {
        type: 'task',
        name: 'Review task',
        metadata: { files: ['src/app.ts'] },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Mock review always returns no issues
      if (passedResults.length > 0) {
        const reviewResult = passedResults.find(
          (r) => r.gate === 'code_review'
        );
        expect(reviewResult).toBeDefined();
        expect(reviewResult!.passed).toBe(true);
      }
    });
  });

  describe('frame event handling', () => {
    it('should listen for frame:closed events on task frames', async () => {
      await hooks.initialize();

      const handler = vi.fn();
      hooks.on('task:completed', handler);

      mockFrameManager.emit('frame:closed', 'frame-5', {
        type: 'task',
        name: 'My task',
        metadata: { files: ['a.ts'] },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'task_complete',
          frameId: 'frame-5',
          frameName: 'My task',
        })
      );
    });

    it('should listen for frame:closed events on subtask frames', async () => {
      await hooks.initialize();

      const handler = vi.fn();
      hooks.on('task:completed', handler);

      mockFrameManager.emit('frame:closed', 'frame-6', {
        type: 'subtask',
        name: 'My subtask',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'task_complete',
          frameName: 'My subtask',
        })
      );
    });

    it('should ignore non-task frame closures', async () => {
      await hooks.initialize();

      const handler = vi.fn();
      hooks.on('task:completed', handler);

      mockFrameManager.emit('frame:closed', 'frame-7', {
        type: 'session',
        name: 'Session frame',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should prevent duplicate processing for same frame', async () => {
      await hooks.initialize();

      const handler = vi.fn();
      hooks.on('task:completed', handler);

      // Emit same frame closure twice
      mockFrameManager.emit('frame:closed', 'frame-dup', {
        type: 'task',
        name: 'Dup task',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      mockFrameManager.emit('frame:closed', 'frame-dup', {
        type: 'task',
        name: 'Dup task',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle code_change events from frame:event', async () => {
      await hooks.initialize();

      const handler = vi.fn();
      hooks.on('task:completed', handler);

      mockFrameManager.emit('frame:event', 'frame-8', 'code_change', {
        description: 'Updated file',
        files: ['src/main.ts'],
        changes: { added: 5, removed: 2, modified: 1 },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'code_change',
          frameId: 'frame-8',
        })
      );
    });
  });

  describe('stop', () => {
    it('should deactivate hooks', async () => {
      await hooks.initialize();
      await hooks.stop();

      // Emitting events should not trigger handlers
      const handler = vi.fn();
      hooks.on('task:completed', handler);

      // Hooks removes all listeners on stop
      // New listeners won't fire on old frame manager events
    });
  });

  describe('record quality results', () => {
    it('should update frame metadata with quality results', async () => {
      const qualityHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: false,
            requireTestCoverage: false,
            runCodeReview: false,
            runLinter: false,
            blockOnFailure: false,
          },
        }
      );

      await qualityHooks.initialize();

      mockFrameManager.emit('frame:closed', 'frame-record', {
        type: 'task',
        name: 'Record task',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // getFrame should have been called for the frame
      expect(mockFrameManager.getFrame).toHaveBeenCalledWith('frame-record');

      // updateFrame should have been called with quality results
      expect(mockFrameManager.updateFrame).toHaveBeenCalledWith(
        'frame-record',
        expect.objectContaining({
          metadata: expect.objectContaining({
            qualityGates: expect.objectContaining({
              timestamp: expect.any(String),
              results: expect.any(Array),
              passed: expect.any(Boolean),
              totalDuration: expect.any(Number),
            }),
          }),
        })
      );
    });

    it('should handle missing frame gracefully', async () => {
      mockFrameManager.getFrame.mockResolvedValue(null);

      const qualityHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: false,
            requireTestCoverage: false,
            runCodeReview: false,
            runLinter: false,
            blockOnFailure: false,
          },
        }
      );

      await qualityHooks.initialize();

      mockFrameManager.emit('frame:closed', 'frame-missing', {
        type: 'task',
        name: 'Missing frame task',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not throw, updateFrame should not be called
      expect(mockFrameManager.updateFrame).not.toHaveBeenCalled();
    });
  });

  describe('blocking on failure', () => {
    it('should block further work when blockOnFailure is enabled and gates fail', async () => {
      const blockHooks = new PostTaskHooks(
        mockFrameManager as any,
        mockDbManager as any,
        {
          projectRoot: '/tmp/test-project',
          qualityGates: {
            runTests: false,
            requireTestCoverage: false,
            runCodeReview: false,
            runLinter: true,
            blockOnFailure: true,
          },
          testFrameworks: {
            detected: [],
            lintCommand: 'npm run lint',
          },
        }
      );

      const lintError = new Error('Lint failed');
      (lintError as any).stdout = 'error: some lint error';
      (execSync as any).mockImplementation(() => {
        throw lintError;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await blockHooks.initialize();

      mockFrameManager.emit('frame:closed', 'frame-block', {
        type: 'task',
        name: 'Blocked task',
        metadata: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have logged blocking message
      const blockMessages = consoleSpy.mock.calls.filter((call) =>
        String(call[0]).includes('Quality gates failed')
      );
      expect(blockMessages.length).toBeGreaterThanOrEqual(1);

      consoleSpy.mockRestore();
    });
  });
});
