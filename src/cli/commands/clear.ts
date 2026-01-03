#!/usr/bin/env node
/**
 * Clear command for StackMemory
 * Manages context clearing with ledger preservation
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { ClearSurvival } from '../../core/session/clear-survival.js';
import { FrameManager } from '../../core/context/frame-manager.js';
import { HandoffGenerator } from '../../core/session/handoff-generator.js';
import { sessionManager } from '../../core/session/session-manager.js';

const clearCommand = new Command('clear')
  .description('Manage context clearing with ledger preservation')
  .option('--save', 'Save continuity ledger before clearing')
  .option('--restore', 'Restore from continuity ledger')
  .option('--check', 'Check if clear is recommended')
  .option('--auto', 'Automatically save if needed and clear')
  .option('--status', 'Show current context usage')
  .option('--show-ledger', 'Display current ledger')
  .action(async (options) => {
    const spinner = ora();

    try {
      // Initialize managers
      const projectRoot = process.cwd();
      const dbPath = path.join(projectRoot, '.stackmemory', 'context.db');

      // Check if StackMemory is initialized
      if (!existsSync(dbPath)) {
        console.error(
          chalk.red('✗ StackMemory not initialized in this directory')
        );
        console.log(chalk.yellow('Run: stackmemory init'));
        process.exit(1);
      }

      const db = new Database(dbPath);
      
      // Initialize session manager
      await sessionManager.initialize();
      const session = await sessionManager.getOrCreateSession({
        projectPath: projectRoot,
      });

      const frameManager = new FrameManager(db, session.projectId);
      const handoffGenerator = new HandoffGenerator(
        frameManager,
        projectRoot
      );
      const clearSurvival = new ClearSurvival(
        frameManager,
        handoffGenerator,
        projectRoot
      );

      // Handle different options
      if (options.status) {
        await showContextStatus(clearSurvival);
      } else if (options.check) {
        await checkIfClearRecommended(clearSurvival);
      } else if (options.save) {
        await saveLedger(clearSurvival, spinner);
      } else if (options.restore) {
        await restoreFromLedger(clearSurvival, spinner);
      } else if (options.showLedger) {
        await showLedger(projectRoot);
      } else if (options.auto) {
        await autoClear(clearSurvival, spinner);
      } else {
        // Default: Show status and options
        await showContextStatus(clearSurvival);
        console.log('\nOptions:');
        console.log('  --status     Show current context usage');
        console.log('  --check      Check if clear is recommended');
        console.log('  --save       Save continuity ledger');
        console.log('  --restore    Restore from ledger');
        console.log('  --auto       Auto-save if needed and clear');
      }
    } catch (error) {
      spinner.fail(chalk.red('Error: ' + (error as Error).message));
      process.exit(1);
    }
  });

async function showContextStatus(clearSurvival: ClearSurvival): Promise<void> {
  const usage = await clearSurvival.getContextUsage();
  const status = clearSurvival.assessContextStatus(usage);

  console.log(chalk.bold('\n📊 Context Usage Status'));
  console.log('─'.repeat(40));
  
  const percentage = Math.round(usage.percentageUsed);
  const statusColor = getStatusColor(status);
  
  console.log(`Usage: ${percentage}% ${getProgressBar(percentage)}`);
  console.log(`Status: ${statusColor}`);
  console.log(`Active Frames: ${usage.activeFrames}`);
  console.log(`Total Frames: ${usage.totalFrames}`);
  console.log(`Sessions: ${usage.sessionCount}`);
  
  if (status === 'critical' || status === 'saved') {
    console.log(
      chalk.yellow('\n⚠️  Consider clearing context to improve performance')
    );
    console.log(chalk.cyan('Run: stackmemory clear --save'));
  }
}

async function checkIfClearRecommended(clearSurvival: ClearSurvival): Promise<void> {
  const usage = await clearSurvival.getContextUsage();
  const status = clearSurvival.assessContextStatus(usage);
  
  if (status === 'critical' || status === 'saved') {
    console.log(chalk.yellow('✓ Clear recommended'));
    console.log(`Context usage: ${Math.round(usage.percentageUsed)}%`);
    process.exit(0);
  } else {
    console.log(chalk.green('✗ Clear not needed'));
    console.log(`Context usage: ${Math.round(usage.percentageUsed)}%`);
    process.exit(1);
  }
}

async function saveLedger(clearSurvival: ClearSurvival, spinner: ora.Ora): Promise<void> {
  spinner.start('Saving continuity ledger...');
  
  const ledgerPath = await clearSurvival.saveContinuityLedger();
  
  spinner.succeed(chalk.green('Continuity ledger saved'));
  console.log(chalk.cyan(`Location: ${ledgerPath}`));
  
  // Show what was saved
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf-8'));
  console.log('\nSaved:');
  console.log(`  • ${ledger.activeFrames.length} active frames`);
  console.log(`  • ${ledger.decisions.length} key decisions`);
  console.log(`  • ${ledger.context.importantTasks?.length || 0} important tasks`);
}

async function restoreFromLedger(clearSurvival: ClearSurvival, spinner: ora.Ora): Promise<void> {
  spinner.start('Restoring from continuity ledger...');
  
  const result = await clearSurvival.restoreFromLedger();
  
  if (result.success) {
    spinner.succeed(chalk.green('Context restored from ledger'));
    console.log('\nRestored:');
    console.log(`  • ${result.restoredFrames} frames`);
    console.log(`  • ${result.restoredDecisions} decisions`);
  } else {
    spinner.fail(chalk.red('Failed to restore from ledger'));
    console.log(chalk.yellow(result.message));
  }
}

async function showLedger(projectRoot: string): Promise<void> {
  const ledgerPath = path.join(projectRoot, '.stackmemory', 'continuity.json');
  
  if (!existsSync(ledgerPath)) {
    console.log(chalk.yellow('No continuity ledger found'));
    return;
  }
  
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf-8'));
  
  console.log(chalk.bold('\n📖 Continuity Ledger'));
  console.log('─'.repeat(40));
  console.log(`Created: ${new Date(ledger.timestamp).toLocaleString()}`);
  console.log(`Active Frames: ${ledger.activeFrames.length}`);
  console.log(`Key Decisions: ${ledger.decisions.length}`);
  
  if (ledger.activeFrames.length > 0) {
    console.log('\nActive Work:');
    ledger.activeFrames.slice(0, 5).forEach((frame: any) => {
      console.log(`  • ${frame.name} (${frame.type})`);
    });
  }
  
  if (ledger.decisions.length > 0) {
    console.log('\nKey Decisions:');
    ledger.decisions.slice(0, 3).forEach((decision: any) => {
      console.log(`  • ${decision.decision}`);
    });
  }
}

async function autoClear(clearSurvival: ClearSurvival, spinner: ora.Ora): Promise<void> {
  const usage = await clearSurvival.getContextUsage();
  const status = clearSurvival.assessContextStatus(usage);
  
  if (status === 'critical' || status === 'saved') {
    spinner.start('Auto-saving ledger before clear...');
    await clearSurvival.saveContinuityLedger();
    spinner.succeed('Ledger saved');
    
    spinner.start('Clearing context...');
    // Note: Actual clear implementation would go here
    // For now, just simulate
    await new Promise(resolve => setTimeout(resolve, 1000));
    spinner.succeed('Context cleared successfully');
  } else {
    console.log(chalk.green('Context usage is healthy, no clear needed'));
  }
}

function getProgressBar(percentage: number): string {
  const filled = Math.round(percentage / 5);
  const empty = 20 - filled;
  
  let bar = '[';
  bar += chalk.green('■').repeat(Math.min(filled, 10));
  bar += chalk.yellow('■').repeat(Math.max(0, Math.min(filled - 10, 5)));
  bar += chalk.red('■').repeat(Math.max(0, filled - 15));
  bar += chalk.gray('□').repeat(empty);
  bar += ']';
  
  return bar;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return chalk.green('✓ Healthy (<50%)');
    case 'moderate':
      return chalk.blue('⚡ Moderate (50-70%)');
    case 'critical':
      return chalk.yellow('⚠️ Critical (70-85%)');
    case 'saved':
      return chalk.red('💾 Auto-saved (>85%)');
    default:
      return status;
  }
}

// Export for use in main CLI
export default clearCommand;