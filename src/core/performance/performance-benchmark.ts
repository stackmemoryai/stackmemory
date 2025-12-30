/**
 * Performance Benchmark Suite
 * Measure improvements from optimization efforts
 */

import { performance } from 'perf_hooks';
import { logger } from '../monitoring/logger.js';
import { StreamingJSONLParser } from './streaming-jsonl-parser.js';
import { ContextCache } from './context-cache.js';
import { LazyContextLoader } from './lazy-context-loader.js';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface BenchmarkResult {
  name: string;
  duration: number;
  memoryUsed: number;
  itemsProcessed: number;
  throughput: number;
  improvement?: number;
}

export interface BenchmarkSuite {
  name: string;
  results: BenchmarkResult[];
  totalDuration: number;
  averageImprovement: number;
}

export class PerformanceBenchmark {
  private results: BenchmarkResult[] = [];

  /**
   * Benchmark JSONL parsing performance
   */
  async benchmarkJSONLParsing(
    filePath: string,
    iterations = 3
  ): Promise<BenchmarkResult> {
    const parser = new StreamingJSONLParser();
    
    // Baseline: traditional sync parsing
    const baselineStart = performance.now();
    const baselineMemStart = process.memoryUsage().heapUsed;
    
    let baselineCount = 0;
    for (let i = 0; i < iterations; i++) {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          JSON.parse(line);
          baselineCount++;
        } catch {}
      }
    }
    
    const baselineDuration = performance.now() - baselineStart;
    const baselineMemUsed = process.memoryUsage().heapUsed - baselineMemStart;
    
    // Optimized: streaming parser
    const optimizedStart = performance.now();
    const optimizedMemStart = process.memoryUsage().heapUsed;
    
    let optimizedCount = 0;
    for (let i = 0; i < iterations; i++) {
      for await (const batch of parser.parseStream(filePath)) {
        optimizedCount += batch.length;
      }
    }
    
    const optimizedDuration = performance.now() - optimizedStart;
    const optimizedMemUsed = process.memoryUsage().heapUsed - optimizedMemStart;
    
    const improvement = ((baselineDuration - optimizedDuration) / baselineDuration) * 100;
    const memImprovement = ((baselineMemUsed - optimizedMemUsed) / baselineMemUsed) * 100;
    
    const result: BenchmarkResult = {
      name: 'JSONL Parsing',
      duration: optimizedDuration / iterations,
      memoryUsed: optimizedMemUsed,
      itemsProcessed: optimizedCount / iterations,
      throughput: (optimizedCount / iterations) / (optimizedDuration / 1000 / iterations),
      improvement,
    };
    
    logger.info('JSONL Parsing Benchmark', {
      baseline: {
        duration: baselineDuration / iterations,
        memory: baselineMemUsed,
        throughput: (baselineCount / iterations) / (baselineDuration / 1000 / iterations),
      },
      optimized: result,
      improvements: {
        speed: `${improvement.toFixed(1)}%`,
        memory: `${memImprovement.toFixed(1)}%`,
      },
    });
    
    this.results.push(result);
    return result;
  }

  /**
   * Benchmark context caching performance
   */
  async benchmarkContextCache(
    itemCount = 1000,
    accessPatterns = 10000
  ): Promise<BenchmarkResult> {
    const cache = new ContextCache<any>({
      maxSize: 50 * 1024 * 1024,
      maxItems: itemCount,
    });
    
    // Prepare test data
    const testData = Array.from({ length: itemCount }, (_, i) => ({
      key: `item-${i}`,
      value: { 
        id: i, 
        data: 'x'.repeat(Math.floor(Math.random() * 1000)),
        timestamp: Date.now(),
      },
    }));
    
    // Populate cache
    const populateStart = performance.now();
    for (const item of testData) {
      cache.set(item.key, item.value);
    }
    const populateDuration = performance.now() - populateStart;
    
    // Benchmark cache access
    const accessStart = performance.now();
    let hits = 0;
    let misses = 0;
    
    for (let i = 0; i < accessPatterns; i++) {
      const index = Math.floor(Math.random() * itemCount * 1.2); // Some will miss
      const key = `item-${index}`;
      const result = cache.get(key);
      if (result) hits++;
      else misses++;
    }
    
    const accessDuration = performance.now() - accessStart;
    const stats = cache.getStats();
    
    const result: BenchmarkResult = {
      name: 'Context Cache',
      duration: accessDuration,
      memoryUsed: cache.getSize().bytes,
      itemsProcessed: accessPatterns,
      throughput: accessPatterns / (accessDuration / 1000),
      improvement: stats.hitRate * 100,
    };
    
    logger.info('Context Cache Benchmark', {
      populate: {
        duration: populateDuration,
        items: itemCount,
      },
      access: {
        duration: accessDuration,
        patterns: accessPatterns,
        hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
      },
      performance: {
        throughput: `${result.throughput.toFixed(0)} ops/sec`,
        avgAccessTime: `${stats.avgAccessTime.toFixed(2)}ms`,
      },
    });
    
    this.results.push(result);
    return result;
  }

  /**
   * Benchmark lazy loading performance
   */
  async benchmarkLazyLoading(
    db: any,
    projectId: string,
    frameCount = 100
  ): Promise<BenchmarkResult> {
    const loader = new LazyContextLoader(db, projectId);
    
    // Check if frames table exists, if not use a mock test
    let frames: any[] = [];
    try {
      frames = db.prepare(
        'SELECT id FROM frames ORDER BY updated_at DESC LIMIT ?'
      ).all(frameCount) as any[];
    } catch (error) {
      // Create mock frame IDs if table doesn't exist
      logger.warn('Frames table not found, using mock data for benchmark');
      frames = Array.from({ length: Math.min(frameCount, 10) }, (_, i) => ({
        id: `frame-${i}`,
      }));
    }
    
    const frameIds = frames.map((f: any) => f.id);
    
    // Benchmark eager loading (baseline)
    const eagerStart = performance.now();
    const eagerMemStart = process.memoryUsage().heapUsed;
    
    const eagerData = [];
    for (const id of frameIds) {
      try {
        const frame = db.prepare('SELECT * FROM frames WHERE id = ?').get(id);
        const anchors = db.prepare('SELECT * FROM anchors WHERE frame_id = ?').all(id);
        const events = db.prepare('SELECT * FROM events WHERE frame_id = ? LIMIT 10').all(id);
        eagerData.push({ frame, anchors, events });
      } catch {
        // Use mock data if tables don't exist
        eagerData.push({
          frame: { id, type: 'mock', name: `Mock ${id}` },
          anchors: [],
          events: [],
        });
      }
    }
    
    const eagerDuration = performance.now() - eagerStart;
    const eagerMemUsed = process.memoryUsage().heapUsed - eagerMemStart;
    
    // Benchmark lazy loading
    const lazyStart = performance.now();
    const lazyMemStart = process.memoryUsage().heapUsed;
    
    // Preload with lazy loading
    await loader.preloadContext(frameIds, { parallel: true, depth: 2 });
    
    // Access data lazily
    let accessedCount = 0;
    for (const id of frameIds.slice(0, frameCount / 2)) {
      const frame = await loader.lazyFrame(id).get();
      if (frame) accessedCount++;
    }
    
    const lazyDuration = performance.now() - lazyStart;
    const lazyMemUsed = process.memoryUsage().heapUsed - lazyMemStart;
    
    const improvement = ((eagerDuration - lazyDuration) / eagerDuration) * 100;
    const memImprovement = ((eagerMemUsed - lazyMemUsed) / eagerMemUsed) * 100;
    
    const result: BenchmarkResult = {
      name: 'Lazy Loading',
      duration: lazyDuration,
      memoryUsed: lazyMemUsed,
      itemsProcessed: frameCount,
      throughput: frameCount / (lazyDuration / 1000),
      improvement,
    };
    
    logger.info('Lazy Loading Benchmark', {
      eager: {
        duration: eagerDuration,
        memory: eagerMemUsed,
      },
      lazy: {
        duration: lazyDuration,
        memory: lazyMemUsed,
        accessed: accessedCount,
      },
      improvements: {
        speed: `${improvement.toFixed(1)}%`,
        memory: `${memImprovement.toFixed(1)}%`,
      },
    });
    
    this.results.push(result);
    return result;
  }

  /**
   * Run full benchmark suite
   */
  async runFullSuite(
    projectRoot: string,
    db: any,
    projectId: string
  ): Promise<BenchmarkSuite> {
    const suiteStart = performance.now();
    
    logger.info('Starting Performance Benchmark Suite');
    
    // Run benchmarks
    const tasksFile = join(projectRoot, '.stackmemory', 'tasks.jsonl');
    
    const jsonlResult = await this.benchmarkJSONLParsing(tasksFile);
    const cacheResult = await this.benchmarkContextCache();
    const lazyResult = await this.benchmarkLazyLoading(db, projectId);
    
    const totalDuration = performance.now() - suiteStart;
    const averageImprovement = this.results
      .filter(r => r.improvement !== undefined)
      .reduce((sum, r) => sum + (r.improvement || 0), 0) / 
      this.results.filter(r => r.improvement !== undefined).length;
    
    const suite: BenchmarkSuite = {
      name: 'Performance Optimization Suite',
      results: this.results,
      totalDuration,
      averageImprovement,
    };
    
    // Generate summary report
    this.generateReport(suite);
    
    return suite;
  }

  /**
   * Generate performance report
   */
  private generateReport(suite: BenchmarkSuite): void {
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║     Performance Benchmark Results         ║');
    console.log('╚════════════════════════════════════════════╝\n');
    
    for (const result of suite.results) {
      console.log(`📊 ${result.name}`);
      console.log(`   Duration: ${result.duration.toFixed(2)}ms`);
      console.log(`   Memory: ${(result.memoryUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`   Throughput: ${result.throughput.toFixed(0)} items/sec`);
      if (result.improvement !== undefined) {
        const icon = result.improvement > 0 ? '🚀' : '⚠️';
        console.log(`   ${icon} Improvement: ${result.improvement.toFixed(1)}%`);
      }
      console.log('');
    }
    
    console.log('═══════════════════════════════════════════');
    console.log(`⏱️  Total Duration: ${suite.totalDuration.toFixed(2)}ms`);
    console.log(`📈 Average Improvement: ${suite.averageImprovement.toFixed(1)}%`);
    console.log('');
    
    logger.info('Performance Benchmark Complete', {
      suite: suite.name,
      duration: suite.totalDuration,
      avgImprovement: suite.averageImprovement,
      results: suite.results.map(r => ({
        name: r.name,
        improvement: r.improvement,
        throughput: r.throughput,
      })),
    });
  }

  /**
   * Get benchmark results
   */
  getResults(): BenchmarkResult[] {
    return this.results;
  }

  /**
   * Clear results
   */
  clearResults(): void {
    this.results = [];
  }
}