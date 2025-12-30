/**
 * Compaction Handler for Claude Code Autocompaction
 * Preserves critical context across token limit boundaries
 */

import { FrameManager, Anchor, Event } from './frame-manager.js';
import { logger } from '../monitoring/logger.js';

export interface CompactionMetrics {
  estimatedTokens: number;
  warningThreshold: number;
  criticalThreshold: number;
  lastCompactionAt?: number;
  anchorsPreserved: number;
}

export interface ToolCallSummary {
  tool: string;
  timestamp: number;
  key_inputs: Record<string, any>;
  key_outputs: Record<string, any>;
  files_affected: string[];
  success: boolean;
  error?: string;
}

export interface CriticalContextAnchor {
  anchor_id: string;
  type: 'COMPACTION_PRESERVE';
  priority: 10; // Highest priority
  content: {
    tool_calls: ToolCallSummary[];
    decisions: string[];
    file_operations: FileOperation[];
    error_resolutions: ErrorPattern[];
  };
  created_at: number;
  token_estimate: number;
}

export interface FileOperation {
  type: 'read' | 'write' | 'edit' | 'delete' | 'create';
  path: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface ErrorPattern {
  error: string;
  resolution: string;
  tool_sequence: string[];
  timestamp: number;
}

export class CompactionHandler {
  private frameManager: FrameManager;
  private metrics: CompactionMetrics;
  private tokenAccumulator: number = 0;
  private preservedAnchors: Map<string, CriticalContextAnchor> = new Map();

  constructor(frameManager: FrameManager) {
    this.frameManager = frameManager;
    this.metrics = {
      estimatedTokens: 0,
      warningThreshold: 150000, // 150K tokens
      criticalThreshold: 170000, // 170K tokens
      anchorsPreserved: 0,
    };
  }

  /**
   * Track token usage from a message
   */
  trackTokens(content: string): void {
    // Rough estimation: 1 token ≈ 4 characters
    const estimatedTokens = Math.ceil(content.length / 4);
    this.tokenAccumulator += estimatedTokens;
    this.metrics.estimatedTokens += estimatedTokens;

    // Check thresholds
    if (this.isApproachingCompaction()) {
      this.preserveCriticalContext();
    }
  }

  /**
   * Check if approaching compaction threshold
   */
  isApproachingCompaction(): boolean {
    return this.metrics.estimatedTokens >= this.metrics.warningThreshold;
  }

  /**
   * Check if past critical threshold
   */
  isPastCriticalThreshold(): boolean {
    return this.metrics.estimatedTokens >= this.metrics.criticalThreshold;
  }

  /**
   * Detect if compaction likely occurred
   */
  detectCompactionEvent(content: string): boolean {
    const compactionIndicators = [
      'earlier in this conversation',
      'previously discussed',
      'as mentioned before',
      'summarized for brevity',
      '[conversation compressed]',
      '[context truncated]',
    ];

    const lowerContent = content.toLowerCase();
    return compactionIndicators.some((indicator) =>
      lowerContent.includes(indicator)
    );
  }

