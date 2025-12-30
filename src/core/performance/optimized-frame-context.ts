/**
 * Optimized Frame Context Assembly
 * High-performance context retrieval with caching and batching
 */

import Database from 'better-sqlite3';
import { getQueryCache, createCacheKey } from '../database/query-cache.js';
import { logger } from '../monitoring/logger.js';
import { Frame, FrameContext, Anchor, Event } from '../context/frame-manager.js';

export interface ContextAssemblyOptions {
  maxEvents?: number;
  includeClosed?: boolean;
  enableCaching?: boolean;
  batchSize?: number;
}

export interface OptimizedFrameContext extends FrameContext {
  performance: {
    assemblyTimeMs: number;
    cacheHits: number;
    dbQueries: number;
    totalRows: number;
  };
}

/**
 * Optimized context assembly with caching and batching
 */
export class OptimizedContextAssembler {
  private db: Database.Database;
  private cache = getQueryCache();
  private preparedStatements = new Map<string, Database.Statement>();

  constructor(db: Database.Database) {
    this.db = db;
    this.initializePreparedStatements();
  }

  /**
   * Get hot stack context with optimizations
   */
  async getHotStackContext(
    activeStack: string[],
    options: ContextAssemblyOptions = {}
  ): Promise<OptimizedFrameContext[]> {
    const startTime = performance.now();
    const stats = {
      cacheHits: 0,
      dbQueries: 0,
      totalRows: 0,
    };

    const {
      maxEvents = 20,
      includeClosed = false,
      enableCaching = true,
      batchSize = 10,
    } = options;

    try {
      // Batch process frames for better performance
      const contexts: OptimizedFrameContext[] = [];
      
      for (let i = 0; i < activeStack.length; i += batchSize) {
        const batch = activeStack.slice(i, i + batchSize);
        const batchContexts = await this.processBatch(
          batch,
          maxEvents,
          includeClosed,
          enableCaching,
          stats
        );
        contexts.push(...batchContexts);
      }

      const assemblyTimeMs = performance.now() - startTime;

      // Add performance stats to each context
      return contexts.map(context => ({
        ...context,
        performance: {
          assemblyTimeMs: assemblyTimeMs / contexts.length,
          ...stats,
        },
      }));

    } catch (error) {
      logger.error('Failed to assemble hot stack context', error as Error, {
        activeStack,
        options,
      });
      throw error;
    }
  }

  /**
   * Get single frame context with full optimization
   */
  async getFrameContext(
    frameId: string,
    options: ContextAssemblyOptions = {}
  ): Promise<OptimizedFrameContext | null> {
    const startTime = performance.now();
    const stats = { cacheHits: 0, dbQueries: 0, totalRows: 0 };

    const {
      maxEvents = 50,
      enableCaching = true,
    } = options;

    // Check cache first
    const cacheKey = createCacheKey('frame_context', [frameId, maxEvents]);
    if (enableCaching) {
      const cached = this.cache.getFrameContext(cacheKey);
      if (cached) {
        stats.cacheHits++;
        return {
          ...cached,
          performance: {
            assemblyTimeMs: performance.now() - startTime,
            ...stats,
          },
        };
      }
    }

    try {
      const context = await this.assembleFrameContext(frameId, maxEvents, stats);
      
      if (!context) return null;

      // Cache the result
      if (enableCaching) {
        this.cache.cacheFrameContext(cacheKey, context);
      }

      const result: OptimizedFrameContext = {
        ...context,
        performance: {
          assemblyTimeMs: performance.now() - startTime,
          ...stats,
        },
      };

      return result;

    } catch (error) {
      logger.error('Failed to get frame context', error as Error, { frameId });
      throw error;
    }
  }

