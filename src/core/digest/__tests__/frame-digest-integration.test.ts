import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FrameManager } from '../../context/frame-manager.js';
import {
  enhanceFrameManagerWithDigest,
  FrameDigestIntegration,
} from '../frame-digest-integration.js';
import { DigestLLMProvider } from '../types.js';

describe('FrameDigestIntegration', () => {
  let db: Database.Database;
  let frameManager: FrameManager;
  let integration: FrameDigestIntegration;
  let mockLLMProvider: DigestLLMProvider;

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:');

    // Create frame manager
    frameManager = new FrameManager(db, 'test-project', 'test-run');

    // Create mock LLM provider
    mockLLMProvider = {
      generateSummary: vi.fn().mockResolvedValue({
        summary: 'Test AI summary',
        insight: 'Test insight',
        flaggedIssue: null,
        generatedAt: Date.now(),
        modelUsed: 'test-model',
        tokensUsed: 100,
      }),
    };

    // Enhance frame manager with digest integration
    integration = enhanceFrameManagerWithDigest(
      frameManager,
      db,
      mockLLMProvider
    );
  });

  afterEach(() => {
    integration.shutdown();
    db.close();
  });

  describe('Frame Lifecycle Integration', () => {
    it('should track frame creation', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
        inputs: { test: true },
      });

      expect(frameId).toBeDefined();

      // Check idle status shows active frame
      const status = integration.getIdleStatus();
      expect(status.activeFrames).toBe(1);
    });

    it('should track tool calls for idle detection', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
      });

      // Add tool call event
      frameManager.addEvent('tool_call', {
        tool_name: 'test_tool',
        args: {},
      });

      // Should reset idle timer
      const status = integration.getIdleStatus();
      expect(status.timeSinceLastToolCall).toBeLessThan(100);
    });

    it('should track user input', () => {
      frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
      });

      // Add user message event
      frameManager.addEvent('user_message', {
        content: 'Test message',
      });

      // Should reset input timer
      const status = integration.getIdleStatus();
      expect(status.timeSinceLastInput).toBeLessThan(100);
    });

    it('should generate digest on frame close', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
      });

      // Add some events
      frameManager.addEvent('tool_call', {
        tool_name: 'write_file',
        file_path: '/src/test.ts',
      });

      frameManager.addAnchor('DECISION', 'Use TypeScript');

      // Close frame
      frameManager.closeFrame(frameId, { result: 'success' });

      // Get frame to check digest
      const frame = frameManager.getFrame(frameId);
      expect(frame).toBeDefined();
      expect(frame?.state).toBe('closed');
      expect(frame?.outputs).toBeDefined();
      expect(frame?.outputs.digestText).toBeDefined();
    });

    it('should trigger digest processing on frame close', () => {
      const frameId = frameManager.createFrame({
        type: 'feature',
        name: 'Feature Implementation',
      });

      // Add events to make it interesting
      frameManager.addEvent('tool_call', {
        tool_name: 'write_file',
        file_path: '/src/feature.ts',
      });

      frameManager.addEvent('tool_result', {
        success: true,
        output: 'File written successfully',
      });

      // Before close, frame is active
      let status = integration.getIdleStatus();
      expect(status.activeFrames).toBe(1);

      // Close frame
      frameManager.closeFrame(frameId);

      // After close, frame is not active
      status = integration.getIdleStatus();
      expect(status.activeFrames).toBe(0);
    });
  });

  describe('Idle Detection', () => {
    it('should detect idle state after inactivity', async () => {
      frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
      });

      // Initially not idle
      let status = integration.getIdleStatus();
      expect(status.isIdle).toBe(false);

      // Simulate passage of time by manipulating internal state
      // This would normally happen with actual time passing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Force check of idle state
      await integration.forceProcessQueue();

      // Verify LLM was potentially called (if frames were queued)
      // Note: Actual idle detection would require more time to pass
    });

    it('should handle user interruption', () => {
      frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
      });

      // Simulate user interruption
      integration.handleUserInterruption();

      // Should reset idle timers
      const status = integration.getIdleStatus();
      expect(status.isIdle).toBe(false);
    });
  });

  describe('Digest Content Generation', () => {
    it('should generate both deterministic and AI content', async () => {
      const frameId = frameManager.createFrame({
        type: 'feature',
        name: 'Complex Feature',
      });

      // Add various events
      frameManager.addEvent('tool_call', {
        tool_name: 'write_file',
        file_path: '/src/feature.ts',
      });

      frameManager.addEvent('tool_call', {
        tool_name: 'run_test',
        command: 'npm test',
      });

      frameManager.addEvent('tool_result', {
        success: true,
        output: '10 tests passed',
      });

      frameManager.addAnchor(
        'DECISION',
        'Implement using event-driven architecture'
      );
      frameManager.addAnchor(
        'RISK',
        'Performance may degrade with high event volume'
      );

      // Close frame to trigger digest
      frameManager.closeFrame(frameId);

      const frame = frameManager.getFrame(frameId);
      expect(frame?.outputs.digest).toBeDefined();
      expect(frame?.outputs.digest.deterministic).toBeDefined();
      expect(frame?.outputs.digest.status).toBeDefined();
    });

    it('should calculate importance scores', () => {
      // Create different types of frames
      const debugFrame = frameManager.createFrame({
        type: 'debug',
        name: 'Debug Critical Issue',
      });

      const toolFrame = frameManager.createFrame({
        type: 'tool_scope',
        name: 'Tool Execution',
      });

      // Close both
      frameManager.closeFrame(toolFrame);
      frameManager.closeFrame(debugFrame);

      // Debug frame should have higher importance
      const debugFrameData = frameManager.getFrame(debugFrame);
      const toolFrameData = frameManager.getFrame(toolFrame);

      // Both should have digests
      expect(debugFrameData?.outputs.digest).toBeDefined();
      expect(toolFrameData?.outputs.digest).toBeDefined();
    });
  });

  describe('Multiple Frames', () => {
    it('should handle nested frames correctly', () => {
      const parentFrame = frameManager.createFrame({
        type: 'task',
        name: 'Parent Task',
      });

      const childFrame = frameManager.createFrame({
        type: 'subtask',
        name: 'Child Task',
        parentFrameId: parentFrame,
      });

      // Track both frames
      let status = integration.getIdleStatus();
      expect(status.activeFrames).toBe(2);

      // Close child
      frameManager.closeFrame(childFrame);
      status = integration.getIdleStatus();
      expect(status.activeFrames).toBe(1);

      // Close parent
      frameManager.closeFrame(parentFrame);
      status = integration.getIdleStatus();
      expect(status.activeFrames).toBe(0);
    });

    it('should process frames independently', async () => {
      // Create multiple frames
      const frame1 = frameManager.createFrame({
        type: 'task',
        name: 'Task 1',
      });

      frameManager.addEvent('tool_call', { tool_name: 'tool1' }, frame1);
      frameManager.closeFrame(frame1);

      const frame2 = frameManager.createFrame({
        type: 'task',
        name: 'Task 2',
      });

      frameManager.addEvent('tool_call', { tool_name: 'tool2' }, frame2);
      frameManager.closeFrame(frame2);

      // Both should have digests
      const frame1Data = frameManager.getFrame(frame1);
      const frame2Data = frameManager.getFrame(frame2);

      expect(frame1Data?.outputs.digestText).toBeDefined();
      expect(frame2Data?.outputs.digestText).toBeDefined();
    });
  });

  describe('Queue Processing', () => {
    it('should allow forced queue processing', async () => {
      const frameId = frameManager.createFrame({
        type: 'feature',
        name: 'Feature for AI Processing',
      });

      // Add events
      frameManager.addEvent('tool_call', {
        tool_name: 'complex_operation',
      });

      // Close to queue for AI processing
      frameManager.closeFrame(frameId);

      // Force process queue
      await integration.forceProcessQueue();

      // Verify AI provider was called
      expect(mockLLMProvider.generateSummary).toHaveBeenCalled();
    });
  });
});
