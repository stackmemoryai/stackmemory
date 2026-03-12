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
  _TraceScoringFactors,
  CompressedTrace,
  CompressionStrategy,
} from './types.js';
import { ConfigManager } from '../config/config-manager.js';
import { TraceStore } from './trace-store.js';
import Database from 'better-sqlite3';

export class TraceDetector {
  private config: TraceBoundaryConfig;
  private activeTrace: ToolCall[] = [];
  private lastToolTime: number = 0;
  private traces: Trace[] = [];
  private configManager: ConfigManager;
  private traceStore?: TraceStore;

  constructor(
    config: Partial<TraceBoundaryConfig> = {},
    configManager?: ConfigManager,
    db?: Database.Database
  ) {
    this.config = { ...DEFAULT_TRACE_CONFIG, ...config };
    this.configManager = configManager || new ConfigManager();

    if (db) {
      this.traceStore = new TraceStore(db);
      // Load existing traces from database
      this.loadTracesFromStore();
    }
  }

  /**
   * Load traces from the database
   */
  private loadTracesFromStore(): void {
    if (!this.traceStore) return;

    try {
      // Load recent traces (last 24 hours)
      const recentTraces = this.traceStore.getAllTraces();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;

      this.traces = recentTraces.filter((t) => t.metadata.startTime >= cutoff);
    } catch (error: unknown) {
      // If loading fails, start with empty traces
      console.error('Failed to load traces from store:', error);
      this.traces = [];
    }
  }

