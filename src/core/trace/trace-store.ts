/**
 * Trace Store - Database persistence for traces
 */

import Database from 'better-sqlite3';
import {
  Trace,
  ToolCall,
  TraceType,
  TraceMetadata,
  CompressedTrace,
} from './types.js';
import { logger } from '../monitoring/logger.js';

export class TraceStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initializeSchema();
  }

  /**
   * Initialize database schema for traces
   */
  private initializeSchema(): void {
    // Check if frames table exists (it may not in all contexts)
    const hasFramesTable = this.db
      .prepare(
        `
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='frames'
    `
      )
      .get();

    // Create traces table with optional foreign key
    if (hasFramesTable) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          score REAL NOT NULL,
          summary TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          frame_id TEXT,
          user_id TEXT,
          files_modified TEXT,
          errors_encountered TEXT,
          decisions_recorded TEXT,
          causal_chain INTEGER,
          compressed_data TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE SET NULL
        )
      `);
    } else {
      // Create without foreign key constraint
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          score REAL NOT NULL,
          summary TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          frame_id TEXT,
          user_id TEXT,
          files_modified TEXT,
          errors_encountered TEXT,
          decisions_recorded TEXT,
          causal_chain INTEGER,
          compressed_data TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `);
    }

    // Create tool_calls table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        arguments TEXT,
        timestamp INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        files_affected TEXT,
        duration INTEGER,
        sequence_number INTEGER NOT NULL,
        FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_traces_type ON traces(type);
      CREATE INDEX IF NOT EXISTS idx_traces_frame_id ON traces(frame_id);
      CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time);
      CREATE INDEX IF NOT EXISTS idx_traces_score ON traces(score);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_trace_id ON tool_calls(trace_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
    `);
  }

  /**
   * Save a trace to the database
   */
  saveTrace(trace: Trace): void {
    const traceStmt = this.db.prepare(`
      INSERT OR REPLACE INTO traces (
        id, type, score, summary, start_time, end_time,
        frame_id, user_id, files_modified, errors_encountered,
        decisions_recorded, causal_chain, compressed_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const toolCallStmt = this.db.prepare(`
      INSERT OR REPLACE INTO tool_calls (
        id, trace_id, tool, arguments, timestamp, result,
        error, files_affected, duration, sequence_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      this.db.transaction(() => {
        // Save trace
        traceStmt.run(
          trace.id,
          trace.type,
          trace.score,
          trace.summary,
          trace.metadata.startTime,
          trace.metadata.endTime,
          trace.metadata.frameId || null,
          trace.metadata.userId || null,
          JSON.stringify(trace.metadata.filesModified),
          JSON.stringify(trace.metadata.errorsEncountered),
          JSON.stringify(trace.metadata.decisionsRecorded),
          trace.metadata.causalChain ? 1 : 0,
          trace.compressed ? JSON.stringify(trace.compressed) : null
        );

        // Save tool calls
        trace.tools.forEach((tool, index) => {
          toolCallStmt.run(
            tool.id,
            trace.id,
            tool.tool,
            tool.arguments ? JSON.stringify(tool.arguments) : null,
            tool.timestamp,
            tool.result ? JSON.stringify(tool.result) : null,
            tool.error || null,
            tool.filesAffected ? JSON.stringify(tool.filesAffected) : null,
            tool.duration || null,
            index
          );
        });
      })();

      logger.debug(
        `Saved trace ${trace.id} with ${trace.tools.length} tool calls`
      );
    } catch (error) {
      logger.error(`Failed to save trace ${trace.id}:`, error as Error);
      throw error;
    }
  }

  /**
   * Load a trace by ID
   */
  getTrace(id: string): Trace | null {
    const traceRow = this.db
      .prepare(
        `
      SELECT * FROM traces WHERE id = ?
    `
      )
      .get(id) as any;

    if (!traceRow) {
      return null;
    }

    const toolRows = this.db
      .prepare(
        `
      SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number
    `
      )
      .all(id) as any[];

    return this.rowsToTrace(traceRow, toolRows);
  }

  /**
   * Load all traces
   */
  getAllTraces(): Trace[] {
    const traceRows = this.db
      .prepare(
        `
      SELECT * FROM traces ORDER BY start_time DESC
    `
      )
      .all() as any[];

    return traceRows.map((traceRow) => {
      const toolRows = this.db
        .prepare(
          `
        SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number
      `
        )
        .all(traceRow.id) as any[];

      return this.rowsToTrace(traceRow, toolRows);
    });
  }

  /**
   * Load traces by type
   */
  getTracesByType(type: TraceType): Trace[] {
    const traceRows = this.db
      .prepare(
        `
      SELECT * FROM traces WHERE type = ? ORDER BY start_time DESC
    `
      )
      .all(type) as any[];

    return traceRows.map((traceRow) => {
      const toolRows = this.db
        .prepare(
          `
        SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number
      `
        )
        .all(traceRow.id) as any[];

      return this.rowsToTrace(traceRow, toolRows);
    });
  }

  /**
   * Load traces by frame
   */
  getTracesByFrame(frameId: string): Trace[] {
    const traceRows = this.db
      .prepare(
        `
      SELECT * FROM traces WHERE frame_id = ? ORDER BY start_time DESC
    `
      )
      .all(frameId) as any[];

    return traceRows.map((traceRow) => {
      const toolRows = this.db
        .prepare(
          `
        SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number
      `
        )
        .all(traceRow.id) as any[];

      return this.rowsToTrace(traceRow, toolRows);
    });
  }

  /**
   * Load high-importance traces
   */
  getHighImportanceTraces(minScore: number = 0.7): Trace[] {
    const traceRows = this.db
      .prepare(
        `
      SELECT * FROM traces WHERE score >= ? ORDER BY score DESC, start_time DESC
    `
      )
      .all(minScore) as any[];

    return traceRows.map((traceRow) => {
      const toolRows = this.db
        .prepare(
          `
        SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number
      `
        )
        .all(traceRow.id) as any[];

      return this.rowsToTrace(traceRow, toolRows);
    });
  }

  /**
   * Load error traces
   */
  getErrorTraces(): Trace[] {
    const traceRows = this.db
      .prepare(
        `
      SELECT * FROM traces 
      WHERE type = ? OR errors_encountered != '[]'
      ORDER BY start_time DESC
    `
      )
      .all(TraceType.ERROR_RECOVERY) as any[];

    return traceRows.map((traceRow) => {
      const toolRows = this.db
        .prepare(
          `
        SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number
      `
        )
        .all(traceRow.id) as any[];

      return this.rowsToTrace(traceRow, toolRows);
    });
  }

  /**
   * Get trace statistics
   */
  getStatistics(): {
    totalTraces: number;
    tracesByType: Record<string, number>;
    averageScore: number;
    averageLength: number;
    errorRate: number;
  } {
    const stats = this.db
      .prepare(
        `
      SELECT 
        COUNT(*) as total,
        AVG(score) as avg_score,
        AVG((
          SELECT COUNT(*) FROM tool_calls WHERE trace_id = traces.id
        )) as avg_length,
        SUM(CASE WHEN type = ? OR errors_encountered != '[]' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as error_rate
      FROM traces
    `
      )
      .get(TraceType.ERROR_RECOVERY) as any;

    const typeStats = this.db
      .prepare(
        `
      SELECT type, COUNT(*) as count
      FROM traces
      GROUP BY type
    `
      )
      .all() as any[];

    const tracesByType: Record<string, number> = {};
    typeStats.forEach((row) => {
      tracesByType[row.type] = row.count;
    });

    return {
      totalTraces: stats.total || 0,
      tracesByType,
      averageScore: stats.avg_score || 0,
      averageLength: stats.avg_length || 0,
      errorRate: stats.error_rate || 0,
    };
  }

  /**
   * Delete old traces
   */
  deleteOldTraces(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db
      .prepare(
        `
      DELETE FROM traces WHERE start_time < ?
    `
      )
      .run(cutoff);

    return result.changes;
  }

  /**
   * Convert database rows to Trace object
   */
  private rowsToTrace(traceRow: any, toolRows: any[]): Trace {
    const tools: ToolCall[] = toolRows.map((row) => ({
      id: row.id,
      tool: row.tool,
      arguments: row.arguments ? JSON.parse(row.arguments) : undefined,
      timestamp: row.timestamp,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error || undefined,
      filesAffected: row.files_affected
        ? JSON.parse(row.files_affected)
        : undefined,
      duration: row.duration || undefined,
    }));

    const metadata: TraceMetadata = {
      startTime: traceRow.start_time,
      endTime: traceRow.end_time,
      frameId: traceRow.frame_id || undefined,
      userId: traceRow.user_id || undefined,
      filesModified: JSON.parse(traceRow.files_modified || '[]'),
      errorsEncountered: JSON.parse(traceRow.errors_encountered || '[]'),
      decisionsRecorded: JSON.parse(traceRow.decisions_recorded || '[]'),
      causalChain: traceRow.causal_chain === 1,
    };

    const trace: Trace = {
      id: traceRow.id,
      type: traceRow.type as TraceType,
      tools,
      score: traceRow.score,
      summary: traceRow.summary,
      metadata,
    };

    if (traceRow.compressed_data) {
      trace.compressed = JSON.parse(traceRow.compressed_data);
    }

    return trace;
  }
}
