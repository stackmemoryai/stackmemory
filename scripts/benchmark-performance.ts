#!/usr/bin/env node
/**
 * Run performance benchmarks
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { PerformanceBenchmark } from '../src/core/performance/performance-benchmark.js';
import { logger } from '../src/core/monitoring/logger.js';

async function runBenchmarks() {
  const projectRoot = process.cwd();
  const dbPath = join(projectRoot, '.stackmemory', 'context.db');

  if (!existsSync(dbPath)) {
    console.error(
      '❌ StackMemory not initialized. Run "stackmemory init" first.'
    );
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: false });
  const projectId = 'benchmark-test';

  console.log('🚀 Starting Performance Benchmarks...\n');

  const benchmark = new PerformanceBenchmark();

  try {
    const suite = await benchmark.runFullSuite(projectRoot, db, projectId);

    console.log('\n✅ Benchmarks completed successfully!');

    // Summary
    if (suite.averageImprovement > 0) {
      console.log(
        `\n🎉 Overall performance improved by ${suite.averageImprovement.toFixed(1)}%`
      );
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    logger.error('Benchmark error', error as Error);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmarks().catch(console.error);
}

export { runBenchmarks };
