#!/usr/bin/env tsx
/**
 * Test script for Redis trace storage
 * Tests the 3-tier storage system with Redis hot tier
 */

import { createClient } from 'redis';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import ora from 'ora';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { RailwayOptimizedStorage } from '../src/core/storage/railway-optimized-storage.js';
import { ConfigManager } from '../src/core/config/config-manager.js';
import { Trace, TraceType, ToolCall } from '../src/core/trace/types.js';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

async function testRedisConnection() {
  const spinner = ora('Testing Redis connection...').start();

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    console.log(
      chalk.gray(
        `  Using Redis URL: ${redisUrl.replace(/:[^:@]+@/, ':****@')})`
      )
    );
    const client = createClient({ url: redisUrl });

    await client.connect();

    // Test basic operations
    const testKey = 'test:connection';
    await client.set(testKey, 'connected');
    const result = await client.get(testKey);
    await client.del(testKey);

    if (result === 'connected') {
      spinner.succeed(`Redis connected successfully at ${redisUrl}`);

      // Get Redis info
      const info = await client.info('memory');
      const memoryUsed = info.match(/used_memory_human:(\S+)/)?.[1];
      console.log(chalk.gray(`  Memory used: ${memoryUsed || 'unknown'}`));
    } else {
      spinner.fail('Redis connection test failed');
      return false;
    }

    await client.quit();
    return true;
  } catch (error) {
    spinner.fail(`Redis connection failed: ${error}`);
    return false;
  }
}

function createMockTrace(index: number): Trace {
  const now = Date.now() - index * 60 * 60 * 1000; // Offset by hours
  const tools: ToolCall[] = [
    {
      id: uuidv4(),
      tool: 'search',
      timestamp: now,
      arguments: { query: `test query ${index}` },
      filesAffected: ['src/test.ts', 'src/index.ts'],
    },
    {
      id: uuidv4(),
      tool: 'read',
      timestamp: now + 1000,
      arguments: { file: 'src/test.ts' },
      result: 'file contents',
    },
    {
      id: uuidv4(),
      tool: 'edit',
      timestamp: now + 2000,
      arguments: { file: 'src/test.ts', changes: 'some changes' },
      filesAffected: ['src/test.ts'],
    },
    {
      id: uuidv4(),
      tool: 'test',
      timestamp: now + 3000,
      arguments: { command: 'npm test' },
      result: 'tests passed',
    },
  ];

  const trace: Trace = {
    id: uuidv4(),
    type: TraceType.SEARCH_DRIVEN,
    tools,
    score: 0.5 + Math.random() * 0.5, // Random score 0.5-1.0
    summary: `Test trace #${index}: Search-driven modification`,
    metadata: {
      startTime: now,
      endTime: now + 4000,
      filesModified: ['src/test.ts'],
      errorsEncountered: index % 3 === 0 ? ['Test error'] : [],
      decisionsRecorded: index % 2 === 0 ? ['Use async pattern'] : [],
      causalChain: index % 3 === 0,
    },
  };

  return trace;
}

