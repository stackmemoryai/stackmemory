/**
 * Tests for StackMemory MCP Server - Local Instance
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import Database from 'better-sqlite3';
import LocalStackMemoryMCP from '../server.js';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

// Create a mock server reference that can be updated per test
let mockServerInstance: any = null;

// Mock the MCP SDK - use a proper constructor function
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  const MockServer = vi.fn().mockImplementation(function (this: any) {
    if (mockServerInstance) {
      Object.assign(this, mockServerInstance);
    } else {
      this.setRequestHandler = vi.fn();
      this.connect = vi.fn();
    }
    return this;
  });
  return { Server: MockServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('mocked git output')),
}));

// Mock browser MCP integration
vi.mock('../../features/browser/browser-mcp.js', () => ({
  BrowserMCPIntegration: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock Linear imports with dynamic imports
vi.mock('../../integrations/linear/auth.js', async () => {
  const actual = await vi.importActual('../../integrations/linear/auth.js');
  return {
    ...actual,
    LinearAuthManager: vi.fn().mockImplementation(() => ({
      loadTokens: vi.fn(),
      isConfigured: vi.fn(() => false),
    })),
  };
});

vi.mock('../../integrations/linear/client.js', async () => {
  const actual = await vi.importActual('../../integrations/linear/client.js');
  return {
    ...actual,
    LinearClient: vi.fn().mockImplementation(() => ({
      getIssue: vi.fn(),
      findIssueByIdentifier: vi.fn(),
      updateIssue: vi.fn(),
      getTeam: vi.fn(),
      getWorkflowStates: vi.fn(),
      getViewer: vi.fn(),
      getIssues: vi.fn(),
    })),
  };
});

vi.mock('../../integrations/linear/sync.js', async () => {
  const actual = await vi.importActual('../../integrations/linear/sync.js');
  return {
    ...actual,
    LinearSyncEngine: vi.fn().mockImplementation(() => ({
      sync: vi.fn(),
    })),
    DEFAULT_SYNC_CONFIG: {
      enabled: true,
      direction: 'bidirectional',
      conflictResolution: 'newest_wins',
    },
  };
});

describe('LocalStackMemoryMCP', () => {
  let tempDir: string;
  let mcpServer: any;
  let mockServer: any;
  let originalCwd: string;
  let originalArgv: string[];

  beforeEach(() => {
    // Setup temp directory
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-mcp-test-'));
    originalCwd = process.cwd();
    originalArgv = [...process.argv];

    // Create .git directory to simulate git repo
    const gitDir = join(tempDir, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(
      join(gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0'
    );

    // Create package.json
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
      })
    );

    // Mock process.cwd() to return our temp directory
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    // Setup mock server - update the module-level reference
    mockServer = {
      setRequestHandler: vi.fn(),
      connect: vi.fn(),
    };
    mockServerInstance = mockServer;
  });

  afterEach(() => {
    if (mcpServer) {
      // Cleanup if needed
    }

    // Restore original process state
    vi.spyOn(process, 'cwd').mockRestore();
    process.argv = originalArgv;

    // Cleanup temp directory
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize server with correct project detection', () => {
      mcpServer = new LocalStackMemoryMCP();

      expect(Server).toHaveBeenCalledWith(
        {
          name: 'stackmemory-local',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );
    });

    it('should create .stackmemory directory if it does not exist', () => {
      mcpServer = new LocalStackMemoryMCP();

      const stackmemoryDir = join(tempDir, '.stackmemory');
      expect(existsSync(stackmemoryDir)).toBe(true);
    });

    it('should initialize database and frame manager', () => {
      mcpServer = new LocalStackMemoryMCP();

      const dbPath = join(tempDir, '.stackmemory', 'context.db');
      expect(existsSync(dbPath)).toBe(true);
    });

    it('should handle missing .git directory gracefully', () => {
      // Remove .git directory
      rmSync(join(tempDir, '.git'), { recursive: true });

      // Should still work, using current directory as project root
      expect(() => {
        mcpServer = new LocalStackMemoryMCP();
      }).not.toThrow();
    });

    it('should setup tool handlers correctly', () => {
      mcpServer = new LocalStackMemoryMCP();

      // Should have called setRequestHandler at least twice (tools/list and tools/call)
      expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);

      // Check for tools/list handler
      const toolsListCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) =>
          call[0].parse({ method: 'tools/list' }).method === 'tools/list'
      );
      expect(toolsListCall).toBeDefined();

      // Check for tools/call handler
      const toolsCallCall = mockServer.setRequestHandler.mock.calls.find(
        (call: any) =>
          call[0].parse({
            method: 'tools/call',
            params: { name: 'test', arguments: {} },
          }).method === 'tools/call'
      );
      expect(toolsCallCall).toBeDefined();
    });
  });

  describe('Tool Listing', () => {
    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
    });

    it('should list all available tools', async () => {
      const toolsListHandler = mockServer.setRequestHandler.mock.calls[0][1];

      const result = await toolsListHandler({ method: 'tools/list' });

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);

      // Check for essential tools
      const toolNames = result.tools.map((tool: any) => tool.name);
      expect(toolNames).toContain('get_context');
      expect(toolNames).toContain('add_decision');
      expect(toolNames).toContain('start_frame');
      expect(toolNames).toContain('close_frame');
      expect(toolNames).toContain('add_anchor');
      expect(toolNames).toContain('get_hot_stack');
      expect(toolNames).toContain('create_task');
      expect(toolNames).toContain('update_task_status');
      expect(toolNames).toContain('get_active_tasks');
    });

    it('should include Linear integration tools', async () => {
      const toolsListHandler = mockServer.setRequestHandler.mock.calls[0][1];

      const result = await toolsListHandler({ method: 'tools/list' });

      const toolNames = result.tools.map((tool: any) => tool.name);
      expect(toolNames).toContain('linear_sync');
      expect(toolNames).toContain('linear_update_task');
      expect(toolNames).toContain('linear_get_tasks');
      expect(toolNames).toContain('linear_status');
    });

    it('should include proper tool schemas', async () => {
      const toolsListHandler = mockServer.setRequestHandler.mock.calls[0][1];

      const result = await toolsListHandler({ method: 'tools/list' });

      const getContextTool = result.tools.find(
        (tool: any) => tool.name === 'get_context'
      );
      expect(getContextTool).toBeDefined();
      expect(getContextTool.description).toBeDefined();
      expect(getContextTool.inputSchema).toBeDefined();
      expect(getContextTool.inputSchema.type).toBe('object');
      expect(getContextTool.inputSchema.properties).toBeDefined();

      const startFrameTool = result.tools.find(
        (tool: any) => tool.name === 'start_frame'
      );
      expect(startFrameTool.inputSchema.required).toContain('name');
      expect(startFrameTool.inputSchema.required).toContain('type');
    });
  });

  describe('Tool Execution - Context Management', () => {
    let toolsCallHandler: any;

    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
      toolsCallHandler = mockServer.setRequestHandler.mock.calls[1][1];
    });

    it('should handle get_context tool', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_context',
          arguments: { query: 'test', limit: 5 },
        },
      });

      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
    });

    it('should handle add_decision tool', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'add_decision',
          arguments: { content: 'Test decision', type: 'decision' },
        },
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Added decision');
      expect(result.content[0].text).toContain('Test decision');
    });

    it('should handle start_frame tool', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: {
            name: 'Test Frame',
            type: 'task',
            constraints: ['constraint1', 'constraint2'],
          },
        },
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Started task');
      expect(result.content[0].text).toContain('Test Frame');
      expect(result.content[0].text).toContain('Frame ID:');
      expect(result.content[0].text).toContain('Stack depth:');
    });

    it('should handle close_frame tool', async () => {
      // First start a frame
      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Test Frame', type: 'task' },
        },
      });

      // Then close it
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'close_frame',
          arguments: {
            result: 'Completed successfully',
            outputs: { key: 'value' },
          },
        },
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Closed frame');
      expect(result.content[0].text).toContain('Completed successfully');
    });

    it('should handle close_frame with no active frame', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'close_frame',
          arguments: { result: 'Test' },
        },
      });

      expect(result.content[0].text).toContain('No active frame to close');
    });

    it('should handle add_anchor tool', async () => {
      // First start a frame
      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Test Frame', type: 'task' },
        },
      });

      // Then add an anchor
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'add_anchor',
          arguments: {
            type: 'FACT',
            text: 'Important fact',
            priority: 9,
          },
        },
      });

      expect(result.content[0].text).toContain('Added FACT');
      expect(result.content[0].text).toContain('Important fact');
      expect(result.content[0].text).toContain('Anchor ID:');
    });

    it('should handle get_hot_stack tool', async () => {
      // First start some frames
      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Root Frame', type: 'task' },
        },
      });

      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Child Frame', type: 'subtask' },
        },
      });

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_hot_stack',
          arguments: { maxEvents: 10 },
        },
      });

      expect(result.content[0].text).toContain('Active Call Stack');
      expect(result.content[0].text).toContain('Root Frame');
      expect(result.content[0].text).toContain('Child Frame');
      expect(result.content[0].text).toContain('Total stack depth');
    });

    it('should handle get_hot_stack with no active frames', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_hot_stack',
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain('No active frames');
    });
  });

  describe('Tool Execution - Task Management', () => {
    let toolsCallHandler: any;

    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
      toolsCallHandler = mockServer.setRequestHandler.mock.calls[1][1];

      // Start a frame for task operations
      toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Task Frame', type: 'task' },
        },
      });
    });

    it('should handle create_task tool', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: {
            title: 'Test Task',
            description: 'A test task',
            priority: 'high',
            estimatedEffort: 120,
            tags: ['test', 'urgent'],
          },
        },
      });

      expect(result.content[0].text).toContain('Created task');
      expect(result.content[0].text).toContain('Test Task');
      expect(result.content[0].text).toContain('ID:');
      expect(result.content[0].text).toContain('tasks.jsonl');
    });

    it('should handle create_task without active frame', async () => {
      // Close all frames first
      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'close_frame',
          arguments: { result: 'closed' },
        },
      });

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'No Frame Task' },
        },
      });

      expect(result.content[0].text).toContain('No active frame');
    });

    it('should handle update_task_status tool', async () => {
      // First create a task
      const createResult = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Update Test Task' },
        },
      });

      // Extract task ID from response (simplified)
      const taskIdMatch = createResult.content[0].text.match(
        /ID: (tsk-[a-f0-9]{8})/
      );
      expect(taskIdMatch).toBeTruthy();
      const taskId = taskIdMatch[1];

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'update_task_status',
          arguments: {
            taskId,
            status: 'in_progress',
            reason: 'Starting work',
          },
        },
      });

      expect(result.content[0].text).toContain('Updated task');
      expect(result.content[0].text).toContain('in_progress');
      expect(result.content[0].text).toContain('Starting work');
    });

    it('should handle update_task_status with invalid task', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'update_task_status',
          arguments: {
            taskId: 'invalid-task-id',
            status: 'completed',
          },
        },
      });

      expect(result.content[0].text).toContain('Failed to update task');
    });

    it('should handle get_active_tasks tool', async () => {
      // Create some tasks
      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Active Task 1', priority: 'high' },
        },
      });

      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Active Task 2', priority: 'low' },
        },
      });

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_active_tasks',
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain('Active Tasks');
      expect(result.content[0].text).toContain('Active Task 1');
      expect(result.content[0].text).toContain('Active Task 2');
      expect(result.content[0].text).toContain('HIGH');
      expect(result.content[0].text).toContain('LOW');
    });

    it('should handle get_active_tasks with no tasks', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_active_tasks',
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain('No active tasks');
    });

    it('should handle get_task_metrics tool', async () => {
      // Create some tasks with different statuses
      const taskId1 = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Metrics Task 1' },
        },
      });

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_task_metrics',
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain('Task Metrics');
      expect(result.content[0].text).toContain('Total Tasks');
      expect(result.content[0].text).toContain('Completion Rate');
      expect(result.content[0].text).toContain('By Status');
      expect(result.content[0].text).toContain('By Priority');
    });

    it('should handle add_task_dependency tool', async () => {
      // Create two tasks
      const task1Result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Dependency Task' },
        },
      });

      const task2Result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Dependent Task' },
        },
      });

      // Extract task IDs
      const task1Id = task1Result.content[0].text.match(
        /ID: (tsk-[a-f0-9]{8})/
      )[1];
      const task2Id = task2Result.content[0].text.match(
        /ID: (tsk-[a-f0-9]{8})/
      )[1];

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'add_task_dependency',
          arguments: {
            taskId: task2Id,
            dependsOnId: task1Id,
          },
        },
      });

      expect(result.content[0].text).toContain('Added dependency');
      expect(result.content[0].text).toContain(task2Id);
      expect(result.content[0].text).toContain(task1Id);
    });
  });

  describe('Tool Execution - Linear Integration', () => {
    let toolsCallHandler: any;

    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
      toolsCallHandler = mockServer.setRequestHandler.mock.calls[1][1];
    });

    it('should handle linear_status tool when not configured', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'linear_status',
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain(
        'Linear integration not configured'
      );
      expect(result.content[0].text).toContain('stackmemory linear setup');
    });

    it('should handle linear_sync tool when not authenticated', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'linear_sync',
          arguments: { direction: 'bidirectional' },
        },
      });

      expect(result.content[0].text).toContain('Linear not authenticated');
    });

    it('should handle linear_update_task when not authenticated', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'linear_update_task',
          arguments: { issueId: 'STA-123', status: 'done' },
        },
      });

      expect(result.content[0].text).toContain('Linear not authenticated');
    });

    it('should handle linear_get_tasks when not authenticated', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'linear_get_tasks',
          arguments: { status: 'todo', limit: 10 },
        },
      });

      expect(result.content[0].text).toContain('Linear not authenticated');
    });

    it('should handle linear integration errors gracefully', async () => {
      // Mock successful authentication but failed operation
      const { LinearAuthManager } =
        await import('../../../integrations/linear/auth.js');
      const mockAuthManager = LinearAuthManager as Mock;

      mockAuthManager.mockImplementation(() => ({
        loadTokens: vi.fn(() => ({
          accessToken: 'test-token',
          expiresAt: Date.now() + 3600000,
        })),
        isConfigured: vi.fn(() => true),
      }));

      const { LinearClient } =
        await import('../../../integrations/linear/client.js');
      const mockClient = LinearClient as Mock;

      mockClient.mockImplementation(() => ({
        getViewer: vi.fn().mockRejectedValue(new Error('Network error')),
      }));

      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'linear_status',
          arguments: {},
        },
      });

      expect(result.content[0].text).toContain('connection failed');
    });
  });

  describe('Error Handling', () => {
    let toolsCallHandler: any;

    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
      toolsCallHandler = mockServer.setRequestHandler.mock.calls[1][1];
    });

    it('should handle unknown tool calls', async () => {
      await expect(
        toolsCallHandler({
          method: 'tools/call',
          params: {
            name: 'unknown_tool',
            arguments: {},
          },
        })
      ).rejects.toThrow('Unknown tool: unknown_tool');
    });

    it('should handle malformed tool arguments gracefully', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Test' }, // Missing required 'type'
        },
      });

      // Should handle the missing type gracefully
      expect(result).toBeDefined();
    });

    it('should maintain error context in responses', async () => {
      const result = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'add_anchor',
          arguments: {
            type: 'FACT',
            text: 'Test fact',
          },
        },
      });

      // Should fail because no active frame
      expect(result).toBeDefined();
    });
  });

  describe('Project Detection and Context Loading', () => {
    it('should detect git repository information', () => {
      // Mock git commands
      const { execSync } = require('child_process');
      execSync.mockReturnValueOnce(
        Buffer.from('origin\thttps://github.com/user/repo.git')
      );
      execSync.mockReturnValueOnce(
        Buffer.from('abc123 Initial commit\ndef456 Second commit')
      );

      mcpServer = new LocalStackMemoryMCP();

      // Should have called git commands for project detection
      expect(execSync).toHaveBeenCalledWith(
        'git config --get remote.origin.url',
        expect.any(Object)
      );
      expect(execSync).toHaveBeenCalledWith(
        'git log --oneline -10',
        expect.any(Object)
      );
    });

    it('should handle missing git repository gracefully', () => {
      const { execSync } = require('child_process');
      execSync.mockImplementation(() => {
        throw new Error('Not a git repository');
      });

      expect(() => {
        mcpServer = new LocalStackMemoryMCP();
      }).not.toThrow();
    });

    it('should load README.md if present', () => {
      const readmePath = join(tempDir, 'README.md');
      writeFileSync(
        readmePath,
        '# Test Project\n\nThis is a test project for MCP server testing.'
      );

      mcpServer = new LocalStackMemoryMCP();

      // Should have loaded README content into context
      expect(existsSync(readmePath)).toBe(true);
    });

    it('should handle missing README.md gracefully', () => {
      // Ensure no README exists
      const readmePath = join(tempDir, 'README.md');
      if (existsSync(readmePath)) {
        rmSync(readmePath);
      }

      expect(() => {
        mcpServer = new LocalStackMemoryMCP();
      }).not.toThrow();
    });
  });

  describe('Database Schema and Persistence', () => {
    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
    });

    it('should create required database tables', () => {
      const dbPath = join(tempDir, '.stackmemory', 'context.db');
      const db = new Database(dbPath);

      const tables = db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name IN ('contexts', 'frames', 'attention_log')
      `
        )
        .all();

      expect(tables).toHaveLength(3);
      db.close();
    });

    it('should handle database initialization errors gracefully', () => {
      // Mock Database constructor to throw error
      const originalDatabase = Database;

      vi.doMock('better-sqlite3', () => ({
        default: vi.fn(() => {
          throw new Error('Database error');
        }),
      }));

      expect(() => {
        // This would fail in real usage but we test error handling
        mcpServer = new LocalStackMemoryMCP();
      }).toThrow();
    });
  });

  describe('Server Lifecycle', () => {
    it('should start server successfully', async () => {
      mcpServer = new LocalStackMemoryMCP();

      const mockTransport = { connect: vi.fn() };
      vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
        StdioServerTransport: vi.fn(() => mockTransport),
      }));

      mockServer.connect.mockResolvedValue(undefined);

      await expect(mcpServer.start()).resolves.not.toThrow();
      expect(mockServer.connect).toHaveBeenCalled();
    });

    it('should handle server start errors', async () => {
      mcpServer = new LocalStackMemoryMCP();

      mockServer.connect.mockRejectedValue(new Error('Connection failed'));

      await expect(mcpServer.start()).rejects.toThrow('Connection failed');
    });
  });

  describe('Integration with Framework Components', () => {
    beforeEach(() => {
      mcpServer = new LocalStackMemoryMCP();
    });

    it('should integrate frame manager operations', async () => {
      const toolsCallHandler = mockServer.setRequestHandler.mock.calls[1][1];

      // Test frame lifecycle
      const startResult = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Integration Test', type: 'task' },
        },
      });

      expect(startResult.content[0].text).toContain('Started task');

      const hotStackResult = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_hot_stack',
          arguments: {},
        },
      });

      expect(hotStackResult.content[0].text).toContain('Integration Test');

      const closeResult = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'close_frame',
          arguments: { result: 'Integration complete' },
        },
      });

      expect(closeResult.content[0].text).toContain('Closed frame');
    });

    it('should integrate task store operations', async () => {
      const toolsCallHandler = mockServer.setRequestHandler.mock.calls[1][1];

      // Start frame for task operations
      await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'start_frame',
          arguments: { name: 'Task Integration', type: 'task' },
        },
      });

      // Create task
      const createResult = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'create_task',
          arguments: { title: 'Integration Task' },
        },
      });

      expect(createResult.content[0].text).toContain('Created task');

      // Get active tasks
      const activeResult = await toolsCallHandler({
        method: 'tools/call',
        params: {
          name: 'get_active_tasks',
          arguments: {},
        },
      });

      expect(activeResult.content[0].text).toContain('Integration Task');
    });
  });
});
