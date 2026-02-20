/**
 * Multi-Loop Orchestrator for Complex Tasks
 * Manages multiple Ralph loops working together on large, complex tasks
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../core/monitoring/logger.js';
import { FrameManager } from '../../../core/context/index.js';
import { sessionManager } from '../../../core/session/index.js';
import { RalphStackMemoryBridge } from '../bridge/ralph-stackmemory-bridge.js';
import {
  OrchestratedTask,
  TaskDependency,
  LoopCoordination,
  ParallelExecution,
  TaskBreakdown,
  ExecutionPlan,
  OrchestrationResult,
} from '../types.js';

export interface OrchestrationConfig {
  maxConcurrentLoops: number;
  dependencyResolutionTimeout: number;
  enableAdaptivePlanning: boolean;
  sharedContextEnabled: boolean;
  fallbackStrategy: 'sequential' | 'abort' | 'manual';
}

export class MultiLoopOrchestrator {
  private frameManager?: FrameManager;
  private activeTasks: Map<string, OrchestratedTask> = new Map();
  private activeLoops: Map<string, RalphStackMemoryBridge> = new Map();
  private config: OrchestrationConfig;

  constructor(config?: Partial<OrchestrationConfig>) {
    this.config = {
      maxConcurrentLoops: 3,
      dependencyResolutionTimeout: 30000, // 30 seconds
      enableAdaptivePlanning: true,
      sharedContextEnabled: true,
      fallbackStrategy: 'sequential',
      ...config,
    };

    logger.info('Multi-loop orchestrator initialized', this.config);
  }

  async initialize(): Promise<void> {
    try {
      await sessionManager.initialize();

      const session = await sessionManager.getOrCreateSession({});
      if (session.database) {
        this.frameManager = new FrameManager(
          session.database,
          session.projectId
        );
      }

      logger.info('Orchestrator initialized successfully');
    } catch (error: unknown) {
      logger.error('Failed to initialize orchestrator', error as Error);
      throw error;
    }
  }

  /**
   * Break down complex task into manageable loops
   */
  async orchestrateComplexTask(
    description: string,
    criteria: string[],
    options?: {
      maxLoops?: number;
      forceSequential?: boolean;
      customBreakdown?: TaskBreakdown[];
    }
  ): Promise<OrchestrationResult> {
    logger.info('Orchestrating complex task', {
      task: description.substring(0, 100),
      criteriaCount: criteria.length,
      maxLoops: options?.maxLoops || this.config.maxConcurrentLoops,
    });

    const orchestrationId = uuidv4();

    try {
      // 1. Break down task into subtasks
      const breakdown =
        options?.customBreakdown ||
        (await this.analyzeAndBreakdownTask(description, criteria));

      // 2. Create execution plan
      const executionPlan = await this.createExecutionPlan(breakdown, options);

      // 3. Validate dependencies
      const dependencyErrors = this.validateDependencies(executionPlan);
      if (dependencyErrors.length > 0) {
        throw new Error(`Dependency errors: ${dependencyErrors.join(', ')}`);
      }

      // 4. Create orchestrated task
      const orchestratedTask: OrchestratedTask = {
        id: orchestrationId,
        description,
        breakdown,
        executionPlan,
        status: 'planning',
        startTime: Date.now(),
        loops: new Map(),
        sharedContext: {},
      };

      this.activeTasks.set(orchestrationId, orchestratedTask);

      // 5. Execute the plan
      const result = await this.executeOrchestration(orchestratedTask);

      logger.info('Complex task orchestration completed', {
        orchestrationId,
        status: result.success ? 'success' : 'failure',
        loopsExecuted: result.completedLoops.length,
        duration: Date.now() - orchestratedTask.startTime,
      });

      return result;
    } catch (error: unknown) {
      logger.error('Orchestration failed', error as Error);
      throw error;
    } finally {
      this.activeTasks.delete(orchestrationId);
    }
  }

  /**
   * Execute coordinated parallel loops
   */
  async executeParallelLoops(
    tasks: TaskBreakdown[],
    coordination?: LoopCoordination
  ): Promise<ParallelExecution> {
    logger.info(`Executing ${tasks.length} parallel loops`);

    const execution: ParallelExecution = {
      id: uuidv4(),
      tasks: tasks,
      startTime: Date.now(),
      results: new Map(),
      sharedState: coordination?.sharedState || {},
    };

    const promises = tasks.map((task) =>
      this.executeParallelTask(task, execution)
    );

    try {
      await Promise.allSettled(promises);

      execution.endTime = Date.now();
      execution.status = Array.from(execution.results.values()).every(
        (r) => r.success
      )
        ? 'success'
        : 'partial';

      return execution;
    } catch (error: unknown) {
      logger.error('Parallel execution failed', error as Error);
      execution.status = 'failed';
      execution.error = (error as Error).message;
      return execution;
    }
  }

  /**
   * Analyze and break down complex task
   */
  private async analyzeAndBreakdownTask(
    description: string,
    criteria: string[]
  ): Promise<TaskBreakdown[]> {
    // Intelligent task breakdown using patterns and heuristics
    const complexity = this.assessTaskComplexity(description);

    if (complexity.score < 5) {
      // Simple task - no breakdown needed
      return [
        {
          id: uuidv4(),
          title: description,
          description,
          criteria: criteria,
          priority: 1,
          estimatedIterations: 3,
          dependencies: [],
          type: 'single',
        },
      ];
    }

    // Complex task - break down by patterns
    const subtasks: TaskBreakdown[] = [];

    // Pattern 1: Setup/Foundation tasks
    if (this.needsSetup(description)) {
      subtasks.push({
        id: uuidv4(),
        title: 'Project Setup',
        description: 'Set up project structure and dependencies',
        criteria: ['Project structure created', 'Dependencies installed'],
        priority: 1,
        estimatedIterations: 2,
        dependencies: [],
        type: 'setup',
      });
    }

    // Pattern 2: Core implementation
    const coreTask = this.extractCoreTask(description);
    if (coreTask) {
      subtasks.push({
        id: uuidv4(),
        title: 'Core Implementation',
        description: coreTask,
        criteria: criteria.filter(
          (c) =>
            c.toLowerCase().includes('function') ||
            c.toLowerCase().includes('implement')
        ),
        priority: 2,
        estimatedIterations: 5,
        dependencies: subtasks.length > 0 ? [subtasks[0].id] : [],
        type: 'implementation',
      });
    }

    // Pattern 3: Testing tasks
    if (this.needsTesting(criteria)) {
      subtasks.push({
        id: uuidv4(),
        title: 'Testing Implementation',
        description: 'Create comprehensive tests',
        criteria: criteria.filter((c) => c.toLowerCase().includes('test')),
        priority: 3,
        estimatedIterations: 3,
        dependencies:
          subtasks.length > 0 ? [subtasks[subtasks.length - 1].id] : [],
        type: 'testing',
      });
    }

    // Pattern 4: Documentation tasks
    if (this.needsDocumentation(criteria)) {
      subtasks.push({
        id: uuidv4(),
        title: 'Documentation',
        description: 'Create documentation and examples',
        criteria: criteria.filter((c) => c.toLowerCase().includes('doc')),
        priority: 4,
        estimatedIterations: 2,
        dependencies: [],
        type: 'documentation',
      });
    }

    return subtasks.length > 0
      ? subtasks
      : [
          {
            id: uuidv4(),
            title: description,
            description,
            criteria,
            priority: 1,
            estimatedIterations: Math.min(8, Math.max(3, complexity.score)),
            dependencies: [],
            type: 'single',
          },
        ];
  }

  /**
   * Create execution plan from breakdown
   */
  private async createExecutionPlan(
    breakdown: TaskBreakdown[],
    options?: { forceSequential?: boolean }
  ): Promise<ExecutionPlan> {
    const plan: ExecutionPlan = {
      phases: [],
      totalEstimatedTime: 0,
      parallelizable: !options?.forceSequential && breakdown.length > 1,
    };

    if (options?.forceSequential || !this.canExecuteInParallel(breakdown)) {
      // Sequential execution
      plan.phases = breakdown.map((task, index) => ({
        id: `phase-${index + 1}`,
        tasks: [task],
        dependencies: index > 0 ? [`phase-${index}`] : [],
        parallelExecution: false,
      }));
    } else {
      // Group tasks by dependencies for parallel execution
      const phases = this.groupTasksByDependencies(breakdown);
      plan.phases = phases;
    }

    plan.totalEstimatedTime = plan.phases.reduce(
      (sum, phase) =>
        sum +
        Math.max(...phase.tasks.map((t) => t.estimatedIterations)) * 30000, // 30s per iteration
      0
    );

    return plan;
  }

  /**
   * Execute the orchestration plan
   */
  private async executeOrchestration(
    task: OrchestratedTask
  ): Promise<OrchestrationResult> {
    const result: OrchestrationResult = {
      orchestrationId: task.id,
      success: false,
      completedLoops: [],
      failedLoops: [],
      totalDuration: 0,
      insights: [],
    };

    try {
      task.status = 'executing';

      for (const phase of task.executionPlan.phases) {
        logger.info(
          `Executing phase ${phase.id} with ${phase.tasks.length} tasks`
        );

        if (phase.parallelExecution && phase.tasks.length > 1) {
          // Parallel execution
          const parallelResult = await this.executeParallelLoops(phase.tasks);

          for (const [taskId, taskResult] of parallelResult.results) {
            if (taskResult.success) {
              result.completedLoops.push(taskResult.loopId);
            } else {
              result.failedLoops.push({
                loopId: taskResult.loopId,
                error: taskResult.error || 'Unknown error',
              });
            }
          }
        } else {
          // Sequential execution
          for (const phaseTask of phase.tasks) {
            const loopResult = await this.executeTaskLoop(phaseTask, task);

            if (loopResult.success) {
              result.completedLoops.push(loopResult.loopId);

              // Share learnings with other tasks
              if (this.config.sharedContextEnabled) {
                await this.updateSharedContext(task, loopResult);
              }
            } else {
              result.failedLoops.push({
                loopId: loopResult.loopId,
                error: loopResult.error || 'Unknown error',
              });

              // Handle failure based on strategy
              if (this.config.fallbackStrategy === 'abort') {
                throw new Error(`Task failed: ${loopResult.error}`);
              }
            }
          }
        }
      }

      task.status = 'completed';
      result.success = result.failedLoops.length === 0;
      result.totalDuration = Date.now() - task.startTime;

      // Generate insights
      result.insights = this.generateOrchestrationInsights(task, result);

      return result;
    } catch (error: unknown) {
      task.status = 'failed';
      result.success = false;
      result.error = (error as Error).message;
      return result;
    }
  }

  /**
   * Execute a single task as a Ralph loop
   */
  private async executeTaskLoop(
    taskBreakdown: TaskBreakdown,
    orchestratedTask: OrchestratedTask
  ): Promise<{ success: boolean; loopId: string; error?: string }> {
    try {
      // Create Ralph loop with shared context
      const bridge = new RalphStackMemoryBridge({
        baseDir: `.ralph-${taskBreakdown.id}`,
        maxIterations: taskBreakdown.estimatedIterations * 2, // Allow extra iterations
        useStackMemory: true,
      });

      await bridge.initialize({
        task: taskBreakdown.description,
        criteria: taskBreakdown.criteria.join('\n'),
      });

      // Store loop reference
      this.activeLoops.set(taskBreakdown.id, bridge);
      orchestratedTask.loops.set(taskBreakdown.id, {
        bridge,
        status: 'running',
        startTime: Date.now(),
      });

      // Run the loop
      await bridge.run();

      // Check result
      const loopInfo = orchestratedTask.loops.get(taskBreakdown.id);
      if (loopInfo) {
        loopInfo.status = 'completed';
        loopInfo.endTime = Date.now();
      }

      this.activeLoops.delete(taskBreakdown.id);

      return { success: true, loopId: taskBreakdown.id };
    } catch (error: unknown) {
      logger.error(`Task loop failed: ${taskBreakdown.title}`, error as Error);

      const loopInfo = orchestratedTask.loops.get(taskBreakdown.id);
      if (loopInfo) {
        loopInfo.status = 'failed';
        loopInfo.error = (error as Error).message;
        loopInfo.endTime = Date.now();
      }

      this.activeLoops.delete(taskBreakdown.id);

      return {
        success: false,
        loopId: taskBreakdown.id,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute a task in parallel context
   */
  private async executeParallelTask(
    task: TaskBreakdown,
    execution: ParallelExecution
  ): Promise<void> {
    try {
      const result = await this.executeTaskLoop(task, {
        id: execution.id,
        description: `Parallel task: ${task.title}`,
        breakdown: [task],
        executionPlan: {
          phases: [],
          totalEstimatedTime: 0,
          parallelizable: false,
        },
        status: 'executing',
        startTime: execution.startTime,
        loops: new Map(),
        sharedContext: execution.sharedState,
      });

      execution.results.set(task.id, result);
    } catch (error: unknown) {
      execution.results.set(task.id, {
        success: false,
        loopId: task.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Update shared context between tasks
   */
  private async updateSharedContext(
    orchestratedTask: OrchestratedTask,
    loopResult: { loopId: string }
  ): Promise<void> {
    // Extract learnings from completed loop and share with other active loops
    // This would integrate with StackMemory's shared context layer
    logger.debug('Updating shared context', {
      orchestrationId: orchestratedTask.id,
      loopId: loopResult.loopId,
    });
  }

  /**
   * Generate insights from orchestration
   */
  private generateOrchestrationInsights(
    task: OrchestratedTask,
    result: OrchestrationResult
  ): string[] {
    const insights: string[] = [];

    // Performance insights
    const avgLoopDuration =
      Array.from(task.loops.values())
        .filter((l) => l.endTime && l.startTime)
        .map((l) => l.endTime! - l.startTime)
        .reduce((sum, duration) => sum + duration, 0) / task.loops.size;

    if (avgLoopDuration > 0) {
      insights.push(
        `Average loop duration: ${Math.round(avgLoopDuration / 1000)}s`
      );
    }

    // Success rate insights
    const successRate =
      result.completedLoops.length /
      (result.completedLoops.length + result.failedLoops.length);
    insights.push(`Success rate: ${Math.round(successRate * 100)}%`);

    // Complexity insights
    if (task.breakdown.length > 3) {
      insights.push(
        'Complex task benefited from breakdown into multiple loops'
      );
    }

    return insights;
  }

  // Helper methods for task analysis
  private assessTaskComplexity(description: string): {
    score: number;
    factors: string[];
  } {
    const factors: string[] = [];
    let score = 1;

    if (description.length > 200) {
      score += 2;
      factors.push('long description');
    }
    if (description.includes('and')) {
      score += 1;
      factors.push('multiple requirements');
    }
    if (description.toLowerCase().includes('test')) {
      score += 2;
      factors.push('testing required');
    }
    if (description.toLowerCase().includes('document')) {
      score += 1;
      factors.push('documentation needed');
    }
    if (description.toLowerCase().includes('refactor')) {
      score += 3;
      factors.push('refactoring complexity');
    }

    return { score, factors };
  }

  private needsSetup(description: string): boolean {
    const setupKeywords = [
      'project',
      'initialize',
      'setup',
      'scaffold',
      'create structure',
    ];
    return setupKeywords.some((keyword) =>
      description.toLowerCase().includes(keyword)
    );
  }

  private needsTesting(criteria: string[]): boolean {
    return criteria.some((c) => c.toLowerCase().includes('test'));
  }

  private needsDocumentation(criteria: string[]): boolean {
    return criteria.some((c) => c.toLowerCase().includes('doc'));
  }

  private extractCoreTask(description: string): string | null {
    // Extract the main implementation task from description
    const sentences = description.split('.');
    return (
      sentences.find(
        (s) =>
          s.toLowerCase().includes('implement') ||
          s.toLowerCase().includes('create') ||
          s.toLowerCase().includes('add')
      ) || null
    );
  }

  private canExecuteInParallel(breakdown: TaskBreakdown[]): boolean {
    // Check if tasks can be executed in parallel based on dependencies
    return breakdown.some((task) => task.dependencies.length === 0);
  }

  private groupTasksByDependencies(breakdown: TaskBreakdown[]): any[] {
    // Group tasks into phases based on dependencies
    const phases: any[] = [];
    const processed = new Set<string>();

    while (processed.size < breakdown.length) {
      const readyTasks = breakdown.filter(
        (task) =>
          !processed.has(task.id) &&
          task.dependencies.every((dep) => processed.has(dep))
      );

      if (readyTasks.length === 0) break; // Circular dependency

      phases.push({
        id: `phase-${phases.length + 1}`,
        tasks: readyTasks,
        dependencies: phases.length > 0 ? [`phase-${phases.length}`] : [],
        parallelExecution: readyTasks.length > 1,
      });

      readyTasks.forEach((task) => processed.add(task.id));
    }

    return phases;
  }

  private validateDependencies(plan: ExecutionPlan): string[] {
    const errors: string[] = [];
    const allTaskIds = new Set(
      plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id))
    );

    for (const phase of plan.phases) {
      for (const task of phase.tasks) {
        for (const dep of task.dependencies) {
          if (!allTaskIds.has(dep)) {
            errors.push(`Task ${task.id} depends on non-existent task ${dep}`);
          }
        }
      }
    }

    return errors;
  }

  /**
   * Monitor orchestration progress
   */
  getOrchestrationStatus(orchestrationId: string): OrchestratedTask | null {
    return this.activeTasks.get(orchestrationId) || null;
  }

  /**
   * Stop orchestration
   */
  async stopOrchestration(orchestrationId: string): Promise<void> {
    const task = this.activeTasks.get(orchestrationId);
    if (!task) return;

    // Stop all active loops
    for (const [loopId, loopInfo] of task.loops) {
      if (loopInfo.status === 'running') {
        try {
          // Signal stop to the loop
          loopInfo.status = 'stopped';
          this.activeLoops.delete(loopId);
        } catch (error: unknown) {
          logger.error(`Failed to stop loop ${loopId}`, error as Error);
        }
      }
    }

    task.status = 'stopped';
    this.activeTasks.delete(orchestrationId);

    logger.info('Orchestration stopped', { orchestrationId });
  }
}

// Export default instance
export const multiLoopOrchestrator = new MultiLoopOrchestrator();
