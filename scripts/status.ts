#!/usr/bin/env tsx
/**
 * Check StackMemory status and statistics
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const projectRoot = process.cwd();
const dbPath = join(projectRoot, '.stackmemory', 'context.db');

if (!existsSync(dbPath)) {
  console.log(chalk.red('❌ StackMemory not initialized in this project'));
  console.log(chalk.gray('Run: npm run init'));
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

console.log(chalk.blue.bold('\n📊 StackMemory Status\n'));

// Get statistics
const stats = {
  contexts: db.prepare('SELECT COUNT(*) as count FROM contexts').get() as any,
  frames: db.prepare('SELECT COUNT(*) as count FROM frames').get() as any,
  attention: db.prepare('SELECT COUNT(*) as count FROM attention_log').get() as any,
};

console.log(chalk.green('Database:') + ` ${dbPath}`);
console.log(chalk.green('Contexts:') + ` ${stats.contexts.count}`);
console.log(chalk.green('Frames:') + ` ${stats.frames.count}`);
console.log(chalk.green('Attention logs:') + ` ${stats.attention.count}`);

// Get top contexts by importance
console.log(chalk.blue('\n🎯 Top Contexts by Importance:\n'));

const topContexts = db.prepare(`
  SELECT type, substr(content, 1, 60) as preview, importance, access_count
  FROM contexts
  ORDER BY importance DESC, access_count DESC
  LIMIT 5
`).all() as any[];

topContexts.forEach((ctx, i) => {
  const importance = '●'.repeat(Math.round(ctx.importance * 5));
  console.log(
    chalk.cyan(`${i + 1}.`) + 
    ` [${ctx.type}] ` +
    chalk.gray(`(${ctx.access_count} uses)`) +
    ` ${importance}`
  );
  console.log(chalk.gray(`   ${ctx.preview}...`));
});

// Get active frames
const activeFrames = db.prepare(`
  SELECT task, datetime(created_at, 'unixepoch') as started
  FROM frames
  WHERE status = 'active'
  ORDER BY created_at DESC
  LIMIT 3
`).all() as any[];

if (activeFrames.length > 0) {
  console.log(chalk.blue('\n🔄 Active Tasks:\n'));
  activeFrames.forEach(frame => {
    console.log(chalk.green('•') + ` ${frame.task}`);
    console.log(chalk.gray(`  Started: ${frame.started}`));
  });
}

// Get recent attention patterns
const recentAttention = db.prepare(`
  SELECT 
    substr(query, 1, 50) as query_preview,
    COUNT(*) as count
  FROM attention_log
  WHERE timestamp > unixepoch() - 86400
  GROUP BY query_preview
  ORDER BY count DESC
  LIMIT 3
`).all() as any[];

if (recentAttention.length > 0) {
  console.log(chalk.blue('\n👁️ Recent Query Patterns:\n'));
  recentAttention.forEach(pattern => {
    console.log(chalk.yellow('?') + ` "${pattern.query_preview}..." (${pattern.count}x)`);
  });
}

// Show context decay
const oldContexts = db.prepare(`
  SELECT COUNT(*) as count
  FROM contexts
  WHERE last_accessed < unixepoch() - 86400 * 7
`).get() as any;

if (oldContexts.count > 0) {
  console.log(chalk.yellow(`\n⚠️  ${oldContexts.count} contexts haven't been accessed in 7+ days`));
}

console.log(chalk.gray('\n💡 Tip: Run "npm run analyze" for detailed attention analysis\n'));

db.close();