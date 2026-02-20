/**
 * Enhanced Context Rehydration System
 * Addresses compact summary limitations with rich context recovery
 *
 * Includes CompactionHandler for Claude Code Autocompaction
 * Preserves critical context across token limit boundaries
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../monitoring/logger.js';
import { FrameManager } from './index.js';
import type { Anchor, Event } from './index.js';
import {
  getModelTokenLimit,
  DEFAULT_MODEL_TOKEN_LIMIT,
} from '../models/model-router.js';

// ============================================================================
// Compaction Handler Types
// ============================================================================

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

// ============================================================================
// Compaction Handler Class
// ============================================================================

export class CompactionHandler {
  private frameManager: FrameManager;
  private metrics: CompactionMetrics;
  private tokenAccumulator: number = 0;
  private preservedAnchors: Map<string, CriticalContextAnchor> = new Map();
  private modelTokenLimit: number;

  /**
   * @param frameManager - Frame manager instance
   * @param modelOrLimit - Model name string (looked up in MODEL_TOKEN_LIMITS)
   *                       or explicit numeric token limit.
   *                       Defaults to DEFAULT_MODEL_TOKEN_LIMIT (200K).
   *
   * Thresholds are derived from the model limit:
   *   warning  = 90% of limit
   *   critical = 95% of limit (auto-compact trigger)
   */
  constructor(frameManager: FrameManager, modelOrLimit?: string | number) {
    this.frameManager = frameManager;
    this.modelTokenLimit =
      typeof modelOrLimit === 'number'
        ? modelOrLimit
        : getModelTokenLimit(modelOrLimit ?? undefined);

    this.metrics = {
      estimatedTokens: 0,
      warningThreshold: Math.floor(this.modelTokenLimit * 0.9),
      criticalThreshold: Math.floor(this.modelTokenLimit * 0.95),
      anchorsPreserved: 0,
    };
  }

  /**
   * Get the resolved model token limit
   */
  getModelTokenLimit(): number {
    return this.modelTokenLimit;
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
        'CONSTRAINT',
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
    } catch (error: unknown) {
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

// ============================================================================
// Enhanced Rehydration Types
// ============================================================================

export interface FileSnapshot {
  path: string;
  content: string;
  size: number;
  lastModified: number;
  hash: string; // Quick change detection
  contextTags: string[]; // e.g., ['migration', 'pipedream', 'hubspot']
}

export interface StackTrace {
  error_message: string;
  stack_frames: string[];
  file_path?: string;
  line_number?: number;
  function_name?: string;
  timestamp: number;
  context: string; // What was being done when error occurred
  resolution_attempted?: string[];
  resolution_status: 'pending' | 'resolved' | 'workaround' | 'blocked';
}

export interface ConversationContext {
  timestamp: number;
  reasoning: string[];
  decisions_made: string[];
  next_steps: string[];
  user_preferences: Record<string, any>;
  pain_points: string[];
  stack_traces: StackTrace[];
  error_patterns: string[]; // Recurring error types
}

export interface ProjectMapping {
  file_relationships: Record<string, string[]>; // file -> related files
  workflow_sequences: string[][]; // sequences of files in workflows
  key_directories: string[];
  entry_points: string[];
  configuration_files: string[];
}

export interface RehydrationContext {
  session_id: string;
  compact_detected_at: number;
  pre_compact_state: {
    file_snapshots: FileSnapshot[];
    conversation_context: ConversationContext;
    project_mapping: ProjectMapping;
    active_workflows: string[];
    current_focus: string;
  };
  recovery_anchors: string[];
}

export class EnhancedRehydrationManager {
  private frameManager: FrameManager;
  private compactionHandler: CompactionHandler;
  private snapshotThreshold = 10; // Take snapshot every N significant events
  private eventCount = 0;
  private rehydrationStorage = new Map<string, RehydrationContext>();

  constructor(
    frameManager: FrameManager,
    compactionHandler: CompactionHandler
  ) {
    this.frameManager = frameManager;
    this.compactionHandler = compactionHandler;
    this.setupCompactDetection();
    this.initializeStackTraceStorage();
  }

  /**
   * Initialize dedicated stack trace storage in database
   */
  private initializeStackTraceStorage(): void {
    try {
      const db = (this.frameManager as any).db; // Access the underlying database

      // Create stack_traces table for persistent storage
      db.exec(`
        CREATE TABLE IF NOT EXISTS stack_traces (
          trace_id TEXT PRIMARY KEY,
          frame_id TEXT,
          project_id TEXT NOT NULL,
          error_message TEXT NOT NULL,
          stack_frames TEXT NOT NULL,
          file_path TEXT,
          line_number INTEGER,
          function_name TEXT,
          context TEXT,
          resolution_attempted TEXT,
          resolution_status TEXT NOT NULL DEFAULT 'pending',
          error_type TEXT,
          error_severity TEXT DEFAULT 'medium',
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY(frame_id) REFERENCES frames(frame_id)
        );

        CREATE INDEX IF NOT EXISTS idx_stack_traces_frame ON stack_traces(frame_id);
        CREATE INDEX IF NOT EXISTS idx_stack_traces_status ON stack_traces(resolution_status);
        CREATE INDEX IF NOT EXISTS idx_stack_traces_type ON stack_traces(error_type);
        CREATE INDEX IF NOT EXISTS idx_stack_traces_severity ON stack_traces(error_severity);
        CREATE INDEX IF NOT EXISTS idx_stack_traces_created ON stack_traces(created_at);
      `);

      logger.info('Stack trace storage initialized');
    } catch (error) {
      logger.error('Failed to initialize stack trace storage:', error);
    }
  }

  /**
   * Set up automatic compact detection and recovery
   */
  private setupCompactDetection(): void {
    // Monitor for compact indicators in new frames
    setInterval(() => this.checkForCompactionEvent(), 30000); // Check every 30s
  }

  /**
   * Enhanced file content snapshot with context
   */
  async captureFileSnapshot(
    filePath: string,
    contextTags: string[] = []
  ): Promise<FileSnapshot | null> {
    try {
      const stats = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf8');

      // Simple hash for change detection
      const hash = this.simpleHash(content);

      return {
        path: filePath,
        content: content,
        size: stats.size,
        lastModified: stats.mtimeMs,
        hash: hash,
        contextTags: contextTags,
      };
    } catch (error) {
      logger.warn(`Failed to capture snapshot for ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Capture conversation reasoning and decisions including stack traces
   */
  captureConversationContext(
    reasoning: string[],
    decisions: string[],
    nextSteps: string[] = [],
    userPrefs: Record<string, any> = {},
    painPoints: string[] = [],
    stackTraces: StackTrace[] = [],
    errorPatterns: string[] = []
  ): ConversationContext {
    return {
      timestamp: Date.now(),
      reasoning: reasoning,
      decisions_made: decisions,
      next_steps: nextSteps,
      user_preferences: userPrefs,
      pain_points: painPoints,
      stack_traces: stackTraces,
      error_patterns: errorPatterns,
    };
  }

  /**
   * Capture stack trace from error with context and store in database
   */
  captureStackTrace(
    error: Error | string,
    context: string,
    filePath?: string,
    resolutionAttempts: string[] = [],
    frameId?: string
  ): StackTrace {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const stackFrames =
      typeof error === 'string' ? [] : error.stack?.split('\n') || [];

    // Extract file path and line number from stack if not provided
    let extractedFilePath = filePath;
    let lineNumber: number | undefined;
    let functionName: string | undefined;

    if (stackFrames.length > 0) {
      const firstFrame = stackFrames.find((frame) => frame.includes('at '));
      if (firstFrame) {
        const match = firstFrame.match(/at (.+?) \((.+):(\d+):(\d+)\)/);
        if (match) {
          functionName = match[1];
          extractedFilePath = extractedFilePath || match[2];
          lineNumber = parseInt(match[3]);
        }
      }
    }

    const stackTrace: StackTrace = {
      error_message: errorMessage,
      stack_frames: stackFrames,
      file_path: extractedFilePath,
      line_number: lineNumber,
      function_name: functionName,
      timestamp: Date.now(),
      context: context,
      resolution_attempted: resolutionAttempts,
      resolution_status: 'pending',
    };

    // Store in database
    this.storeStackTrace(stackTrace, frameId);

    return stackTrace;
  }

  /**
   * Store stack trace in database
   */
  private storeStackTrace(stackTrace: StackTrace, frameId?: string): string {
    try {
      const db = (this.frameManager as any).db;
      const traceId = this.generateTraceId();
      const currentFrameId = frameId || this.frameManager.getCurrentFrameId();

      // Determine error type and severity
      const errorType = this.extractErrorType(stackTrace.error_message);
      const severity = this.determineErrorSeverity(stackTrace);

      const stmt = db.prepare(`
        INSERT INTO stack_traces (
          trace_id, frame_id, project_id, error_message, stack_frames,
          file_path, line_number, function_name, context, resolution_attempted,
          resolution_status, error_type, error_severity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        traceId,
        currentFrameId,
        (this.frameManager as any).projectId,
        stackTrace.error_message,
        JSON.stringify(stackTrace.stack_frames),
        stackTrace.file_path,
        stackTrace.line_number,
        stackTrace.function_name,
        stackTrace.context,
        JSON.stringify(stackTrace.resolution_attempted),
        stackTrace.resolution_status,
        errorType,
        severity
      );

      logger.info(`Stored stack trace ${traceId} for frame ${currentFrameId}`);
      return traceId;
    } catch (error) {
      logger.error('Failed to store stack trace:', error);
      return '';
    }
  }

  /**
   * Retrieve stack traces from database
   */
  public getStackTraces(frameId?: string, limit: number = 50): StackTrace[] {
    try {
      const db = (this.frameManager as any).db;
      const traces: StackTrace[] = [];

      let query: string;
      let params: any[];

      if (frameId) {
        query = `
          SELECT * FROM stack_traces 
          WHERE frame_id = ? 
          ORDER BY created_at DESC 
          LIMIT ?
        `;
        params = [frameId, limit];
      } else {
        query = `
          SELECT * FROM stack_traces 
          WHERE project_id = ? 
          ORDER BY created_at DESC 
          LIMIT ?
        `;
        params = [(this.frameManager as any).projectId, limit];
      }

      const rows = db.prepare(query).all(...params);

      for (const row of rows) {
        traces.push({
          error_message: row.error_message,
          stack_frames: JSON.parse(row.stack_frames || '[]'),
          file_path: row.file_path,
          line_number: row.line_number,
          function_name: row.function_name,
          timestamp: row.created_at * 1000, // Convert from unix to JS timestamp
          context: row.context,
          resolution_attempted: JSON.parse(row.resolution_attempted || '[]'),
          resolution_status: row.resolution_status,
        });
      }

      return traces;
    } catch (error) {
      logger.error('Failed to retrieve stack traces:', error);
      return [];
    }
  }

  /**
   * Update stack trace resolution status
   */
  public updateStackTraceStatus(
    traceId: string,
    status: StackTrace['resolution_status'],
    resolutionAttempts?: string[]
  ): boolean {
    try {
      const db = (this.frameManager as any).db;

      const stmt = db.prepare(`
        UPDATE stack_traces 
        SET resolution_status = ?, resolution_attempted = ?, updated_at = unixepoch()
        WHERE trace_id = ?
      `);

      const result = stmt.run(
        status,
        resolutionAttempts ? JSON.stringify(resolutionAttempts) : undefined,
        traceId
      );

      return result.changes > 0;
    } catch (error) {
      logger.error('Failed to update stack trace status:', error);
      return false;
    }
  }

  /**
   * Helper methods for stack trace processing
   */
  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private extractErrorType(errorMessage: string): string {
    const typeMatch = errorMessage.match(/^(\w+Error?):/);
    return typeMatch ? typeMatch[1] : 'Unknown';
  }

  private determineErrorSeverity(stackTrace: StackTrace): string {
    const message = stackTrace.error_message.toLowerCase();

    if (
      message.includes('critical') ||
      message.includes('fatal') ||
      message.includes('cannot read properties')
    ) {
      return 'high';
    } else if (message.includes('warning') || message.includes('deprecated')) {
      return 'low';
    } else {
      return 'medium';
    }
  }

  /**
   * Auto-detect project structure and relationships
   */
  async analyzeProjectMapping(workingDir: string): Promise<ProjectMapping> {
    const mapping: ProjectMapping = {
      file_relationships: {},
      workflow_sequences: [],
      key_directories: [],
      entry_points: [],
      configuration_files: [],
    };

    try {
      // Find configuration files
      const configPatterns = [
        'package.json',
        'tsconfig.json',
        '.env',
        'docker-compose.yml',
        '*.config.js',
        '*.config.ts',
        'Dockerfile',
        'README.md',
      ];

      // Analyze directory structure
      const files = await this.getDirectoryFiles(workingDir);

      for (const file of files) {
        const ext = path.extname(file);
        const basename = path.basename(file);

        // Identify configuration files
        if (
          configPatterns.some((pattern) =>
            pattern.includes('*')
              ? basename.includes(pattern.replace('*', ''))
              : basename === pattern
          )
        ) {
          mapping.configuration_files.push(file);
        }

        // Identify entry points
        if (
          basename === 'index.js' ||
          basename === 'index.ts' ||
          basename === 'main.js'
        ) {
          mapping.entry_points.push(file);
        }

        // Find related files based on naming patterns
        const filePrefix = basename.split('.')[0];
        const relatedFiles = files.filter(
          (f) => f !== file && path.basename(f).startsWith(filePrefix)
        );
        if (relatedFiles.length > 0) {
          mapping.file_relationships[file] = relatedFiles;
        }
      }

      // Identify key directories
      const dirs = files
        .map((f) => path.dirname(f))
        .filter((v, i, a) => a.indexOf(v) === i);
      mapping.key_directories = dirs.filter((dir) =>
        ['src', 'lib', 'components', 'pages', 'api', 'utils', 'types'].some(
          (key) => dir.includes(key)
        )
      );
    } catch (error) {
      logger.warn('Failed to analyze project mapping:', error);
    }

    return mapping;
  }

  /**
   * Create comprehensive rehydration context before compaction
   */
  async createRehydrationCheckpoint(): Promise<string> {
    const sessionId = this.frameManager.getSessionId() || 'unknown';
    const checkpointId = `${sessionId}_${Date.now()}`;

    try {
      // Get current working directory
      const workingDir = process.cwd();

      // Capture file snapshots for recently modified files
      const fileSnapshots: FileSnapshot[] = [];
      const recentFiles = await this.getRecentlyModifiedFiles(workingDir);

      for (const file of recentFiles.slice(0, 20)) {
        // Limit to 20 most recent
        const snapshot = await this.captureFileSnapshot(
          file,
          this.inferContextTags(file)
        );
        if (snapshot) {
          fileSnapshots.push(snapshot);
        }
      }

      // Capture project mapping
      const projectMapping = await this.analyzeProjectMapping(workingDir);

      // Extract conversation context from recent events
      const conversationContext = this.extractConversationContext();

      // Create rehydration context
      const rehydrationContext: RehydrationContext = {
        session_id: sessionId,
        compact_detected_at: Date.now(),
        pre_compact_state: {
          file_snapshots: fileSnapshots,
          conversation_context: conversationContext,
          project_mapping: projectMapping,
          active_workflows: this.detectActiveWorkflows(fileSnapshots),
          current_focus: this.inferCurrentFocus(
            fileSnapshots,
            conversationContext
          ),
        },
        recovery_anchors: this.createRecoveryAnchors(
          fileSnapshots,
          conversationContext
        ),
      };

      // Store for later retrieval
      this.rehydrationStorage.set(checkpointId, rehydrationContext);

      // Also persist to file system for cross-session recovery
      await this.persistRehydrationContext(checkpointId, rehydrationContext);

      logger.info(
        `Created rehydration checkpoint ${checkpointId} with ${fileSnapshots.length} file snapshots`
      );

      return checkpointId;
    } catch (error) {
      logger.error('Failed to create rehydration checkpoint:', error);
      throw error;
    }
  }

  /**
   * Inject rich context after compaction detection
   */
  async rehydrateContext(checkpointId?: string): Promise<boolean> {
    try {
      let context: RehydrationContext | undefined;

      if (checkpointId) {
        context = this.rehydrationStorage.get(checkpointId);
        if (!context) {
          context = await this.loadPersistedContext(checkpointId);
        }
      } else {
        // Find most recent context
        context = await this.findMostRecentContext();
      }

      if (!context) {
        logger.warn('No rehydration context available');
        return false;
      }

      await this.injectRichContext(context);
      return true;
    } catch (error) {
      logger.error('Failed to rehydrate context:', error);
      return false;
    }
  }

  /**
   * Inject rich context into current session
   */
  private async injectRichContext(context: RehydrationContext): Promise<void> {
    const frameId = this.frameManager.getCurrentFrameId();
    if (!frameId) {
      logger.warn('No active frame for context injection');
      return;
    }

    // Inject file context
    for (const snapshot of context.pre_compact_state.file_snapshots.slice(
      0,
      5
    )) {
      // Top 5 files
      this.frameManager.addAnchor(
        'FACT',
        `File: ${snapshot.path} (${snapshot.contextTags.join(', ')})\n` +
          `Last modified: ${new Date(snapshot.lastModified).toISOString()}\n` +
          `Size: ${snapshot.size} bytes\n` +
          `Content preview: ${this.getContentPreview(snapshot.content)}`,
        9,
        {
          rehydration: true,
          file_path: snapshot.path,
          context_tags: snapshot.contextTags,
        },
        frameId
      );
    }

    // Inject conversation context
    const conv = context.pre_compact_state.conversation_context;
    if (conv.decisions_made.length > 0) {
      this.frameManager.addAnchor(
        'DECISION',
        `Previous decisions: ${conv.decisions_made.join('; ')}`,
        8,
        { rehydration: true },
        frameId
      );
    }

    if (conv.next_steps.length > 0) {
      this.frameManager.addAnchor(
        'FACT',
        `Next steps identified: ${conv.next_steps.join('; ')}`,
        7,
        { rehydration: true },
        frameId
      );
    }

    // Inject stack trace context
    if (conv.stack_traces.length > 0) {
      for (const trace of conv.stack_traces.slice(0, 3)) {
        // Top 3 most recent errors
        this.frameManager.addAnchor(
          'ERROR',
          `Error context: ${trace.error_message}\n` +
            `Context: ${trace.context}\n` +
            `File: ${trace.file_path || 'unknown'}${trace.line_number ? `:${trace.line_number}` : ''}\n` +
            `Function: ${trace.function_name || 'unknown'}\n` +
            `Status: ${trace.resolution_status}\n` +
            `Stack preview: ${trace.stack_frames.slice(0, 3).join('\n')}`,
          9,
          {
            rehydration: true,
            error_type: trace.error_message.split(':')[0],
            resolution_status: trace.resolution_status,
            file_path: trace.file_path,
          },
          frameId
        );
      }
    }

    // Inject error patterns
    if (conv.error_patterns.length > 0) {
      this.frameManager.addAnchor(
        'PATTERN',
        `Recurring error patterns detected: ${conv.error_patterns.join(', ')}`,
        7,
        { rehydration: true },
        frameId
      );
    }

    // Inject project mapping
    const mapping = context.pre_compact_state.project_mapping;
    if (mapping.entry_points.length > 0) {
      this.frameManager.addAnchor(
        'FACT',
        `Project entry points: ${mapping.entry_points.join(', ')}`,
        6,
        { rehydration: true },
        frameId
      );
    }

    // Inject current focus
    if (context.pre_compact_state.current_focus) {
      this.frameManager.addAnchor(
        'CONSTRAINT',
        `Previous focus: ${context.pre_compact_state.current_focus}`,
        8,
        { rehydration: true },
        frameId
      );
    }

    logger.info('Rich context injected successfully');
  }

  // Helper methods
  private async getDirectoryFiles(dir: string): Promise<string[]> {
    // Implementation to recursively get files
    return []; // Simplified for now
  }

  private async getRecentlyModifiedFiles(dir: string): Promise<string[]> {
    // Implementation to get recently modified files
    return []; // Simplified for now
  }

  private inferContextTags(filePath: string): string[] {
    const tags: string[] = [];
    const content = filePath.toLowerCase();

    if (content.includes('pipeline') || content.includes('migrate'))
      tags.push('migration');
    if (content.includes('hubspot')) tags.push('hubspot');
    if (content.includes('pipedream')) tags.push('pipedream');
    if (content.includes('test')) tags.push('test');
    if (content.includes('config')) tags.push('configuration');

    return tags;
  }

  private extractConversationContext(): ConversationContext {
    // Extract from recent frame events
    const recentErrors = this.extractRecentStackTraces();
    const errorPatterns = this.detectErrorPatterns(recentErrors);

    return {
      timestamp: Date.now(),
      reasoning: [],
      decisions_made: [],
      next_steps: [],
      user_preferences: {},
      pain_points: [],
      stack_traces: recentErrors,
      error_patterns: errorPatterns,
    };
  }

  /**
   * Extract recent stack traces from database and frame events
   */
  private extractRecentStackTraces(): StackTrace[] {
    try {
      // Get recent stack traces from database (most reliable source)
      const dbTraces = this.getStackTraces(undefined, 10);

      // Also check frame events for additional traces
      const eventTraces = this.extractStackTracesFromFrameEvents();

      // Combine and deduplicate
      const allTraces = [...dbTraces, ...eventTraces];

      // Remove duplicates based on error message and file path
      const uniqueTraces = allTraces.filter(
        (trace, index, array) =>
          array.findIndex(
            (t) =>
              t.error_message === trace.error_message &&
              t.file_path === trace.file_path
          ) === index
      );

      // Sort by timestamp (newest first) and return top 5
      return uniqueTraces.sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
    } catch (error) {
      logger.warn('Failed to extract stack traces:', error);
      return [];
    }
  }

  /**
   * Extract stack traces from frame events (fallback method)
   */
  private extractStackTracesFromFrameEvents(): StackTrace[] {
    const traces: StackTrace[] = [];

    try {
      // Get recent frames and look for error events
      const frames = this.frameManager.getActiveFramePath();

      for (const frame of frames.slice(-3)) {
        // Check last 3 frames
        const frameData = this.frameManager.getFrame(frame.frame_id);
        if (frameData?.events) {
          for (const event of frameData.events) {
            if (event.type === 'error' || event.type === 'exception') {
              const trace = this.parseStackTraceFromEvent(event);
              if (trace) {
                traces.push(trace);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to extract frame event traces:', error);
    }

    return traces;
  }

  /**
   * Parse stack trace from frame event
   */
  private parseStackTraceFromEvent(event: any): StackTrace | null {
    try {
      const data =
        typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

      return {
        error_message: data.error || data.message || 'Unknown error',
        stack_frames: data.stack ? data.stack.split('\n') : [],
        file_path: data.file || data.fileName,
        line_number: data.line || data.lineNumber,
        function_name: data.function || data.functionName,
        timestamp: event.timestamp || Date.now(),
        context: data.context || 'Error occurred during frame processing',
        resolution_attempted: data.resolutionAttempts || [],
        resolution_status: data.resolved ? 'resolved' : 'pending',
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect recurring error patterns
   */
  private detectErrorPatterns(traces: StackTrace[]): string[] {
    const patterns = new Map<string, number>();

    for (const trace of traces) {
      // Extract error type from message
      const errorType = trace.error_message.split(':')[0].trim();
      patterns.set(errorType, (patterns.get(errorType) || 0) + 1);
    }

    // Return patterns that occur more than once
    return Array.from(patterns.entries())
      .filter(([, count]) => count > 1)
      .map(([pattern]) => pattern);
  }

  private detectActiveWorkflows(snapshots: FileSnapshot[]): string[] {
    const workflows: string[] = [];

    for (const snapshot of snapshots) {
      if (snapshot.contextTags.includes('migration')) {
        workflows.push('data_migration');
      }
      if (snapshot.path.includes('test')) {
        workflows.push('testing');
      }
    }

    return [...new Set(workflows)];
  }

  private inferCurrentFocus(
    snapshots: FileSnapshot[],
    context: ConversationContext
  ): string {
    // Analyze recent file activity and conversation to infer focus
    if (snapshots.some((s) => s.contextTags.includes('migration'))) {
      return 'Data migration and transformation';
    }
    if (snapshots.some((s) => s.path.includes('test'))) {
      return 'Testing and validation';
    }
    return 'Development';
  }

  private createRecoveryAnchors(
    snapshots: FileSnapshot[],
    context: ConversationContext
  ): string[] {
    const anchors: string[] = [];

    // Create anchor points for each significant file
    for (const snapshot of snapshots.slice(0, 3)) {
      anchors.push(
        `File context: ${snapshot.path} with ${snapshot.contextTags.join(', ')}`
      );
    }

    return anchors;
  }

  private async persistRehydrationContext(
    id: string,
    context: RehydrationContext
  ): Promise<void> {
    // Implementation to persist context to filesystem
    const contextDir = path.join(process.cwd(), '.stackmemory', 'rehydration');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(
      path.join(contextDir, `${id}.json`),
      JSON.stringify(context, null, 2)
    );
  }

  private async loadPersistedContext(
    id: string
  ): Promise<RehydrationContext | undefined> {
    try {
      const contextPath = path.join(
        process.cwd(),
        '.stackmemory',
        'rehydration',
        `${id}.json`
      );
      const content = await fs.readFile(contextPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  private async findMostRecentContext(): Promise<
    RehydrationContext | undefined
  > {
    // Find most recent persisted context
    return undefined; // Simplified for now
  }

  private checkForCompactionEvent(): void {
    // Check if compaction occurred and trigger rehydration
    if (this.compactionHandler.detectCompactionEvent('')) {
      this.rehydrateContext();
    }
  }

  private simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  private getContentPreview(content: string, maxLength = 200): string {
    return content.length > maxLength
      ? content.substring(0, maxLength) + '...'
      : content;
  }
}
