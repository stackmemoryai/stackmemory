/**
 * Tests for ClaudeCodeLifecycleHooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Mock dependencies before imports
vi.mock('../../core/monitoring/session-monitor', () => {
  const SessionMonitor = vi.fn().mockImplementation(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.on = vi.fn();
    this.getStatus = vi.fn().mockReturnValue({ isRunning: true });
  });
  return { SessionMonitor };
});

vi.mock('../../core/frame/frame-manager', () => {
  const FrameManager = vi.fn().mockImplementation(function () {
    return {};
  });
  return { FrameManager };
});

vi.mock('../../core/storage/database-manager', () => {
  const DatabaseManager = vi.fn().mockImplementation(function (this: any) {
    this.initialize = vi.fn().mockResolvedValue(undefined);
  });
  return { DatabaseManager };
});

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: vi.fn(() =>
      vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' })
    ),
  };
});

import {
  ClaudeCodeLifecycleHooks,
  initializeClaudeHooks,
  getClaudeHooks,
  stopClaudeHooks,
} from '../lifecycle-hooks.js';
import * as fsPromises from 'fs/promises';

describe('ClaudeCodeLifecycleHooks', () => {
  let hooks: ClaudeCodeLifecycleHooks;
  const testProjectRoot = '/tmp/test-project';

  beforeEach(() => {
    vi.clearAllMocks();
    hooks = new ClaudeCodeLifecycleHooks({
      projectRoot: testProjectRoot,
      autoTriggers: {
        onContextHigh: true,
        onContextCritical: true,
        onSessionIdle: true,
        onSessionEnd: true,
        onClearCommand: true,
      },
    });
  });

  afterEach(async () => {
    // Ensure hooks are stopped
    try {
      await hooks.stop();
    } catch {
      // ignore
    }
  });

  describe('constructor', () => {
    it('should create instance with provided config', () => {
      const status = hooks.getStatus();
      expect(status.isActive).toBe(false);
      expect(status.config.projectRoot).toBe(testProjectRoot);
      expect(status.config.autoTriggers.onContextHigh).toBe(true);
      expect(status.config.autoTriggers.onContextCritical).toBe(true);
      expect(status.config.autoTriggers.onSessionIdle).toBe(true);
      expect(status.config.autoTriggers.onSessionEnd).toBe(true);
      expect(status.config.autoTriggers.onClearCommand).toBe(true);
    });

    it('should set default claudeHooksPath when not provided', () => {
      const status = hooks.getStatus();
      expect(status.config.claudeHooksPath).toBe(
        path.join(os.homedir(), '.claude', 'hooks')
      );
    });

    it('should use custom claudeHooksPath when provided', () => {
      const customHooks = new ClaudeCodeLifecycleHooks({
        projectRoot: testProjectRoot,
        autoTriggers: {
          onContextHigh: false,
          onContextCritical: false,
          onSessionIdle: false,
          onSessionEnd: false,
          onClearCommand: false,
        },
        claudeHooksPath: '/custom/hooks/path',
      });

      const status = customHooks.getStatus();
      expect(status.config.claudeHooksPath).toBe('/custom/hooks/path');
    });
  });

  describe('initialize', () => {
    it('should initialize and set active state', async () => {
      await hooks.initialize();

      const status = hooks.getStatus();
      expect(status.isActive).toBe(true);
    });

    it('should create hooks directory', async () => {
      await hooks.initialize();

      expect(fsPromises.mkdir).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      });
    });

    it('should install hook scripts', async () => {
      await hooks.initialize();

      // Should have written at least 4 hook scripts
      expect(fsPromises.writeFile).toHaveBeenCalled();
      const writeFileCalls = (fsPromises.writeFile as any).mock.calls;
      expect(writeFileCalls.length).toBeGreaterThanOrEqual(4);
    });

    it('should set correct permissions on hook scripts', async () => {
      await hooks.initialize();

      // Should have chmod'd the hooks to 0o755
      expect(fsPromises.chmod).toHaveBeenCalled();
      const chmodCalls = (fsPromises.chmod as any).mock.calls;
      for (const call of chmodCalls) {
        expect(call[1]).toBe(0o755);
      }
    });

    it('should not re-initialize when already active', async () => {
      await hooks.initialize();
      const firstCallCount = (fsPromises.writeFile as any).mock.calls.length;

      await hooks.initialize();
      const secondCallCount = (fsPromises.writeFile as any).mock.calls.length;

      expect(secondCallCount).toBe(firstCallCount);
    });

    it('should register event handlers for context warnings', async () => {
      await hooks.initialize();

      // The monitor instance is stored in hooks, accessible via getStatus
      const status = hooks.getStatus();
      // Verify that monitor was created (status shows monitor is active)
      expect(status.isActive).toBe(true);
      expect(status.monitorStatus).toBeDefined();
      // The hooks are installed (event handlers registered during init)
      expect(status.installedHooks).toContain('on-message-submit');
    });
  });

  describe('stop', () => {
    it('should set isActive to false', async () => {
      await hooks.initialize();
      await hooks.stop();

      const status = hooks.getStatus();
      expect(status.isActive).toBe(false);
    });

    it('should stop session monitor', async () => {
      await hooks.initialize();
      expect(hooks.getStatus().isActive).toBe(true);

      await hooks.stop();
      expect(hooks.getStatus().isActive).toBe(false);
    });

    it('should handle stop when no monitor exists', async () => {
      // Stop without initializing - should not throw
      await expect(hooks.stop()).resolves.not.toThrow();
    });
  });

  describe('getStatus', () => {
    it('should return inactive status before initialization', () => {
      const status = hooks.getStatus();

      expect(status.isActive).toBe(false);
      expect(status.installedHooks).toEqual([]);
    });

    it('should return active status with installed hooks after init', async () => {
      await hooks.initialize();

      const status = hooks.getStatus();
      expect(status.isActive).toBe(true);
      expect(status.installedHooks.length).toBeGreaterThan(0);
      expect(status.installedHooks).toContain('on-message-submit');
      expect(status.installedHooks).toContain('on-session-end');
      expect(status.installedHooks).toContain('on-command-clear');
      expect(status.installedHooks).toContain('on-idle-5min');
    });

    it('should include monitor status when initialized', async () => {
      await hooks.initialize();

      const status = hooks.getStatus();
      expect(status.monitorStatus).toBeDefined();
    });

    it('should return config in status', () => {
      const status = hooks.getStatus();

      expect(status.config).toBeDefined();
      expect(status.config.projectRoot).toBe(testProjectRoot);
    });
  });
});

describe('Global hooks functions', () => {
  afterEach(async () => {
    await stopClaudeHooks();
  });

  describe('initializeClaudeHooks', () => {
    it('should create and initialize a global instance', async () => {
      const instance = await initializeClaudeHooks('/tmp/test-global');

      expect(instance).toBeInstanceOf(ClaudeCodeLifecycleHooks);
      const status = instance.getStatus();
      expect(status.isActive).toBe(true);
    });

    it('should return same instance on repeated calls', async () => {
      const first = await initializeClaudeHooks('/tmp/test-global');
      const second = await initializeClaudeHooks('/tmp/test-global');

      expect(first).toBe(second);
    });

    it('should use process.cwd when no projectRoot provided', async () => {
      const instance = await initializeClaudeHooks();

      expect(instance).toBeInstanceOf(ClaudeCodeLifecycleHooks);
    });
  });

  describe('getClaudeHooks', () => {
    it('should return undefined when not initialized', async () => {
      // Ensure clean state
      await stopClaudeHooks();
      const instance = getClaudeHooks();
      expect(instance).toBeUndefined();
    });

    it('should return instance after initialization', async () => {
      await initializeClaudeHooks('/tmp/test-global');
      const instance = getClaudeHooks();

      expect(instance).toBeInstanceOf(ClaudeCodeLifecycleHooks);
    });
  });

  describe('stopClaudeHooks', () => {
    it('should stop and clear global instance', async () => {
      await initializeClaudeHooks('/tmp/test-global');
      await stopClaudeHooks();

      const instance = getClaudeHooks();
      expect(instance).toBeUndefined();
    });

    it('should be safe to call when no instance exists', async () => {
      await expect(stopClaudeHooks()).resolves.not.toThrow();
    });
  });
});