  /**
   * Add a tool call and check if it belongs to current trace
   */
  addToolCall(tool: ToolCall): void {
    const _now = Date.now();

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
        const lastDirs = lastFiles.map((f) => this.getDirectory(f));
        const currentDirs = currentFiles.map((f) => this.getDirectory(f));

        const hasCommonDir = lastDirs.some((d) => currentDirs.includes(d));
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
    if (
      previous.error &&
      (current.tool === 'edit' || current.tool === 'write')
    ) {
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

    // Persist to database if store is available
    if (this.traceStore) {
      try {
        this.traceStore.saveTrace(trace);
      } catch (error: unknown) {
        console.error('Failed to persist trace:', error);
      }
    }

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
    const toolSequence = tools.map((t) => t.tool);

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

    if (tools.some((t) => t.error)) {
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
        tool.filesAffected.forEach((f) => filesModified.add(f));
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
    const toolScores = tools.map((t) =>
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
    const toolChain = tools.map((t) => t.tool).join('→');

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
   * Compress a trace for long-term storage using strategy
   */
  private compressTrace(
    trace: Trace,
    strategy: CompressionStrategy = CompressionStrategy.PATTERN_BASED
  ): CompressedTrace {
    switch (strategy) {
      case CompressionStrategy.SUMMARY_ONLY:
        return this.compressSummaryOnly(trace);

      case CompressionStrategy.PATTERN_BASED:
        return this.compressPatternBased(trace);

      case CompressionStrategy.SELECTIVE:
        return this.compressSelective(trace);

      case CompressionStrategy.FULL_COMPRESSION:
        return this.compressMaximal(trace);

      default:
        return this.compressPatternBased(trace);
    }
  }

  /**
   * Summary-only compression - minimal data retention
   */
  private compressSummaryOnly(trace: Trace): CompressedTrace {
    return {
      pattern: '', // No pattern stored
      summary: trace.summary.substring(0, 100), // Limit summary
      score: trace.score,
      toolCount: trace.tools.length,
      duration: trace.metadata.endTime - trace.metadata.startTime,
      timestamp: trace.metadata.startTime,
    };
  }

  /**
   * Pattern-based compression - keep tool sequence
   */
  private compressPatternBased(trace: Trace): CompressedTrace {
    const pattern = trace.tools.map((t) => t.tool).join('→');
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
   * Selective compression - keep high-score tools only
   */
  private compressSelective(
    trace: Trace,
    threshold: number = 0.5
  ): CompressedTrace {
    // Calculate individual tool scores
    const significantTools = trace.tools.filter((tool: any) => {
      const score = this.configManager.calculateScore(tool.tool, {
        filesAffected: tool.filesAffected?.length || 0,
        isPermanent: this.isPermanentChange(tool),
        referenceCount: 0,
      });
      return score >= threshold;
    });

    const pattern =
      significantTools.length > 0
        ? significantTools.map((t: any) => t.tool).join('→')
        : trace.tools.map((t: any) => t.tool).join('→');

    return {
      pattern,
      summary: `${trace.summary} [${significantTools.length}/${trace.tools.length} significant]`,
      score: trace.score,
      toolCount: significantTools.length,
      duration: trace.metadata.endTime - trace.metadata.startTime,
      timestamp: trace.metadata.startTime,
    };
  }

  /**
   * Maximal compression - absolute minimum data
   */
  private compressMaximal(trace: Trace): CompressedTrace {
    // Compress pattern to type abbreviation
    const typeAbbrev = this.getTraceTypeAbbreviation(trace.type);
    const pattern = `${typeAbbrev}:${trace.tools.length}`;

    return {
      pattern,
      summary: trace.type, // Just the type
      score: Math.round(trace.score * 10) / 10, // Round to 1 decimal
      toolCount: trace.tools.length,
      duration:
        Math.round((trace.metadata.endTime - trace.metadata.startTime) / 1000) *
        1000, // Round to seconds
      timestamp: trace.metadata.startTime,
    };
  }

  /**
   * Get abbreviated trace type
   */
  private getTraceTypeAbbreviation(type: TraceType): string {
    const abbreviations: Record<TraceType, string> = {
      [TraceType.SEARCH_DRIVEN]: 'SD',
      [TraceType.ERROR_RECOVERY]: 'ER',
      [TraceType.FEATURE_IMPLEMENTATION]: 'FI',
      [TraceType.REFACTORING]: 'RF',
      [TraceType.TESTING]: 'TS',
      [TraceType.EXPLORATION]: 'EX',
      [TraceType.DEBUGGING]: 'DB',
      [TraceType.DOCUMENTATION]: 'DC',
      [TraceType.BUILD_DEPLOY]: 'BD',
      [TraceType.UNKNOWN]: 'UN',
    };
    return abbreviations[type] || 'UN';
  }

  /**
   * Choose compression strategy based on trace age and importance
   */
  private selectCompressionStrategy(trace: Trace): CompressionStrategy {
    const ageHours = (Date.now() - trace.metadata.startTime) / (1000 * 60 * 60);
    const score = trace.score;

    // Recent and important: pattern-based
    if (ageHours < 24 && score > 0.7) {
      return CompressionStrategy.PATTERN_BASED;
    }

    // Recent but less important: selective
    if (ageHours < 24) {
      return CompressionStrategy.SELECTIVE;
    }

    // Old and important: selective
    if (ageHours < 168 && score > 0.5) {
      // 1 week
      return CompressionStrategy.SELECTIVE;
    }

    // Old and less important: summary only
    if (ageHours < 720) {
      // 30 days
      return CompressionStrategy.SUMMARY_ONLY;
    }

    // Very old: maximal compression
    return CompressionStrategy.FULL_COMPRESSION;
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
    return this.traces.filter((t) => t.type === type);
  }

  /**
   * Get high-importance traces
   */
  getHighImportanceTraces(threshold: number = 0.7): Trace[] {
    return this.traces.filter((t) => t.score >= threshold);
  }

  /**
   * Compress old traces with intelligent strategy selection
   */
  compressOldTraces(ageHours: number = 24): number {
    let compressed = 0;
    const now = Date.now();

    for (const trace of this.traces) {
      const age = (now - trace.metadata.startTime) / (1000 * 60 * 60);
      if (age > ageHours && !trace.compressed) {
        // Select compression strategy based on age and importance
        const strategy = this.selectCompressionStrategy(trace);
        trace.compressed = this.compressTrace(trace, strategy);

        // Remove full tool data for older traces to save memory
        if (
          strategy === CompressionStrategy.FULL_COMPRESSION ||
          strategy === CompressionStrategy.SUMMARY_ONLY
        ) {
          trace.tools = []; // Clear tool data for maximum compression
        } else if (strategy === CompressionStrategy.SELECTIVE) {
          // Keep only high-score tools
          trace.tools = trace.tools.filter((tool: any) => {
            const score = this.configManager.calculateScore(tool.tool, {
              filesAffected: tool.filesAffected?.length || 0,
              isPermanent: this.isPermanentChange(tool),
              referenceCount: 0,
            });
            return score >= 0.5;
          });
        }

        compressed++;

        // Update database if available
        if (this.traceStore) {
          try {
            this.traceStore.updateCompression(
              trace.id,
              trace.compressed,
              strategy
            );
          } catch (error: unknown) {
            console.error(
              'Failed to update trace compression in store:',
              error
            );
          }
        }
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
      stats.tracesByType[trace.type] =
        (stats.tracesByType[trace.type] || 0) + 1;

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
