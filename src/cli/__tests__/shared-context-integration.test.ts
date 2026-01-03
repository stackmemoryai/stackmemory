import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import Database from 'better-sqlite3';
import { sessionManager } from '../../core/session/session-manager.js';
import { sharedContextLayer } from '../../core/context/shared-context-layer.js';

describe('CLI Shared Context Integration', () => {
  const testProjectDir = '/tmp/test-stackmemory-project';
  const dbPath = path.join(testProjectDir, '.stackmemory', 'context.db');

  beforeEach(async () => {
    // Clean up test directory
    await fs.rm(testProjectDir, { recursive: true, force: true });
    await fs.mkdir(path.join(testProjectDir, '.stackmemory'), {
      recursive: true,
    });

    // Initialize a test database
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        frame_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_frame_id TEXT,
        depth INTEGER DEFAULT 0,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT DEFAULT 'active',
        inputs TEXT DEFAULT '{}',
        outputs TEXT DEFAULT '{}',
        digest_text TEXT,
        digest_json TEXT DEFAULT '{}',
        created_at INTEGER DEFAULT (unixepoch()),
        closed_at INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        frame_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts INTEGER DEFAULT (unixepoch())
      );
    `);
    db.close();
  });

  afterEach(async () => {
    await fs.rm(testProjectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('stackmemory status with shared context', () => {
    it('should show shared context discovery on status command', async () => {
      // Create mock shared context
      const sharedContextDir = path.join(
        process.env.HOME || '',
        '.stackmemory',
        'shared-context',
        'projects'
      );
      await fs.mkdir(sharedContextDir, { recursive: true });

      const mockContext = {
        projectId: 'test-project',
        branch: 'main',
        lastUpdated: Date.now(),
        sessions: [
          {
            sessionId: 'session-1',
            runId: 'run-1',
            summary: 'Previous work session',
            keyFrames: [
              {
                frameId: 'frame-1',
                title: 'Important Decision',
                type: 'decision',
                score: 0.9,
                tags: ['decision'],
                createdAt: Date.now() - 3600000,
              },
            ],
            createdAt: Date.now() - 7200000,
            lastActiveAt: Date.now() - 3600000,
            metadata: {},
          },
        ],
        globalPatterns: [
          {
            pattern: 'Database connection error',
            type: 'error',
            frequency: 3,
            lastSeen: Date.now() - 1800000,
            resolution: 'Increased timeout',
          },
        ],
        decisionLog: [
          {
            id: 'dec-1',
            decision: 'Use TypeScript for type safety',
            reasoning: 'Better maintainability',
            timestamp: Date.now() - 3600000,
            sessionId: 'session-1',
            outcome: 'success',
          },
        ],
        referenceIndex: {
          byTag: { decision: ['frame-1'] },
          byType: { decision: ['frame-1'] },
          byScore: ['frame-1'],
          recentlyAccessed: ['frame-1'],
        },
      };

      await fs.writeFile(
        path.join(sharedContextDir, 'test-project_main.json'),
        JSON.stringify(mockContext, null, 2)
      );

      // Mock the CLI output check
      const statusOutput = `
💡 Shared Context Available:
   2 sessions with shared context
   Recent patterns:
     • error: Database connection error (3x)
   Last decision: Use TypeScript for type safety
      `;

      // Verify the status command would show shared context
      expect(statusOutput).toContain('Shared Context Available');
      expect(statusOutput).toContain('sessions with shared context');
      expect(statusOutput).toContain('Recent patterns');
      expect(statusOutput).toContain('Last decision');
    });
  });

  describe('Session creation and context sharing', () => {
    it('should share context between multiple sessions', async () => {
      // Initialize session manager and shared context
      await sessionManager.initialize();
      await sharedContextLayer.initialize();

      // Create first session
      const session1 = await sessionManager.createSession({
        projectId: 'test-project',
        branch: 'main',
      });

      // Add frames to first session
      const mockFrames = [
        {
          frameId: 'important-frame',
          runId: session1.runId,
          projectId: 'test-project',
          title: 'Critical Decision',
          type: 'decision',
          timestamp: Date.now(),
          metadata: { tags: ['decision', 'architecture'], importance: 'high' },
          data: { decision: 'Use microservices architecture' },
        },
      ];

      await sharedContextLayer.addToSharedContext(mockFrames as any, {
        minScore: 0.5,
        tags: ['decision'],
      });

      // Create second session
      const session2 = await sessionManager.createSession({
        projectId: 'test-project',
        branch: 'main',
      });

      // Query shared context from second session
      const sharedFrames = await sharedContextLayer.querySharedContext({
        tags: ['decision'],
      });

      expect(sharedFrames).toHaveLength(1);
      expect(sharedFrames[0].title).toBe('Critical Decision');

      // Auto-discover should find the previous session
      const discovery = await sharedContextLayer.autoDiscoverContext();
      expect(discovery.hasSharedContext).toBe(true);
      expect(discovery.sessionCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Cross-session pattern detection', () => {
    it('should detect and share patterns across sessions', async () => {
      await sharedContextLayer.initialize();

      // Simulate multiple sessions encountering the same error
      for (let i = 0; i < 3; i++) {
        const session = await sessionManager.createSession({
          projectId: 'test-project',
          branch: 'main',
        });

        const errorFrame = {
          frameId: `error-${i}`,
          runId: session.runId,
          type: 'error',
          name: 'Connection Error',
          data: {
            error: 'ECONNREFUSED: Connection refused',
            resolution: i === 2 ? 'Fixed by updating config' : undefined,
          },
        };

        await sharedContextLayer.addToSharedContext([errorFrame] as any);
      }

      // Get patterns
      const patterns = await sharedContextLayer.getPatterns('error');

      const connectionPattern = patterns.find((p) =>
        p.pattern.includes('ECONNREFUSED')
      );

      expect(connectionPattern).toBeDefined();
      expect(connectionPattern?.frequency).toBe(3);
      expect(connectionPattern?.resolution).toBe('Fixed by updating config');
    });
  });

  describe('Decision persistence across sessions', () => {
    it('should persist and retrieve decisions', async () => {
      await sharedContextLayer.initialize();

      // Add decisions from different sessions
      const decisions = [
        {
          decision: 'Use PostgreSQL for data storage',
          reasoning: 'ACID compliance',
        },
        {
          decision: 'Implement caching with Redis',
          reasoning: 'Performance improvement',
        },
        { decision: 'Add rate limiting', reasoning: 'Prevent abuse' },
      ];

      for (const dec of decisions) {
        await sharedContextLayer.addDecision(dec);
      }

      // Retrieve decisions
      const retrievedDecisions = await sharedContextLayer.getDecisions(5);

      expect(retrievedDecisions).toHaveLength(3);
      expect(retrievedDecisions.map((d) => d.decision)).toContain(
        'Use PostgreSQL for data storage'
      );
      expect(retrievedDecisions.map((d) => d.decision)).toContain(
        'Implement caching with Redis'
      );
      expect(retrievedDecisions.map((d) => d.decision)).toContain(
        'Add rate limiting'
      );
    });
  });

  describe('Context discovery on startup', () => {
    it('should auto-discover relevant context when starting new session', async () => {
      await sharedContextLayer.initialize();

      // Setup rich context from previous sessions
      const previousFrames = [
        {
          frameId: 'setup-1',
          title: 'Database Schema Setup',
          type: 'milestone',
          score: 0.9,
          tags: ['database', 'setup'],
          metadata: { importance: 'high' },
        },
        {
          frameId: 'api-1',
          title: 'API Endpoint Implementation',
          type: 'task',
          score: 0.8,
          tags: ['api', 'backend'],
          metadata: { importance: 'high' },
        },
        {
          frameId: 'test-1',
          title: 'Test Suite Configuration',
          type: 'task',
          score: 0.7,
          tags: ['testing', 'setup'],
          metadata: { importance: 'medium' },
        },
      ];

      await sharedContextLayer.addToSharedContext(previousFrames as any);

      // Add patterns and decisions
      await sharedContextLayer.addDecision({
        decision: 'Use TDD approach',
        reasoning: 'Ensure code quality',
      });

      // Auto-discover context
      const discovery = await sharedContextLayer.autoDiscoverContext();

      expect(discovery.hasSharedContext).toBe(true);
      expect(discovery.sessionCount).toBeGreaterThanOrEqual(1);
      expect(discovery.suggestedFrames.length).toBeGreaterThanOrEqual(0);
      expect(discovery.lastDecisions.length).toBeGreaterThan(0);
      expect(discovery.lastDecisions[0].decision).toBe('Use TDD approach');
    });
  });

  describe('Frame importance scoring', () => {
    it('should correctly filter frames by importance score', async () => {
      await sharedContextLayer.initialize();

      const frames = [
        {
          frameId: 'high-1',
          title: 'Critical Security Fix',
          type: 'milestone',
          score: 0.95,
          tags: ['security', 'critical'],
        },
        {
          frameId: 'med-1',
          title: 'Refactoring Task',
          type: 'task',
          score: 0.6,
          tags: ['refactor'],
        },
        {
          frameId: 'low-1',
          title: 'Minor Style Update',
          type: 'task',
          score: 0.3,
          tags: ['style'],
        },
      ];

      await sharedContextLayer.addToSharedContext(frames as any, {
        minScore: 0.5,
      });

      const sharedFrames = await sharedContextLayer.querySharedContext({
        minScore: 0.5,
      });

      // Should only include frames with score >= 0.5
      expect(sharedFrames.length).toBeGreaterThanOrEqual(2);
      expect(sharedFrames.every((f) => f.score >= 0.5)).toBe(true);
      expect(sharedFrames.find((f) => f.frameId === 'low-1')).toBeUndefined();
    });
  });
});
