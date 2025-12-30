/**
 * Agent command - Integrates Spotify's background coding agent strategies
 * with StackMemory's task system
 *
 * Usage: stackmemory agent <action> [options]
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { PebblesTaskStore } from '../../features/tasks/pebbles-task-store.js';
import { FrameManager } from '../../core/context/frame-manager.js';
import {
  AgentTaskManager,
  AgentTaskSession,
} from '../../agents/core/agent-task-manager.js';
import { FormatterVerifier } from '../../agents/verifiers/formatter-verifier.js';
import { LLMJudge } from '../../agents/verifiers/llm-judge.js';
import { logger } from '../../core/monitoring/logger.js';

export function createAgentCommand(): Command {
  const agent = new Command('agent')
    .description('AI agent task execution with Spotify-inspired strategies')
    .option('-p, --project <path>', 'Project root directory', process.cwd());

  agent
    .command('execute <taskId>')
    .description('Execute a task with agent assistance')
    .option('-f, --frame <frameId>', 'Frame ID to use')
    .option('--max-turns <number>', 'Maximum turns per session', '10')
    .option('--no-verify', 'Skip verification loops')
    .action(async (taskId: string, options) => {
      const spinner = ora('Initializing agent...').start();

      try {
        const { taskManager, session } = await initializeAgent(
          options.project,
          taskId,
          options.frame,
          parseInt(options.maxTurns)
        );

        spinner.succeed('Agent initialized');

        // Display session info
        console.log(chalk.cyan('\n📋 Task Session Started'));
        console.log(chalk.gray('  Session ID:'), session.id);
        console.log(chalk.gray('  Task ID:'), session.taskId);
        console.log(chalk.gray('  Max Turns:'), session.maxTurns);
        console.log(
          chalk.gray('  Verification:'),
          options.verify ? 'Enabled' : 'Disabled'
        );

        // Execute task with feedback loop
        await executeTaskWithFeedback(taskManager, session, options.verify);
      } catch (error) {
        spinner.fail('Agent execution failed');
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  agent
    .command('status')
    .description('Show active agent sessions')
    .action(async (options) => {
      const spinner = ora('Loading sessions...').start();

      try {
        const projectRoot = options.parent?.project || process.cwd();
        const { taskManager } = await initializeAgentManager(projectRoot);

        const sessions = taskManager.getActiveSessions();
        spinner.stop();

        if (sessions.length === 0) {
          console.log(chalk.yellow('No active agent sessions'));
          return;
        }

        console.log(chalk.cyan('\n🤖 Active Agent Sessions\n'));

        for (const session of sessions) {
          console.log(chalk.bold(`Session: ${session.sessionId}`));
          console.log(chalk.gray('  Task:'), session.taskId);
          console.log(
            chalk.gray('  Status:'),
            getStatusColor(session.status)(session.status)
          );
          console.log(chalk.gray('  Turn:'), `${session.turnCount}/10`);
          console.log(
            chalk.gray('  Started:'),
            session.startedAt.toLocaleString()
          );
          console.log('');
        }
      } catch (error) {
        spinner.fail('Failed to load sessions');
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  agent
    .command('retry <sessionId>')
    .description('Retry a failed session with learned context')
    .action(async (sessionId: string, options) => {
      const spinner = ora('Retrying session...').start();

      try {
        const projectRoot = options.parent?.project || process.cwd();
        const { taskManager } = await initializeAgentManager(projectRoot);

        const newSession = await taskManager.retrySession(sessionId);

        if (!newSession) {
          spinner.fail(
            'Cannot retry session (max retries reached or session active)'
          );
          return;
        }

        spinner.succeed('Session retry started');
        console.log(chalk.cyan('\n♻️ Retry Session Started'));
        console.log(chalk.gray('  New Session ID:'), newSession.id);
        console.log(chalk.gray('  Task ID:'), newSession.taskId);

        // Execute with feedback
        await executeTaskWithFeedback(taskManager, newSession, true);
      } catch (error) {
        spinner.fail('Retry failed');
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  agent
    .command('breakdown <taskId>')
    .description('Break down a complex task into subtasks')
    .action(async (taskId: string, options) => {
      const spinner = ora('Analyzing task complexity...').start();

      try {
        const projectRoot = options.parent?.project || process.cwd();
        const db = await openDatabase(projectRoot);
        const taskStore = new PebblesTaskStore(projectRoot, db);

        const task = taskStore.getTask(taskId);
        if (!task) {
          spinner.fail(`Task ${taskId} not found`);
          return;
        }

        spinner.text = 'Breaking down task...';

        // Simulate task breakdown (in production, would use LLM)
        const subtasks = generateTaskBreakdown(
          task.title,
          task.description || ''
        );

        spinner.succeed('Task breakdown complete');

        console.log(chalk.cyan(`\n📊 Task Breakdown: ${task.title}\n`));

        subtasks.forEach((subtask, index) => {
          console.log(chalk.bold(`${index + 1}. ${subtask.title}`));
          console.log(chalk.gray('   Description:'), subtask.description);
          console.log(
            chalk.gray('   Estimated turns:'),
            subtask.estimatedTurns
          );
          console.log(
            chalk.gray('   Verifiers:'),
            subtask.verifiers.join(', ')
          );
          console.log('');
        });

        console.log(
          chalk.yellow('Total estimated turns:'),
          subtasks.reduce((sum, st) => sum + st.estimatedTurns, 0)
        );
      } catch (error) {
        spinner.fail('Breakdown failed');
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  return agent;
}

/**
 * Initialize agent and start task session
 */
