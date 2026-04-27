/**
 * End-to-End Full Session Lifecycle Tests
 * Tests complete user workflows from initialization to handoff
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestEnvironment,
  TestSession,
  ActivityRecord,
} from '../helpers/test-environment.js';
import {
  generateTestFrames,
  generateSearchQueries,
} from '../fixtures/test-data-generator.js';

describe('Full Session Lifecycle', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await TestEnvironment.create('e2e-test-project');
    await env.initializeProject();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('should handle complete development session', async () => {
    // Step 1: Initialize project
    const project = await env.createProject('test-app');
    expect(project.id).toContain('e2e-test-project');
    expect(project.path).toContain('test-app');

    // Step 2: Start development session
    const session = await env.startSession('dev-session-1');
    expect(session).toBeDefined();
    expect(session.frameManager).toBeDefined();
    // sharedContext was removed in v1.11.0

    // Step 3: Record development activities
    const activities: ActivityRecord[] = [
      { type: 'file_edit', file: 'src/app.ts' },
      { type: 'test_run', status: 'fail' },
      { type: 'file_edit', file: 'src/app.ts' },
      { type: 'test_run', status: 'pass' },
      { type: 'commit', message: 'Fix test failures' },
    ];

    const frameIds = await session.recordActivity(activities);
    expect(frameIds).toHaveLength(5);

    // Step 4: Save context before clear
    const savedContext = await session.saveContext();
    expect(savedContext.frames).toHaveLength(5);
    expect(savedContext.sessionId).toBe('dev-session-1');

    // Step 5: Simulate Claude clear
    await env.simulateClear();

    // Step 6: Restore context after clear
    const restoredContext = await env.restoreContext('dev-session-1');
    expect(restoredContext.frames).toHaveLength(5);
    expect(restoredContext.sessionId).toBe('dev-session-1');

    // Verify frame content preserved
    const firstFrame = restoredContext.frames[0];
    expect(firstFrame.name).toContain('Edit');
    expect(firstFrame.type).toBe('operation');

    // Step 7: Generate handoff document
    const handoff = await session.generateHandoff();
    expect(handoff).toContain('# Session Handoff');
    expect(handoff).toContain('Session ID: dev-session-1');
    expect(handoff).toContain('Total Frames: 5');
    expect(handoff).toContain('Fix test failures');
  });

  it('should handle multi-session collaboration', async () => {
    // Session A creates context
    const sessionA = await env.startSession('session-a');
    await sessionA.recordActivity([
      { type: 'file_edit', file: 'api.ts' },
      { type: 'command', command: 'npm test' },
    ]);

    const contextA = await sessionA.saveContext();
    expect(contextA.frames).toHaveLength(2);

    // Session B reads and extends context
    const sessionB = await env.startSession('session-b');

    // Session B should be able to query Session A's frames
    const retriever = sessionB.retriever;
    const searchResult = await retriever.retrieveContext({
      text: 'api.ts',
      maxResults: 5,
    });

    expect(searchResult.contexts.length).toBeGreaterThan(0);
    expect(searchResult.contexts[0].frame.name).toContain('api.ts');

    // Session B adds more work
    await sessionB.recordActivity([
      { type: 'file_edit', file: 'api.test.ts' },
      { type: 'test_run', status: 'pass' },
    ]);

    const contextB = await sessionB.saveContext();
    expect(contextB.frames.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle error recovery workflow', async () => {
    const session = await env.startSession('error-recovery');

    // Simulate error scenario
    const activities: ActivityRecord[] = [
      { type: 'command', command: 'npm run build' },
      { type: 'error', error: 'Build failed: TypeScript errors' },
      { type: 'file_edit', file: 'src/types.ts' },
      { type: 'command', command: 'npm run build' },
      { type: 'test_run', status: 'pass' },
    ];

    const frameIds = await session.recordActivity(activities);

    // Verify error was recorded
    const db = await env.getDatabase();
    const errorFrame = await db.getFrame(frameIds[1]);
    expect(errorFrame?.type).toBe('error');
    expect(errorFrame?.state).toBe('error');

    // Search for error patterns
    const errorSearch = await session.retriever.retrieveContext({
      text: 'build failed',
      maxResults: 10,
    });

    expect(errorSearch.contexts.length).toBeGreaterThan(0);
    expect(errorSearch.contexts[0].frame.digest_text).toContain('Build failed');

    // Generate handoff should include error context
    const handoff = await session.generateHandoff();
    expect(handoff).toContain('[error]');
    expect(handoff).toContain('Build failed');
  });

  it('should handle large session with many frames', async () => {
    const session = await env.startSession('large-session');
    const db = await env.getDatabase();

    // Generate many activities
    const activities: ActivityRecord[] = [];
    for (let i = 0; i < 100; i++) {
      activities.push({
        type: i % 10 === 0 ? 'test_run' : 'file_edit',
        file: `src/file${i}.ts`,
        status: i % 3 === 0 ? 'fail' : 'pass',
      });
    }

    const frameIds = await session.recordActivity(activities);
    expect(frameIds).toHaveLength(100);

    // Test search performance
    const startTime = Date.now();
    const searchResult = await db.search({
      query: 'file',
      searchType: 'text',
      limit: 20,
    });
    const searchTime = Date.now() - startTime;

    expect(searchResult.length).toBeLessThanOrEqual(20);
    expect(searchTime).toBeLessThan(100); // Should be fast

    // Test context retrieval with large dataset
    const queries = generateSearchQueries();
    for (const query of queries.slice(0, 5)) {
      const result = await session.retriever.retrieveContext({
        text: query,
        maxResults: 10,
      });

      expect(result.retrievalTimeMs).toBeLessThan(200);
    }
  });

  it('should handle workflow transitions', async () => {
    const session = await env.startSession('workflow-test');

    // Start TDD workflow
    await session.recordActivity([
      { type: 'command', command: 'stackmemory workflow start tdd' },
      { type: 'file_edit', file: 'test/feature.test.ts' },
      { type: 'test_run', status: 'fail' },
      { type: 'file_edit', file: 'src/feature.ts' },
      { type: 'test_run', status: 'pass' },
      { type: 'file_edit', file: 'src/feature.ts' }, // Refactor
    ]);

    // Save workflow state
    const context = await session.saveContext();
    expect(context.frames).toHaveLength(6);

    // Verify workflow pattern detected
    const frames = context.frames;
    const hasTestFirst = frames.some(
      (f) => f.name.includes('test') && f.state === 'completed'
    );
    const hasImplementation = frames.some((f) => f.name.includes('feature.ts'));

    expect(hasTestFirst).toBe(true);
    expect(hasImplementation).toBe(true);
  });
});
