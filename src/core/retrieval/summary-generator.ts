/**
 * Compressed Summary Generator
 * Creates compact summaries of project memory for LLM analysis
 */

import Database from 'better-sqlite3';
import {
  FrameManager,
  Frame,
  Anchor,
  Event,
} from '../context/frame-manager.js';
import { TraceDetector } from '../trace/trace-detector.js';
import {
  CompressedSummary,
  RecentSessionSummary,
  HistoricalPatterns,
  QueryableIndices,
  SummaryStats,
  FrameSummary,
  OperationSummary,
  FileSummary,
  ErrorSummary,
  DecisionSummary,
  IssueSummary,
  ToolSequence,
  ActivityPattern,
  RetrievalConfig,
  DEFAULT_RETRIEVAL_CONFIG,
} from './types.js';
import { logger } from '../monitoring/logger.js';

export class CompressedSummaryGenerator {
  private db: Database.Database;
  private frameManager: FrameManager;
  private traceDetector?: TraceDetector;
  private projectId: string;
  private config: RetrievalConfig;
  private cache: Map<
    string,
    { summary: CompressedSummary; expiresAt: number }
  > = new Map();

  constructor(
    db: Database.Database,
    frameManager: FrameManager,
    projectId: string,
    config: Partial<RetrievalConfig> = {},
    traceDetector?: TraceDetector
  ) {
    this.db = db;
    this.frameManager = frameManager;
    this.projectId = projectId;
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    this.traceDetector = traceDetector;
  }