  /**
   * Process a batch of frames efficiently
   */
  private async processBatch(
    frameIds: string[],
    maxEvents: number,
    includeClosed: boolean,
    enableCaching: boolean,
    stats: { cacheHits: number; dbQueries: number; totalRows: number }
  ): Promise<OptimizedFrameContext[]> {
    const contexts: OptimizedFrameContext[] = [];
    
    // Get cached contexts first
    const uncachedIds = [];
    for (const frameId of frameIds) {
      const cacheKey = createCacheKey('frame_context', [frameId, maxEvents]);
      if (enableCaching) {
        const cached = this.cache.getFrameContext(cacheKey);
        if (cached) {
          stats.cacheHits++;
          contexts.push(cached);
          continue;
        }
      }
      uncachedIds.push(frameId);
    }

    if (uncachedIds.length === 0) {
      return contexts;
    }

    // Batch fetch uncached frames
    const frames = await this.batchGetFrames(uncachedIds, stats);
    const allEvents = await this.batchGetEvents(uncachedIds, maxEvents, stats);
    const allAnchors = await this.batchGetAnchors(uncachedIds, stats);
    const allArtifacts = await this.batchGetArtifacts(uncachedIds, stats);

    // Assemble contexts from batched data
    for (const frameId of uncachedIds) {
      const frame = frames.get(frameId);
      if (!frame || (!includeClosed && frame.state === 'closed')) {
        continue;
      }

      const context: FrameContext = {
        frameId,
        header: {
          goal: frame.name,
          constraints: this.extractConstraints(frame.inputs),
          definitions: frame.inputs.definitions,
        },
        anchors: allAnchors.get(frameId) || [],
        recentEvents: allEvents.get(frameId) || [],
        activeArtifacts: allArtifacts.get(frameId) || [],
      };

      // Cache the context
      if (enableCaching) {
        const cacheKey = createCacheKey('frame_context', [frameId, maxEvents]);
        this.cache.cacheFrameContext(cacheKey, context);
      }

      contexts.push(context as OptimizedFrameContext);
    }

    return contexts;
  }

  /**
   * Batch get frames with single query
   */
  private async batchGetFrames(
    frameIds: string[],
    stats: { dbQueries: number; totalRows: number }
  ): Promise<Map<string, Frame>> {
    if (frameIds.length === 0) return new Map();

    const stmt = this.preparedStatements.get('batch_frames');
    if (!stmt) throw new Error('Prepared statement not found: batch_frames');

    const placeholders = frameIds.map(() => '?').join(',');
    const query = `SELECT * FROM frames WHERE frame_id IN (${placeholders})`;
    
    stats.dbQueries++;
    const rows = this.db.prepare(query).all(...frameIds) as any[];
    stats.totalRows += rows.length;

    const frameMap = new Map<string, Frame>();
    for (const row of rows) {
      frameMap.set(row.frame_id, {
        ...row,
        inputs: JSON.parse(row.inputs || '{}'),
        outputs: JSON.parse(row.outputs || '{}'),
        digest_json: JSON.parse(row.digest_json || '{}'),
      });
    }

    return frameMap;
  }

  /**
   * Batch get events for multiple frames
   */
  private async batchGetEvents(
    frameIds: string[],
    maxEvents: number,
    stats: { dbQueries: number; totalRows: number }
  ): Promise<Map<string, Event[]>> {
    if (frameIds.length === 0) return new Map();

    const placeholders = frameIds.map(() => '?').join(',');
    const query = `
      SELECT *, ROW_NUMBER() OVER (PARTITION BY frame_id ORDER BY seq DESC) as rn
      FROM events 
      WHERE frame_id IN (${placeholders}) 
      AND rn <= ${maxEvents}
      ORDER BY frame_id, seq DESC
    `;

    stats.dbQueries++;
    const rows = this.db.prepare(query).all(...frameIds) as any[];
    stats.totalRows += rows.length;

    const eventMap = new Map<string, Event[]>();
    for (const row of rows) {
      if (!eventMap.has(row.frame_id)) {
        eventMap.set(row.frame_id, []);
      }
      eventMap.get(row.frame_id)!.push({
        ...row,
        payload: JSON.parse(row.payload),
      });
    }

    return eventMap;
  }

