/**
 * Hybrid Digest Generator
 * Implements 80/20 split: deterministic extraction + AI review/insights
 */

import Database from 'better-sqlite3';
import {
  HybridDigest,
  DeterministicDigest,
  AIGeneratedDigest,
  DigestConfig,
  DigestInput,
  DigestGenerationRequest,
  DigestQueueStats,
  DigestLLMProvider,
  DigestStatus,
  FileModification,
  TestResult,
  ErrorInfo,
  DEFAULT_DIGEST_CONFIG,
} from './types.js';
import { Frame, Anchor, Event } from '../context/frame-manager.js';
import { logger } from '../monitoring/logger.js';

/**
 * Hybrid Digest Generator
 * Generates 80% deterministic + 20% AI review for frames
 */
export class HybridDigestGenerator {
  protected db: Database.Database;
  protected config: DigestConfig;
  protected llmProvider?: DigestLLMProvider;
  private queue: DigestGenerationRequest[] = [];
  private processing: boolean = false;
  private idleTimer?: NodeJS.Timeout;
  private stats: DigestQueueStats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    avgProcessingTimeMs: 0,
  };

  constructor(
    db: Database.Database,
    config: Partial<DigestConfig> = {},
    llmProvider?: DigestLLMProvider
  ) {
    this.db = db;
    this.config = { ...DEFAULT_DIGEST_CONFIG, ...config };
    this.llmProvider = llmProvider;
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS digest_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        frame_id TEXT NOT NULL UNIQUE,
        frame_name TEXT NOT NULL,
        frame_type TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_digest_queue_status ON digest_queue(status);
      CREATE INDEX IF NOT EXISTS idx_digest_queue_priority ON digest_queue(priority, created_at);
    `);
  }

  /**
   * Generate digest for a frame (immediate deterministic, queued AI)
   */
  public generateDigest(input: DigestInput): HybridDigest {
    const startTime = Date.now();

    // 1. Generate deterministic fields (60%) - always immediate
    const deterministic = this.extractDeterministicFields(input);

    // 2. Generate initial text summary from deterministic data
    const text = this.generateDeterministicText(input.frame, deterministic);

    // 3. Create the hybrid digest
    const digest: HybridDigest = {
      frameId: input.frame.frame_id,
      frameName: input.frame.name,
      frameType: input.frame.type,
      deterministic,
      status: 'deterministic_only',
      text,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 4. Queue for AI generation if enabled
    if (this.config.enableAIGeneration && this.llmProvider) {
      this.queueForAIGeneration({
        frameId: input.frame.frame_id,
        frameName: input.frame.name,
        frameType: input.frame.type,
        priority: this.determinePriority(input),
        createdAt: Date.now(),
        retryCount: 0,
        maxRetries: this.config.maxRetries,
      });
      digest.status = 'ai_pending';
    }

    logger.debug('Generated deterministic digest', {
      frameId: input.frame.frame_id,
      durationMs: Date.now() - startTime,
      aiQueued: digest.status === 'ai_pending',
    });

    return digest;
  }

  /**
   * Extract deterministic fields from frame data (60%)
   */
  private extractDeterministicFields(input: DigestInput): DeterministicDigest {
    const { frame, anchors, events } = input;

    // Extract files modified from events
    const filesModified = this.extractFilesModified(events);

    // Extract test results
    const testsRun = this.extractTestResults(events);

    // Extract errors
    const errorsEncountered = this.extractErrors(events);

    // Count tool calls by type
    const toolCalls = events.filter((e) => e.event_type === 'tool_call');
    const toolCallsByType: Record<string, number> = {};
    for (const tc of toolCalls) {
      const toolName = tc.payload?.tool_name || 'unknown';
      toolCallsByType[toolName] = (toolCallsByType[toolName] || 0) + 1;
    }

    // Count anchors by type
    const anchorCounts: Record<string, number> = {};
    for (const anchor of anchors) {
      anchorCounts[anchor.type] = (anchorCounts[anchor.type] || 0) + 1;
    }

    // Extract decisions, constraints, risks
    const decisions = anchors
      .filter((a) => a.type === 'DECISION')
      .map((a) => a.text);
    const constraints = anchors
      .filter((a) => a.type === 'CONSTRAINT')
      .map((a) => a.text);
    const risks = anchors.filter((a) => a.type === 'RISK').map((a) => a.text);

    // Calculate duration
    const durationSeconds = frame.closed_at
      ? frame.closed_at - frame.created_at
      : Math.floor(Date.now() / 1000 - frame.created_at);

    // Determine exit status
    const exitStatus = this.determineExitStatus(frame, errorsEncountered);

    return {
      filesModified,
      testsRun,
      errorsEncountered,
      toolCallCount: toolCalls.length,
      toolCallsByType,
      durationSeconds,
      exitStatus,
      anchorCounts,
      decisions,
      constraints,
      risks,
    };
  }

  private extractFilesModified(events: Event[]): FileModification[] {
    const fileMap = new Map<string, FileModification>();

    for (const event of events) {
      if (
        event.event_type === 'tool_call' ||
        event.event_type === 'tool_result'
      ) {
        const payload = event.payload || {};

        // Handle various tool patterns
        const filePath = payload.file_path || payload.path || payload.file;
        if (filePath && typeof filePath === 'string') {
          const toolName = payload.tool_name || '';
          let operation: FileModification['operation'] = 'read';

          if (
            toolName.includes('write') ||
            toolName.includes('edit') ||
            toolName.includes('create')
          ) {
            operation = 'modify';
          } else if (
            toolName.includes('delete') ||
            toolName.includes('remove')
          ) {
            operation = 'delete';
          } else if (
            toolName.includes('read') ||
            toolName.includes('cat') ||
            toolName.includes('view')
          ) {
            operation = 'read';
          }

          const existing = fileMap.get(filePath);
          if (
            !existing ||
            this.operationPriority(operation) >
              this.operationPriority(existing.operation)
          ) {
            fileMap.set(filePath, {
              path: filePath,
              operation,
              linesChanged: payload.lines_changed,
            });
          }
        }

        // Handle filesAffected array
        const filesAffected = payload.filesAffected || payload.files_affected;
        if (Array.isArray(filesAffected)) {
          for (const f of filesAffected) {
            if (typeof f === 'string' && !fileMap.has(f)) {
              fileMap.set(f, { path: f, operation: 'modify' });
            }
          }
        }
      }
    }

    return Array.from(fileMap.values());
  }

  private operationPriority(op: FileModification['operation']): number {
    const priorities = { delete: 4, create: 3, modify: 2, read: 1 };
    return priorities[op] || 0;
  }

  private extractTestResults(events: Event[]): TestResult[] {
    const tests: TestResult[] = [];

    for (const event of events) {
      const payload = event.payload || {};

      // Look for test-related events
      if (
        payload.tool_name?.includes('test') ||
        payload.command?.includes('test') ||
        payload.test_name
      ) {
        const testName = payload.test_name || payload.command || 'unknown test';
        const success = payload.success !== false && !payload.error;

        tests.push({
          name: testName,
          status: success ? 'passed' : 'failed',
          duration: payload.duration,
        });
      }

      // Parse test output for results
      const output = payload.output || payload.result;
      if (typeof output === 'string') {
        // Match common test output patterns
        const passMatch = output.match(/(\d+)\s*(?:tests?\s*)?passed/i);
        const failMatch = output.match(/(\d+)\s*(?:tests?\s*)?failed/i);

        if (passMatch || failMatch) {
          const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
          const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

          if (passed > 0) {
            tests.push({ name: `${passed} tests`, status: 'passed' });
          }
          if (failed > 0) {
            tests.push({ name: `${failed} tests`, status: 'failed' });
          }
        }
      }
    }

    return tests;
  }

  private extractErrors(events: Event[]): ErrorInfo[] {
    const errorMap = new Map<string, ErrorInfo>();

    for (const event of events) {
      const payload = event.payload || {};

      // Check for explicit errors
      if (payload.error || payload.success === false) {
        const errorType = payload.error_type || 'UnknownError';
        const message =
          payload.error?.message || payload.error || 'Unknown error';

        const key = `${errorType}:${message.substring(0, 50)}`;
        const existing = errorMap.get(key);

        if (existing) {
          existing.count++;
        } else {
          errorMap.set(key, {
            type: errorType,
            message: String(message).substring(0, 200),
            resolved: false,
            count: 1,
          });
        }
      }
    }

    // Mark errors as resolved if there's a subsequent success
    // (simplified heuristic)
    return Array.from(errorMap.values());
  }

  private determineExitStatus(
    frame: Frame,
    errors: ErrorInfo[]
  ): DeterministicDigest['exitStatus'] {
    // Frame state is 'active' or 'closed', check outputs for cancellation
    const outputs = frame.outputs || {};
    if (outputs.cancelled || outputs.status === 'cancelled') return 'cancelled';
    if (errors.length === 0) return 'success';
    if (errors.some((e) => !e.resolved)) return 'failure';
    return 'partial';
  }

  /**
   * Generate text summary from deterministic data
   */
  private generateDeterministicText(
    frame: Frame,
    det: DeterministicDigest
  ): string {
    const parts: string[] = [];

    // Header
    parts.push(`## ${frame.name} (${frame.type})`);
    parts.push(`Status: ${det.exitStatus}`);

    // Duration
    if (det.durationSeconds > 0) {
      const mins = Math.floor(det.durationSeconds / 60);
      const secs = det.durationSeconds % 60;
      parts.push(`Duration: ${mins}m ${secs}s`);
    }

    // Files
    if (det.filesModified.length > 0) {
      parts.push(`\n### Files Modified (${det.filesModified.length})`);
      for (const f of det.filesModified.slice(0, 10)) {
        parts.push(`- ${f.operation}: ${f.path}`);
      }
      if (det.filesModified.length > 10) {
        parts.push(`  ...and ${det.filesModified.length - 10} more`);
      }
    }

    // Tool calls
    if (det.toolCallCount > 0) {
      parts.push(`\n### Tool Calls (${det.toolCallCount})`);
      const sorted = Object.entries(det.toolCallsByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      for (const [tool, count] of sorted) {
        parts.push(`- ${tool}: ${count}`);
      }
    }

    // Decisions
    if (det.decisions.length > 0) {
      parts.push(`\n### Decisions (${det.decisions.length})`);
      for (const d of det.decisions.slice(0, 5)) {
        parts.push(`- ${d}`);
      }
    }

    // Constraints
    if (det.constraints.length > 0) {
      parts.push(`\n### Constraints (${det.constraints.length})`);
      for (const c of det.constraints.slice(0, 3)) {
        parts.push(`- ${c}`);
      }
    }

    // Errors
    if (det.errorsEncountered.length > 0) {
      parts.push(`\n### Errors (${det.errorsEncountered.length})`);
      for (const e of det.errorsEncountered.slice(0, 3)) {
        parts.push(`- ${e.type}: ${e.message.substring(0, 80)}`);
      }
    }

    // Tests
    if (det.testsRun.length > 0) {
      const passed = det.testsRun.filter((t) => t.status === 'passed').length;
      const failed = det.testsRun.filter((t) => t.status === 'failed').length;
      parts.push(`\n### Tests: ${passed} passed, ${failed} failed`);
    }

    return parts.join('\n');
  }

  /**
   * Queue frame for AI generation
   */
  private queueForAIGeneration(request: DigestGenerationRequest): void {
    try {
      this.db
        .prepare(
          `
          INSERT OR REPLACE INTO digest_queue 
          (frame_id, frame_name, frame_type, priority, status, retry_count, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `
        )
        .run(
          request.frameId,
          request.frameName,
          request.frameType,
          request.priority,
          request.retryCount,
          Math.floor(request.createdAt / 1000)
        );

      this.stats.pending++;
      this.scheduleIdleProcessing();

      logger.debug('Queued frame for AI digest generation', {
        frameId: request.frameId,
        priority: request.priority,
      });
    } catch (error: any) {
      logger.error('Failed to queue digest generation', error);
    }
  }

  /**
   * Determine priority based on frame characteristics
   */
  private determinePriority(
    input: DigestInput
  ): DigestGenerationRequest['priority'] {
    const { frame, anchors, events } = input;

    // High priority for frames with many decisions or errors
    const decisionCount = anchors.filter((a) => a.type === 'DECISION').length;
    const errorCount = events.filter(
      (e) => e.payload?.error || e.payload?.success === false
    ).length;

    if (decisionCount >= 3 || errorCount >= 2) return 'high';
    if (decisionCount >= 1 || events.length >= 20) return 'normal';
    return 'low';
  }

  /**
   * Schedule idle-time processing
   */
  private scheduleIdleProcessing(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.processQueue();
    }, this.config.idleThresholdMs);
  }

  /**
   * Process queued AI generation requests
   */
  public async processQueue(): Promise<void> {
    if (this.processing || !this.llmProvider) return;

    this.processing = true;

    try {
      // Get pending items ordered by priority and age
      const pending = this.db
        .prepare(
          `
          SELECT * FROM digest_queue 
          WHERE status = 'pending' 
          ORDER BY 
            CASE priority 
              WHEN 'high' THEN 1 
              WHEN 'normal' THEN 2 
              WHEN 'low' THEN 3 
            END,
            created_at ASC
          LIMIT ?
        `
        )
        .all(this.config.batchSize) as any[];

      for (const item of pending) {
        await this.processQueueItem(item);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processQueueItem(item: any): Promise<void> {
    const startTime = Date.now();

    try {
      // Mark as processing
      this.db
        .prepare(
          `UPDATE digest_queue SET status = 'processing', updated_at = unixepoch() WHERE frame_id = ?`
        )
        .run(item.frame_id);

      this.stats.processing++;
      this.stats.pending--;

      // Get frame data
      const frame = this.db
        .prepare(`SELECT * FROM frames WHERE frame_id = ?`)
        .get(item.frame_id) as any;

      if (!frame) {
        throw new Error(`Frame not found: ${item.frame_id}`);
      }

      const anchors = this.db
        .prepare(`SELECT * FROM anchors WHERE frame_id = ?`)
        .all(item.frame_id) as Anchor[];

      const events = this.db
        .prepare(`SELECT * FROM events WHERE frame_id = ? ORDER BY ts ASC`)
        .all(item.frame_id) as Event[];

      // Parse JSON fields
      const parsedFrame: Frame = {
        ...frame,
        inputs: JSON.parse(frame.inputs || '{}'),
        outputs: JSON.parse(frame.outputs || '{}'),
        digest_json: JSON.parse(frame.digest_json || '{}'),
      };

      const input: DigestInput = {
        frame: parsedFrame,
        anchors: anchors.map((a: any) => ({
          ...a,
          metadata: JSON.parse(a.metadata || '{}'),
        })),
        events: events.map((e: any) => ({
          ...e,
          payload: JSON.parse(e.payload || '{}'),
        })),
      };

      // Generate deterministic first (needed for AI context)
      const deterministic = this.extractDeterministicFields(input);

      // Generate AI summary
      const aiGenerated = await this.llmProvider!.generateSummary(
        input,
        deterministic,
        this.config.maxTokens
      );

      // Update digest in frames table
      const existingDigest = parsedFrame.digest_json || {};
      const updatedDigest = {
        ...existingDigest,
        aiGenerated,
        status: 'complete',
        updatedAt: Date.now(),
      };

      // Generate enhanced text with AI summary
      const enhancedText = this.generateEnhancedText(
        parsedFrame,
        deterministic,
        aiGenerated
      );

      this.db
        .prepare(
          `
          UPDATE frames 
          SET digest_json = ?, digest_text = ?
          WHERE frame_id = ?
        `
        )
        .run(JSON.stringify(updatedDigest), enhancedText, item.frame_id);

      // Mark as completed
      this.db
        .prepare(
          `UPDATE digest_queue SET status = 'completed', updated_at = unixepoch() WHERE frame_id = ?`
        )
        .run(item.frame_id);

      this.stats.processing--;
      this.stats.completed++;

      // Update average processing time
      const processingTime = Date.now() - startTime;
      this.stats.avgProcessingTimeMs =
        (this.stats.avgProcessingTimeMs * (this.stats.completed - 1) +
          processingTime) /
        this.stats.completed;

      logger.info('Generated AI digest', {
        frameId: item.frame_id,
        processingTimeMs: processingTime,
      });
    } catch (error: any) {
      // Handle retry logic
      const newRetryCount = item.retry_count + 1;

      if (newRetryCount < this.config.maxRetries) {
        this.db
          .prepare(
            `
            UPDATE digest_queue 
            SET status = 'pending', retry_count = ?, error_message = ?, updated_at = unixepoch()
            WHERE frame_id = ?
          `
          )
          .run(newRetryCount, error.message, item.frame_id);

        this.stats.processing--;
        this.stats.pending++;

        logger.warn('AI digest generation failed, will retry', {
          frameId: item.frame_id,
          retryCount: newRetryCount,
          error: error.message,
        });
      } else {
        // Mark as failed
        this.db
          .prepare(
            `
            UPDATE digest_queue 
            SET status = 'failed', error_message = ?, updated_at = unixepoch()
            WHERE frame_id = ?
          `
          )
          .run(error.message, item.frame_id);

        this.stats.processing--;
        this.stats.failed++;

        logger.error('AI digest generation failed permanently', error, {
          frameId: item.frame_id,
        });
      }
    }
  }

  /**
   * Generate enhanced text with AI review (20%)
   */
  private generateEnhancedText(
    frame: Frame,
    det: DeterministicDigest,
    ai: AIGeneratedDigest
  ): string {
    const parts: string[] = [];

    // Deterministic content first (80%)
    parts.push(this.generateDeterministicText(frame, det));

    // AI review section (20%) - compact
    parts.push(`\n---`);
    parts.push(`**AI Review**: ${ai.summary}`);

    if (ai.insight) {
      parts.push(`**Insight**: ${ai.insight}`);
    }

    if (ai.flaggedIssue) {
      parts.push(`**Flag**: ${ai.flaggedIssue}`);
    }

    return parts.join('\n');
  }

  /**
   * Get queue statistics
   */
  public getStats(): DigestQueueStats {
    return { ...this.stats };
  }

  /**
   * Set LLM provider
   */
  public setLLMProvider(provider: DigestLLMProvider): void {
    this.llmProvider = provider;
  }

  /**
   * Force process queue (for testing or manual trigger)
   */
  public async forceProcessQueue(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    await this.processQueue();
  }

  /**
   * Get digest for a frame
   */
  public getDigest(frameId: string): HybridDigest | null {
    const frame = this.db
      .prepare(`SELECT * FROM frames WHERE frame_id = ?`)
      .get(frameId) as any;

    if (!frame) return null;

    const digestJson = JSON.parse(frame.digest_json || '{}');
    const anchors = this.db
      .prepare(`SELECT * FROM anchors WHERE frame_id = ?`)
      .all(frameId) as any[];
    const events = this.db
      .prepare(`SELECT * FROM events WHERE frame_id = ?`)
      .all(frameId) as any[];

    const parsedFrame: Frame = {
      ...frame,
      inputs: JSON.parse(frame.inputs || '{}'),
      outputs: JSON.parse(frame.outputs || '{}'),
      digest_json: digestJson,
    };

    const input: DigestInput = {
      frame: parsedFrame,
      anchors: anchors.map((a) => ({
        ...a,
        metadata: JSON.parse(a.metadata || '{}'),
      })),
      events: events.map((e) => ({
        ...e,
        payload: JSON.parse(e.payload || '{}'),
      })),
    };

    const deterministic = this.extractDeterministicFields(input);

    // Check queue status
    const queueItem = this.db
      .prepare(`SELECT status FROM digest_queue WHERE frame_id = ?`)
      .get(frameId) as any;

    let status: DigestStatus = 'deterministic_only';
    if (digestJson.aiGenerated) {
      status = 'complete';
    } else if (queueItem) {
      status =
        queueItem.status === 'processing'
          ? 'ai_processing'
          : queueItem.status === 'failed'
            ? 'ai_failed'
            : 'ai_pending';
    }

    return {
      frameId: frame.frame_id,
      frameName: frame.name,
      frameType: frame.type,
      deterministic,
      aiGenerated: digestJson.aiGenerated,
      status,
      text:
        frame.digest_text ||
        this.generateDeterministicText(parsedFrame, deterministic),
      version: 1,
      createdAt: frame.created_at * 1000,
      updatedAt: digestJson.updatedAt || frame.created_at * 1000,
    };
  }
}
