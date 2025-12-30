/**
 * Integration module for Enhanced Hybrid Digest with Frame Manager
 * Connects the 60/40 digest generator with frame lifecycle events
 */

import Database from 'better-sqlite3';
import {
  FrameManager,
  Frame,
  Event,
  Anchor,
} from '../context/frame-manager.js';
import { EnhancedHybridDigestGenerator } from './enhanced-hybrid-digest.js';
import { DigestInput, DigestLLMProvider } from './types.js';
import { logger } from '../monitoring/logger.js';

/**
 * Frame Digest Integration
 * Enhances FrameManager with hybrid digest capabilities
 */
export class FrameDigestIntegration {
  private frameManager: FrameManager;
  private digestGenerator: EnhancedHybridDigestGenerator;
  private frameActivityMap = new Map<string, number>();

  constructor(
    frameManager: FrameManager,
    db: Database.Database,
    llmProvider?: DigestLLMProvider
  ) {
    this.frameManager = frameManager;
    this.digestGenerator = new EnhancedHybridDigestGenerator(
      db,
      {
        enableAIGeneration: true,
        maxTokens: 200,
      },
      llmProvider
    );

    this.setupHooks();
  }

  /**
   * Setup frame lifecycle hooks
   */
  private setupHooks(): void {
    // Track frame activity
    const originalAddEvent = this.frameManager.addEvent.bind(this.frameManager);
    this.frameManager.addEvent = (
      eventType: Event['event_type'],
      payload: Record<string, any>,
      frameId?: string
    ): string => {
      const result = originalAddEvent(eventType, payload, frameId);

      // Track tool calls for idle detection
      if (eventType === 'tool_call') {
        this.digestGenerator.recordToolCall();
      }

      // Track user messages
      if (eventType === 'user_message') {
        this.digestGenerator.recordUserInput();
      }

      // Track frame activity
      const targetFrameId = frameId || this.frameManager.getCurrentFrameId();
      if (targetFrameId) {
        this.frameActivityMap.set(targetFrameId, Date.now());
      }

      return result;
    };

    // Hook into frame creation
    const originalCreateFrame = this.frameManager.createFrame.bind(
      this.frameManager
    );
    this.frameManager.createFrame = (options: any): string => {
      const frameId = originalCreateFrame(options);
      this.digestGenerator.onFrameOpened(frameId);
      this.frameActivityMap.set(frameId, Date.now());
      return frameId;
    };

    // Hook into frame closure
    const originalCloseFrame = this.frameManager.closeFrame.bind(
      this.frameManager
    );
    this.frameManager.closeFrame = (
      frameId?: string,
      outputs?: Record<string, any>
    ): void => {
      const targetFrameId = frameId || this.frameManager.getCurrentFrameId();

      if (targetFrameId) {
        // Generate enhanced digest
        const digest = this.generateEnhancedDigest(targetFrameId);

        // Merge digest outputs with provided outputs
        const enhancedOutputs = {
          ...outputs,
          digest: digest.json,
          digestText: digest.text,
        };

        // Notify digest generator of frame closure
        this.digestGenerator.onFrameClosed(targetFrameId);
        this.frameActivityMap.delete(targetFrameId);

        // Call original with enhanced outputs
        originalCloseFrame(frameId, enhancedOutputs);
      } else {
        originalCloseFrame(frameId, outputs);
      }
    };
  }

  /**
   * Generate enhanced digest for a frame
   */
  private generateEnhancedDigest(frameId: string): {
    text: string;
    json: Record<string, any>;
  } {
    // Get frame data
    const frame = this.frameManager.getFrame(frameId);
    if (!frame) {
      logger.warn('Frame not found for digest generation', { frameId });
      return { text: '', json: {} };
    }

    // Get events and anchors
    const events = this.frameManager.getFrameEvents(frameId);
    const anchors = this.getFrameAnchors(frameId);

    // Convert to digest input format
    const digestInput: DigestInput = {
      frame: this.convertFrame(frame),
      events: events.map(this.convertEvent),
      anchors: anchors.map(this.convertAnchor),
    };

    // Generate hybrid digest
    const hybridDigest = this.digestGenerator.generateDigest(digestInput);

    // Format for frame manager
    return {
      text: hybridDigest.text,
      json: {
        deterministic: hybridDigest.deterministic,
        aiGenerated: hybridDigest.aiGenerated,
        status: hybridDigest.status,
        generatedAt: Date.now(),
      },
    };
  }

  /**
   * Convert FrameManager frame to DigestInput frame
   */
  private convertFrame(frame: Frame): Frame {
    // Frame types are the same - just pass through with type assertion
    return frame;
  }

  /**
   * Convert FrameManager event to DigestInput event
   */
  private convertEvent(event: Event): Event {
    // Events are the same type - just pass through
    return event;
  }

  /**
   * Convert FrameManager anchor to DigestInput anchor
   */
  private convertAnchor(anchor: Anchor): Anchor {
    // Anchors are the same type - just pass through
    return anchor;
  }

  /**
   * Calculate importance score based on frame characteristics
   */
  private calculateImportanceScore(frame: Frame): number {
    let score = 0.5; // Base score

    // Adjust based on frame type
    const typeScores: Record<string, number> = {
      task: 0.6,
      debug: 0.8,
      review: 0.7,
      write: 0.5,
      tool_scope: 0.3,
      subtask: 0.4,
    };
    score = typeScores[frame.type] || score;

    // Adjust based on depth (deeper frames are usually less important)
    score -= frame.depth * 0.05;

    // Adjust based on duration (longer frames might be more important)
    if (frame.closed_at) {
      const durationMinutes = (frame.closed_at - frame.created_at) / 60;
      if (durationMinutes > 10) score += 0.1;
      if (durationMinutes > 30) score += 0.1;
    }

    // Clamp between 0 and 1
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Get frame anchors (wrapper for proper typing)
   */
  private getFrameAnchors(frameId: string): Anchor[] {
    // This would typically use frameManager's method, but it's private
    // For now, return empty array - in production would need to expose this
    return [];
  }

  /**
   * Handle user interruption
   */
  public handleUserInterruption(): void {
    this.digestGenerator.handleInterruption();
  }

  /**
   * Get idle status
   */
  public getIdleStatus(): ReturnType<
    EnhancedHybridDigestGenerator['getIdleStatus']
  > {
    return this.digestGenerator.getIdleStatus();
  }

  /**
   * Force process digest queue
   */
  public async forceProcessQueue(): Promise<void> {
    await this.digestGenerator.forceProcessQueue();
  }

  /**
   * Cleanup
   */
  public shutdown(): void {
    this.digestGenerator.shutdown();
  }
}

/**
 * Factory function to enhance existing FrameManager
 */
export function enhanceFrameManagerWithDigest(
  frameManager: FrameManager,
  db: Database.Database,
  llmProvider?: DigestLLMProvider
): FrameDigestIntegration {
  return new FrameDigestIntegration(frameManager, db, llmProvider);
}
