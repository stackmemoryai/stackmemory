/**
 * Retrieval Quality Benchmarks at Scale
 * Tests different retrieval strategies to monitor for semantic collapse
 *
 * Key metrics:
 * - Precision: How relevant are retrieved results?
 * - Recall: Are we missing important context?
 * - Semantic Drift: Do embeddings collapse over time?
 * - Query Latency: Performance at scale
 */

import Database from 'better-sqlite3';
import { logger } from '../monitoring/logger.js';
import { Trace } from '../trace/types.js';
import { LLMContextRetrieval } from './llm-context-retrieval.js';
import { HierarchicalRetrieval } from './hierarchical-retrieval.js';
import { GraphRetrieval } from './graph-retrieval.js';
import { FrameManager } from '../context/frame-manager.js';

export interface BenchmarkQuery {
  query: string;
  expectedTraceIds: string[];
  expectedTopics: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
}

export interface BenchmarkResult {
  strategy: 'flat' | 'hierarchical' | 'graph';
  query: BenchmarkQuery;
  retrievedTraceIds: string[];
  precision: number;
  recall: number;
  f1Score: number;
  queryTimeMs: number;
  tokensUsed: number;
  semanticDrift?: number;
  explanation: string;
}

export interface BenchmarkReport {
  timestamp: number;
  traceCount: number;
  strategies: {
    flat: StrategyMetrics;
    hierarchical: StrategyMetrics;
    graph: StrategyMetrics;
  };
  warnings: string[];
  recommendations: string[];
}

export interface StrategyMetrics {
  avgPrecision: number;
  avgRecall: number;
  avgF1Score: number;
  avgQueryTime: number;
  avgTokensUsed: number;
  semanticCollapse: boolean;
  collapseIndicators: string[];
}

/**
 * Benchmark suite for retrieval quality at scale
 */
export class RetrievalBenchmarks {
  private db: Database.Database;
  private flatRetrieval: LLMContextRetrieval;
  private hierarchicalRetrieval: HierarchicalRetrieval;
  private graphRetrieval: GraphRetrieval;
  private frameManager: FrameManager;