async function testStorageOperations() {
  console.log(chalk.blue('\n📦 Testing Storage Operations'));
  console.log(chalk.gray('━'.repeat(50)));

  // Setup database
  const dbDir = join(process.cwd(), '.stackmemory');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = join(dbDir, 'test-context.db');
  const db = new Database(dbPath);

  // Initialize trace tables
  db.exec(`
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

  db.exec(`
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

  // Create storage_tiers table required by RailwayOptimizedStorage
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_tiers (
      trace_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      location TEXT NOT NULL,
      original_size INTEGER,
      compressed_size INTEGER,
      compression_ratio REAL,
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER DEFAULT (unixepoch()),
      created_at INTEGER DEFAULT (unixepoch()),
      migrated_at INTEGER,
      score REAL,
      migration_score REAL,
      metadata TEXT,
      FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
    )
  `);

  // Create indexes for storage_tiers
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_storage_tier ON storage_tiers(tier);
    CREATE INDEX IF NOT EXISTS idx_storage_created ON storage_tiers(created_at);
    CREATE INDEX IF NOT EXISTS idx_storage_accessed ON storage_tiers(last_accessed);
  `);

  const configManager = new ConfigManager();

  // Initialize storage with Redis URL from environment
  const storage = new RailwayOptimizedStorage(db, configManager, {
    redis: {
      url: process.env.REDIS_URL,
      ttlSeconds: 24 * 60 * 60, // 24 hours
      maxMemory: '100mb',
    },
  });

  // Test storing traces
  const traces: Trace[] = [];
  const results: { id: string; tier: string; score: number }[] = [];

  console.log(chalk.yellow('\n✏️  Creating and storing test traces...'));

  for (let i = 0; i < 10; i++) {
    const trace = createMockTrace(i);
    traces.push(trace);

    const spinner = ora(`Storing trace #${i + 1}...`).start();

    try {
      // First insert the trace into the traces table
      const insertTrace = db.prepare(`
        INSERT INTO traces (
          id, type, score, summary, start_time, end_time,
          files_modified, errors_encountered, decisions_recorded, causal_chain,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertTrace.run(
        trace.id,
        trace.type,
        trace.score,
        trace.summary,
        trace.metadata.startTime,
        trace.metadata.endTime,
        JSON.stringify(trace.metadata.filesModified || []),
        JSON.stringify(trace.metadata.errorsEncountered || []),
        JSON.stringify(trace.metadata.decisionsRecorded || []),
        trace.metadata.causalChain ? 1 : 0,
        Date.now()
      );

      // Insert tool calls
      const insertToolCall = db.prepare(`
        INSERT INTO tool_calls (
          id, trace_id, tool, arguments, timestamp, result, files_affected, sequence_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      trace.tools.forEach((tool, index) => {
        insertToolCall.run(
          tool.id,
          trace.id,
          tool.tool,
          JSON.stringify(tool.arguments),
          tool.timestamp,
          tool.result || null,
          JSON.stringify(tool.filesAffected || []),
          index
        );
      });

      // Now store in tiered storage
      const tier = await storage.storeTrace(trace);
      results.push({ id: trace.id, tier, score: trace.score });

      const tierIcon = tier === 'hot' ? '🔥' : tier === 'warm' ? '☁️' : '❄️';
      spinner.succeed(
        `Trace #${i + 1} stored in ${tierIcon} ${tier} tier (score: ${trace.score.toFixed(2)})`
      );
    } catch (error) {
      spinner.fail(`Failed to store trace #${i + 1}: ${error}`);
    }

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Test retrieval
  console.log(chalk.yellow('\n🔍 Testing trace retrieval...'));

  for (let i = 0; i < 3; i++) {
    const result = results[i];
    const spinner = ora(
      `Retrieving trace ${result.id.substring(0, 8)}...`
    ).start();

    try {
      const retrieved = await storage.retrieveTrace(result.id);

      if (retrieved) {
        spinner.succeed(
          `Retrieved from ${result.tier} tier: ${retrieved.summary}`
        );
      } else {
        spinner.fail('Trace not found');
      }
    } catch (error) {
      spinner.fail(`Retrieval failed: ${error}`);
    }
  }

  // Get storage statistics
  console.log(chalk.yellow('\n📊 Storage Statistics:'));

  const stats = storage.getStorageStats();

  console.log(chalk.gray('━'.repeat(50)));
  for (const tier of stats.byTier) {
    const icon =
      tier.tier === 'hot' ? '🔥' : tier.tier === 'warm' ? '☁️' : '❄️';
    console.log(`${icon} ${chalk.bold(tier.tier.toUpperCase())} Tier:`);
    console.log(`   Traces: ${tier.count}`);
    console.log(`   Original Size: ${formatBytes(tier.total_original || 0)}`);
    console.log(`   Compressed: ${formatBytes(tier.total_compressed || 0)}`);
    if (tier.avg_compression) {
      console.log(
        `   Compression: ${(tier.avg_compression * 100).toFixed(1)}%`
      );
    }
  }

  // Test Redis-specific operations
  console.log(chalk.yellow('\n🔥 Testing Redis Hot Tier...'));

  const redisClient = createClient({ url: process.env.REDIS_URL });
  await redisClient.connect();

  // Check stored traces in Redis
  const keys = await redisClient.keys('trace:*');
  console.log(`   Traces in Redis: ${chalk.green(keys.length)}`);

  // Check sorted sets
  const byScore = await redisClient.zCard('traces:by_score');
  const byTime = await redisClient.zCard('traces:by_time');
  console.log(`   Score index: ${chalk.green(byScore)} entries`);
  console.log(`   Time index: ${chalk.green(byTime)} entries`);

  // Get top traces by score
  const topTraces = await redisClient.zRangeWithScores(
    'traces:by_score',
    -3,
    -1
  );
  if (topTraces.length > 0) {
    console.log(chalk.yellow('\n🏆 Top Traces by Score:'));
    for (const trace of topTraces.reverse()) {
      console.log(
        `   ${trace.value.substring(0, 8)}... - Score: ${trace.score.toFixed(3)}`
      );
    }
  }

  // Memory usage
  const memInfo = await redisClient.memoryUsage('trace:' + results[0]?.id);
  if (memInfo) {
    console.log(chalk.yellow('\n💾 Memory Usage:'));
    console.log(`   Sample trace memory: ${formatBytes(memInfo)}`);
    console.log(`   Estimated total: ${formatBytes(memInfo * keys.length)}`);
  }

  await redisClient.quit();

  // Test migration
  console.log(chalk.yellow('\n🔄 Testing tier migration...'));

  const migrationResults = await storage.migrateTiers();
  console.log(
    `   Hot → Warm: ${chalk.yellow(migrationResults.hotToWarm)} traces`
  );
  console.log(
    `   Warm → Cold: ${chalk.cyan(migrationResults.warmToCold)} traces`
  );
  if (migrationResults.errors.length > 0) {
    console.log(chalk.red(`   Errors: ${migrationResults.errors.length}`));
  }

  // Cleanup
  db.close();

  console.log(chalk.green('\n✅ Storage tests completed successfully!'));
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

async function main() {
  console.log(chalk.blue.bold('\n🧪 StackMemory Redis Storage Test\n'));

  // Test Redis connection
  const redisConnected = await testRedisConnection();

  if (!redisConnected) {
    console.log(chalk.red('\n❌ Cannot proceed without Redis connection'));
    console.log(chalk.yellow('\nTo fix:'));
    console.log('1. Ensure Redis is running');
    console.log('2. Check REDIS_URL in .env file');
    console.log('3. For Railway: Ensure Redis addon is provisioned');
    process.exit(1);
  }

  // Test storage operations
  await testStorageOperations();

  // Interactive test
  console.log(chalk.blue('\n🎮 Interactive Test'));
  console.log(chalk.gray('━'.repeat(50)));
  console.log(
    chalk.cyan('You can now use the CLI to interact with the stored traces:')
  );
  console.log();
  console.log(
    '  ' +
      chalk.white('stackmemory storage status') +
      '     - View storage statistics'
  );
  console.log(
    '  ' +
      chalk.white('stackmemory storage migrate') +
      '    - Migrate traces between tiers'
  );
  console.log(
    '  ' +
      chalk.white('stackmemory storage retrieve <id>') +
      ' - Retrieve a specific trace'
  );
  console.log();
  console.log(chalk.gray('Trace IDs from this test:'));

  // Show first 3 trace IDs for testing
  const dbPath = join(process.cwd(), '.stackmemory', 'test-context.db');
  const db = new Database(dbPath);

  // Make sure storage_tiers table exists before querying
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_tiers (
      trace_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      location TEXT NOT NULL,
      original_size INTEGER,
      compressed_size INTEGER,
      compression_ratio REAL,
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER DEFAULT (unixepoch()),
      created_at INTEGER DEFAULT (unixepoch()),
      migrated_at INTEGER,
      score REAL,
      migration_score REAL,
      metadata TEXT
    )
  `);

  const recentTraces = db
    .prepare(
      `
    SELECT trace_id, tier FROM storage_tiers 
    ORDER BY created_at DESC LIMIT 3
  `
    )
    .all() as any[];

  for (const trace of recentTraces) {
    const tierIcon =
      trace.tier === 'hot' ? '🔥' : trace.tier === 'warm' ? '☁️' : '❄️';
    console.log(`  ${tierIcon} ${trace.trace_id}`);
  }

  db.close();

  console.log(chalk.green('\n✨ Test complete!'));
}

// Run the test
main().catch((error) => {
  console.error(chalk.red('Test failed:'), error);
  process.exit(1);
});
