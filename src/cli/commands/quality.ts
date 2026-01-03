#!/usr/bin/env node

/**
 * Quality command for StackMemory
 * Manages post-task quality gates and code review automation
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import {
  PostTaskHooks,
  PostTaskConfig,
  QualityGateResult,
} from '../../integrations/claude-code/post-task-hooks.js';
import { FrameManager } from '../../core/context/frame-manager.js';
import Database from 'better-sqlite3';
// getProjectRoot function will be defined below
import * as fs from 'fs/promises';
import * as path from 'path';

export function createQualityCommand(): Command {
  const cmd = new Command('quality')
    .description('Manage post-task quality gates and automation')
    .option('--enable', 'Enable quality gates')
    .option('--disable', 'Disable quality gates')
    .option('--status', 'Show quality gate status')
    .option('--config', 'Configure quality gates')
    .option('--run', 'Run quality gates manually')
    .option('--history', 'Show quality gate history')
    .option('--setup', 'Interactive setup wizard')
    .action(async (options) => {
      const spinner = ora();

      try {
        const projectRoot = await getProjectRoot();
        const dbPath = path.join(
          projectRoot,
          '.stackmemory',
          'db',
          'stackmemory.db'
        );

        // Check if StackMemory is initialized
        try {
          await fs.access(dbPath);
        } catch {
          console.error(chalk.red('✗ StackMemory not initialized'));
          console.log(chalk.yellow('Run: stackmemory init'));
          process.exit(1);
        }

        const db = new Database(dbPath);
        const frameManager = new FrameManager(db);

        if (options.enable) {
          await enableQualityGates(
            projectRoot,
            frameManager,
            db,
            spinner
          );
        } else if (options.disable) {
          await disableQualityGates(projectRoot, spinner);
        } else if (options.status) {
          await showStatus(projectRoot, frameManager, db);
        } else if (options.config) {
          await configureQualityGates(projectRoot);
        } else if (options.run) {
          await runQualityGates(projectRoot, frameManager, db, spinner);
        } else if (options.history) {
          await showHistory(frameManager);
        } else if (options.setup) {
          await setupWizard(projectRoot, frameManager, db);
        } else {
          // Default: show status
          await showStatus(projectRoot, frameManager, db);
        }
      } catch (error) {
        spinner.fail(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Enable quality gates
 */
async function enableQualityGates(
  projectRoot: string,
  frameManager: FrameManager,
  db: any,
  spinner: any
) {
  spinner.start('Enabling quality gates...');

  try {
    // Load or create config
    const config = await loadConfig(projectRoot);
    config.qualityGates = {
      ...config.qualityGates,
      runTests: true,
      runCodeReview: true,
      runLinter: true,
    };

    // Initialize hooks
    const hooks = new PostTaskHooks(frameManager, db, config);
    await hooks.initialize();

    // Save config
    await saveConfig(projectRoot, config);

    // Create systemd-style service file for persistence
    await createServiceFile(projectRoot);

    spinner.succeed(chalk.green('✅ Quality gates enabled'));

    console.log(chalk.bold('\n🔍 Quality Gates Active:'));
    console.log('  • Auto-run tests after code changes');
    console.log('  • Auto-run linter on file saves');
    console.log('  • Auto-trigger code review on task completion');
    console.log('  • Real-time file change monitoring');

    console.log(chalk.gray('\nDisable with: stackmemory quality --disable'));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to enable quality gates: ${error}`));
  }
}

/**
 * Disable quality gates
 */
async function disableQualityGates(projectRoot: string, spinner: ora.Ora) {
  spinner.start('Disabling quality gates...');

  try {
    const config = await loadConfig(projectRoot);
    config.qualityGates = {
      ...config.qualityGates,
      runTests: false,
      runCodeReview: false,
      runLinter: false,
    };

    await saveConfig(projectRoot, config);

    // Remove service file
    const serviceFile = path.join(
      projectRoot,
      '.stackmemory',
      'quality.service'
    );
    try {
      await fs.unlink(serviceFile);
    } catch {
      // Service file doesn't exist
    }

    spinner.succeed(chalk.green('✅ Quality gates disabled'));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to disable quality gates: ${error}`));
  }
}

/**
 * Show quality gate status
 */