  /**
   * Preserve critical context before compaction
   */
  async preserveCriticalContext(): Promise<void> {
    try {
      const currentFrameId = this.frameManager.getCurrentFrameId();
      if (!currentFrameId) {
        logger.warn('No active frame to preserve context from');
        return;
      }

      // Get events from current frame
      const events = this.frameManager.getFrameEvents(currentFrameId);

      // Extract critical information
      const toolCalls = this.extractToolCalls(events);
      const fileOps = this.extractFileOperations(events);
      const decisions = this.extractDecisions(events);
      const errorPatterns = this.extractErrorPatterns(events);

      // Create preservation anchor
      const anchor: CriticalContextAnchor = {
        anchor_id: `compact_${Date.now()}`,
        type: 'COMPACTION_PRESERVE',
        priority: 10,
        content: {
          tool_calls: toolCalls,
          file_operations: fileOps,
          decisions: decisions,
          error_resolutions: errorPatterns,
        },
        created_at: Date.now(),
        token_estimate: this.metrics.estimatedTokens,
      };

      // Store in frame manager as high-priority anchor
      this.frameManager.addAnchor(
        'CONSTRAINT' as any, // Using CONSTRAINT type for now
        JSON.stringify(anchor),
        10,
        {
          compaction_preserve: true,
          token_count: this.metrics.estimatedTokens,
        },
        currentFrameId
      );

      // Store locally for quick access
      this.preservedAnchors.set(anchor.anchor_id, anchor);
      this.metrics.anchorsPreserved++;

      logger.info(
        `Preserved critical context at ${this.metrics.estimatedTokens} tokens`
      );
    } catch (error) {
      logger.error(
        'Failed to preserve critical context:',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Extract tool calls from events
   */
  private extractToolCalls(events: Event[]): ToolCallSummary[] {
    const toolCalls: ToolCallSummary[] = [];
    const toolEvents = events.filter((e) => e.event_type === 'tool_call');

    for (const event of toolEvents) {
      const resultEvent = events.find(
        (e) =>
          e.event_type === 'tool_result' &&
          e.seq > event.seq &&
          e.payload.tool_name === event.payload.tool_name
      );

      toolCalls.push({
        tool: event.payload.tool_name || 'unknown',
        timestamp: event.ts,
        key_inputs: this.extractKeyInputs(event.payload),
        key_outputs: resultEvent
          ? this.extractKeyOutputs(resultEvent.payload)
          : {},
        files_affected: this.extractAffectedFiles(
          event.payload,
          resultEvent?.payload
        ),
        success: resultEvent ? !resultEvent.payload.error : false,
        error: resultEvent?.payload.error,
      });
    }

    return toolCalls;
  }

  /**
   * Extract key inputs from tool call
   */
  private extractKeyInputs(payload: any): Record<string, any> {
    const keys = [
      'file_path',
      'command',
      'query',
      'path',
      'pattern',
      'content',
    ];
    const result: Record<string, any> = {};

    for (const key of keys) {
      if (payload.arguments?.[key]) {
        result[key] = payload.arguments[key];
      }
    }

    return result;
  }

  /**
   * Extract key outputs from tool result
   */
  private extractKeyOutputs(payload: any): Record<string, any> {
    return {
      success: !payload.error,
      error: payload.error,
      result_type: payload.result_type,
      files_created: payload.files_created,
      files_modified: payload.files_modified,
    };
  }

  /**
   * Extract affected files from tool events
   */
  private extractAffectedFiles(callPayload: any, resultPayload: any): string[] {
    const files = new Set<string>();

    // From tool call
    if (callPayload?.arguments?.file_path) {
      files.add(callPayload.arguments.file_path);
    }
    if (callPayload?.arguments?.path) {
      files.add(callPayload.arguments.path);
    }

    // From tool result
    if (resultPayload?.files_created) {
      resultPayload.files_created.forEach((f: string) => files.add(f));
    }
    if (resultPayload?.files_modified) {
      resultPayload.files_modified.forEach((f: string) => files.add(f));
    }

    return Array.from(files);
  }

  /**
   * Extract file operations from events
   */
  private extractFileOperations(events: Event[]): FileOperation[] {
    const fileOps: FileOperation[] = [];
    const fileTools = ['Read', 'Write', 'Edit', 'MultiEdit', 'Delete'];

    const toolEvents = events.filter(
      (e) =>
        e.event_type === 'tool_call' && fileTools.includes(e.payload.tool_name)
    );

    for (const event of toolEvents) {
      const operation = this.mapToolToOperation(event.payload.tool_name);
      const path =
        event.payload.arguments?.file_path ||
        event.payload.arguments?.path ||
        'unknown';

      fileOps.push({
        type: operation,
        path: path,
        timestamp: event.ts,
        success: true, // Will be updated from result
        error: undefined,
      });
    }

    return fileOps;
  }

  /**
   * Map tool name to file operation type
   */
  private mapToolToOperation(toolName: string): FileOperation['type'] {
    const mapping: Record<string, FileOperation['type']> = {
      Read: 'read',
      Write: 'write',
      Edit: 'edit',
      MultiEdit: 'edit',
      Delete: 'delete',
    };

    return mapping[toolName] || 'read';
  }

  /**
   * Extract decisions from events
   */
  private extractDecisions(events: Event[]): string[] {
    const decisions: string[] = [];

    const decisionEvents = events.filter((e) => e.event_type === 'decision');
    for (const event of decisionEvents) {
      if (event.payload.text) {
        decisions.push(event.payload.text);
      }
    }

    return decisions;
  }

  /**
   * Extract error patterns and resolutions
   */
  private extractErrorPatterns(events: Event[]): ErrorPattern[] {
    const patterns: ErrorPattern[] = [];

    // Find tool results with errors
    const errorEvents = events.filter(
      (e) => e.event_type === 'tool_result' && e.payload.error
    );

    for (const errorEvent of errorEvents) {
      // Look for subsequent successful tool calls that might be resolutions
      const subsequentTools = events
        .filter((e) => e.event_type === 'tool_call' && e.seq > errorEvent.seq)
        .slice(0, 3); // Next 3 tools might be resolution attempts

      if (subsequentTools.length > 0) {
        patterns.push({
          error: errorEvent.payload.error,
          resolution: `Attempted resolution with ${subsequentTools.map((t) => t.payload.tool_name).join(', ')}`,
          tool_sequence: subsequentTools.map((t) => t.payload.tool_name),
          timestamp: errorEvent.ts,
        });
      }
    }

    return patterns;
  }

  /**
   * Restore context after compaction detected
   */
  async restoreContext(): Promise<void> {
    if (this.preservedAnchors.size === 0) {
      logger.warn('No preserved anchors to restore from');
      return;
    }

    // Get the most recent anchor
    const anchors = Array.from(this.preservedAnchors.values());
    anchors.sort((a, b) => b.created_at - a.created_at);
    const latestAnchor = anchors[0];

    // Create restoration frame
    const restorationFrame = this.frameManager.createFrame({
      type: 'review',
      name: 'Context Restoration After Compaction',
      inputs: { reason: 'autocompaction_detected' },
    });

    // Add restoration anchor
    this.frameManager.addAnchor(
      'FACT',
      `Context restored from token position ${latestAnchor.token_estimate}`,
      10,
      { restoration: true },
      restorationFrame
    );

    // Add tool sequence summary
    const toolSequence = latestAnchor.content.tool_calls
      .map((t) => t.tool)
      .join(' → ');
    this.frameManager.addAnchor(
      'FACT',
      `Tool sequence: ${toolSequence}`,
      9,
      {},
      restorationFrame
    );

    // Add file operations summary
    const files = new Set<string>();
    latestAnchor.content.file_operations.forEach((op) => files.add(op.path));
    if (files.size > 0) {
      this.frameManager.addAnchor(
        'FACT',
        `Files touched: ${Array.from(files).join(', ')}`,
        8,
        {},
        restorationFrame
      );
    }

    // Add decisions
    for (const decision of latestAnchor.content.decisions) {
      this.frameManager.addAnchor(
        'DECISION',
        decision,
        7,
        {},
        restorationFrame
      );
    }

    logger.info('Context restored after compaction detection');
  }

  /**
   * Get current metrics
   */
  getMetrics(): CompactionMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset token counter (e.g., at session start)
   */
  resetTokenCount(): void {
    this.metrics.estimatedTokens = 0;
    this.tokenAccumulator = 0;
    this.metrics.lastCompactionAt = undefined;
  }
}
