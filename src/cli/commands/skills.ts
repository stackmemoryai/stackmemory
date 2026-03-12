#!/usr/bin/env node
/**
 * Claude Skills CLI Commands
 * Integrates Claude skills into the stackmemory CLI
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  _ClaudeSkillsManager,
  type SkillContext,
} from '../../skills/claude-skills.js';
import {
  UnifiedRLMOrchestrator,
  initializeUnifiedOrchestrator,
} from '../../skills/unified-rlm-orchestrator.js';
import { DualStackManager } from '../../core/context/dual-stack-manager.js';
import { FrameHandoffManager } from '../../core/context/frame-handoff-manager.js';
import { FrameManager } from '../../core/context/index.js';
import { ContextRetriever } from '../../core/retrieval/context-retriever.js';
import { SQLiteAdapter } from '../../core/database/sqlite-adapter.js';
import { createTransformersProvider } from '../../core/database/transformers-embedding-provider.js';
import { LinearTaskManager } from '../../features/tasks/linear-task-manager.js';
import { ConfigManager } from '../../core/config/config-manager.js';
import * as path from 'path';
import * as os from 'os';
import {
  SystemError,
  DatabaseError,
  ErrorCode,
} from '../../core/errors/index.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// VERSION is only used for verbose spike output — resolve lazily
let _version: string | undefined;
function getVersion(): string {
  if (_version) return _version;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Walk up to project root from src/cli/commands/ (or dist/src/cli/commands/)
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'package.json');
      try {
        _version = JSON.parse(readFileSync(candidate, 'utf-8')).version;
        return _version!;
      } catch {
        dir = path.dirname(dir);
      }
    }
  } catch {
    // fallback
  }
  _version = '0.0.0';
  return _version;
}

// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new SystemError(
      `Environment variable ${key} is required`,
      ErrorCode.CONFIGURATION_ERROR,
      { variable: key }
    );
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

async function initializeSkillContext(): Promise<{
  context: SkillContext;
  unifiedOrchestrator: UnifiedRLMOrchestrator;
}> {
  const config = ConfigManager.getInstance();
  const projectId = config.get('project.id') || 'default-project';
  const userId = config.get('user.id') || process.env['USER'] || 'default';

  const dbPath = path.join(
    os.homedir(),
    '.stackmemory',
    'data',
    projectId,
    'stackmemory.db'
  );

  const embeddingProvider = (await createTransformersProvider()) ?? undefined;
  const database = new SQLiteAdapter(projectId, { dbPath, embeddingProvider });
  await database.connect();
  await database.initializeSchema();

  // Get raw database for FrameManager
  const rawDatabase = database.getRawDatabase();
  if (!rawDatabase) {
    throw new DatabaseError(
      'Failed to get raw database connection',
      ErrorCode.DB_CONNECTION_FAILED,
      { projectId, operation: 'initializeSkillContext' }
    );
  }

  // Validate database has required methods
  if (typeof rawDatabase.exec !== 'function') {
    throw new DatabaseError(
      `Invalid database instance: missing exec() method. Got: ${typeof rawDatabase.exec}`,
      ErrorCode.DB_CONNECTION_FAILED,
      { projectId, operation: 'initializeSkillContext' }
    );
  }

  // Test database connectivity
  try {
    rawDatabase.exec('SELECT 1');
  } catch (err) {
    throw new DatabaseError(
      `Database connection test failed: ${(err as Error).message}`,
      ErrorCode.DB_CONNECTION_FAILED,
      { projectId, operation: 'initializeSkillContext' },
      err as Error
    );
  }

  const dualStackManager = new DualStackManager(database, projectId, userId);
  const handoffManager = new FrameHandoffManager(dualStackManager);
  const contextRetriever = new ContextRetriever(database);
  const frameManager = new FrameManager(rawDatabase, projectId);
  const taskStore = new LinearTaskManager();

  const context: SkillContext = {
    projectId,
    userId,
    dualStackManager,
    handoffManager,
    contextRetriever,
    database,
    frameManager,
  };

  // Initialize unified RLM orchestrator
  const unifiedOrchestrator = initializeUnifiedOrchestrator(
    frameManager,
    dualStackManager,
    contextRetriever,
    taskStore,
    context
  );

  return { context, unifiedOrchestrator };
}

export function createSkillsCommand(): Command {
  const skillsCmd = new Command('skills').description(
    'Execute Claude skills for enhanced workflow'
  );

  // Handoff skill command
  skillsCmd
    .command('handoff <targetUser> <message>')
    .description('Streamline frame handoffs between team members')
    .option(
      '-p, --priority <level>',
      'Set priority (low, medium, high, critical)',
      'medium'
    )
    .option('-f, --frames <frames...>', 'Specific frames to handoff')
    .option('--no-auto-detect', 'Disable auto-detection of frames')
    .action(async (targetUser, message, options) => {
      const spinner = ora('Initiating handoff...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        // Use unified RLM orchestrator for RLM-first execution
        const result = await unifiedOrchestrator.executeSkill(
          'handoff',
          [targetUser, message],
          {
            priority: options.priority,
            frames: options.frames,
            autoDetect: options.autoDetect !== false,
          }
        );

        spinner.stop();

        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(chalk.cyan('\nHandoff Details:'));
            console.log(`  ID: ${result.data.handoffId}`);
            console.log(`  Frames: ${result.data.frameCount}`);
            console.log(`  Priority: ${result.data.priority}`);
            if (result.data.actionItems?.length > 0) {
              console.log(chalk.yellow('\n  Action Items:'));
              result.data.actionItems.forEach((item) => {
                console.log(`    • ${item}`);
              });
            }
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  // Checkpoint skill commands
  const checkpointCmd = skillsCmd
    .command('checkpoint')
    .description('Create and manage recovery points');

  checkpointCmd
    .command('create <description>')
    .description('Create a new checkpoint')
    .option('--files <files...>', 'Include specific files in checkpoint')
    .option('--auto-detect-risky', 'Auto-detect risky operations')
    .action(async (description, options) => {
      const spinner = ora('Creating checkpoint...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        const result = await unifiedOrchestrator.executeSkill(
          'checkpoint',
          ['create', description],
          {
            includeFiles: options.files,
            autoDetectRisky: options.autoDetectRisky,
          }
        );

        spinner.stop();

        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(chalk.cyan('\nCheckpoint Info:'));
            console.log(`  ID: ${result.data.checkpointId}`);
            console.log(`  Time: ${result.data.timestamp}`);
            console.log(`  Frames: ${result.data.frameCount}`);
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  checkpointCmd
    .command('restore <checkpointId>')
    .description('Restore from a checkpoint')
    .action(async (checkpointId) => {
      const spinner = ora('Restoring checkpoint...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        const result = await unifiedOrchestrator.executeSkill('checkpoint', [
          'restore',
          checkpointId,
        ]);

        spinner.stop();

        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(chalk.cyan('\nRestored:'));
            console.log(`  Frames: ${result.data.frameCount}`);
            console.log(`  Files: ${result.data.filesRestored}`);
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  checkpointCmd
    .command('list')
    .description('List available checkpoints')
    .option('-l, --limit <number>', 'Limit number of results', '10')
    .option('-s, --since <date>', 'Show checkpoints since date')
    .action(async (options) => {
      const spinner = ora('Loading checkpoints...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        const result = await unifiedOrchestrator.executeSkill(
          'checkpoint',
          ['list'],
          {
            limit: parseInt(options.limit),
            since: options.since ? new Date(options.since) : undefined,
          }
        );

        spinner.stop();

        if (result.success) {
          console.log(chalk.cyan('Available Checkpoints:\n'));
          if (result.data && result.data.length > 0) {
            result.data.forEach((cp: any) => {
              const riskIndicator = cp.risky ? chalk.yellow(' [RISKY]') : '';
              console.log(`${chalk.bold(cp.id)}${riskIndicator}`);
              console.log(`  ${cp.description}`);
              console.log(
                chalk.gray(`  ${cp.timestamp} (${cp.frameCount} frames)\n`)
              );
            });
          } else {
            console.log(chalk.gray('No checkpoints found'));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  checkpointCmd
    .command('diff <checkpoint1> <checkpoint2>')
    .description('Show differences between two checkpoints')
    .action(async (checkpoint1, checkpoint2) => {
      const spinner = ora('Comparing checkpoints...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        const result = await unifiedOrchestrator.executeSkill('checkpoint', [
          'diff',
          checkpoint1,
          checkpoint2,
        ]);

        spinner.stop();

        if (result.success) {
          console.log(chalk.cyan('Checkpoint Diff:\n'));
          if (result.data) {
            console.log(`  Time difference: ${result.data.timeDiff}`);
            console.log(`  Frame difference: ${result.data.framesDiff}`);
            console.log(`  New frames: ${result.data.newFrames}`);
            console.log(`  Removed frames: ${result.data.removedFrames}`);
            console.log(`  Modified frames: ${result.data.modifiedFrames}`);
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  // Multi-modal spike (planner/implementer/critic)
  skillsCmd
    .command('spike')
    .description(
      'Run multi-agent spike (planner: Claude, implementer: Codex/Claude, critic: Claude)'
    )
    .option('-t, --task <desc>', 'Task description', 'Spike harness')
    .option(
      '--planner-model <name>',
      'Claude model for planning',
      'claude-sonnet-4-20250514'
    )
    .option(
      '--reviewer-model <name>',
      'Claude model for review',
      'claude-sonnet-4-20250514'
    )
    .option('--implementer <name>', 'codex|claude', 'codex')
    .option('--max-iters <n>', 'Retry loop iterations', '2')
    .option(
      '--execute',
      'Execute implementer (codex-sm) instead of dry-run',
      false
    )
    .option('--audit-dir <path>', 'Persist spike results to directory')
    .option('--record-frame', 'Record as real frame with anchors', false)
    .option(
      '--record',
      'Record plan & critique into StackMemory context',
      false
    )
    .option('--json', 'Emit single JSON result (UI-friendly)', false)
    .option('--quiet', 'Minimal output (default)', true)
    .option('--verbose', 'Verbose sectioned output', false)
    .action(async (options) => {
      const spinner = ora('Planning with Claude...').start();

      try {
        const { runSpike } =
          await import('../../orchestrators/multimodal/harness.js');
        const result = await runSpike(
          {
            task: options.task,
            repoPath: process.cwd(),
          },
          {
            plannerModel: options.plannerModel,
            reviewerModel: options.reviewerModel,
            implementer: options.implementer,
            maxIters: parseInt(options.maxIters),
            dryRun: !options.execute,
            auditDir: options.auditDir,
            recordFrame: Boolean(options.recordFrame),
            record: Boolean(options.record),
          }
        );

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result));
        } else if (options.verbose) {
          console.log(chalk.gray(`StackMemory v${getVersion()}`));
          console.log(chalk.cyan('\n=== Plan ==='));
          console.log(JSON.stringify(result.plan, null, 2));
          console.log(chalk.cyan('\n=== Iterations ==='));
          (result.iterations || []).forEach((it, idx) => {
            console.log(chalk.gray(`\n-- Attempt ${idx + 1} --`));
            console.log(`Command: ${it.command}`);
            console.log(`OK: ${it.ok}`);
            console.log('Critique:', JSON.stringify(it.critique));
          });
          console.log(chalk.cyan('\n=== Final ==='));
          console.log(JSON.stringify(result.implementation, null, 2));
          console.log(chalk.cyan('\n=== Critique ==='));
          console.log(JSON.stringify(result.critique, null, 2));
        } else if (!options.quiet) {
          console.log(
            `Plan steps: ${result.plan.steps.length}, Approved: ${result.critique.approved}`
          );
        }

        if (!result.implementation.success) process.exitCode = 1;
      } catch (error: any) {
        spinner.stop();
        console.error(chalk.red('Spike failed:'), error?.message || error);
        process.exit(1);
      }
    });

  // Context Archaeologist skill command
  // Lightweight planning helper
  skillsCmd
    .command('plan <task>')
    .description('Generate an implementation plan (no code execution)')
    .option(
      '--planner-model <name>',
      'Claude model for planning',
      'claude-sonnet-4-20250514'
    )
    .option('--json', 'Emit JSON (default)', true)
    .option('--pretty', 'Pretty-print JSON', false)
    .option(
      '--compact',
      'Compact output (summary + step titles + criteria)',
      false
    )
    .action(async (task, options) => {
      const spinner = ora('Planning with Claude...').start();
      try {
        const { runPlanOnly } =
          await import('../../orchestrators/multimodal/harness.js');
        const plan = await runPlanOnly(
          { task, repoPath: process.cwd() },
          { plannerModel: options.plannerModel }
        );
        spinner.stop();
        const planRecord = plan as Record<string, unknown> | undefined;
        const compacted = options.compact
          ? {
              summary: plan?.summary,
              steps: Array.isArray(planRecord?.steps)
                ? (
                    planRecord.steps as Array<{
                      id: string;
                      title: string;
                      acceptanceCriteria: string;
                    }>
                  ).map((s) => ({
                    id: s.id,
                    title: s.title,
                    acceptanceCriteria: s.acceptanceCriteria,
                  }))
                : [],
              risks: planRecord?.risks,
            }
          : plan;
        const payload = JSON.stringify(compacted, null, options.pretty ? 2 : 0);
        console.log(payload);
      } catch (error: any) {
        spinner.stop();
        console.error(chalk.red('Plan failed:'), error?.message || error);
        process.exit(1);
      }
    });

  skillsCmd
    .command('dig <query>')
    .description('Deep historical context retrieval')
    .option(
      '-d, --depth <depth>',
      'Search depth (e.g., 30days, 6months, all)',
      '30days'
    )
    .option('--patterns', 'Extract patterns from results')
    .option('--decisions', 'Extract key decisions')
    .option('--timeline', 'Generate activity timeline')
    .action(async (query, options) => {
      const spinner = ora('Digging through context...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        const result = await unifiedOrchestrator.executeSkill('dig', [query], {
          depth: options.depth,
          patterns: options.patterns,
          decisions: options.decisions,
          timeline: options.timeline,
        });

        spinner.stop();

        if (result.success) {
          console.log(chalk.green('✓'), result.message);

          if (result.data) {
            console.log(
              chalk.cyan(
                `\nSearched ${result.data.timeRange.from} to ${result.data.timeRange.to}`
              )
            );

            if (result.data.summary) {
              console.log('\n' + result.data.summary);
            } else {
              // Display top results
              if (result.data.topResults?.length > 0) {
                console.log(chalk.cyan('\nTop Results:'));
                result.data.topResults.forEach((r: any) => {
                  console.log(
                    `  ${chalk.yellow(`[${r.score.toFixed(2)}]`)} ${r.summary}`
                  );
                });
              }

              // Display patterns if found
              if (result.data.patterns?.length > 0) {
                console.log(chalk.cyan('\nDetected Patterns:'));
                result.data.patterns.forEach((p: any) => {
                  console.log(`  ${p.name}: ${p.count} occurrences`);
                });
              }

              // Display decisions if found
              if (result.data.decisions?.length > 0) {
                console.log(chalk.cyan('\nKey Decisions:'));
                result.data.decisions.slice(0, 5).forEach((d: any) => {
                  console.log(
                    `  ${chalk.gray(new Date(d.timestamp).toLocaleDateString())}: ${d.decision}`
                  );
                });
              }

              // Display timeline if generated
              if (result.data.timeline?.length > 0) {
                console.log(chalk.cyan('\nActivity Timeline:'));
                result.data.timeline.slice(0, 5).forEach((t: any) => {
                  console.log(`  ${t.date}: ${t.itemCount} activities`);
                });
              }
            }
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  // RLM (Recursive Language Model) skill command
  skillsCmd
    .command('rlm <task>')
    .description('Execute complex tasks with recursive agent orchestration')
    .option('--max-parallel <number>', 'Maximum concurrent subagents', '5')
    .option('--max-recursion <number>', 'Maximum recursion depth', '4')
    .option(
      '--max-tokens-per-agent <number>',
      'Token budget per subagent',
      '30000'
    )
    .option('--review-stages <number>', 'Number of review iterations', '3')
    .option(
      '--quality-threshold <number>',
      'Target quality score (0-1)',
      '0.85'
    )
    .option(
      '--test-mode <mode>',
      'Test generation mode (unit/integration/e2e/all)',
      'all'
    )
    .option('--verbose', 'Show all recursive operations', false)
    .option(
      '--share-context-realtime',
      'Share discoveries between agents',
      true
    )
    .option('--retry-failed-agents', 'Retry on failure', true)
    .option('--timeout-per-agent <number>', 'Timeout in seconds', '300')
    .action(async (task, options) => {
      const spinner = ora('Initializing RLM orchestrator...').start();

      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();

        spinner.text = 'Decomposing task...';

        const result = await unifiedOrchestrator.executeSkill('rlm', [task], {
          maxParallel: parseInt(options.maxParallel),
          maxRecursionDepth: parseInt(options.maxRecursion),
          maxTokensPerAgent: parseInt(options.maxTokensPerAgent),
          reviewStages: parseInt(options.reviewStages),
          qualityThreshold: parseFloat(options.qualityThreshold),
          testGenerationMode: options.testMode,
          verboseLogging: options.verbose,
          shareContextRealtime: options.shareContextRealtime,
          retryFailedAgents: options.retryFailedAgents,
          timeoutPerAgent: parseInt(options.timeoutPerAgent) * 1000,
        });

        spinner.stop();

        if (result.success) {
          console.log(chalk.green('✓'), 'RLM execution completed');

          if (result.data) {
            console.log(chalk.cyan('\nExecution Summary:'));
            console.log(`  Total tokens: ${result.data.totalTokens}`);
            console.log(
              `  Estimated cost: $${result.data.totalCost.toFixed(2)}`
            );
            console.log(`  Duration: ${result.data.duration}ms`);
            console.log(`  Tests generated: ${result.data.testsGenerated}`);
            console.log(`  Issues found: ${result.data.issuesFound}`);
            console.log(`  Issues fixed: ${result.data.issuesFixed}`);

            if (result.data.improvements?.length > 0) {
              console.log(chalk.cyan('\nImprovements:'));
              result.data.improvements.forEach((imp: string) => {
                console.log(`  • ${imp}`);
              });
            }
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }

        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
    });

  // Spec generator skill
  const specCmd = skillsCmd
    .command('spec')
    .description('Generate iterative spec documents');

  specCmd
    .command('generate <type> <title>')
    .description(
      'Generate a spec document (one-pager, dev-spec, prompt-plan, agents)'
    )
    .action(async (type, title) => {
      const spinner = ora(`Generating ${type}...`).start();
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'spec',
          ['generate', type, title],
          {}
        );
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  specCmd
    .command('list')
    .description('List existing spec documents')
    .action(async () => {
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'spec',
          ['list'],
          {}
        );
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(JSON.stringify(result.data, null, 2));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  specCmd
    .command('validate <path>')
    .description('Validate spec document completeness')
    .action(async (filePath) => {
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'spec',
          ['validate', filePath],
          {}
        );
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  // Linear task runner skill
  const linearRunCmd = skillsCmd
    .command('linear-run')
    .description('Execute Linear tasks via RLM orchestrator');

  linearRunCmd
    .command('next')
    .description('Execute the next highest-priority Linear task')
    .option('--priority <level>', 'Filter by priority')
    .option('--tag <tag>', 'Filter by tag')
    .option('--dry-run', 'Preview without executing')
    .action(async (options) => {
      const spinner = ora('Fetching next task...').start();
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'linear-run',
          ['next'],
          {
            priority: options.priority,
            tag: options.tag,
            dryRun: options.dryRun,
          }
        );
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(JSON.stringify(result.data, null, 2));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  linearRunCmd
    .command('all')
    .description('Execute all active Linear tasks iteratively')
    .option('--max-concurrent <n>', 'Max concurrent tasks', '1')
    .option('--dry-run', 'Preview without executing')
    .action(async (options) => {
      const spinner = ora('Running all tasks...').start();
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'linear-run',
          ['all'],
          {
            maxConcurrent: parseInt(options.maxConcurrent),
            dryRun: options.dryRun,
          }
        );
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(JSON.stringify(result.data, null, 2));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  linearRunCmd
    .command('task <taskId>')
    .description('Execute a specific Linear task by ID')
    .action(async (taskId) => {
      const spinner = ora(`Executing task ${taskId}...`).start();
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'linear-run',
          ['task', taskId],
          {}
        );
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  linearRunCmd
    .command('preview [taskId]')
    .description('Show execution plan without running')
    .action(async (taskId) => {
      try {
        const { context, unifiedOrchestrator } = await initializeSkillContext();
        const result = await unifiedOrchestrator.executeSkill(
          'linear-run',
          ['preview', taskId || ''],
          {}
        );
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(JSON.stringify(result.data, null, 2));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  // Parallel agent skill commands
  const agentCmd = skillsCmd
    .command('agent')
    .description('Spawn parallel Claude agents in isolated workspaces');

  agentCmd
    .command('research <question>')
    .description('Explore codebase and save findings as a frame')
    .option('--timeout <ms>', 'Agent timeout in milliseconds', '300000')
    .action(async (question, options) => {
      const spinner = ora('Spawning research agent...').start();
      try {
        const { context } = await initializeSkillContext();
        const { ParallelAgentSkill } =
          await import('../../skills/parallel-agent-skill.js');
        const agentSkill = new ParallelAgentSkill(context);
        const result = await agentSkill.research(question, {
          timeout: parseInt(options.timeout),
        });
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data?.findings) {
            console.log(chalk.cyan('\nFindings:\n'));
            console.log(result.data.findings);
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  agentCmd
    .command('maintain <task>')
    .description('Low-stakes fix, produces a .patch file')
    .option('--timeout <ms>', 'Agent timeout in milliseconds', '300000')
    .action(async (task, options) => {
      const spinner = ora('Spawning maintenance agent...').start();
      try {
        const { context } = await initializeSkillContext();
        const { ParallelAgentSkill } =
          await import('../../skills/parallel-agent-skill.js');
        const agentSkill = new ParallelAgentSkill(context);
        const result = await agentSkill.maintain(task, {
          timeout: parseInt(options.timeout),
        });
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data) {
            console.log(chalk.cyan('\nPatch Details:'));
            console.log(`  Files changed: ${result.data.filesChanged}`);
            console.log(`  Additions: +${result.data.additions}`);
            console.log(`  Deletions: -${result.data.deletions}`);
            console.log(chalk.yellow(`\n  ${result.action}`));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  agentCmd
    .command('spec-run <specPath>')
    .description('Implement a spec on a branch, validate with lint+test+build')
    .option('--timeout <ms>', 'Agent timeout in milliseconds', '300000')
    .action(async (specPath, options) => {
      const spinner = ora('Spawning spec agent...').start();
      try {
        const { context } = await initializeSkillContext();
        const { ParallelAgentSkill } =
          await import('../../skills/parallel-agent-skill.js');
        const agentSkill = new ParallelAgentSkill(context);
        const result = await agentSkill.specRun(specPath, {
          timeout: parseInt(options.timeout),
        });
        spinner.stop();
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        if (result.data) {
          console.log(chalk.cyan('\nResults:'));
          console.log(`  Branch: ${result.data.branch}`);
          console.log(`  Workspace: ${result.data.workDir}`);
          const v = result.data.validation;
          if (v) {
            console.log(
              `  Lint: ${v.lint ? chalk.green('pass') : chalk.red('fail')}  ` +
                `Test: ${v.test ? chalk.green('pass') : chalk.red('fail')}  ` +
                `Build: ${v.build ? chalk.green('pass') : chalk.red('fail')}`
            );
          }
          if (result.data.diffStat) {
            console.log(chalk.gray(`\n${result.data.diffStat}`));
          }
          if (result.action) {
            console.log(chalk.yellow(`\n  ${result.action}`));
          }
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        spinner.stop();
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  // Theory skill commands
  const theoryCmd = skillsCmd
    .command('theory')
    .description('Maintain a living THEORY.MD at repo root');

  theoryCmd
    .command('show')
    .description('Display current THEORY.MD content')
    .action(async () => {
      try {
        const { context } = await initializeSkillContext();
        const { TheorySkill } = await import('../../skills/theory-skill.js');
        const skill = new TheorySkill(context);
        const result = skill.show();
        if (result.success) {
          console.log(result.message);
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  theoryCmd
    .command('init <problem>')
    .description('Create THEORY.MD with scaffold sections')
    .action(async (problem) => {
      try {
        const { context } = await initializeSkillContext();
        const { TheorySkill } = await import('../../skills/theory-skill.js');
        const skill = new TheorySkill(context);
        const result = skill.init(problem);
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  theoryCmd
    .command('update <content>')
    .description('Overwrite THEORY.MD with new content')
    .action(async (content) => {
      try {
        const { context } = await initializeSkillContext();
        const { TheorySkill } = await import('../../skills/theory-skill.js');
        const skill = new TheorySkill(context);
        const result = skill.update(content);
        if (result.success) {
          console.log(chalk.green('✓'), result.message);
          if (result.data?.warnings?.length > 0) {
            result.data.warnings.forEach((w: string) => {
              console.log(chalk.yellow(`  ⚠ ${w}`));
            });
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  theoryCmd
    .command('status')
    .description('Show THEORY.MD metadata')
    .action(async () => {
      try {
        const { context } = await initializeSkillContext();
        const { TheorySkill } = await import('../../skills/theory-skill.js');
        const skill = new TheorySkill(context);
        const result = skill.status();
        if (result.success) {
          console.log(chalk.cyan('THEORY.MD Status:'));
          if (result.data?.exists) {
            console.log(`  Lines: ${result.data.lineCount}`);
            console.log(
              `  Sections: ${result.data.sections?.length}/${result.data.totalSections}`
            );
            console.log(`  Last modified: ${result.data.lastModified}`);
          } else {
            console.log(chalk.gray('  Not found'));
          }
        } else {
          console.log(chalk.red('✗'), result.message);
        }
        await context.database.disconnect();
      } catch (error: unknown) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });

  // Help command for skills
  skillsCmd
    .command('help [skill]')
    .description('Show help for a specific skill')
    .action(async (skill) => {
      if (skill) {
        // Show specific skill help
        switch (skill) {
          case 'lint':
            console.log(`
lint (RLM-Orchestrated)
Primary Agent: linting
Secondary Agents: improve

Comprehensive linting of code: Check syntax, types, formatting, security, performance, and dead code. Provide fixes.

This skill is executed through RLM orchestration for:
- Automatic task decomposition
- Parallel agent execution
- Multi-stage quality review
- Comprehensive result aggregation

Usage:
  stackmemory skills lint                  # Lint current directory
  stackmemory skills lint src/             # Lint specific directory
  stackmemory skills lint src/file.ts     # Lint specific file

Options:
  --fix                 Automatically fix issues where possible
  --format             Focus on formatting issues
  --security           Focus on security vulnerabilities
  --performance        Focus on performance issues
  --verbose            Show detailed output
`);
            break;
          case 'agent':
            console.log(`
agent — Parallel Agent Skill (Willison Patterns)

Spawn isolated Claude agents in disposable /tmp workspaces.

Subcommands:
  research <question>     Explore codebase, save findings as a frame
  maintain <task>         Low-stakes fix, produces a .patch file
  spec-run <specPath>     Implement spec on branch, validate

Options:
  --timeout <ms>          Agent timeout (default: 300000)

Examples:
  stackmemory skills agent research "How does FTS5 search work?"
  stackmemory skills agent maintain "Fix deprecation warning in webhook.ts"
  stackmemory skills agent spec-run docs/specs/my-feature.md

Apply patches:  git apply .stackmemory/patches/<file>.patch
Review specs:   cd /tmp/sm-spec-* && git log --oneline
`);
            break;
          case 'theory':
            console.log(`
theory — Living Operating Theory Document

Maintains a THEORY.MD at repo root: a narrative capturing your problem
thesis, mental model, strategy, discoveries, and open questions.

Subcommands:
  show                     Display current THEORY.MD
  init <problem>           Create THEORY.MD with scaffold sections
  update <content>         Overwrite THEORY.MD (validates, warns on anti-patterns)
  status                   Show metadata (lines, sections, last modified)

Examples:
  stackmemory skills theory init "Build context-aware memory for AI agents"
  stackmemory skills theory show
  stackmemory skills theory status

Based on Theorist by @blader (MIT).
`);
            break;
          default:
            console.log(
              `Unknown skill: ${skill}. Use "stackmemory skills help" to see all available skills.`
            );
        }
      } else {
        console.log(
          chalk.cyan('Available Claude Skills (RLM-Orchestrated):\n')
        );
        console.log(
          '  handoff    - Streamline frame handoffs between team members'
        );
        console.log('  checkpoint - Create and manage recovery points');
        console.log('  dig        - Deep historical context retrieval');
        console.log(
          '  lint       - Comprehensive code linting and quality checks'
        );
        console.log('  test       - Generate comprehensive test suites');
        console.log('  review     - Multi-stage code review and improvements');
        console.log('  refactor   - Refactor code for better architecture');
        console.log('  publish    - Prepare and execute releases');
        console.log('  rlm        - Direct recursive agent orchestration');
        console.log(
          '  spec       - Generate iterative spec docs (one-pager, dev-spec, prompt-plan, agents)'
        );
        console.log('  linear-run - Execute Linear tasks via RLM orchestrator');
        console.log(
          '  agent      - Spawn parallel agents (research, maintain, spec-run)'
        );
        console.log(
          '  theory     - Maintain a living THEORY.MD (show, init, update, status)\n'
        );
        console.log(
          chalk.yellow(
            '\nAll skills now use RLM orchestration for intelligent task decomposition'
          )
        );
        console.log(
          'Use "stackmemory skills help <skill>" for detailed help on each skill'
        );
      }
    });

  return skillsCmd;
}
