/**
 * Trace Detection and Bundling System
 * Identifies chains of related tool calls and bundles them as single traces
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ToolCall,
  Trace,
  TraceType,
  TraceBoundaryConfig,
  DEFAULT_TRACE_CONFIG,
  TRACE_PATTERNS,
  TraceMetadata,
  TraceScoringFactors,
  CompressedTrace,
  CompressionStrategy,
} from './types';
import { ConfigManager } from '../config/config-manager';

export class TraceDetector {
  private config: TraceBoundaryConfig;
  private activeTrace: ToolCall[] = [];
  private lastToolTime: number = 0;
  private traces: Trace[] = [];
  private configManager: ConfigManager;

  constructor(
    config: Partial<TraceBoundaryConfig> = {},
    configManager?: ConfigManager
  ) {
    this.config = { ...DEFAULT_TRACE_CONFIG, ...config };
    this.configManager = configManager || new ConfigManager();
  }

  /**
   * Add a tool call and check if it belongs to current trace
   */
  addToolCall(tool: ToolCall): void {
    const now = Date.now();

    // Check if this tool belongs to the current trace
    if (this.shouldStartNewTrace(tool)) {
      // Finalize current trace if it exists
      if (this.activeTrace.length > 0) {
        this.finalizeTrace();
      }
      // Start new trace
      this.activeTrace = [tool];
    } else {
      // Add to current trace
      this.activeTrace.push(tool);
    }

    this.lastToolTime = tool.timestamp;

    // Check if trace is getting too large
    if (this.activeTrace.length >= this.config.maxTraceSize) {
      this.finalizeTrace();
    }
  }

  /**
   * Determine if a tool call should start a new trace
   */
  private shouldStartNewTrace(tool: ToolCall): boolean {
    // First tool always starts a new trace
    if (this.activeTrace.length === 0) {
      return false;
    }

    const lastTool = this.activeTrace[this.activeTrace.length - 1];

    // Time proximity check
    const timeDiff = tool.timestamp - lastTool.timestamp;
    if (timeDiff > this.config.timeProximityMs) {
      return true;
    }

    // Directory check if enabled
    if (this.config.sameDirThreshold) {
      const lastFiles = lastTool.filesAffected || [];
      const currentFiles = tool.filesAffected || [];
      
      if (lastFiles.length > 0 && currentFiles.length > 0) {
        const lastDirs = lastFiles.map(f => this.getDirectory(f));
        const currentDirs = currentFiles.map(f => this.getDirectory(f));
        
        const hasCommonDir = lastDirs.some(d => currentDirs.includes(d));
        if (!hasCommonDir) {
          return true;
        }
      }
    }

    // Causal relationship check
    if (this.config.causalRelationship) {
      // If last tool had an error and current tool is not a fix attempt, start new trace
      if (lastTool.error && !this.isFixAttempt(tool, lastTool)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a tool is attempting to fix an error from previous tool
   */
  private isFixAttempt(current: ToolCall, previous: ToolCall): boolean {
    // Edit after error is likely a fix
    if (previous.error && (current.tool === 'edit' || current.tool === 'write')) {
      return true;
    }

    // Test after fix is validation
    if (current.tool === 'test' || current.tool === 'bash') {
      return true;
    }

    return false;
  }

  /**
   * Finalize current trace and add to traces list
   */
  private finalizeTrace(): void {
    if (this.activeTrace.length === 0) return;

    const trace = this.createTrace(this.activeTrace);
    this.traces.push(trace);
    this.activeTrace = [];
  }

  /**
   * Create a trace from a sequence of tool calls
   */
  private createTrace(tools: ToolCall[]): Trace {
    const id = uuidv4();
    const type = this.detectTraceType(tools);
    const metadata = this.extractMetadata(tools);
    const score = this.calculateTraceScore(tools, metadata);
    const summary = this.generateSummary(tools, type, metadata);

    const trace: Trace = {
      id,
      type,
      tools,
      score,
      summary,
      metadata,
    };

    // Check if trace should be compressed
    const ageHours = (Date.now() - metadata.startTime) / (1000 * 60 * 60);
    if (ageHours > this.config.compressionThreshold) {
      trace.compressed = this.compressTrace(trace);
    }

    return trace;
  }

  /**
   * Detect the type of trace based on tool patterns
   */
  private detectTraceType(tools: ToolCall[]): TraceType {
    const toolSequence = tools.map(t => t.tool);

    // Check against known patterns
    for (const pattern of TRACE_PATTERNS) {
      if (this.matchesPattern(toolSequence, pattern.pattern)) {
        return pattern.type;
      }
    }

    // Heuristic detection
    if (toolSequence.includes('search') || toolSequence.includes('grep')) {
      if (toolSequence.includes('edit')) {
        return TraceType.SEARCH_DRIVEN;
      }
      return TraceType.EXPLORATION;
    }

    if (tools.some(t => t.error)) {
      return TraceType.ERROR_RECOVERY;
    }

    if (toolSequence.includes('test')) {
      return TraceType.TESTING;
    }

    if (toolSequence.includes('write')) {
      return TraceType.FEATURE_IMPLEMENTATION;
    }

    return TraceType.UNKNOWN;
  }

  /**
   * Check if tool sequence matches a pattern
   */
  private matchesPattern(
    sequence: string[],
    pattern: RegExp | string[]
  ): boolean {
    if (pattern instanceof RegExp) {
      return pattern.test(sequence.join('→'));
    }

    if (Array.isArray(pattern)) {
      // Check if pattern is a subsequence
      let patternIndex = 0;
      for (const tool of sequence) {
        if (tool === pattern[patternIndex]) {
          patternIndex++;
          if (patternIndex >= pattern.length) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Extract metadata from tool calls
   */
  private extractMetadata(tools: ToolCall[]): TraceMetadata {
    const startTime = tools[0].timestamp;
    const endTime = tools[tools.length - 1].timestamp;

    const filesModified = new Set<string>();
    const errorsEncountered: string[] = [];
    const decisionsRecorded: string[] = [];

    let hasCausalChain = false;

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];

      // Collect files
      if (tool.filesAffected) {
        tool.filesAffected.forEach(f => filesModified.add(f));
      }

      // Collect errors
      if (tool.error) {
        errorsEncountered.push(tool.error);
        // Check if next tool is a fix attempt
        if (i < tools.length - 1) {
          const nextTool = tools[i + 1];
          if (this.isFixAttempt(nextTool, tool)) {
            hasCausalChain = true;
          }
        }
      }

      // Collect decisions (if tool is decision_recording)
      if (tool.tool === 'decision_recording' && tool.arguments?.decision) {
        decisionsRecorded.push(tool.arguments.decision);
      }
    }

    return {
      startTime,
      endTime,
      filesModified: Array.from(filesModified),
      errorsEncountered,
      decisionsRecorded,
      causalChain: hasCausalChain,
    };
  }

  /**
   * Calculate importance score for a trace
   */
  private calculateTraceScore(
    tools: ToolCall[],
    metadata: TraceMetadata
  ): number {
    // Get individual tool scores
    const toolScores = tools.map(t => 
      this.configManager.calculateScore(t.tool, {
        filesAffected: t.filesAffected?.length || 0,
        isPermanent: this.isPermanentChange(t),
        referenceCount: 0, // Would need to track references
      })
    );

    // Use MAX strategy for trace scoring (highest tool determines trace importance)
    const maxScore = Math.max(...toolScores);

    // Apply bonuses
    let score = maxScore;

    // Bonus for causal chains (error→fix→verify)
    if (metadata.causalChain) {
      score = Math.min(score + 0.1, 1.0);
    }

    // Bonus for decisions
    if (metadata.decisionsRecorded.length > 0) {
      score = Math.min(score + 0.05 * metadata.decisionsRecorded.length, 1.0);
    }

    // Penalty for errors without fixes
    if (metadata.errorsEncountered.length > 0 && !metadata.causalChain) {
      score = Math.max(score - 0.1, 0);
    }

    return score;
  }

  /**
   * Check if a tool call represents a permanent change
   */
  private isPermanentChange(tool: ToolCall): boolean {
    const permanentTools = ['write', 'edit', 'decision_recording'];
    return permanentTools.includes(tool.tool);
  }

  /**
   * Generate a summary for the trace
   */
  private generateSummary(
    tools: ToolCall[],
    type: TraceType,
    metadata: TraceMetadata
  ): string {
    const toolChain = tools.map(t => t.tool).join('→');

    switch (type) {
      case TraceType.SEARCH_DRIVEN:
        return `Search-driven modification: ${toolChain}`;

      case TraceType.ERROR_RECOVERY:
        const error = metadata.errorsEncountered[0] || 'unknown error';
        return `Error recovery: ${error} via ${toolChain}`;

      case TraceType.FEATURE_IMPLEMENTATION:
        const files = metadata.filesModified.length;
        return `Feature implementation: ${files} files via ${toolChain}`;

      case TraceType.REFACTORING:
        return `Code refactoring: ${toolChain}`;

      case TraceType.TESTING:
        return `Test execution: ${toolChain}`;

      case TraceType.EXPLORATION:
        return `Codebase exploration: ${toolChain}`;

      case TraceType.DEBUGGING:
        return `Debugging session: ${toolChain}`;

      case TraceType.BUILD_DEPLOY:
        return `Build and deploy: ${toolChain}`;

      default:
        return `Tool sequence: ${toolChain}`;
    }
  }

  /**
   * Compress a trace for long-term storage
   */
  private compressTrace(trace: Trace): CompressedTrace {
    const pattern = trace.tools.map(t => t.tool).join('→');
    const duration = trace.metadata.endTime - trace.metadata.startTime;

    return {
      pattern,
      summary: trace.summary,
      score: trace.score,
      toolCount: trace.tools.length,
      duration,
      timestamp: trace.metadata.startTime,
    };
  }

  /**
   * Get directory from file path
   */
  private getDirectory(filePath: string): string {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename
    return parts.join('/');
  }

  /**
   * Flush any pending trace
   */
  flush(): void {
    if (this.activeTrace.length > 0) {
      this.finalizeTrace();
    }
  }

  /**
   * Get all detected traces
   */
  getTraces(): Trace[] {
    return this.traces;
  }

  /**
   * Get traces by type
   */
  getTracesByType(type: TraceType): Trace[] {
    return this.traces.filter(t => t.type === type);
  }

  /**
   * Get high-importance traces
   */
  getHighImportanceTraces(threshold: number = 0.7): Trace[] {
    return this.traces.filter(t => t.score >= threshold);
  }

  /**
   * Compress old traces
   */
  compressOldTraces(ageHours: number = 24): number {
    let compressed = 0;
    const now = Date.now();

    for (const trace of this.traces) {
      const age = (now - trace.metadata.startTime) / (1000 * 60 * 60);
      if (age > ageHours && !trace.compressed) {
        trace.compressed = this.compressTrace(trace);
        // Optionally remove full tool data to save space
        // trace.tools = [];
        compressed++;
      }
    }

    return compressed;
  }

  /**
   * Export traces for analysis
   */
  exportTraces(): string {
    return JSON.stringify(this.traces, null, 2);
  }

  /**
   * Get statistics about traces
   */
  getStatistics() {
    const stats = {
      totalTraces: this.traces.length,
      tracesByType: {} as Record<string, number>,
      averageScore: 0,
      averageLength: 0,
      compressedCount: 0,
      highImportanceCount: 0,
    };

    if (this.traces.length === 0) return stats;

    let totalScore = 0;
    let totalLength = 0;

    for (const trace of this.traces) {
      // Type distribution
      stats.tracesByType[trace.type] = (stats.tracesByType[trace.type] || 0) + 1;

      // Scores
      totalScore += trace.score;

      // Length
      totalLength += trace.tools.length;

      // Compressed
      if (trace.compressed) {
        stats.compressedCount++;
      }

      // High importance
      if (trace.score >= 0.7) {
        stats.highImportanceCount++;
      }
    }

    stats.averageScore = totalScore / this.traces.length;
    stats.averageLength = totalLength / this.traces.length;

    return stats;
  }
}