  constructor(
    db: Database.Database,
    frameManager: FrameManager,
    projectId: string
  ) {
    this.db = db;
    this.frameManager = frameManager;

    // Initialize retrieval strategies
    this.flatRetrieval = new LLMContextRetrieval(db, frameManager, projectId);
    this.hierarchicalRetrieval = new HierarchicalRetrieval(db);
    this.graphRetrieval = new GraphRetrieval(db);

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (unixepoch() * 1000),
        strategy TEXT NOT NULL,
        query TEXT NOT NULL,
        difficulty TEXT,
        category TEXT,
        precision REAL,
        recall REAL,
        f1_score REAL,
        query_time_ms INTEGER,
        tokens_used INTEGER,
        semantic_drift REAL,
        trace_count INTEGER,
        retrieved_ids TEXT,
        expected_ids TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_benchmark_strategy ON benchmark_results(strategy);
      CREATE INDEX IF NOT EXISTS idx_benchmark_timestamp ON benchmark_results(timestamp);
      CREATE INDEX IF NOT EXISTS idx_benchmark_difficulty ON benchmark_results(difficulty);
    `);
  }

  /**
   * Generate benchmark queries based on current data
   */
  async generateBenchmarkQueries(traces: Trace[]): Promise<BenchmarkQuery[]> {
    const queries: BenchmarkQuery[] = [];

    // Easy: Recent specific traces
    const recentTraces = traces
      .sort((a, b) => b.metadata.startTime - a.metadata.startTime)
      .slice(0, 10);

    for (const trace of recentTraces.slice(0, 3)) {
      queries.push({
        query: `Show me the ${trace.type} operation from ${new Date(trace.metadata.startTime).toLocaleString()}`,
        expectedTraceIds: [trace.id],
        expectedTopics: [trace.type],
        difficulty: 'easy',
        category: 'specific_lookup',
      });
    }

    // Medium: Topic-based queries
    const topicGroups = this.groupByTopic(traces);

    for (const [topic, topicTraces] of topicGroups.entries()) {
      if (topicTraces.length >= 5) {
        queries.push({
          query: `What ${topic} operations have been performed recently?`,
          expectedTraceIds: topicTraces.slice(0, 10).map((t) => t.id),
          expectedTopics: [topic],
          difficulty: 'medium',
          category: 'topic_search',
        });
      }
    }

    // Hard: Cross-topic and temporal queries
    if (traces.length > 50) {
      // Find traces with errors
      const errorTraces = traces.filter(
        (t) => t.metadata.errorsEncountered.length > 0
      );

      if (errorTraces.length > 0) {
        queries.push({
          query: 'What errors occurred and how were they resolved?',
          expectedTraceIds: errorTraces.map((t) => t.id),
          expectedTopics: ['error', 'fix', 'debug'],
          difficulty: 'hard',
          category: 'error_analysis',
        });
      }

      // Find decision chains
      const decisionTraces = traces.filter(
        (t) => t.metadata.decisionsRecorded.length > 0
      );

      if (decisionTraces.length > 0) {
        queries.push({
          query: 'What architectural decisions were made and why?',
          expectedTraceIds: decisionTraces.map((t) => t.id),
          expectedTopics: ['decision', 'architecture', 'design'],
          difficulty: 'hard',
          category: 'decision_tracking',
        });
      }
    }

    // Adversarial: Test for semantic collapse
    queries.push({
      query: 'something about code',
      expectedTraceIds: [],
      expectedTopics: [],
      difficulty: 'hard',
      category: 'vague_query',
    });

    queries.push({
      query: 'the thing we did yesterday with the files',
      expectedTraceIds: [],
      expectedTopics: [],
      difficulty: 'hard',
      category: 'ambiguous_query',
    });

    return queries;
  }

  /**
   * Run benchmarks on all strategies
   */
  async runBenchmarks(
    traces: Trace[],
    sampleSize: number = 10
  ): Promise<BenchmarkReport> {
    logger.info('Starting retrieval benchmarks', {
      traceCount: traces.length,
      sampleSize,
    });

    const queries = await this.generateBenchmarkQueries(traces);
    const sampledQueries = this.sampleQueries(queries, sampleSize);

    const results: BenchmarkResult[] = [];

    // Build hierarchical and graph structures
    await this.hierarchicalRetrieval.buildHierarchy(traces);
    const frames = await this.frameManager.getAllFrames();
    await this.graphRetrieval.buildGraph(traces, frames);

    // Test flat retrieval
    for (const query of sampledQueries) {
      const result = await this.benchmarkFlatRetrieval(query, traces);
      results.push(result);
      await this.saveResult(result, traces.length);
    }

    // Test hierarchical retrieval
    for (const query of sampledQueries) {
      const result = await this.benchmarkHierarchicalRetrieval(query, traces);
      results.push(result);
      await this.saveResult(result, traces.length);
    }

    // Test graph retrieval
    for (const query of sampledQueries) {
      const result = await this.benchmarkGraphRetrieval(query, traces);
      results.push(result);
      await this.saveResult(result, traces.length);
    }

    // Generate report
    const report = this.generateReport(results, traces.length);

    logger.info('Benchmarks complete', {
      strategies: 3,
      queries: sampledQueries.length,
      avgF1: {
        flat: report.strategies.flat.avgF1Score,
        hierarchical: report.strategies.hierarchical.avgF1Score,
        graph: report.strategies.graph.avgF1Score,
      },
    });

    return report;
  }

  /**
   * Benchmark flat embedding retrieval
   */
  private async benchmarkFlatRetrieval(
    query: BenchmarkQuery,
    traces: Trace[]
  ): Promise<BenchmarkResult> {
    const startTime = Date.now();

    try {
      const result = await this.flatRetrieval.retrieveContext(query.query, {
        tokenBudget: 4000,
      });

      const retrievedIds = result.frames.map((f) => f.id);
      const queryTime = Date.now() - startTime;

      return this.evaluateResult(
        'flat',
        query,
        retrievedIds,
        queryTime,
        result.tokenUsage.used,
        'Standard flat embedding retrieval'
      );
    } catch (error) {
      logger.error('Flat retrieval failed', error);
      return this.createErrorResult('flat', query, error as Error);
    }
  }

  /**
   * Benchmark hierarchical retrieval
   */
  private async benchmarkHierarchicalRetrieval(
    query: BenchmarkQuery,
    traces: Trace[]
  ): Promise<BenchmarkResult> {
    const startTime = Date.now();

    try {
      const context = await this.hierarchicalRetrieval.retrieve(
        query.query,
        4,
        4000
      );

      const queryTime = Date.now() - startTime;

      // Extract trace IDs from context (simplified)
      const retrievedIds = this.extractTraceIds(context);

      return this.evaluateResult(
        'hierarchical',
        query,
        retrievedIds,
        queryTime,
        context.length / 4, // Estimate tokens
        'Hierarchical retrieval with progressive summarization'
      );
    } catch (error) {
      logger.error('Hierarchical retrieval failed', error);
      return this.createErrorResult('hierarchical', query, error as Error);
    }
  }

  /**
   * Benchmark graph retrieval
   */
  private async benchmarkGraphRetrieval(
    query: BenchmarkQuery,
    traces: Trace[]
  ): Promise<BenchmarkResult> {
    const startTime = Date.now();

    try {
      const paths = await this.graphRetrieval.traverse(query.query, {
        maxHops: 3,
        minWeight: 0.3,
      });

      const queryTime = Date.now() - startTime;

      // Extract trace IDs from paths
      const retrievedIds = new Set<string>();
      for (const path of paths) {
        for (const node of path.nodes) {
          if (node.metadata.traceIds) {
            node.metadata.traceIds.forEach((id) => retrievedIds.add(id));
          }
        }
      }

      return this.evaluateResult(
        'graph',
        query,
        Array.from(retrievedIds),
        queryTime,
        paths.length * 100, // Estimate tokens
        'Graph-based retrieval with explicit relationships'
      );
    } catch (error) {
      logger.error('Graph retrieval failed', error);
      return this.createErrorResult('graph', query, error as Error);
    }
  }

  /**
   * Evaluate retrieval results
   */
  private evaluateResult(
    strategy: 'flat' | 'hierarchical' | 'graph',
    query: BenchmarkQuery,
    retrievedIds: string[],
    queryTimeMs: number,
    tokensUsed: number,
    explanation: string
  ): BenchmarkResult {
    const expectedSet = new Set(query.expectedTraceIds);
    const retrievedSet = new Set(retrievedIds);

    // Calculate metrics
    const truePositives = [...retrievedSet].filter((id) =>
      expectedSet.has(id)
    ).length;
    const falsePositives = retrievedSet.size - truePositives;
    const falseNegatives = expectedSet.size - truePositives;

    const precision =
      retrievedSet.size > 0 ? truePositives / retrievedSet.size : 0;
    const recall = expectedSet.size > 0 ? truePositives / expectedSet.size : 1;
    const f1Score =
      precision + recall > 0
        ? (2 * (precision * recall)) / (precision + recall)
        : 0;

    // Check for semantic drift (simplified)
    const semanticDrift = this.calculateSemanticDrift(query, retrievedIds);

    return {
      strategy,
      query,
      retrievedTraceIds: retrievedIds,
      precision,
      recall,
      f1Score,
      queryTimeMs,
      tokensUsed,
      semanticDrift,
      explanation,
    };
  }

  /**
   * Calculate semantic drift indicator
   */
  private calculateSemanticDrift(
    query: BenchmarkQuery,
    retrievedIds: string[]
  ): number {
    // If vague query returns too many results, indicates collapse
    if (query.category === 'vague_query' && retrievedIds.length > 10) {
      return 0.8; // High drift
    }

    // If specific query returns nothing, indicates problem
    if (query.category === 'specific_lookup' && retrievedIds.length === 0) {
      return 0.7;
    }

    return 0.1; // Normal
  }

  /**
   * Create error result
   */
  private createErrorResult(
    strategy: 'flat' | 'hierarchical' | 'graph',
    query: BenchmarkQuery,
    error: Error
  ): BenchmarkResult {
    return {
      strategy,
      query,
      retrievedTraceIds: [],
      precision: 0,
      recall: 0,
      f1Score: 0,
      queryTimeMs: 0,
      tokensUsed: 0,
      semanticDrift: 1.0,
      explanation: `Error: ${error.message}`,
    };
  }

  /**
   * Generate benchmark report
   */
  private generateReport(
    results: BenchmarkResult[],
    traceCount: number
  ): BenchmarkReport {
    const byStrategy = this.groupByStrategy(results);

    const report: BenchmarkReport = {
      timestamp: Date.now(),
      traceCount,
      strategies: {
        flat: this.calculateStrategyMetrics(byStrategy.flat || []),
        hierarchical: this.calculateStrategyMetrics(
          byStrategy.hierarchical || []
        ),
        graph: this.calculateStrategyMetrics(byStrategy.graph || []),
      },
      warnings: [],
      recommendations: [],
    };

    // Generate warnings
    if (report.strategies.flat.semanticCollapse) {
      report.warnings.push('Flat embedding shows signs of semantic collapse');
    }

    if (report.strategies.flat.avgQueryTime > 1000) {
      report.warnings.push('Flat retrieval query time exceeds 1 second');
    }

    // Generate recommendations
    const bestStrategy = this.getBestStrategy(report.strategies);
    report.recommendations.push(`Best overall strategy: ${bestStrategy}`);

    if (traceCount > 10000) {
      report.recommendations.push('Consider hierarchical retrieval for scale');
    }

    if (
      report.strategies.graph.avgF1Score >
      report.strategies.flat.avgF1Score * 1.2
    ) {
      report.recommendations.push(
        'Graph retrieval significantly outperforms flat - consider switching'
      );
    }

    return report;
  }

  /**
   * Calculate strategy metrics
   */
  private calculateStrategyMetrics(
    results: BenchmarkResult[]
  ): StrategyMetrics {
    if (results.length === 0) {
      return {
        avgPrecision: 0,
        avgRecall: 0,
        avgF1Score: 0,
        avgQueryTime: 0,
        avgTokensUsed: 0,
        semanticCollapse: false,
        collapseIndicators: [],
      };
    }

    const avgPrecision =
      results.reduce((sum, r) => sum + r.precision, 0) / results.length;
    const avgRecall =
      results.reduce((sum, r) => sum + r.recall, 0) / results.length;
    const avgF1Score =
      results.reduce((sum, r) => sum + r.f1Score, 0) / results.length;
    const avgQueryTime =
      results.reduce((sum, r) => sum + r.queryTimeMs, 0) / results.length;
    const avgTokensUsed =
      results.reduce((sum, r) => sum + r.tokensUsed, 0) / results.length;

    // Check for semantic collapse
    const collapseIndicators: string[] = [];
    const avgDrift =
      results.reduce((sum, r) => sum + (r.semanticDrift || 0), 0) /
      results.length;

    if (avgDrift > 0.5) {
      collapseIndicators.push('High semantic drift detected');
    }

    // Check for uniform results (everything returns same thing)
    const uniqueResults = new Set(
      results.map((r) => r.retrievedTraceIds.sort().join(','))
    );
    if (uniqueResults.size < results.length * 0.3) {
      collapseIndicators.push(
        'Low result diversity - possible embedding collapse'
      );
    }

    // Check for poor precision on specific queries
    const specificQueries = results.filter(
      (r) => r.query.difficulty === 'easy'
    );
    const specificPrecision =
      specificQueries.reduce((sum, r) => sum + r.precision, 0) /
      (specificQueries.length || 1);
    if (specificPrecision < 0.5) {
      collapseIndicators.push('Poor precision on specific queries');
    }

    return {
      avgPrecision,
      avgRecall,
      avgF1Score,
      avgQueryTime,
      avgTokensUsed,
      semanticCollapse: collapseIndicators.length > 0,
      collapseIndicators,
    };
  }

  /**
   * Determine best strategy
   */
  private getBestStrategy(strategies: BenchmarkReport['strategies']): string {
    const scores = {
      flat:
        strategies.flat.avgF1Score * (1 - strategies.flat.avgQueryTime / 5000),
      hierarchical:
        strategies.hierarchical.avgF1Score *
        (1 - strategies.hierarchical.avgQueryTime / 5000),
      graph:
        strategies.graph.avgF1Score *
        (1 - strategies.graph.avgQueryTime / 5000),
    };

    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }

  /**
   * Group traces by topic
   */
  private groupByTopic(traces: Trace[]): Map<string, Trace[]> {
    const groups = new Map<string, Trace[]>();

    for (const trace of traces) {
      if (!groups.has(trace.type)) {
        groups.set(trace.type, []);
      }
      groups.get(trace.type)!.push(trace);
    }

    return groups;
  }

  /**
   * Group results by strategy
   */
  private groupByStrategy(
    results: BenchmarkResult[]
  ): Record<string, BenchmarkResult[]> {
    const grouped: Record<string, BenchmarkResult[]> = {};

    for (const result of results) {
      if (!grouped[result.strategy]) {
        grouped[result.strategy] = [];
      }
      grouped[result.strategy].push(result);
    }

    return grouped;
  }

  /**
   * Sample queries for benchmarking
   */
  private sampleQueries(
    queries: BenchmarkQuery[],
    sampleSize: number
  ): BenchmarkQuery[] {
    // Ensure we get a mix of difficulties
    const byDifficulty = this.groupByDifficulty(queries);
    const sampled: BenchmarkQuery[] = [];

    const perDifficulty = Math.ceil(sampleSize / 3);

    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const difficultyQueries = byDifficulty[difficulty] || [];
      const sample = this.randomSample(difficultyQueries, perDifficulty);
      sampled.push(...sample);
    }

    return sampled.slice(0, sampleSize);
  }

  /**
   * Group queries by difficulty
   */
  private groupByDifficulty(
    queries: BenchmarkQuery[]
  ): Record<string, BenchmarkQuery[]> {
    const grouped: Record<string, BenchmarkQuery[]> = {};

    for (const query of queries) {
      if (!grouped[query.difficulty]) {
        grouped[query.difficulty] = [];
      }
      grouped[query.difficulty].push(query);
    }

    return grouped;
  }

  /**
   * Random sample from array
   */
  private randomSample<T>(array: T[], size: number): T[] {
    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
  }

  /**
   * Extract trace IDs from context string
   */
  private extractTraceIds(context: string): string[] {
    // Simple pattern matching for trace IDs
    const matches = context.match(/trace_[a-f0-9]{16}/g) || [];
    return [...new Set(matches)];
  }

  /**
   * Save benchmark result to database
   */
  private async saveResult(
    result: BenchmarkResult,
    traceCount: number
  ): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO benchmark_results (
        strategy, query, difficulty, category,
        precision, recall, f1_score,
        query_time_ms, tokens_used, semantic_drift,
        trace_count, retrieved_ids, expected_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        result.strategy,
        result.query.query,
        result.query.difficulty,
        result.query.category,
        result.precision,
        result.recall,
        result.f1Score,
        result.queryTimeMs,
        result.tokensUsed,
        result.semanticDrift || 0,
        traceCount,
        JSON.stringify(result.retrievedTraceIds),
        JSON.stringify(result.query.expectedTraceIds)
      );
  }

  /**
   * Get historical benchmark trends
   */
  getHistoricalTrends(days: number = 7): any {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const trends = this.db
      .prepare(
        `
      SELECT 
        strategy,
        DATE(timestamp / 1000, 'unixepoch') as date,
        AVG(precision) as avg_precision,
        AVG(recall) as avg_recall,
        AVG(f1_score) as avg_f1,
        AVG(query_time_ms) as avg_query_time,
        AVG(semantic_drift) as avg_drift,
        COUNT(*) as query_count
      FROM benchmark_results
      WHERE timestamp > ?
      GROUP BY strategy, date
      ORDER BY date, strategy
    `
      )
      .all(cutoff);

    return trends;
  }
}
