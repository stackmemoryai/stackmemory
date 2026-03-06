/**
 * Tests for ClaudeCodeTaskCoordinator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeCodeTaskCoordinator } from '../task-coordinator.js';
import { ClaudeCodeAgent } from '../agent-bridge.js';
import { EventEmitter } from 'events';

// Mock child_process.spawn to avoid invoking real claude CLI
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;

    // Create mock readable streams
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };

    // Simulate successful completion after a short delay
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('Mock agent response'));
      proc.emit('close', 0);
    }, 50);

    return proc;
  }),
}));

describe('ClaudeCodeTaskCoordinator', () => {
  let coordinator: ClaudeCodeTaskCoordinator;

  const mockWorkerAgent: ClaudeCodeAgent = {
    name: 'test-worker',
    type: 'worker',
    description: 'Test worker agent',
    capabilities: ['test_capability'],
    costMultiplier: 0.2,
    complexity: 'medium',
    specializations: ['testing'],
  };

  const mockOracleAgent: ClaudeCodeAgent = {
    name: 'test-oracle',
    type: 'oracle',
    description: 'Test oracle agent',
    capabilities: ['strategic_planning'],
    costMultiplier: 1.0,
    complexity: 'very_high',
    specializations: ['architecture'],
  };

  beforeEach(() => {
    coordinator = new ClaudeCodeTaskCoordinator();
  });

  afterEach(async () => {
    await coordinator.cleanup();
  });

  describe('constructor', () => {
    it('should create coordinator with initial metrics', () => {
      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics.totalTasks).toBe(0);
      expect(metrics.completedTasks).toBe(0);
      expect(metrics.failedTasks).toBe(0);
      expect(metrics.successRate).toBe(0);
    });
  });

  describe('executeTask', () => {
    it('should execute task successfully', async () => {
      const result = await coordinator.executeTask(
        'test-worker',
        mockWorkerAgent,
        'Test prompt',
        { maxRetries: 0, timeout: 10000 }
      );

      expect(result).toBe('Mock agent response');
    }, 15000);

    it('should track task in metrics', async () => {
      await coordinator.executeTask(
        'test-worker',
        mockWorkerAgent,
        'Test prompt',
        { maxRetries: 0, timeout: 10000 }
      );

      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics.totalTasks).toBe(1);
      expect(metrics.completedTasks).toBe(1);
    }, 15000);

    it('should track agent utilization', async () => {
      await coordinator.executeTask('test-worker', mockWorkerAgent, 'Task 1', {
        maxRetries: 0,
        timeout: 10000,
      });
      await coordinator.executeTask('test-worker', mockWorkerAgent, 'Task 2', {
        maxRetries: 0,
        timeout: 10000,
      });

      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics.agentUtilization['test-worker']).toBe(2);
    }, 15000);

    it('should calculate cost', async () => {
      await coordinator.executeTask(
        'test-worker',
        mockWorkerAgent,
        'Test prompt',
        { maxRetries: 0, timeout: 10000 }
      );

      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics.totalCost).toBeGreaterThanOrEqual(0);
    }, 15000);

    it('should pass --model opus for oracle agents', async () => {
      const { spawn } = await import('child_process');

      await coordinator.executeTask(
        'test-oracle',
        mockOracleAgent,
        'Strategic task',
        { maxRetries: 0, timeout: 10000 }
      );

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--model', 'opus']),
        expect.any(Object)
      );
    }, 15000);

    it('should pass code tools for code_implementation capability', async () => {
      const { spawn } = await import('child_process');
      const codeAgent: ClaudeCodeAgent = {
        ...mockWorkerAgent,
        capabilities: ['code_implementation'],
      };

      await coordinator.executeTask('code-worker', codeAgent, 'Write code', {
        maxRetries: 0,
        timeout: 10000,
      });

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '--allowedTools',
          'Edit,Write,Bash,Read,Glob,Grep',
        ]),
        expect.any(Object)
      );
    }, 15000);
  });

  describe('getCoordinationMetrics', () => {
    it('should return comprehensive metrics', async () => {
      await coordinator.executeTask(
        'test-worker',
        mockWorkerAgent,
        'Test task',
        { maxRetries: 0, timeout: 10000 }
      );

      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics).toMatchObject({
        totalTasks: expect.any(Number),
        completedTasks: expect.any(Number),
        failedTasks: expect.any(Number),
        averageExecutionTime: expect.any(Number),
        totalCost: expect.any(Number),
        successRate: expect.any(Number),
        agentUtilization: expect.any(Object),
        activeTasks: expect.any(Number),
        recentErrors: expect.any(Array),
        performanceTrend: expect.stringMatching(/improving|stable|degrading/),
      });
    }, 15000);

    it('should calculate success rate correctly', async () => {
      await coordinator.executeTask(
        'test-worker',
        mockWorkerAgent,
        'Success task',
        { maxRetries: 0, timeout: 10000 }
      );

      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics.successRate).toBe(1);
    }, 15000);
  });

  describe('getActiveTaskStatus', () => {
    it('should return empty array when no active tasks', () => {
      const status = coordinator.getActiveTaskStatus();

      expect(status).toEqual([]);
    });
  });

  describe('cancelTask', () => {
    it('should return false for non-existent task', async () => {
      const result = await coordinator.cancelTask('nonexistent-task');

      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should reset metrics', async () => {
      await coordinator.executeTask(
        'test-worker',
        mockWorkerAgent,
        'Pre-cleanup task',
        { maxRetries: 0, timeout: 10000 }
      );

      await coordinator.cleanup();

      const metrics = coordinator.getCoordinationMetrics();

      expect(metrics.totalTasks).toBe(0);
      expect(metrics.completedTasks).toBe(0);
    }, 15000);

    it('should clear active tasks', async () => {
      await coordinator.cleanup();

      const active = coordinator.getActiveTaskStatus();

      expect(active.length).toBe(0);
    }, 15000);
  });
});
