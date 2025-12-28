/**
 * Tests for StackMemory CLI Commands
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { program } from 'commander';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

// Mock dependencies
vi.mock('../core/monitoring/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn()
  }
}));

vi.mock('better-sqlite3', () => ({
  default: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => [])
    })),
    close: vi.fn()
  }))
}));

vi.mock('../core/context/frame-manager', () => ({
  FrameManager: vi.fn().mockImplementation(() => ({
    createFrame: vi.fn(() => 'frame-123'),
    getActiveFramePath: vi.fn(() => []),
    getStackDepth: vi.fn(() => 0),
    getHotStackContext: vi.fn(() => [])
  }))
}));

vi.mock('../features/tasks/pebbles-task-store.js', () => ({
  PebblesTaskStore: vi.fn().mockImplementation(() => ({
    createTask: vi.fn(() => 'task-123'),
    getActiveTasks: vi.fn(() => []),
    getMetrics: vi.fn(() => ({
      total_tasks: 0,
      completion_rate: 0,
      blocked_tasks: 0
    }))
  }))
}));

vi.mock('../integrations/linear/auth', () => ({
  LinearAuthManager: vi.fn().mockImplementation(() => ({
    isConfigured: vi.fn(() => false),
    loadConfig: vi.fn(),
    loadTokens: vi.fn()
  })),
  LinearOAuthSetup: vi.fn().mockImplementation(() => ({
    setupInteractive: vi.fn(),
    completeAuth: vi.fn(),
    testConnection: vi.fn()
  }))
}));

vi.mock('../integrations/linear/sync', () => ({
  LinearSyncEngine: vi.fn().mockImplementation(() => ({
    sync: vi.fn(() => ({
      success: true,
      synced: { toLinear: 1, fromLinear: 2, updated: 0 },
      conflicts: [],
      errors: []
    }))
  })),
  DEFAULT_SYNC_CONFIG: {
    enabled: true,
    direction: 'bidirectional'
  }
}));

vi.mock('../core/utils/update-checker', () => ({
  UpdateChecker: {
    checkForUpdates: vi.fn(),
    forceCheck: vi.fn()
  }
}));

vi.mock('../core/monitoring/progress-tracker', () => ({
  ProgressTracker: vi.fn().mockImplementation(() => ({
    getSummary: vi.fn(() => 'Progress summary'),
    updateLinearStatus: vi.fn()
  }))
}));

// Mock child_process for git operations
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('mock git output'))
}));

// Mock the command registration functions
vi.mock('./commands/projects', () => ({
  registerProjectCommands: vi.fn()
}));

vi.mock('./commands/linear', () => ({
  registerLinearCommands: vi.fn()
}));

vi.mock('./commands/linear-test', () => ({
  registerLinearTestCommand: vi.fn()
}));

vi.mock('./commands/session', () => ({
  createSessionCommands: vi.fn()
}));

vi.mock('./commands/worktree', () => ({
  registerWorktreeCommands: vi.fn()
}));

vi.mock('./commands/onboard', () => ({
  registerOnboardingCommand: vi.fn()
}));

vi.mock('./commands/webhook', () => ({
  webhookCommand: vi.fn(() => ({ name: 'webhook' }))
}));

vi.mock('../core/projects/project-manager.js', () => ({
  ProjectManager: {
    getInstance: vi.fn(() => ({
      detectProject: vi.fn()
    }))
  }
}));

vi.mock('../core/session/index.js', () => ({
  sessionManager: {
    initialize: vi.fn(),
    getOrCreateSession: vi.fn(() => ({
      sessionId: 'test-session-123',
      projectId: 'test-project',
      state: 'active',
      startedAt: Date.now() - 600000, // 10 minutes ago
      branch: 'main'
    })),
    listSessions: vi.fn(() => [])
  },
  FrameQueryMode: {
    CURRENT_SESSION: 'current_session',
    ALL_ACTIVE: 'all_active',
    PROJECT_ACTIVE: 'project_active',
    HISTORICAL: 'historical'
  }
}));

describe('CLI Commands', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalArgv: string[];
  let consoleSpy: any;

  beforeEach(() => {
    // Setup temp directory
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-cli-test-'));
    originalCwd = process.cwd();
    originalArgv = [...process.argv];

    // Mock process.cwd() to return our temp directory
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    // Mock console methods
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };

    // Mock process.exit to prevent tests from exiting
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit() called');
    });

    // Clear commander program
    (program.commands as any[]).length = 0;
    (program.options as any[]).length = 0;
  });

  afterEach(() => {
    // Restore original state
    vi.spyOn(process, 'cwd').mockRestore();
    process.argv = originalArgv;
    
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
    vi.spyOn(process, 'exit').mockRestore();

    // Cleanup temp directory
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    vi.clearAllMocks();
  });

  describe('init command', () => {
    beforeEach(async () => {
      // Dynamically import to get fresh instance
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');
    });

    it('should initialize StackMemory in current directory', async () => {
      process.argv = ['node', 'stackmemory', 'init'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        // Expect process.exit to be called
        expect(error.message).toBe('process.exit() called');
      }

      const stackmemoryDir = join(tempDir, '.stackmemory');
      expect(existsSync(stackmemoryDir)).toBe(true);
      expect(consoleSpy.log).toHaveBeenCalledWith('✅ StackMemory initialized in', tempDir);
    });

    it('should handle initialization errors', async () => {
      // Mock FrameManager to throw error  
      const { FrameManager } = await vi.importMock('../core/context/frame-manager');
      (FrameManager as Mock).mockImplementationOnce(() => {
        throw new Error('Database error');
      });

      process.argv = ['node', 'stackmemory', 'init'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ Initialization failed:', 'Database error');
    });
  });

  describe('status command', () => {
    beforeEach(async () => {
      // Create a test database file
      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');

      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');
    });

    it('should show status when StackMemory is initialized', async () => {
      process.argv = ['node', 'stackmemory', 'status'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('📊 StackMemory Status:');
    });

    it('should show error when StackMemory is not initialized', async () => {
      // Remove the database file
      rmSync(join(tempDir, '.stackmemory'), { recursive: true });

      process.argv = ['node', 'stackmemory', 'status'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith(
        '❌ StackMemory not initialized. Run "stackmemory init" first.'
      );
    });

    it('should handle --all option', async () => {
      process.argv = ['node', 'stackmemory', 'status', '--all'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('📊 StackMemory Status:');
    });

    it('should handle --project option', async () => {
      process.argv = ['node', 'stackmemory', 'status', '--project'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('📊 StackMemory Status:');
    });

    it('should handle --session option', async () => {
      process.argv = ['node', 'stackmemory', 'status', '--session', 'test-session-id'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('📊 StackMemory Status:');
    });

    it('should handle status check errors', async () => {
      // Mock FrameManager to throw error
      const { FrameManager } = await import('../core/context/frame-manager');
      (FrameManager as Mock).mockImplementationOnce(() => {
        throw new Error('Status error');
      });

      process.argv = ['node', 'stackmemory', 'status'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ Status check failed:', 'Status error');
    });
  });

  describe('Linear commands', () => {
    beforeEach(async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');
    });

    describe('linear setup', () => {
      it('should setup Linear OAuth integration', async () => {
        const { LinearOAuthSetup } = await import('../integrations/linear/auth');
        const mockSetup = LinearOAuthSetup as Mock;
        mockSetup.mockImplementation(() => ({
          setupInteractive: vi.fn().mockResolvedValue({
            authUrl: 'https://linear.app/oauth/authorize?client_id=test',
            instructions: [
              'Step 1: Visit the authorization URL',
              'Step 2: Complete authorization'
            ]
          })
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'setup'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('🔗 Linear OAuth Setup\n');
      });

      it('should handle setup errors', async () => {
        const { LinearOAuthSetup } = await import('../integrations/linear/auth');
        const mockSetup = LinearOAuthSetup as Mock;
        mockSetup.mockImplementation(() => ({
          setupInteractive: vi.fn().mockRejectedValue(new Error('Setup failed'))
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'setup'];
        
        try {
          await program.parseAsync();
        } catch (error) {
          expect(error.message).toBe('process.exit() called');
        }

        expect(consoleSpy.error).toHaveBeenCalledWith('❌ Setup failed:', 'Setup failed');
      });
    });

    describe('linear authorize', () => {
      it('should complete Linear authorization', async () => {
        const { LinearOAuthSetup } = await import('../integrations/linear/auth');
        const mockSetup = LinearOAuthSetup as Mock;
        mockSetup.mockImplementation(() => ({
          completeAuth: vi.fn().mockResolvedValue(true),
          testConnection: vi.fn().mockResolvedValue(true)
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'authorize', 'auth-code-123'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('✅ Linear integration authorized successfully!');
        expect(consoleSpy.log).toHaveBeenCalledWith('✅ Linear connection test passed!');
      });

      it('should handle authorization failure', async () => {
        const { LinearOAuthSetup } = await import('../integrations/linear/auth');
        const mockSetup = LinearOAuthSetup as Mock;
        mockSetup.mockImplementation(() => ({
          completeAuth: vi.fn().mockResolvedValue(false)
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'authorize', 'invalid-code'];
        
        try {
          await program.parseAsync();
        } catch (error) {
          expect(error.message).toBe('process.exit() called');
        }

        expect(consoleSpy.error).toHaveBeenCalledWith('❌ Authorization failed. Please try again.');
      });

      it('should handle connection test failure after successful auth', async () => {
        const { LinearOAuthSetup } = await import('../integrations/linear/auth');
        const mockSetup = LinearOAuthSetup as Mock;
        mockSetup.mockImplementation(() => ({
          completeAuth: vi.fn().mockResolvedValue(true),
          testConnection: vi.fn().mockResolvedValue(false)
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'authorize', 'auth-code-123'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('✅ Linear integration authorized successfully!');
        expect(consoleSpy.log).toHaveBeenCalledWith(
          '⚠️ Linear connection test failed. Check your configuration.'
        );
      });
    });

    describe('linear status', () => {
      it('should show status when not configured', async () => {
        process.argv = ['node', 'stackmemory', 'linear', 'status'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('📊 Linear Integration Status:');
        expect(consoleSpy.log).toHaveBeenCalledWith('   Configured: ❌');
      });

      it('should show detailed status when configured', async () => {
        const { LinearAuthManager } = await import('../integrations/linear/auth');
        const mockAuthManager = LinearAuthManager as Mock;
        mockAuthManager.mockImplementation(() => ({
          isConfigured: vi.fn(() => true),
          loadConfig: vi.fn(() => ({
            clientId: 'test-client-id'
          })),
          loadTokens: vi.fn(() => ({
            accessToken: 'test-token',
            expiresAt: Date.now() + 3600000
          }))
        }));

        const { LinearOAuthSetup } = await import('../integrations/linear/auth');
        const mockSetup = LinearOAuthSetup as Mock;
        mockSetup.mockImplementation(() => ({
          testConnection: vi.fn().mockResolvedValue(true)
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'status'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('   Configured: ✅');
        expect(consoleSpy.log).toHaveBeenCalledWith('   Connection: ✅ OK');
      });
    });

    describe('linear sync', () => {
      beforeEach(() => {
        // Create database directory for sync commands
        const dbDir = join(tempDir, '.stackmemory');
        mkdirSync(dbDir, { recursive: true });
        writeFileSync(join(dbDir, 'context.db'), '');
      });

      it('should sync with Linear when configured', async () => {
        const { LinearAuthManager } = await import('../integrations/linear/auth');
        const mockAuthManager = LinearAuthManager as Mock;
        mockAuthManager.mockImplementation(() => ({
          isConfigured: vi.fn(() => true)
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'sync'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('🔄 Starting bidirectional sync with Linear...');
        expect(consoleSpy.log).toHaveBeenCalledWith('✅ Sync completed successfully!');
      });

      it('should handle sync with custom direction', async () => {
        const { LinearAuthManager } = await import('../integrations/linear/auth');
        const mockAuthManager = LinearAuthManager as Mock;
        mockAuthManager.mockImplementation(() => ({
          isConfigured: vi.fn(() => true)
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'sync', '--direction', 'to_linear'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('🔄 Starting to_linear sync with Linear...');
      });

      it('should handle sync errors', async () => {
        const { LinearAuthManager } = await import('../integrations/linear/auth');
        const mockAuthManager = LinearAuthManager as Mock;
        mockAuthManager.mockImplementation(() => ({
          isConfigured: vi.fn(() => true)
        }));

        const { LinearSyncEngine } = await import('../integrations/linear/sync');
        const mockSyncEngine = LinearSyncEngine as Mock;
        mockSyncEngine.mockImplementation(() => ({
          sync: vi.fn().mockResolvedValue({
            success: false,
            errors: ['Sync error occurred']
          })
        }));

        process.argv = ['node', 'stackmemory', 'linear', 'sync'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith('❌ Sync failed');
      });

      it('should show warning when not configured', async () => {
        process.argv = ['node', 'stackmemory', 'linear', 'sync'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith(
          '❌ Linear not configured. Set LINEAR_API_KEY environment variable or run "stackmemory linear setup" first.'
        );
      });

      it('should show warning when not initialized', async () => {
        rmSync(join(tempDir, '.stackmemory'), { recursive: true });

        process.argv = ['node', 'stackmemory', 'linear', 'sync'];
        
        await program.parseAsync();

        expect(consoleSpy.log).toHaveBeenCalledWith(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
      });
    });
  });

  describe('context:test command', () => {
    beforeEach(() => {
      // Create database directory for context commands
      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');
    });

    it('should create test context frames', async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      const { FrameManager } = await import('../core/context/frame-manager');
      const mockFrameManager = FrameManager as Mock;
      let frameCallCount = 0;
      mockFrameManager.mockImplementation(() => ({
        createFrame: vi.fn(() => `frame-${++frameCallCount}`),
        addEvent: vi.fn(),
        closeFrame: vi.fn(),
        getStackDepth: vi.fn(() => frameCallCount),
        getActiveFramePath: vi.fn(() => [])
      }));

      process.argv = ['node', 'stackmemory', 'context:test'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('📝 Creating test context frames...');
      expect(consoleSpy.log).toHaveBeenCalledWith('✅ Test frames created!');
    });

    it('should handle context test errors', async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      const { FrameManager } = await import('../core/context/frame-manager');
      const mockFrameManager = FrameManager as Mock;
      mockFrameManager.mockImplementation(() => {
        throw new Error('Context test error');
      });

      process.argv = ['node', 'stackmemory', 'context:test'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ Test failed:', 'Context test error');
    });

    it('should show warning when not initialized', async () => {
      rmSync(join(tempDir, '.stackmemory'), { recursive: true });

      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      process.argv = ['node', 'stackmemory', 'context:test'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith(
        '❌ StackMemory not initialized. Run "stackmemory init" first.'
      );
    });
  });

  describe('update-check command', () => {
    beforeEach(async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');
    });

    it('should check for updates', async () => {
      const { UpdateChecker } = await import('../core/utils/update-checker');
      UpdateChecker.forceCheck = vi.fn().mockResolvedValue(undefined);

      process.argv = ['node', 'stackmemory', 'update-check'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('🔍 Checking for updates...');
      expect(UpdateChecker.forceCheck).toHaveBeenCalled();
    });

    it('should handle update check errors', async () => {
      const { UpdateChecker } = await import('../core/utils/update-checker');
      UpdateChecker.forceCheck = vi.fn().mockRejectedValue(new Error('Update check failed'));

      process.argv = ['node', 'stackmemory', 'update-check'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ Update check failed:', 'Update check failed');
    });
  });

  describe('progress command', () => {
    beforeEach(() => {
      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');
    });

    it('should show progress summary', async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      process.argv = ['node', 'stackmemory', 'progress'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('Progress summary');
    });

    it('should handle progress errors', async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      const { ProgressTracker } = await import('../core/monitoring/progress-tracker');
      const mockProgressTracker = ProgressTracker as Mock;
      mockProgressTracker.mockImplementation(() => ({
        getSummary: vi.fn(() => {
          throw new Error('Progress error');
        })
      }));

      process.argv = ['node', 'stackmemory', 'progress'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ Failed to show progress:', 'Progress error');
    });

    it('should show warning when not initialized', async () => {
      rmSync(join(tempDir, '.stackmemory'), { recursive: true });

      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      process.argv = ['node', 'stackmemory', 'progress'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith(
        '❌ StackMemory not initialized. Run "stackmemory init" first.'
      );
    });
  });

  describe('mcp-server command', () => {
    beforeEach(async () => {
      delete require.cache[require.resolve('../index.ts')];
    });

    it('should start MCP server with default options', async () => {
      // Mock the MCP server module
      vi.doMock('../integrations/mcp/server.js', () => ({
        runMCPServer: vi.fn().mockResolvedValue(undefined)
      }));

      await import('../index.ts');

      process.argv = ['node', 'stackmemory', 'mcp-server'];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith('🚀 Starting StackMemory MCP Server...');
      expect(process.env.PROJECT_ROOT).toBe(tempDir);
    });

    it('should start MCP server with custom project path', async () => {
      const customPath = '/custom/project/path';

      vi.doMock('../integrations/mcp/server.js', () => ({
        runMCPServer: vi.fn().mockResolvedValue(undefined)
      }));

      await import('../index.ts');

      process.argv = ['node', 'stackmemory', 'mcp-server', '--project', customPath];
      
      await program.parseAsync();

      expect(consoleSpy.log).toHaveBeenCalledWith(`   Project: ${customPath}`);
      expect(process.env.PROJECT_ROOT).toBe(customPath);
    });

    it('should handle MCP server errors', async () => {
      vi.doMock('../integrations/mcp/server.js', () => ({
        runMCPServer: vi.fn().mockRejectedValue(new Error('MCP server error'))
      }));

      await import('../index.ts');

      process.argv = ['node', 'stackmemory', 'mcp-server'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ MCP server failed:', 'MCP server error');
    });
  });

  describe('Command registration', () => {
    it('should register all command modules', async () => {
      const registerProjectCommands = (await import('./commands/projects')).registerProjectCommands;
      const registerLinearCommands = (await import('./commands/linear')).registerLinearCommands;
      const registerLinearTestCommand = (await import('./commands/linear-test')).registerLinearTestCommand;
      const createSessionCommands = (await import('./commands/session')).createSessionCommands;
      const registerWorktreeCommands = (await import('./commands/worktree')).registerWorktreeCommands;
      const registerOnboardingCommand = (await import('./commands/onboard')).registerOnboardingCommand;
      const webhookCommand = (await import('./commands/webhook')).webhookCommand;

      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      expect(registerProjectCommands).toHaveBeenCalledWith(expect.any(Object));
      expect(registerLinearCommands).toHaveBeenCalledWith(expect.any(Object));
      expect(registerLinearTestCommand).toHaveBeenCalledWith(expect.any(Object));
      expect(createSessionCommands).toHaveBeenCalledWith(expect.any(Object));
      expect(registerWorktreeCommands).toHaveBeenCalledWith(expect.any(Object));
      expect(registerOnboardingCommand).toHaveBeenCalledWith(expect.any(Object));
      expect(webhookCommand).toHaveBeenCalled();
    });
  });

  describe('Error handling and edge cases', () => {
    beforeEach(async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');
    });

    it('should handle missing command arguments gracefully', async () => {
      process.argv = ['node', 'stackmemory'];
      
      await program.parseAsync();
      
      // Should not throw error and should show help
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it('should handle unknown commands gracefully', async () => {
      process.argv = ['node', 'stackmemory', 'unknown-command'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        // Commander will handle unknown commands
        expect(error.name).toBe('CommanderError');
      }
    });

    it('should handle interrupted operations gracefully', async () => {
      const { FrameManager } = await import('../core/context/frame-manager');
      const mockFrameManager = FrameManager as Mock;
      
      // Simulate an interruption during initialization
      mockFrameManager.mockImplementation(() => {
        const error = new Error('Operation interrupted') as Error & { code: string };
        error.code = 'EINT';
        throw error;
      });

      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');

      process.argv = ['node', 'stackmemory', 'status'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }
    });

    it('should validate command options properly', async () => {
      process.argv = ['node', 'stackmemory', 'linear', 'sync', '--direction', 'invalid-direction'];
      
      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');

      // Should handle invalid option values gracefully
      await program.parseAsync();
    });

    it('should handle environment variable issues', async () => {
      // Test with missing environment variables
      delete process.env.HOME;
      delete process.env.USER;
      
      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');

      process.argv = ['node', 'stackmemory', 'status'];
      
      // Should still work despite missing env vars
      await program.parseAsync();
      
      expect(consoleSpy.log).toHaveBeenCalledWith('📊 StackMemory Status:');
    });
  });

  describe('Integration with external services', () => {
    beforeEach(() => {
      const dbDir = join(tempDir, '.stackmemory');
      mkdirSync(dbDir, { recursive: true });
      writeFileSync(join(dbDir, 'context.db'), '');
    });

    it('should handle network failures in Linear integration', async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      const { LinearSyncEngine } = await import('../integrations/linear/sync');
      const mockSyncEngine = LinearSyncEngine as Mock;
      mockSyncEngine.mockImplementation(() => ({
        sync: vi.fn().mockRejectedValue(new Error('Network timeout'))
      }));

      const { LinearAuthManager } = await import('../integrations/linear/auth');
      const mockAuthManager = LinearAuthManager as Mock;
      mockAuthManager.mockImplementation(() => ({
        isConfigured: vi.fn(() => true)
      }));

      process.argv = ['node', 'stackmemory', 'linear', 'sync'];
      
      try {
        await program.parseAsync();
      } catch (error) {
        expect(error.message).toBe('process.exit() called');
      }

      expect(consoleSpy.error).toHaveBeenCalledWith('❌ Sync failed:', 'Network timeout');
    });

    it('should handle file system permission issues', async () => {
      delete require.cache[require.resolve('../index.ts')];
      await import('../index.ts');

      // Mock fs operations to throw permission errors
      const originalWriteFileSync = require('fs').writeFileSync;
      require('fs').writeFileSync = vi.fn(() => {
        const error = new Error('Permission denied') as Error & { code: string };
        error.code = 'EACCES';
        throw error;
      });

      try {
        process.argv = ['node', 'stackmemory', 'init'];
        
        try {
          await program.parseAsync();
        } catch (error) {
          expect(error.message).toBe('process.exit() called');
        }
      } finally {
        require('fs').writeFileSync = originalWriteFileSync;
      }
    });
  });
});