  /**
   * Batch get anchors for multiple frames
   */
  private async batchGetAnchors(
    frameIds: string[],
    stats: { dbQueries: number; totalRows: number }
  ): Promise<Map<string, Anchor[]>> {
    if (frameIds.length === 0) return new Map();

    const placeholders = frameIds.map(() => '?').join(',');
    const query = `
      SELECT * FROM anchors 
      WHERE frame_id IN (${placeholders}) 
      ORDER BY frame_id, priority DESC, created_at ASC
    `;

    stats.dbQueries++;
    const rows = this.db.prepare(query).all(...frameIds) as any[];
    stats.totalRows += rows.length;

    const anchorMap = new Map<string, Anchor[]>();
    for (const row of rows) {
      if (!anchorMap.has(row.frame_id)) {
        anchorMap.set(row.frame_id, []);
      }
      anchorMap.get(row.frame_id)!.push({
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
      });
    }

    return anchorMap;
  }

  /**
   * Batch get active artifacts for multiple frames
   */
  private async batchGetArtifacts(
    frameIds: string[],
    stats: { dbQueries: number; totalRows: number }
  ): Promise<Map<string, string[]>> {
    if (frameIds.length === 0) return new Map();

    const placeholders = frameIds.map(() => '?').join(',');
    const query = `
      SELECT frame_id, payload
      FROM events 
      WHERE frame_id IN (${placeholders}) 
      AND event_type = 'artifact'
      ORDER BY frame_id, ts DESC
    `;

    stats.dbQueries++;
    const rows = this.db.prepare(query).all(...frameIds) as any[];
    stats.totalRows += rows.length;

    const artifactMap = new Map<string, string[]>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      if (!artifactMap.has(row.frame_id)) {
        artifactMap.set(row.frame_id, []);
      }
      if (payload.path) {
        artifactMap.get(row.frame_id)!.push(payload.path);
      }
    }

    return artifactMap;
  }

  /**
   * Assemble single frame context
   */
  private async assembleFrameContext(
    frameId: string,
    maxEvents: number,
    stats: { dbQueries: number; totalRows: number }
  ): Promise<FrameContext | null> {
    // Single frame operations - these could be further optimized with prepared statements
    const frame = await this.batchGetFrames([frameId], stats).then(map => map.get(frameId));
    if (!frame) return null;

    const [events, anchors, artifacts] = await Promise.all([
      this.batchGetEvents([frameId], maxEvents, stats).then(map => map.get(frameId) || []),
      this.batchGetAnchors([frameId], stats).then(map => map.get(frameId) || []),
      this.batchGetArtifacts([frameId], stats).then(map => map.get(frameId) || []),
    ]);

    return {
      frameId,
      header: {
        goal: frame.name,
        constraints: this.extractConstraints(frame.inputs),
        definitions: frame.inputs.definitions,
      },
      anchors,
      recentEvents: events,
      activeArtifacts: artifacts,
    };
  }

  /**
   * Extract constraints from frame inputs
   */
  private extractConstraints(inputs: Record<string, any>): string[] {
    const constraints: string[] = [];
    
    if (inputs.constraints && Array.isArray(inputs.constraints)) {
      constraints.push(...inputs.constraints);
    }
    
    if (inputs.requirements && Array.isArray(inputs.requirements)) {
      constraints.push(...inputs.requirements);
    }
    
    if (inputs.limitations && Array.isArray(inputs.limitations)) {
      constraints.push(...inputs.limitations);
    }

    return constraints;
  }

  /**
   * Initialize prepared statements for common queries
   */
  private initializePreparedStatements(): void {
    try {
      // Single frame query
      this.preparedStatements.set(
        'single_frame',
        this.db.prepare('SELECT * FROM frames WHERE frame_id = ?')
      );

      // Frame events with limit
      this.preparedStatements.set(
        'frame_events',
        this.db.prepare('SELECT * FROM events WHERE frame_id = ? ORDER BY seq DESC LIMIT ?')
      );

      // Frame anchors
      this.preparedStatements.set(
        'frame_anchors',
        this.db.prepare('SELECT * FROM anchors WHERE frame_id = ? ORDER BY priority DESC, created_at ASC')
      );

      logger.info('Prepared statements initialized for optimized context assembly');
    } catch (error) {
      logger.error('Failed to initialize prepared statements', error as Error);
      throw error;
    }
  }

  /**
   * Clear cache and reset prepared statements
   */
  cleanup(): void {
    this.cache.clear();
    // Modern better-sqlite3 automatically handles cleanup
    this.preparedStatements.clear();
  }
}