  /**
   * Generate a compressed summary for LLM analysis
   */
  public generateSummary(
    options: {
      maxFrames?: number;
      timeRangeHours?: number;
      forceRefresh?: boolean;
    } = {}
  ): CompressedSummary {
    const cacheKey = `summary_${this.projectId}_${options.maxFrames || this.config.maxSummaryFrames}`;

    // Check cache
    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.debug('Using cached summary', { projectId: this.projectId });
        return cached.summary;
      }
    }

    const startTime = Date.now();
    const maxFrames = options.maxFrames || this.config.maxSummaryFrames;
    const timeRangeHours = options.timeRangeHours || 24;

    // Generate all components
    const recentSession = this.generateRecentSessionSummary(
      maxFrames,
      timeRangeHours
    );
    const historicalPatterns = this.generateHistoricalPatterns();
    const queryableIndices = this.generateQueryableIndices();
    const stats = this.generateStats();

    const summary: CompressedSummary = {
      projectId: this.projectId,
      generatedAt: Date.now(),
      recentSession,
      historicalPatterns,
      queryableIndices,
      stats,
    };

    // Cache the result
    this.cache.set(cacheKey, {
      summary,
      expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
    });

    logger.info('Generated compressed summary', {
      projectId: this.projectId,
      frames: recentSession.frames.length,
      generationTimeMs: Date.now() - startTime,
    });

    return summary;
  }

  /**
   * Generate recent session summary
   */
  private generateRecentSessionSummary(
    maxFrames: number,
    timeRangeHours: number
  ): RecentSessionSummary {
    const cutoffTime = Math.floor(Date.now() / 1000) - timeRangeHours * 3600;

    // Get recent frames
    const frames = this.getRecentFrames(maxFrames, cutoffTime);
    const frameSummaries = frames.map((f) => this.summarizeFrame(f));

    // Get dominant operations
    const dominantOperations = this.getDominantOperations(cutoffTime);

    // Get files touched
    const filesTouched = this.getFilesTouched(cutoffTime);

    // Get errors encountered
    const errorsEncountered = this.getErrorsEncountered(cutoffTime);

    // Calculate time range
    const timestamps = frames.map((f) => f.created_at).filter((t) => t);
    const start = timestamps.length > 0 ? Math.min(...timestamps) : cutoffTime;
    const end =
      timestamps.length > 0
        ? Math.max(...timestamps)
        : Math.floor(Date.now() / 1000);

    return {
      frames: frameSummaries,
      dominantOperations,
      filesTouched,
      errorsEncountered,
      timeRange: {
        start: start * 1000,
        end: end * 1000,
        durationMs: (end - start) * 1000,
      },
    };
  }

  /**
   * Generate historical patterns
   */
  private generateHistoricalPatterns(): HistoricalPatterns {
    return {
      topicFrameCounts: this.getTopicFrameCounts(),
      keyDecisions: this.getKeyDecisions(),
      recurringIssues: this.getRecurringIssues(),
      commonToolSequences: this.getCommonToolSequences(),
      activityPatterns: this.getActivityPatterns(),
    };
  }

  /**
   * Generate queryable indices
   */
  private generateQueryableIndices(): QueryableIndices {
    return {
      byErrorType: this.indexByErrorType(),
      byTimeframe: this.indexByTimeframe(),
      byContributor: this.indexByContributor(),
      byTopic: this.indexByTopic(),
      byFile: this.indexByFile(),
    };
  }

  /**
   * Generate summary statistics
   */
  private generateStats(): SummaryStats {
    try {
      const frameStats =
        (this.db
          .prepare(
            `
        SELECT 
          COUNT(*) as totalFrames,
          MIN(created_at) as oldestFrame,
          MAX(created_at) as newestFrame,
          AVG(depth) as avgDepth
        FROM frames
        WHERE project_id = ?
      `
          )
          .get(this.projectId) as any) || {};

      const eventCount = (this.db
        .prepare(
          `
        SELECT COUNT(*) as count FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ?
      `
        )
        .get(this.projectId) as any) || { count: 0 };

      const anchorCount = (this.db
        .prepare(
          `
        SELECT COUNT(*) as count FROM anchors a
        JOIN frames f ON a.frame_id = f.frame_id
        WHERE f.project_id = ?
      `
        )
        .get(this.projectId) as any) || { count: 0 };

      const decisionCount = (this.db
        .prepare(
          `
        SELECT COUNT(*) as count FROM anchors a
        JOIN frames f ON a.frame_id = f.frame_id
        WHERE f.project_id = ? AND a.type = 'DECISION'
      `
        )
        .get(this.projectId) as any) || { count: 0 };

      const totalFrames = frameStats.totalFrames || 0;

      return {
        totalFrames,
        totalEvents: eventCount.count || 0,
        totalAnchors: anchorCount.count || 0,
        totalDecisions: decisionCount.count || 0,
        oldestFrame: (frameStats.oldestFrame || 0) * 1000,
        newestFrame: (frameStats.newestFrame || 0) * 1000,
        avgFrameDepth: frameStats.avgDepth || 0,
        avgEventsPerFrame:
          totalFrames > 0 ? (eventCount.count || 0) / totalFrames : 0,
      };
    } catch (error) {
      logger.warn('Error generating stats, using defaults', { error });
      return {
        totalFrames: 0,
        totalEvents: 0,
        totalAnchors: 0,
        totalDecisions: 0,
        oldestFrame: 0,
        newestFrame: 0,
        avgFrameDepth: 0,
        avgEventsPerFrame: 0,
      };
    }
  }

  // Helper methods for recent session

  private getRecentFrames(limit: number, cutoffTime: number): Frame[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT * FROM frames
        WHERE project_id = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `
        )
        .all(this.projectId, cutoffTime, limit) as any[];

      return rows.map((row) => ({
        ...row,
        inputs: JSON.parse(row.inputs || '{}'),
        outputs: JSON.parse(row.outputs || '{}'),
        digest_json: JSON.parse(row.digest_json || '{}'),
      }));
    } catch {
      return [];
    }
  }

  private summarizeFrame(frame: Frame): FrameSummary {
    // Get event count
    const eventCount = (this.db
      .prepare(
        `
      SELECT COUNT(*) as count FROM events WHERE frame_id = ?
    `
      )
      .get(frame.frame_id) as any) || { count: 0 };

    // Get anchor count
    const anchorCount = (this.db
      .prepare(
        `
      SELECT COUNT(*) as count FROM anchors WHERE frame_id = ?
    `
      )
      .get(frame.frame_id) as any) || { count: 0 };

    // Calculate score based on activity
    const score = this.calculateFrameScore(
      frame,
      eventCount.count,
      anchorCount.count
    );

    return {
      frameId: frame.frame_id,
      name: frame.name,
      type: frame.type,
      depth: frame.depth,
      eventCount: eventCount.count,
      anchorCount: anchorCount.count,
      score,
      createdAt: frame.created_at * 1000,
      closedAt: frame.closed_at ? frame.closed_at * 1000 : undefined,
      digestPreview: frame.digest_text?.substring(0, 100),
    };
  }

  private calculateFrameScore(
    frame: Frame,
    eventCount: number,
    anchorCount: number
  ): number {
    let score = 0.3; // Base score

    // Activity bonus
    score += Math.min(eventCount / 50, 0.3);
    score += Math.min(anchorCount / 10, 0.2);

    // Recency bonus
    const ageHours = (Date.now() / 1000 - frame.created_at) / 3600;
    if (ageHours < 1) score += 0.2;
    else if (ageHours < 6) score += 0.1;

    // Open frame bonus
    if (frame.state === 'active') score += 0.1;

    return Math.min(score, 1.0);
  }

  private getDominantOperations(cutoffTime: number): OperationSummary[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT 
          e.event_type as operation,
          COUNT(*) as count,
          MAX(e.ts) as lastOccurrence,
          SUM(CASE WHEN json_extract(e.payload, '$.success') = 1 THEN 1 ELSE 0 END) as successCount
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ? AND e.ts >= ?
        GROUP BY e.event_type
        ORDER BY count DESC
        LIMIT 10
      `
        )
        .all(this.projectId, cutoffTime) as any[];

      return rows.map((row) => ({
        operation: row.operation,
        count: row.count,
        lastOccurrence: row.lastOccurrence * 1000,
        successRate: row.count > 0 ? row.successCount / row.count : 0,
      }));
    } catch {
      return [];
    }
  }

  private getFilesTouched(cutoffTime: number): FileSummary[] {
    try {
      // Extract file paths from event payloads
      const rows = this.db
        .prepare(
          `
        SELECT 
          json_extract(e.payload, '$.file_path') as path,
          e.event_type as operation,
          MAX(e.ts) as lastModified
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ? 
          AND e.ts >= ?
          AND json_extract(e.payload, '$.file_path') IS NOT NULL
        GROUP BY json_extract(e.payload, '$.file_path'), e.event_type
      `
        )
        .all(this.projectId, cutoffTime) as any[];

      // Aggregate by file
      const fileMap = new Map<string, FileSummary>();
      for (const row of rows) {
        if (!row.path) continue;

        const existing = fileMap.get(row.path);
        if (existing) {
          existing.operationCount++;
          existing.operations.push(row.operation);
          existing.lastModified = Math.max(
            existing.lastModified,
            row.lastModified * 1000
          );
        } else {
          fileMap.set(row.path, {
            path: row.path,
            operationCount: 1,
            lastModified: row.lastModified * 1000,
            operations: [row.operation],
          });
        }
      }

      return Array.from(fileMap.values())
        .sort((a, b) => b.operationCount - a.operationCount)
        .slice(0, 20);
    } catch {
      return [];
    }
  }

  private getErrorsEncountered(cutoffTime: number): ErrorSummary[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT 
          json_extract(e.payload, '$.error_type') as errorType,
          json_extract(e.payload, '$.error') as message,
          COUNT(*) as count,
          MAX(e.ts) as lastOccurrence
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ? 
          AND e.ts >= ?
          AND (json_extract(e.payload, '$.error') IS NOT NULL 
               OR json_extract(e.payload, '$.error_type') IS NOT NULL)
        GROUP BY json_extract(e.payload, '$.error_type'), json_extract(e.payload, '$.error')
        ORDER BY count DESC
        LIMIT 15
      `
        )
        .all(this.projectId, cutoffTime) as any[];

      return rows.map((row) => ({
        errorType: row.errorType || 'unknown',
        message: row.message || '',
        count: row.count,
        lastOccurrence: row.lastOccurrence * 1000,
        resolved: false, // Would need more context to determine
      }));
    } catch {
      return [];
    }
  }

  // Helper methods for historical patterns

  private getTopicFrameCounts(): Record<string, number> {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT type, COUNT(*) as count
        FROM frames
        WHERE project_id = ?
        GROUP BY type
      `
        )
        .all(this.projectId) as any[];

      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.type] = row.count;
      }
      return counts;
    } catch {
      return {};
    }
  }

  private getKeyDecisions(): DecisionSummary[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT 
          a.anchor_id as id,
          a.text,
          a.frame_id as frameId,
          a.created_at as timestamp,
          a.priority
        FROM anchors a
        JOIN frames f ON a.frame_id = f.frame_id
        WHERE f.project_id = ? AND a.type = 'DECISION'
        ORDER BY a.priority DESC, a.created_at DESC
        LIMIT 20
      `
        )
        .all(this.projectId) as any[];

      return rows.map((row) => ({
        id: row.id,
        text: row.text,
        frameId: row.frameId,
        timestamp: row.timestamp * 1000,
        impact:
          row.priority >= 7 ? 'high' : row.priority >= 4 ? 'medium' : 'low',
      }));
    } catch {
      return [];
    }
  }

  private getRecurringIssues(): IssueSummary[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT 
          json_extract(e.payload, '$.error_type') as issueType,
          COUNT(*) as occurrenceCount,
          MAX(e.ts) as lastSeen
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ? 
          AND json_extract(e.payload, '$.error_type') IS NOT NULL
        GROUP BY json_extract(e.payload, '$.error_type')
        HAVING COUNT(*) > 1
        ORDER BY occurrenceCount DESC
        LIMIT 10
      `
        )
        .all(this.projectId) as any[];

      return rows.map((row) => ({
        issueType: row.issueType,
        occurrenceCount: row.occurrenceCount,
        lastSeen: row.lastSeen * 1000,
        resolutionRate: 0.5, // Would need resolution tracking
      }));
    } catch {
      return [];
    }
  }

  private getCommonToolSequences(): ToolSequence[] {
    // Use trace detector if available
    if (this.traceDetector) {
      const stats = this.traceDetector.getStatistics();
      const sequences: ToolSequence[] = [];

      for (const [type, count] of Object.entries(stats.tracesByType)) {
        sequences.push({
          pattern: type,
          frequency: count,
          avgDuration: 0, // Would need more data
          successRate: 0.8, // Estimate
        });
      }

      return sequences;
    }

    return [];
  }

  private getActivityPatterns(): ActivityPattern[] {
    try {
      // Get hourly distribution
      const hourlyRows = this.db
        .prepare(
          `
        SELECT 
          strftime('%H', datetime(e.ts, 'unixepoch')) as hour,
          COUNT(*) as count
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ?
        GROUP BY hour
        ORDER BY count DESC
      `
        )
        .all(this.projectId) as any[];

      const peakHours = hourlyRows.slice(0, 3).map((r) => `${r.hour}:00`);
      const totalEvents = hourlyRows.reduce((sum, r) => sum + r.count, 0);

      return [
        {
          periodType: 'hourly',
          peakPeriods: peakHours,
          avgEventsPerPeriod: totalEvents / 24,
        },
      ];
    } catch {
      return [];
    }
  }

  // Helper methods for queryable indices

  private indexByErrorType(): Record<string, string[]> {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT DISTINCT
          json_extract(e.payload, '$.error_type') as errorType,
          f.frame_id
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ? 
          AND json_extract(e.payload, '$.error_type') IS NOT NULL
      `
        )
        .all(this.projectId) as any[];

      const index: Record<string, string[]> = {};
      for (const row of rows) {
        if (!row.errorType) continue;
        if (!index[row.errorType]) index[row.errorType] = [];
        if (!index[row.errorType].includes(row.frame_id)) {
          index[row.errorType].push(row.frame_id);
        }
      }
      return index;
    } catch {
      return {};
    }
  }

  private indexByTimeframe(): Record<string, string[]> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const timeframes = {
        last_hour: now - 3600,
        last_day: now - 86400,
        last_week: now - 604800,
        last_month: now - 2592000,
      };

      const index: Record<string, string[]> = {};

      for (const [label, cutoff] of Object.entries(timeframes)) {
        const rows = this.db
          .prepare(
            `
          SELECT frame_id FROM frames
          WHERE project_id = ? AND created_at >= ?
        `
          )
          .all(this.projectId, cutoff) as any[];

        index[label] = rows.map((r) => r.frame_id);
      }

      return index;
    } catch {
      return {};
    }
  }

  private indexByContributor(): Record<string, string[]> {
    // Would need user tracking - return empty for now
    return {};
  }

  private indexByTopic(): Record<string, string[]> {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT frame_id, type, name FROM frames
        WHERE project_id = ?
      `
        )
        .all(this.projectId) as any[];

      const index: Record<string, string[]> = {};

      for (const row of rows) {
        // Index by frame type
        if (!index[row.type]) index[row.type] = [];
        index[row.type].push(row.frame_id);

        // Index by keywords in name
        const keywords = this.extractKeywords(row.name);
        for (const keyword of keywords) {
          if (!index[keyword]) index[keyword] = [];
          if (!index[keyword].includes(row.frame_id)) {
            index[keyword].push(row.frame_id);
          }
        }
      }

      return index;
    } catch {
      return {};
    }
  }

  private indexByFile(): Record<string, string[]> {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT DISTINCT
          json_extract(e.payload, '$.file_path') as filePath,
          f.frame_id
        FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ? 
          AND json_extract(e.payload, '$.file_path') IS NOT NULL
      `
        )
        .all(this.projectId) as any[];

      const index: Record<string, string[]> = {};
      for (const row of rows) {
        if (!row.filePath) continue;
        if (!index[row.filePath]) index[row.filePath] = [];
        if (!index[row.filePath].includes(row.frame_id)) {
          index[row.filePath].push(row.frame_id);
        }
      }
      return index;
    } catch {
      return {};
    }
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
    ]);
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));
  }

  /**
   * Clear the cache
   */
  public clearCache(): void {
    this.cache.clear();
    logger.debug('Summary cache cleared', { projectId: this.projectId });
  }
}
