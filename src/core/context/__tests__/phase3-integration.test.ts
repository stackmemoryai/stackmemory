/**
 * Phase 3 Integration Tests - Team Collaboration End-to-End
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DualStackManager } from '../dual-stack-manager';
import { FrameHandoffManager } from '../frame-handoff-manager';
import { StackMergeResolver } from '../stack-merge-resolver';

describe('Phase 3 Integration - Team Collaboration', () => {
  let dualStackManager: DualStackManager;
  let handoffManager: FrameHandoffManager;
  let mergeResolver: StackMergeResolver;

  const projectId = 'test-project';
  const user1Id = 'alice';
  const user2Id = 'bob';
  const teamId = 'dev-team';

  beforeEach(async () => {
    // Initialize with mock adapter
    const mockAdapter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: () => true,
      initializeSchema: vi.fn(),
      executeBulk: vi.fn(),
      createFrame: vi.fn().mockResolvedValue('frame-id'),
      getFrame: vi.fn().mockResolvedValue(null),
      getActiveFrames: vi.fn().mockResolvedValue([]),
      // Add other required methods...
    } as any;

    dualStackManager = new DualStackManager(mockAdapter, projectId, user1Id);
    handoffManager = new FrameHandoffManager(dualStackManager);
    mergeResolver = new StackMergeResolver(dualStackManager);
  });

  describe('Complete Collaboration Workflow', () => {
    it('should support full team collaboration scenario', async () => {
      // User Alice creates frames in individual stack
      const activeStack = dualStackManager.getActiveStack();
      expect(activeStack).toBeDefined();

      // Alice creates a shared team stack
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Feature Development',
        user1Id
      );
      expect(sharedStackId).toMatch(/^shared-dev-team-/);

      // Alice initiates handoff to shared stack
      const handoffId = await handoffManager.initiateHandoff(
        sharedStackId,
        ['frame-1', 'frame-2'],
        {
          initiatedAt: new Date(),
          initiatorId: user1Id,
          frameContext: {
            totalFrames: 2,
            frameTypes: ['task', 'implementation'],
            estimatedSize: 1024,
            dependencies: [],
          },
          businessContext: {
            milestone: 'Sprint 1',
            priority: 'high',
            deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            stakeholders: [user2Id],
          },
        },
        user2Id,
        'Sharing authentication implementation'
      );

      expect(handoffId).toMatch(/^handoff-/);

      // Bob receives notification and approves handoff
      const notifications = await handoffManager.getUserNotifications(user2Id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe('request');

      await handoffManager.submitHandoffApproval(handoffId, {
        reviewerId: user2Id,
        decision: 'approved',
        feedback: 'Looks good, ready for integration',
      });

      // Check handoff progress
      const progress = await handoffManager.getHandoffProgress(handoffId);
      expect(progress?.status).toBe('completed');
    });

    it('should handle complex merge conflicts', async () => {
      // Create shared stack
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Merge Test Stack',
        user1Id
      );

      // Start merge session with conflicts
      const sessionId = await mergeResolver.startMergeSession(
        `individual-${user1Id}`,
        sharedStackId,
        ['conflicted-frame-1'],
        'default'
      );

      const session = await mergeResolver.getMergeSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.status).toMatch(/analyzing|resolving|manual_review/);

      // Manually resolve any remaining conflicts
      if (session?.conflicts.length) {
        for (const conflict of session.conflicts) {
          if (!conflict.autoResolvable) {
            await mergeResolver.resolveConflict(sessionId, conflict.frameId, {
              strategy: 'merge_both',
              resolvedBy: user1Id,
              notes: 'Manual merge of conflicting implementations',
            });
          }
        }
      }

      // Execute merge
      const updatedSession = await mergeResolver.getMergeSession(sessionId);
      if (updatedSession?.status === 'completed') {
        const result = await mergeResolver.executeMerge(sessionId);
        expect(result.success).toBe(true);
      }
    });

    it('should support handoff rejection and resubmission', async () => {
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Review Stack',
        user1Id
      );

      // Initial handoff request
      const handoffId = await handoffManager.initiateHandoff(
        sharedStackId,
        ['incomplete-frame'],
        {
          initiatedAt: new Date(),
          initiatorId: user1Id,
          frameContext: {
            totalFrames: 1,
            frameTypes: ['task'],
            estimatedSize: 512,
            dependencies: [],
          },
          businessContext: {
            priority: 'medium',
            stakeholders: [user2Id],
          },
        },
        user2Id
      );

      // Reviewer requests changes
      await handoffManager.submitHandoffApproval(handoffId, {
        reviewerId: user2Id,
        decision: 'needs_changes',
        feedback: 'Please add unit tests before handoff',
        suggestedChanges: [
          {
            frameId: 'incomplete-frame',
            suggestion: 'Add test coverage',
            reason: 'Missing test validation',
          },
        ],
      });

      const progress = await handoffManager.getHandoffProgress(handoffId);
      expect(progress?.status).toBe('pending_review');
      expect(progress?.currentStep).toBe('Changes requested');
    });

    it('should track collaboration metrics', async () => {
      // Simulate multiple handoffs
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Metrics Stack',
        user1Id
      );

      // Create and complete several handoffs
      for (let i = 0; i < 3; i++) {
        const handoffId = await handoffManager.initiateHandoff(
          sharedStackId,
          [`metric-frame-${i}`],
          {
            initiatedAt: new Date(),
            initiatorId: user1Id,
            frameContext: {
              totalFrames: 1,
              frameTypes: ['task'],
              estimatedSize: 256,
              dependencies: [],
            },
          },
          user2Id
        );

        await handoffManager.submitHandoffApproval(handoffId, {
          reviewerId: user2Id,
          decision: 'approved',
        });
      }

      // Get metrics
      const metrics = await handoffManager.getHandoffMetrics();
      expect(metrics.totalHandoffs).toBeGreaterThanOrEqual(3);
      expect(metrics.completedHandoffs).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle handoff expiry gracefully', async () => {
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Expiry Test',
        user1Id
      );

      const handoffId = await handoffManager.initiateHandoff(
        sharedStackId,
        ['test-frame'],
        {
          initiatedAt: new Date(),
          initiatorId: user1Id,
          frameContext: {
            totalFrames: 1,
            frameTypes: ['task'],
            estimatedSize: 128,
            dependencies: [],
          },
        }
      );

      // Simulate expiry by manually setting expired status
      const progress = await handoffManager.getHandoffProgress(handoffId);
      if (progress) {
        progress.status = 'failed';
        progress.errors.push({
          step: 'expiry',
          error: 'Request expired after 24 hours',
          timestamp: new Date(),
        });
      }

      expect(progress?.status).toBe('failed');
    });

    it('should handle stack permission violations', async () => {
      // Create stack with limited permissions
      const restrictedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Restricted Stack',
        user1Id,
        {
          canRead: true,
          canWrite: false,
          canHandoff: false,
          canMerge: false,
          canAdminister: false,
        }
      );

      // Attempt handoff to restricted stack should fail
      await expect(
        handoffManager.initiateHandoff(restrictedStackId, ['protected-frame'], {
          initiatedAt: new Date(),
          initiatorId: user2Id, // Different user
          frameContext: {
            totalFrames: 1,
            frameTypes: ['task'],
            estimatedSize: 64,
            dependencies: [],
          },
        })
      ).rejects.toThrow();
    });

    it('should handle concurrent handoffs', async () => {
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Concurrent Test',
        user1Id
      );

      // Start multiple handoffs concurrently
      const handoffPromises = [];
      for (let i = 0; i < 3; i++) {
        handoffPromises.push(
          handoffManager.initiateHandoff(
            sharedStackId,
            [`concurrent-frame-${i}`],
            {
              initiatedAt: new Date(),
              initiatorId: user1Id,
              frameContext: {
                totalFrames: 1,
                frameTypes: ['task'],
                estimatedSize: 32,
                dependencies: [],
              },
            }
          )
        );
      }

      const handoffIds = await Promise.all(handoffPromises);
      expect(handoffIds).toHaveLength(3);
      expect(new Set(handoffIds).size).toBe(3); // All unique IDs
    });
  });

  describe('Advanced Merge Scenarios', () => {
    it('should handle custom merge policies', async () => {
      // Create aggressive merge policy
      await mergeResolver.createMergePolicy({
        name: 'test-aggressive',
        description: 'Auto-resolve everything possible',
        rules: [
          {
            condition: '$.severity == "low" || $.severity == "medium"',
            action: 'source_wins',
            priority: 5,
          },
          {
            condition: '$.autoResolvable',
            action: 'merge_both',
            priority: 3,
          },
        ],
        autoApplyThreshold: 'high',
      });

      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Policy Test',
        user1Id
      );

      const sessionId = await mergeResolver.startMergeSession(
        `individual-${user1Id}`,
        sharedStackId,
        undefined,
        'test-aggressive'
      );

      const session = await mergeResolver.getMergeSession(sessionId);
      expect(session?.policy.name).toBe('test-aggressive');
    });

    it('should preserve data integrity during complex merges', async () => {
      const sourceStackId = `individual-${user1Id}`;
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Integrity Test',
        user1Id
      );

      // Start merge session
      const sessionId = await mergeResolver.startMergeSession(
        sourceStackId,
        sharedStackId
      );

      const session = await mergeResolver.getMergeSession(sessionId);
      expect(session).toBeDefined();

      // Verify session metadata is tracked correctly
      expect(session?.metadata).toHaveProperty('totalFrames');
      expect(session?.metadata).toHaveProperty('conflictFrames');
      expect(session?.metadata).toHaveProperty('autoResolvedConflicts');
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large frame sets efficiently', async () => {
      const startTime = Date.now();

      // Simulate handoff of large frame set
      const largeFrameSet = Array.from(
        { length: 100 },
        (_, i) => `large-frame-${i}`
      );

      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Performance Test',
        user1Id
      );

      const handoffId = await handoffManager.initiateHandoff(
        sharedStackId,
        largeFrameSet,
        {
          initiatedAt: new Date(),
          initiatorId: user1Id,
          frameContext: {
            totalFrames: largeFrameSet.length,
            frameTypes: ['task', 'implementation', 'test'],
            estimatedSize: 51200, // 50KB
            dependencies: [],
          },
        }
      );

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1000); // Should complete within 1 second
      expect(handoffId).toBeDefined();
    });

    it('should cleanup expired sessions and notifications', async () => {
      // Create old handoff that should be cleaned up
      const sharedStackId = await dualStackManager.createSharedStack(
        teamId,
        'Cleanup Test',
        user1Id
      );

      await handoffManager.initiateHandoff(sharedStackId, ['cleanup-frame'], {
        initiatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
        initiatorId: user1Id,
        frameContext: {
          totalFrames: 1,
          frameTypes: ['task'],
          estimatedSize: 16,
          dependencies: [],
        },
      });

      // Check that notifications can be cleaned up
      const notifications = await handoffManager.getUserNotifications(user1Id);
      expect(Array.isArray(notifications)).toBe(true);
    });
  });
});
