/**
 * Tests for ClaudeCodeAgentBridge
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClaudeCodeAgentBridge, CLAUDE_CODE_AGENTS } from '../agent-bridge.js';

// Mock child_process.spawn to avoid invoking real claude CLI
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('Mock swarm agent response'));
      proc.emit('close', 0);
    }, 50);
    return proc;
  }),
}));

// Mock the oracle-worker-pattern module
vi.mock('../../ralph/patterns/oracle-worker-pattern.js', () => ({
  OracleWorkerCoordinator: class MockCoordinator {
    constructor() {}
  },
}));

describe('CLAUDE_CODE_AGENTS', () => {
  it('should have consistent agent structure', () => {
    for (const [name, agent] of Object.entries(CLAUDE_CODE_AGENTS)) {
      expect(agent.name).toBe(name);
      expect(agent.type).toMatch(/^(oracle|worker|reviewer)$/);
      expect(agent.description).toBeDefined();
      expect(Array.isArray(agent.capabilities)).toBe(true);
      expect(agent.capabilities.length).toBeGreaterThan(0);
      expect(typeof agent.costMultiplier).toBe('number');
      expect(agent.complexity).toMatch(/^(low|medium|high|very_high)$/);
      expect(Array.isArray(agent.specializations)).toBe(true);
    }
  });

  it('should have oracle agents with higher cost multiplier', () => {
    const oracleAgents = Object.values(CLAUDE_CODE_AGENTS).filter(
      (a) => a.type === 'oracle'
    );
    const workerAgents = Object.values(CLAUDE_CODE_AGENTS).filter(
      (a) => a.type === 'worker'
    );

    const avgOracleCost =
      oracleAgents.reduce((sum, a) => sum + a.costMultiplier, 0) /
      oracleAgents.length;
    const avgWorkerCost =
      workerAgents.reduce((sum, a) => sum + a.costMultiplier, 0) /
      workerAgents.length;

    expect(avgOracleCost).toBeGreaterThan(avgWorkerCost);
  });
});

describe('ClaudeCodeAgentBridge', () => {
  let bridge: ClaudeCodeAgentBridge;

  beforeEach(() => {
    bridge = new ClaudeCodeAgentBridge();
  });

  describe('constructor', () => {
    it('should create bridge instance', () => {
      expect(bridge).toBeInstanceOf(ClaudeCodeAgentBridge);
    });
  });

  describe('getAvailableAgents', () => {
    it('should return agents grouped by type', () => {
      const agents = bridge.getAvailableAgents();

      expect(agents.oracles).toContain('staff-architect');
      expect(agents.oracles).toContain('product-manager');
      expect(agents.workers).toContain('general-purpose');
      expect(agents.workers).toContain('debugger');
      expect(agents.reviewers).toContain('code-reviewer');
    });

    it('should not mix agent types', () => {
      const agents = bridge.getAvailableAgents();

      // Verify oracles are only oracle type
      for (const oracleName of agents.oracles) {
        const agent = CLAUDE_CODE_AGENTS[oracleName];
        expect(agent.type).toBe('oracle');
      }

      // Verify workers are only worker type
      for (const workerName of agents.workers) {
        const agent = CLAUDE_CODE_AGENTS[workerName];
        expect(agent.type).toBe('worker');
      }

      // Verify reviewers are only reviewer type
      for (const reviewerName of agents.reviewers) {
        const agent = CLAUDE_CODE_AGENTS[reviewerName];
        expect(agent.type).toBe('reviewer');
      }
    });
  });

  describe('launchClaudeCodeSwarm', () => {
    it('should launch swarm with explicit agents', async () => {
      const swarmId = await bridge.launchClaudeCodeSwarm(
        'Test project description',
        {
          oracleAgent: 'staff-architect',
          workerAgents: ['general-purpose'],
          reviewerAgents: ['code-reviewer'],
        }
      );

      expect(swarmId).toBeDefined();
      expect(typeof swarmId).toBe('string');
    }, 30000);

    it('should throw for invalid oracle agent', async () => {
      await expect(
        bridge.launchClaudeCodeSwarm('Test', {
          oracleAgent: 'nonexistent-oracle',
          workerAgents: ['general-purpose'],
          reviewerAgents: ['code-reviewer'],
        })
      ).rejects.toThrow("Oracle agent 'nonexistent-oracle' not found");
    });

    it('should throw for invalid worker agent', async () => {
      await expect(
        bridge.launchClaudeCodeSwarm('Test', {
          oracleAgent: 'staff-architect',
          workerAgents: ['nonexistent-worker'],
          reviewerAgents: ['code-reviewer'],
        })
      ).rejects.toThrow("Worker agent 'nonexistent-worker' not found");
    });

    it('should throw when using wrong agent type', async () => {
      // Worker as oracle
      await expect(
        bridge.launchClaudeCodeSwarm('Test', {
          oracleAgent: 'general-purpose',
          workerAgents: ['debugger'],
          reviewerAgents: ['code-reviewer'],
        })
      ).rejects.toThrow('is not an Oracle-level agent');

      // Reviewer as worker
      await expect(
        bridge.launchClaudeCodeSwarm('Test', {
          oracleAgent: 'staff-architect',
          workerAgents: ['code-reviewer'],
          reviewerAgents: ['code-reviewer'],
        })
      ).rejects.toThrow('is not a Worker-level agent');
    });
  });
});
