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
import { ClearSurvival } from '../../core/session/clear-survival.js';
import { FrameManager } from '../../core/frame/frame-manager.js';
import { DatabaseManager } from '../../core/storage/database-manager.js';
import { HandoffGenerator } from '../../core/session/handoff-generator.js';

export const clearCommand = new Command('clear')
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
      const dbPath = path.join(projectRoot, '.stackmemory', 'stackmemory.db');

      // Check if StackMemory is initialized
      try {
        await fs.access(dbPath);
      } catch {
        console.error(
          chalk.red('✗ StackMemory not initialized in this directory')
        );
        console.log(chalk.yellow('Run: stackmemory init'));
        process.exit(1);
      }

      const dbManager = new DatabaseManager(dbPath);
      const frameManager = new FrameManager(dbManager);
      const handoffGenerator = new HandoffGenerator(
        frameManager,
        dbManager,
        projectRoot
      );
      const clearSurvival = new ClearSurvival(
        frameManager,
        dbManager,
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
        // Interactive mode
        await interactiveClear(clearSurvival, spinner);
      }
    } catch (error) {
      spinner.fail(chalk.red('Operation failed'));
      console.error(error);
      process.exit(1);
    }
  });

async function showContextStatus(clearSurvival: ClearSurvival) {
  // Simulate token counts (in real implementation, get from session)
  const currentTokens = 70000;
  const maxTokens = 100000;
  const usage = (currentTokens / maxTokens) * 100;

  console.log(chalk.bold('\n📊 Context Status\n'));

  // Visual progress bar
  const barLength = 40;
  const filled = Math.round((usage / 100) * barLength);
  const empty = barLength - filled;

  let barColor = chalk.green;
  if (usage >= 85) barColor = chalk.red;
  else if (usage >= 70) barColor = chalk.yellow;
  else if (usage >= 60) barColor = chalk.cyan;

  const bar = barColor('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));

  console.log(`Context Usage: ${bar} ${usage.toFixed(1)}%`);
  console.log(
    `Tokens: ${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()}`
  );

  // Recommendations
  const status = await clearSurvival.monitorContextUsage(
    currentTokens,
    maxTokens
  );

  console.log('\nStatus:', getStatusMessage(status));

  if (status === 'critical' || status === 'warning') {
    const recommendation = await clearSurvival.shouldClear(
      currentTokens,
      maxTokens
    );
    if (recommendation.recommended) {
      console.log(chalk.yellow(`\n⚠️ ${recommendation.reason}`));
      console.log(
        chalk.cyan(
          `Suggestion: ${recommendation.alternative || 'Run: stackmemory clear --save'}`
        )
      );
    }
  }
}

async function checkIfClearRecommended(clearSurvival: ClearSurvival) {
  const currentTokens = 75000;
  const maxTokens = 100000;

  const recommendation = await clearSurvival.shouldClear(
    currentTokens,
    maxTokens
  );

  if (recommendation.recommended) {
    console.log(chalk.yellow('\n⚠️ Clear Recommended\n'));
    console.log(`Reason: ${recommendation.reason}`);
    console.log(
      `Action: ${recommendation.alternative || 'Run: stackmemory clear --save'}`
    );
  } else {
    console.log(chalk.green('\n✓ No Clear Needed\n'));
    if (recommendation.alternative) {
      console.log(`Status: ${recommendation.alternative}`);
    }
  }
}

async function saveLedger(clearSurvival: ClearSurvival, spinner: any) {
  spinner.start('Saving continuity ledger...');

  const ledger = await clearSurvival.saveContinuityLedger();

  spinner.succeed(chalk.green('Continuity ledger saved'));

  console.log(chalk.bold('\n📚 Ledger Summary\n'));
  console.log(`Compression: ${Math.round(ledger.compression_ratio)}x`);
  console.log(`Frames: ${ledger.active_frame_stack.length}`);
  console.log(`Decisions: ${ledger.key_decisions.length}`);
  console.log(
    `Tasks: ${ledger.active_tasks.filter((t) => t.status !== 'completed').length} active`
  );
  console.log(`Focus: ${ledger.current_focus}`);

  if (ledger.warnings.length > 0) {
    console.log(chalk.yellow(`\nWarnings:`));
    ledger.warnings.forEach((w) => console.log(`  - ${w}`));
  }

  console.log(
    chalk.cyan('\n✓ Ready for /clear - context will be restored automatically')
  );
}

async function restoreFromLedger(clearSurvival: ClearSurvival, spinner: any) {
  spinner.start('Restoring from continuity ledger...');

  const success = await clearSurvival.restoreFromLedger();

  if (success) {
    spinner.succeed(chalk.green('Context restored from ledger'));
    console.log(chalk.cyan('\n✓ Previous context restored - continue working'));
  } else {
    spinner.fail(chalk.red('No ledger found to restore'));
    console.log(chalk.yellow('Start fresh or check .stackmemory/continuity/'));
  }
}

async function showLedger(projectRoot: string) {
  const ledgerPath = path.join(
    projectRoot,
    '.stackmemory',
    'continuity',
    'CONTINUITY_CLAUDE-latest.md'
  );

  try {
    const content = await fs.readFile(ledgerPath, 'utf-8');
    console.log(content);
  } catch (error) {
    console.log(chalk.red('No continuity ledger found'));
    console.log(chalk.yellow('Run: stackmemory clear --save'));
  }
}

async function autoClear(clearSurvival: ClearSurvival, spinner: any) {
  spinner.start('Checking context...');

  const currentTokens = 85000;
  const maxTokens = 100000;

  const status = await clearSurvival.monitorContextUsage(
    currentTokens,
    maxTokens
  );

  if (status === 'saved') {
    spinner.succeed(chalk.green('Auto-saved ledger (context at 85%)'));
    console.log(chalk.cyan('\n✓ Ledger saved - you can now use /clear'));
  } else if (status === 'critical') {
    spinner.info('Context critical - saving ledger...');
    await clearSurvival.saveContinuityLedger();
    spinner.succeed(chalk.green('Ledger saved'));
    console.log(chalk.cyan('\n✓ Ready for /clear'));
  } else {
    spinner.info(`Context ${status} - no action needed`);
  }
}

async function interactiveClear(clearSurvival: ClearSurvival, spinner: any) {
  console.log(chalk.bold('\n🔄 Context Clear Management\n'));

  // Show current status
  const currentTokens = 70000;
  const maxTokens = 100000;
  const usage = (currentTokens / maxTokens) * 100;

  console.log(`Current usage: ${usage.toFixed(1)}%`);

  const recommendation = await clearSurvival.shouldClear(
    currentTokens,
    maxTokens
  );

  if (recommendation.recommended) {
    console.log(chalk.yellow(`\nClear recommended: ${recommendation.reason}`));
    console.log(chalk.cyan('\nOptions:'));
    console.log('1. Save ledger and prepare for clear');
    console.log('2. Check status only');
    console.log('3. Exit');

    // In a real implementation, use inquirer for interactive prompts
    console.log(chalk.gray('\nRun: stackmemory clear --save'));
  } else {
    console.log(chalk.green('\n✓ Context healthy - no clear needed'));
    console.log(chalk.gray(`Status: ${recommendation.alternative}`));
  }
}

function getStatusMessage(status: string): string {
  switch (status) {
    case 'ok':
      return chalk.green('✓ Healthy (<60%)');
    case 'warning':
      return chalk.cyan('⚠ Warning (60-70%)');
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