async function showStatus(
  projectRoot: string,
  frameManager: FrameManager,
  db: Database
) {
  console.log(chalk.bold('\n📊 Quality Gates Status\n'));

  try {
    const config = await loadConfig(projectRoot);

    // Overall status
    const isEnabled =
      config.qualityGates?.runTests ||
      config.qualityGates?.runCodeReview ||
      config.qualityGates?.runLinter;
    console.log(
      `Status: ${isEnabled ? chalk.green('✅ Enabled') : chalk.yellow('⚠️ Disabled')}`
    );

    // Individual gates
    console.log('\nGates:');
    console.log(
      `  Tests: ${config.qualityGates?.runTests ? '✅' : '❌'} ${getTestCommand(config)}`
    );
    console.log(
      `  Linter: ${config.qualityGates?.runLinter ? '✅' : '❌'} ${getLintCommand(config)}`
    );
    console.log(
      `  Code Review: ${config.qualityGates?.runCodeReview ? '✅' : '❌'}`
    );
    console.log(
      `  Coverage: ${config.qualityGates?.requireTestCoverage ? '✅' : '❌'}`
    );

    // Detected frameworks
    if (config.testFrameworks?.detected.length) {
      console.log('\nDetected Frameworks:');
      config.testFrameworks.detected.forEach((fw) => {
        console.log(`  • ${fw}`);
      });
    }

    // Recent quality results
    const recentResults = await getRecentQualityResults(frameManager);
    if (recentResults.length > 0) {
      console.log('\nRecent Results:');
      recentResults.slice(0, 3).forEach((result) => {
        const icon = result.passed ? '✅' : '❌';
        console.log(
          `  ${icon} ${result.frameName} (${new Date(result.timestamp).toLocaleString()})`
        );
      });
    }
  } catch (error) {
    console.error(chalk.red('Failed to get status:', error));
  }
}

/**
 * Configure quality gates
 */
async function configureQualityGates(projectRoot: string) {
  console.log(chalk.bold('\n⚙️ Quality Gates Configuration\n'));

  try {
    const config = await loadConfig(projectRoot);

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'runTests',
        message: 'Auto-run tests after code changes?',
        default: config.qualityGates?.runTests ?? true,
      },
      {
        type: 'confirm',
        name: 'runLinter',
        message: 'Auto-run linter on file changes?',
        default: config.qualityGates?.runLinter ?? true,
      },
      {
        type: 'confirm',
        name: 'runCodeReview',
        message: 'Auto-trigger code review on task completion?',
        default: config.qualityGates?.runCodeReview ?? true,
      },
      {
        type: 'confirm',
        name: 'requireTestCoverage',
        message: 'Require test coverage checks?',
        default: config.qualityGates?.requireTestCoverage ?? false,
      },
      {
        type: 'confirm',
        name: 'blockOnFailure',
        message: 'Block further work when quality gates fail?',
        default: config.qualityGates?.blockOnFailure ?? false,
      },
      {
        type: 'input',
        name: 'testCommand',
        message: 'Custom test command (leave empty for auto-detect):',
        default: config.testFrameworks?.testCommand || '',
      },
      {
        type: 'input',
        name: 'lintCommand',
        message: 'Custom lint command (leave empty for auto-detect):',
        default: config.testFrameworks?.lintCommand || '',
      },
    ]);

    // Update config
    config.qualityGates = {
      runTests: answers.runTests,
      runLinter: answers.runLinter,
      runCodeReview: answers.runCodeReview,
      requireTestCoverage: answers.requireTestCoverage,
      blockOnFailure: answers.blockOnFailure,
    };

    config.testFrameworks = {
      ...config.testFrameworks,
      testCommand: answers.testCommand || config.testFrameworks?.testCommand,
      lintCommand: answers.lintCommand || config.testFrameworks?.lintCommand,
    };

    await saveConfig(projectRoot, config);

    console.log(chalk.green('\n✅ Configuration saved'));
    console.log(chalk.gray('Enable with: stackmemory quality --enable'));
  } catch (error) {
    console.error(chalk.red('Configuration failed:', error));
  }
}

/**
 * Run quality gates manually
 */
async function runQualityGates(
  projectRoot: string,
  frameManager: FrameManager,
  db: any,
  spinner: any
) {
  spinner.start('Running quality gates...');

  try {
    const config = await loadConfig(projectRoot);
    const hooks = new PostTaskHooks(frameManager, db, config);

    // Simulate a task completion event
    const mockEvent = {
      taskType: 'task_complete' as const,
      frameId: 'manual-run',
      frameName: 'Manual quality gate run',
      files: await getRecentlyModifiedFiles(projectRoot),
      changes: { added: 0, removed: 0, modified: 1 },
      metadata: { trigger: 'manual' },
    };

    // Run quality gates
    const results = await (hooks as any).runQualityGates(mockEvent);

    spinner.succeed(chalk.green('✅ Quality gates completed'));

    // Show results
    console.log(chalk.bold('\n📋 Quality Gate Results:\n'));

    results.forEach((result: QualityGateResult) => {
      const icon = result.passed ? '✅' : '❌';
      const duration =
        result.duration < 1000
          ? `${result.duration}ms`
          : `${Math.round(result.duration / 1000)}s`;

      console.log(`${icon} ${result.gate} (${duration})`);

      if (!result.passed && result.issues) {
        result.issues.slice(0, 3).forEach((issue) => {
          console.log(
            `   ${issue.severity === 'error' ? '❌' : '⚠️'} ${issue.message}`
          );
        });
        if (result.issues.length > 3) {
          console.log(
            chalk.gray(`   ... and ${result.issues.length - 3} more issues`)
          );
        }
      }
    });

    const allPassed = results.every((r: QualityGateResult) => r.passed);
    if (allPassed) {
      console.log(chalk.green('\n🎉 All quality gates passed!'));
    } else {
      console.log(
        chalk.yellow('\n⚠️ Some quality gates failed. See details above.')
      );
    }
  } catch (error) {
    spinner.fail(chalk.red(`Quality gates failed: ${error}`));
  }
}

