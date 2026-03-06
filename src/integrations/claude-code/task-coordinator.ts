/**
 * Claude Code Task Coordinator
 *
 * Coordinates task execution between StackMemory and Claude Code's Task tool.
 * Handles agent invocation, result processing, and error recovery.
 */

import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { logger } from '../../core/monitoring/logger.js';
import { ClaudeCodeAgent } from './agent-bridge.js';

export interface TaskExecution {
  id: string;
  agentName: string;
  agentType: 'oracle' | 'worker' | 'reviewer';
  prompt: string;
  startTime: number;
  endTime?: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  retryCount: number;
  estimatedCost: number;
  actualTokens?: number;
}

export interface CoordinationMetrics {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageExecutionTime: number;
  totalCost: number;
  successRate: number;
  agentUtilization: Record<string, number>;
}

/**
 * Claude Code Task Coordinator
 * Manages task execution and coordination with Claude Code agents
 */
export class ClaudeCodeTaskCoordinator {
  private activeTasks: Map<string, TaskExecution> = new Map();
  private completedTasks: TaskExecution[] = [];
  private metrics: CoordinationMetrics;

  constructor() {
    this.metrics = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      averageExecutionTime: 0,
      totalCost: 0,
      successRate: 0,
      agentUtilization: {},
    };
  }

  /**
   * Execute task with Claude Code agent
   */
  async executeTask(
    agentName: string,
    agentConfig: ClaudeCodeAgent,
    prompt: string,
    options: {
      maxRetries?: number;
      timeout?: number;
      priority?: 'low' | 'medium' | 'high';
    } = {}
  ): Promise<string> {
    const taskId = uuidv4();
    const { maxRetries = 2, timeout = 300000, priority = 'medium' } = options;

    const task: TaskExecution = {
      id: taskId,
      agentName,
      agentType: agentConfig.type,
      prompt,
      startTime: Date.now(),
      status: 'pending',
      retryCount: 0,
      estimatedCost: this.estimateTaskCost(prompt, agentConfig),
    };

    this.activeTasks.set(taskId, task);
    this.metrics.totalTasks++;

    logger.info('Starting Claude Code task execution', {
      taskId,
      agentName,
      agentType: agentConfig.type,
      promptLength: prompt.length,
      estimatedCost: task.estimatedCost,
      priority,
    });

    try {
      // Execute with retries
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          task.retryCount = attempt;
          task.status = 'running';

          // Execute the task with timeout
          const result = await this.executeWithTimeout(
            () => this.invokeClaudeCodeAgent(agentName, prompt, agentConfig),
            timeout
          );

          // Task completed successfully
          task.status = 'completed';
          task.result = result;
          task.endTime = Date.now();
          task.actualTokens = this.estimateTokenUsage(prompt, result);

          this.completeTask(task);
          return result;
        } catch (error) {
          lastError = error as Error;
          task.status = 'failed';

          logger.warn(`Claude Code task attempt ${attempt + 1} failed`, {
            taskId,
            agentName,
            error: lastError.message,
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
          });

          // Don't retry if it's the last attempt
          if (attempt === maxRetries) {
            break;
          }

          // Wait before retry with exponential backoff
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      // All retries exhausted
      task.error = lastError?.message || 'Unknown error';
      task.endTime = Date.now();
      this.failTask(task, lastError!);
      throw lastError;
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  /**
   * Execute multiple tasks in parallel with coordination
   */
  async executeParallelTasks(
    tasks: {
      agentName: string;
      agentConfig: ClaudeCodeAgent;
      prompt: string;
      priority?: 'low' | 'medium' | 'high';
    }[]
  ): Promise<{ results: string[]; failures: Error[] }> {
    logger.info('Executing parallel Claude Code tasks', {
      taskCount: tasks.length,
      agents: tasks.map((t) => t.agentName),
    });

    // Group tasks by priority
    const priorityGroups = {
      high: tasks.filter((t) => t.priority === 'high'),
      medium: tasks.filter((t) => t.priority === 'medium'),
      low: tasks.filter((t) => t.priority === 'low'),
    };

    const results: string[] = [];
    const failures: Error[] = [];

    // Execute high priority tasks first
    for (const priorityLevel of ['high', 'medium', 'low'] as const) {
      const priorityTasks = priorityGroups[priorityLevel];
      if (priorityTasks.length === 0) continue;

      logger.info(`Executing ${priorityLevel} priority tasks`, {
        count: priorityTasks.length,
      });

      // Execute tasks in this priority level concurrently
      const promises = priorityTasks.map(async (task) => {
        try {
          const result = await this.executeTask(
            task.agentName,
            task.agentConfig,
            task.prompt,
            { priority: task.priority }
          );
          return { success: true, result };
        } catch (error) {
          return { success: false, error: error as Error };
        }
      });

      const outcomes = await Promise.allSettled(promises);

      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') {
          if (outcome.value.success) {
            results.push(outcome.value.result);
          } else {
            failures.push(outcome.value.error);
          }
        } else {
          failures.push(new Error(outcome.reason));
        }
      }
    }

    logger.info('Parallel task execution completed', {
      totalTasks: tasks.length,
      successful: results.length,
      failed: failures.length,
      successRate: ((results.length / tasks.length) * 100).toFixed(1),
    });

    return { results, failures };
  }

  /**
   * Get coordination metrics and health status
   */
  getCoordinationMetrics(): CoordinationMetrics & {
    activeTasks: number;
    recentErrors: string[];
    performanceTrend: 'improving' | 'stable' | 'degrading';
  } {
    // Calculate recent error rate for performance trend
    const recentTasks = this.completedTasks.slice(-10);
    const recentErrorRate =
      recentTasks.length > 0
        ? recentTasks.filter((t) => t.status === 'failed').length /
          recentTasks.length
        : 0;

    const performanceTrend =
      recentErrorRate < 0.1
        ? 'improving'
        : recentErrorRate < 0.3
          ? 'stable'
          : 'degrading';

    const recentErrors = this.completedTasks
      .slice(-5)
      .filter((t) => t.status === 'failed')
      .map((t) => t.error || 'Unknown error');

    return {
      ...this.metrics,
      activeTasks: this.activeTasks.size,
      recentErrors,
      performanceTrend,
    };
  }

  /**
   * Clean up resources and reset metrics
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Claude Code Task Coordinator', {
      activeTasks: this.activeTasks.size,
      completedTasks: this.completedTasks.length,
    });

    // Wait for active tasks to complete or force cleanup after timeout
    if (this.activeTasks.size > 0) {
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(resolve, 30000)
      );
      const completionPromise = this.waitForTaskCompletion();

      await Promise.race([completionPromise, timeoutPromise]);

      if (this.activeTasks.size > 0) {
        logger.warn('Force terminating active tasks', {
          remainingTasks: this.activeTasks.size,
        });
      }
    }

    this.activeTasks.clear();
    this.completedTasks = [];
    this.resetMetrics();
  }

  /**
   * Execute with timeout wrapper
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Task execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Invoke Claude Code agent (integration point)
   */
  private async invokeClaudeCodeAgent(
    agentName: string,
    prompt: string,
    agentConfig: ClaudeCodeAgent
  ): Promise<string> {
    logger.debug('Invoking Claude Code agent', {
      agentName,
      agentType: agentConfig.type,
      promptTokens: this.estimateTokenUsage(prompt, ''),
    });

    return this.spawnClaudeCode(agentName, prompt, agentConfig);
  }

  /**
   * Spawn Claude Code CLI as a subprocess.
   * Uses `claude --print` for non-interactive execution with stdout capture.
   * Workspace cwd is inherited from the coordinator's process.
   */
  private spawnClaudeCode(
    agentName: string,
    prompt: string,
    agentConfig: ClaudeCodeAgent
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['--print'];

      // Map oracle agents to opus model for higher reasoning
      if (agentConfig.type === 'oracle') {
        args.push('--model', 'opus');
      }

      // Scope tool access based on agent capabilities
      if (agentConfig.capabilities.includes('code_implementation')) {
        args.push('--allowedTools', 'Edit,Write,Bash,Read,Glob,Grep');
      } else {
        args.push('--allowedTools', 'Read,Glob,Grep,Bash');
      }

      // Prompt passed as positional arg
      args.push(prompt);

      logger.info('Spawning claude CLI', {
        agentName,
        agentType: agentConfig.type,
        cwd: process.cwd(),
        promptLength: prompt.length,
      });

      const proc = spawn('claude', args, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        logger.error('Failed to spawn claude CLI', {
          agentName,
          error: err.message,
        });
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          logger.debug('Claude CLI completed', {
            agentName,
            outputLength: stdout.length,
          });
          resolve(stdout.trim());
        } else {
          const errMsg = stderr.slice(0, 500) || `exit code ${code}`;
          logger.warn('Claude CLI failed', {
            agentName,
            exitCode: code,
            stderr: errMsg,
          });
          reject(new Error(`Claude CLI exited with code ${code}: ${errMsg}`));
        }
      });
    });
  }

  /**
   * Complete a successful task
   */
  private completeTask(task: TaskExecution): void {
    this.completedTasks.push({ ...task });
    this.metrics.completedTasks++;

    // Update metrics
    this.updateExecutionMetrics(task);
    this.updateAgentUtilization(task.agentName);
    this.updateSuccessRate();

    logger.info('Claude Code task completed', {
      taskId: task.id,
      agentName: task.agentName,
      executionTime: task.endTime! - task.startTime,
      retries: task.retryCount,
      cost: this.calculateActualCost(task),
    });
  }

  /**
   * Handle a failed task
   */
  private failTask(task: TaskExecution, error: Error): void {
    this.completedTasks.push({ ...task });
    this.metrics.failedTasks++;

    this.updateExecutionMetrics(task);
    this.updateSuccessRate();

    logger.error('Claude Code task failed', {
      taskId: task.id,
      agentName: task.agentName,
      error: error.message,
      retries: task.retryCount,
      executionTime: task.endTime! - task.startTime,
    });
  }

  /**
   * Update execution time metrics
   */
  private updateExecutionMetrics(task: TaskExecution): void {
    if (!task.endTime) return;

    const executionTime = task.endTime - task.startTime;
    const totalTasks = this.metrics.completedTasks + this.metrics.failedTasks;

    if (totalTasks === 1) {
      this.metrics.averageExecutionTime = executionTime;
    } else {
      this.metrics.averageExecutionTime =
        (this.metrics.averageExecutionTime * (totalTasks - 1) + executionTime) /
        totalTasks;
    }

    this.metrics.totalCost += this.calculateActualCost(task);
  }

  /**
   * Update agent utilization metrics
   */
  private updateAgentUtilization(agentName: string): void {
    this.metrics.agentUtilization[agentName] =
      (this.metrics.agentUtilization[agentName] || 0) + 1;
  }

  /**
   * Update success rate
   */
  private updateSuccessRate(): void {
    const total = this.metrics.completedTasks + this.metrics.failedTasks;
    this.metrics.successRate =
      total > 0 ? this.metrics.completedTasks / total : 0;
  }

  /**
   * Estimate task cost based on prompt and agent
   */
  private estimateTaskCost(
    prompt: string,
    agentConfig: ClaudeCodeAgent
  ): number {
    const estimatedTokens = this.estimateTokenUsage(prompt, '');
    const baseCost = agentConfig.type === 'oracle' ? 0.015 : 0.00025; // per 1K tokens
    return (estimatedTokens / 1000) * baseCost * agentConfig.costMultiplier;
  }

  /**
   * Estimate token usage
   */
  private estimateTokenUsage(prompt: string, response: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil((prompt.length + response.length) / 4);
  }

  /**
   * Calculate actual task cost
   */
  private calculateActualCost(task: TaskExecution): number {
    if (!task.actualTokens) return task.estimatedCost;

    const baseCost = task.agentType === 'oracle' ? 0.015 : 0.00025;
    return (task.actualTokens / 1000) * baseCost;
  }

  /**
   * Wait for all active tasks to complete
   */
  private async waitForTaskCompletion(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /**
   * Reset metrics
   */
  private resetMetrics(): void {
    this.metrics = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      averageExecutionTime: 0,
      totalCost: 0,
      successRate: 0,
      agentUtilization: {},
    };
  }

  /**
   * Get active task status
   */
  getActiveTaskStatus(): {
    taskId: string;
    agentName: string;
    status: string;
    runtime: number;
  }[] {
    return Array.from(this.activeTasks.values()).map((task) => ({
      taskId: task.id,
      agentName: task.agentName,
      status: task.status,
      runtime: Date.now() - task.startTime,
    }));
  }

  /**
   * Cancel active task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;

    task.status = 'failed';
    task.error = 'Task cancelled by user';
    task.endTime = Date.now();

    this.failTask(task, new Error('Task cancelled'));
    this.activeTasks.delete(taskId);

    logger.info('Task cancelled', { taskId, agentName: task.agentName });
    return true;
  }
}

export default ClaudeCodeTaskCoordinator;