async function initializeAgent(
  projectRoot: string,
  taskId: string,
  frameId?: string,
  maxTurns = 10
): Promise<{
  taskManager: AgentTaskManager;
  session: AgentTaskSession;
}> {
  const { taskManager, frameManager, taskStore } =
    await initializeAgentManager(projectRoot);

  // Create or get frame
  const finalFrameId =
    frameId ||
    frameManager.createFrame({
      type: 'task',
      name: `Agent task execution for ${taskId}`,
      inputs: { taskId, agentSession: true },
    });

  // Start session
  const session = await taskManager.startTaskSession(taskId, finalFrameId);

  // Override max turns if specified
  if (maxTurns !== 10) {
    session.maxTurns = maxTurns;
  }

  return { taskManager, session };
}

/**
 * Initialize agent manager components
 */
async function initializeAgentManager(projectRoot: string): Promise<{
  taskManager: AgentTaskManager;
  frameManager: FrameManager;
  taskStore: PebblesTaskStore;
}> {
  const db = await openDatabase(projectRoot);
  const taskStore = new PebblesTaskStore(projectRoot, db);
  const frameManager = new FrameManager(db, projectRoot, undefined);
  const taskManager = new AgentTaskManager(taskStore, frameManager);

  return { taskManager, frameManager, taskStore };
}

/**
 * Execute task with feedback loop (Spotify pattern)
 */
async function executeTaskWithFeedback(
  taskManager: AgentTaskManager,
  session: AgentTaskSession,
  enableVerification: boolean
): Promise<void> {
  console.log(chalk.cyan('\n🔄 Starting execution loop...\n'));

  let turnCount = 0;
  let shouldContinue = true;
  let lastFeedback = '';

  while (shouldContinue && turnCount < session.maxTurns) {
    turnCount++;

    console.log(chalk.bold(`\n═══ Turn ${turnCount}/${session.maxTurns} ═══`));

    // Simulate agent action (in production, would use actual AI)
    const action = generateMockAction(turnCount, lastFeedback);
    console.log(chalk.gray('Action:'), action.substring(0, 100) + '...');

    // Execute turn with verification
    const spinner = ora('Executing...').start();

    const result = await taskManager.executeTurn(session.id, action, {
      codeChange: turnCount > 1,
      testsPresent: turnCount > 2,
      enableVerification,
    });

    if (result.success) {
      spinner.succeed('Turn completed successfully');
    } else {
      spinner.warn('Turn completed with issues');
    }

    // Display feedback
    console.log(chalk.yellow('\n📝 Feedback:'));
    console.log(result.feedback);

    // Display verification results if any
    if (result.verificationResults.length > 0) {
      console.log(chalk.cyan('\n✓ Verification Results:'));
      for (const vr of result.verificationResults) {
        const icon = vr.passed ? '✓' : '✗';
        const color = vr.passed ? chalk.green : chalk.red;
        console.log(color(`  ${icon} ${vr.verifierId}: ${vr.message}`));
      }
    }

    shouldContinue = result.shouldContinue;
    lastFeedback = result.feedback;

    // Short delay for readability
    await delay(1000);
  }

  // Final status
  console.log(chalk.cyan('\n═══ Session Complete ═══\n'));
  console.log(chalk.gray('Total turns:'), turnCount);
  console.log(chalk.gray('Final status:'), session.status);
}

/**
 * Generate mock action for demonstration
 */
function generateMockAction(turn: number, previousFeedback: string): string {
  const actions = [
    'Analyzing task requirements and constraints',
    'Setting up project structure and dependencies',
    'Implementing core functionality',
    'Adding error handling and validation',
    'Writing unit tests',
    'Refactoring for better code organization',
    'Adding documentation and comments',
    'Running final verification checks',
    'Optimizing performance',
    'Completing final cleanup',
  ];

  if (previousFeedback.includes('error')) {
    return `Fixing issues: ${previousFeedback.substring(0, 50)}...`;
  }

  return actions[Math.min(turn - 1, actions.length - 1)];
}

/**
 * Generate task breakdown for complex tasks
 */
function generateTaskBreakdown(
  title: string,
  description: string
): Array<{
  title: string;
  description: string;
  estimatedTurns: number;
  verifiers: string[];
}> {
  // Simple heuristic breakdown (in production, would use LLM)
  return [
    {
      title: `Analyze and plan: ${title}`,
      description: 'Understand requirements and create implementation plan',
      estimatedTurns: 2,
      verifiers: ['semantic-validator'],
    },
    {
      title: `Implement core: ${title}`,
      description: 'Build main functionality',
      estimatedTurns: 4,
      verifiers: ['formatter', 'linter', 'semantic-validator'],
    },
    {
      title: `Test and validate: ${title}`,
      description: 'Add tests and validate implementation',
      estimatedTurns: 3,
      verifiers: ['test-runner', 'semantic-validator'],
    },
    {
      title: `Polish and document: ${title}`,
      description: 'Final improvements and documentation',
      estimatedTurns: 1,
      verifiers: ['formatter', 'linter'],
    },
  ];
}

/**
 * Open or create database
 */
async function openDatabase(projectRoot: string): Promise<Database.Database> {
  const dbPath = join(projectRoot, '.stackmemory', 'cache.db');

  if (!existsSync(join(projectRoot, '.stackmemory'))) {
    throw new Error(
      'StackMemory not initialized. Run "stackmemory init" first.'
    );
  }

  return new Database(dbPath);
}

/**
 * Get color function for status
 */
function getStatusColor(status: string): (text: string) => string {
  switch (status) {
    case 'active':
      return chalk.green;
    case 'completed':
      return chalk.blue;
    case 'failed':
      return chalk.red;
    case 'timeout':
      return chalk.yellow;
    default:
      return chalk.gray;
  }
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