/**
 * Show quality gate history
 */
async function showHistory(frameManager: FrameManager) {
  console.log(chalk.bold('\n📈 Quality Gate History\n'));

  try {
    const results = await getRecentQualityResults(frameManager);

    if (results.length === 0) {
      console.log(chalk.gray('No quality gate history found'));
      return;
    }

    results.slice(0, 10).forEach((result, index) => {
      const icon = result.passed ? '✅' : '❌';
      const date = new Date(result.timestamp).toLocaleDateString();
      const time = new Date(result.timestamp).toLocaleTimeString();

      console.log(`${icon} ${result.frameName}`);
      console.log(chalk.gray(`   ${date} ${time} - ${result.duration}ms`));

      if (result.gates) {
        result.gates.forEach((gate: any) => {
          const gateIcon = gate.passed ? '  ✓' : '  ✗';
          console.log(chalk.gray(`${gateIcon} ${gate.gate}`));
        });
      }

      if (index < results.length - 1) console.log('');
    });
  } catch (error) {
    console.error(chalk.red('Failed to get history:', error));
  }
}

/**
 * Setup wizard
 */
async function setupWizard(
  projectRoot: string,
  frameManager: FrameManager,
  db: Database
) {
  console.log(chalk.bold('🧙 Quality Gates Setup Wizard\n'));

  console.log(
    'This wizard will help you configure automatic quality gates for your project.'
  );
  console.log(
    'Quality gates run automatically after Claude completes tasks.\n'
  );

  // Detect project type
  const packageJsonPath = path.join(projectRoot, 'package.json');
  let projectType = 'unknown';
  let detectedFrameworks: string[] = [];

  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    const deps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    if (deps.react) projectType = 'React';
    else if (deps.vue) projectType = 'Vue';
    else if (deps.angular) projectType = 'Angular';
    else if (deps.express) projectType = 'Node.js API';
    else if (deps.nextjs) projectType = 'Next.js';

    if (deps.jest) detectedFrameworks.push('Jest');
    if (deps.vitest) detectedFrameworks.push('Vitest');
    if (deps.playwright) detectedFrameworks.push('Playwright');
    if (deps.eslint) detectedFrameworks.push('ESLint');
  } catch {
    // No package.json or invalid
  }

  console.log(`📦 Detected project: ${chalk.cyan(projectType)}`);
  if (detectedFrameworks.length) {
    console.log(
      `🔧 Detected tools: ${chalk.cyan(detectedFrameworks.join(', '))}`
    );
  }
  console.log('');

  const { proceed } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'proceed',
      message: 'Continue with setup?',
      default: true,
    },
  ]);

  if (!proceed) {
    console.log(chalk.gray('Setup cancelled'));
    return;
  }

  // Configure quality gates
  await configureQualityGates(projectRoot);

  // Enable quality gates
  const { enable } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enable',
      message: 'Enable quality gates now?',
      default: true,
    },
  ]);

  if (enable) {
    const spinner = ora();
    await enableQualityGates(projectRoot, frameManager, db, spinner);
  }

  console.log(chalk.bold('\n🎉 Setup Complete!\n'));
  console.log(
    'Quality gates will now run automatically after Claude completes tasks.'
  );
  console.log('Check status with: stackmemory quality --status');
}

// Helper functions

async function getProjectRoot(): Promise<string> {
  return process.cwd();
}

async function loadConfig(
  projectRoot: string
): Promise<Partial<PostTaskConfig>> {
  const configPath = path.join(projectRoot, '.stackmemory', 'config.json');

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveConfig(
  projectRoot: string,
  config: Partial<PostTaskConfig>
): Promise<void> {
  const configPath = path.join(projectRoot, '.stackmemory', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function getTestCommand(config: Partial<PostTaskConfig>): string {
  if (config.testFrameworks?.testCommand) {
    return chalk.gray(`(${config.testFrameworks.testCommand})`);
  }
  return chalk.gray('(auto-detect)');
}

function getLintCommand(config: Partial<PostTaskConfig>): string {
  if (config.testFrameworks?.lintCommand) {
    return chalk.gray(`(${config.testFrameworks.lintCommand})`);
  }
  return chalk.gray('(auto-detect)');
}

async function getRecentQualityResults(
  frameManager: FrameManager
): Promise<any[]> {
  // This would query the frame metadata for quality gate results
  // For now, return empty array
  return [];
}

async function getRecentlyModifiedFiles(
  projectRoot: string
): Promise<string[]> {
  try {
    const { execSync } = await import('child_process');
    const output = execSync('git diff --name-only HEAD~1', {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    return output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

async function createServiceFile(projectRoot: string): Promise<void> {
  const serviceContent = `# StackMemory Quality Gates Service
# This file indicates quality gates are enabled
# Created: ${new Date().toISOString()}
`;

  const servicePath = path.join(projectRoot, '.stackmemory', 'quality.service');
  await fs.writeFile(servicePath, serviceContent, 'utf-8');
}

// Export for use in main CLI
export default createQualityCommand();
