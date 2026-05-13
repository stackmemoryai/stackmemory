/**
 * Oracle/Worker Pattern Implementation for StackMemory Swarms
 *
 * Uses high-end model (Oracle) for planning, review, and coordination
 * Uses smaller models (Workers) for task execution and implementation
 *
 * Cost-effective scaling: Intelligence where needed, efficiency for execution
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../core/monitoring/logger.js';
import { estimateTokens } from '../../../core/cache/token-estimator.js';
import { SwarmCoordinator } from '../swarm/swarm-coordinator.js';
import { RalphStackMemoryBridge } from '../bridge/ralph-stackmemory-bridge.js';

// Model tiers based on capability and cost
export type ModelTier = 'oracle' | 'worker' | 'reviewer';

export interface ModelConfig {
  tier: ModelTier;
  provider: 'claude' | 'openai' | 'anthropic';
  model: string;
  costPerToken: number;
  capabilities: string[];
}

export interface OracleWorkerConfig {
  oracle: ModelConfig;
  workers: ModelConfig[];
  reviewers: ModelConfig[];
  maxWorkers: number;
  coordinationInterval: number;
  costBudget?: number;
}

export interface TaskDecomposition {
  id: string;
  type: 'planning' | 'implementation' | 'review' | 'coordination';
  priority: number;
  complexity: 'low' | 'medium' | 'high';
  estimatedTokens: number;
  assignedModel: ModelTier;
  dependencies: string[];
  acceptanceCriteria: string[];
}

/**
 * Oracle/Worker Pattern Coordinator
 * Implements cost-effective multi-model orchestration
 */
export class OracleWorkerCoordinator extends SwarmCoordinator {
  private oracle: ModelConfig;
  private workerPool: ModelConfig[];
  private reviewerPool: ModelConfig[];
  private costTracker: {
    oracleSpent: number;
    workerSpent: number;
    reviewerSpent: number;
    totalBudget: number;
  };

  constructor(config: OracleWorkerConfig) {
    super({
      maxAgents: config.maxWorkers + 2, // Workers + Oracle + Reviewer
      coordinationInterval: config.coordinationInterval,
      enableDynamicPlanning: true,
      pathologicalBehaviorDetection: true,
    });

    this.oracle = config.oracle;
    this.workerPool = config.workers;
    this.reviewerPool = config.reviewers;

    this.costTracker = {
      oracleSpent: 0,
      workerSpent: 0,
      reviewerSpent: 0,
      totalBudget: config.costBudget || 10.0, // $10 default
    };

    logger.info('Oracle/Worker coordinator initialized', {
      oracle: this.oracle.model,
      workers: this.workerPool.length,
      budget: this.costTracker.totalBudget,
    });
  }

  /**
   * Launch swarm with Oracle/Worker pattern
   */
  async launchOracleWorkerSwarm(
    projectDescription: string,
    taskHints?: string[]
  ): Promise<string> {
    logger.info('Launching Oracle/Worker swarm', {
      project: projectDescription.substring(0, 100),
    });

    // Phase 1: Oracle Planning
    const oracleTaskId = await this.createOracleTask(
      'project_planning',
      projectDescription,
      taskHints
    );

    const decomposition = await this.executeOracleTask(oracleTaskId);

    // Phase 2: Worker Assignment
    const workerTasks = this.allocateTasksToWorkers(decomposition);

    // Phase 3: Parallel Worker Execution
    const workerPromises = workerTasks.map((task) =>
      this.executeWorkerTask(task)
    );

    // Phase 4: Oracle Review & Coordination
    const reviewTaskId = await this.scheduleOracleReview(decomposition);

    // Execute workers in parallel, oracle coordinates
    const [workerResults, reviewResult] = await Promise.all([
      Promise.allSettled(workerPromises),
      this.executeOracleTask(reviewTaskId),
    ]);

    // Phase 5: Final Integration
    const swarmId = await this.integrateResults(workerResults, reviewResult);

    this.logCostAnalysis();
    return swarmId;
  }

  /**
   * Create planning task for Oracle
   */
  private async createOracleTask(
    type: string,
    description: string,
    hints?: string[]
  ): Promise<string> {
    const taskId = uuidv4();

    const oraclePrompt = this.buildOraclePrompt(type, description, hints);
    const estimatedTokens = estimateTokens(oraclePrompt);

    logger.info('Oracle task created', {
      taskId,
      type,
      estimatedTokens,
      estimatedCost: estimatedTokens * this.oracle.costPerToken,
    });

    return taskId;
  }

  /**
   * Build specialized prompt for Oracle model
   */
  private buildOraclePrompt(
    type: string,
    description: string,
    hints?: string[]
  ): string {
    const basePrompt = `
# ORACLE ROLE: Strategic Planning & Coordination

You are the Oracle in an Oracle/Worker pattern. Your role:
- HIGH-LEVEL STRATEGIC thinking
- TASK DECOMPOSITION for worker agents  
- QUALITY CONTROL and review
- COORDINATION between workers
- ERROR CORRECTION and replanning

## Project Context
${description}

${hints ? `## Hints & Context\n${hints.map((h) => `- ${h}`).join('\n')}` : ''}

## Your Oracle Responsibilities
1. **Decompose** this project into discrete, parallelizable tasks
2. **Assign complexity levels** (low/medium/high) to guide worker selection
3. **Define acceptance criteria** for each task
4. **Identify dependencies** between tasks
5. **Plan coordination touchpoints** for integration

## Worker Constraints
- Workers are smaller models optimized for focused execution
- Workers excel at: implementation, testing, documentation, simple analysis
- Workers struggle with: complex architecture, strategic decisions, cross-cutting concerns

## Output Required
Provide a detailed task decomposition in JSON format:

\`\`\`json
{
  "project_summary": "Brief overview",
  "task_decomposition": [
    {
      "id": "unique-id",
      "title": "Task name",
      "description": "Detailed description",
      "complexity": "low|medium|high",
      "type": "implementation|testing|documentation|analysis",
      "estimated_effort": "1-5 scale",
      "worker_requirements": ["specific capabilities needed"],
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "dependencies": ["task-id-1", "task-id-2"]
    }
  ],
  "coordination_plan": {
    "integration_points": ["When to sync between workers"],
    "review_checkpoints": ["When Oracle should review progress"],
    "risk_mitigation": ["Potential issues and solutions"]
  }
}
\`\`\`

Remember: Your intelligence is expensive. Focus on high-value strategic thinking that workers cannot do effectively.
    `;

    return basePrompt;
  }

  /**
   * Execute Oracle task with high-end model
   */
  private async executeOracleTask(
    taskId: string
  ): Promise<TaskDecomposition[]> {
    logger.info('Executing Oracle task', { taskId });

    // Create Ralph loop with Oracle model configuration
    const ralph = new RalphStackMemoryBridge({
      baseDir: `.oracle/${taskId}`,
      maxIterations: 3, // Oracle should be efficient
      useStackMemory: true,
    });

    // Execute with Oracle model (implementation would integrate with actual model APIs)
    const result = await ralph.run();

    // Track Oracle costs
    const tokens = estimateTokens(result);
    const cost = tokens * this.oracle.costPerToken;
    this.costTracker.oracleSpent += cost;

    logger.info('Oracle task completed', {
      taskId,
      tokensUsed: tokens,
      cost: cost.toFixed(4),
    });

    return this.parseTaskDecomposition(result);
  }

  /**
   * Allocate decomposed tasks to worker models
   */
  private allocateTasksToWorkers(
    decomposition: TaskDecomposition[]
  ): TaskDecomposition[] {
    const allocatedTasks: TaskDecomposition[] = [];

    for (const task of decomposition) {
      // Select optimal worker model based on task complexity
      const workerModel = this.selectWorkerForTask(task);

      // Create worker-specific prompt
      const _workerPrompt = this.buildWorkerPrompt(task, workerModel);

      allocatedTasks.push({
        ...task,
        assignedModel: 'worker' as ModelTier,
      });

      logger.debug('Task allocated to worker', {
        taskId: task.id,
        complexity: task.complexity,
        worker: workerModel.model,
      });
    }

    return allocatedTasks;
  }

  /**
   * Select optimal worker model for task complexity
   */
  private selectWorkerForTask(task: TaskDecomposition): ModelConfig {
    // Simple allocation strategy - can be enhanced
    if (task.complexity === 'high') {
      // Use best available worker for complex tasks
      return this.workerPool[0];
    } else {
      // Use cheapest worker for simple tasks
      return this.workerPool.reduce((cheapest, current) =>
        current.costPerToken < cheapest.costPerToken ? current : cheapest
      );
    }
  }

  /**
   * Build focused prompt for worker models
   */
  private buildWorkerPrompt(
    task: TaskDecomposition,
    _worker: ModelConfig
  ): string {
    return `
# WORKER ROLE: Focused Task Execution

You are a specialized worker in an Oracle/Worker pattern.

## Your Task
${task.type}: ${task.title}

${task.description}

## Success Criteria
${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}

## Worker Guidelines
- FOCUS on this specific task only
- IMPLEMENT according to the specifications provided
- ASK for clarification if requirements are unclear
- COMMUNICATE progress through shared context
- COMPLETE the task efficiently without over-engineering

## Constraints
- You are optimized for execution, not planning
- Stay within your assigned scope
- Collaborate with other workers through shared context
- The Oracle will handle integration and review

Execute your task now.
    `;
  }

  /**
   * Execute worker task with cost tracking
   */
  private async executeWorkerTask(task: TaskDecomposition): Promise<any> {
    logger.info('Executing worker task', {
      taskId: task.id,
      complexity: task.complexity,
    });

    const ralph = new RalphStackMemoryBridge({
      baseDir: `.workers/${task.id}`,
      maxIterations: task.complexity === 'low' ? 3 : 7,
      useStackMemory: true,
    });

    const result = await ralph.run();

    // Track worker costs
    const workerModel = this.selectWorkerForTask(task);
    const tokens = estimateTokens(result);
    const cost = tokens * workerModel.costPerToken;
    this.costTracker.workerSpent += cost;

    logger.info('Worker task completed', {
      taskId: task.id,
      tokensUsed: tokens,
      cost: cost.toFixed(4),
    });

    return result;
  }

  /**
   * Schedule Oracle review of worker progress
   */
  private async scheduleOracleReview(
    decomposition: TaskDecomposition[]
  ): Promise<string> {
    const reviewTaskId = uuidv4();

    // Oracle reviews worker outputs and coordinates integration
    logger.info('Oracle review scheduled', {
      reviewTaskId,
      tasksToReview: decomposition.length,
    });

    return reviewTaskId;
  }

  /**
   * Integrate worker results under Oracle coordination
   */
  private async integrateResults(
    workerResults: PromiseSettledResult<any>[],
    _reviewResult: any
  ): Promise<string> {
    const swarmId = uuidv4();

    const successfulTasks = workerResults.filter(
      (result) => result.status === 'fulfilled'
    ).length;

    logger.info('Integration completed', {
      swarmId,
      totalTasks: workerResults.length,
      successfulTasks,
      successRate: ((successfulTasks / workerResults.length) * 100).toFixed(1),
    });

    return swarmId;
  }

  /**
   * Parse task decomposition from Oracle output
   */
  private parseTaskDecomposition(_output: string): TaskDecomposition[] {
    // Parse JSON from Oracle output
    // Implementation would extract the JSON task decomposition
    return [];
  }

  /**
   * Log cost analysis and efficiency metrics
   */
  private logCostAnalysis(): void {
    const total =
      this.costTracker.oracleSpent +
      this.costTracker.workerSpent +
      this.costTracker.reviewerSpent;

    const savings = this.calculateTraditionalCost() - total;

    logger.info('Oracle/Worker Cost Analysis', {
      oracleSpent: `$${this.costTracker.oracleSpent.toFixed(4)}`,
      workerSpent: `$${this.costTracker.workerSpent.toFixed(4)}`,
      totalSpent: `$${total.toFixed(4)}`,
      budgetUsed: `${((total / this.costTracker.totalBudget) * 100).toFixed(1)}%`,
      estimatedSavings: `$${savings.toFixed(4)}`,
      efficiency: `${((this.costTracker.workerSpent / total) * 100).toFixed(1)}% worker tasks`,
    });
  }

  /**
   * Calculate what this would cost with all-Oracle approach
   */
  private calculateTraditionalCost(): number {
    const _totalSpent =
      this.costTracker.oracleSpent +
      this.costTracker.workerSpent +
      this.costTracker.reviewerSpent;

    // Estimate if everything was done with Oracle model
    const avgWorkerCost = this.workerPool[0]?.costPerToken || 0.001;
    const workerTokensAsOracle = this.costTracker.workerSpent / avgWorkerCost;

    return (
      this.costTracker.oracleSpent +
      workerTokensAsOracle * this.oracle.costPerToken
    );
  }
}

/**
 * Default model configurations for Oracle/Worker pattern
 */
export const defaultModelConfigs: Record<ModelTier, ModelConfig[]> = {
  oracle: [
    {
      tier: 'oracle',
      provider: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      costPerToken: 0.003, // $3/1M input tokens
      capabilities: [
        'strategic_planning',
        'complex_reasoning',
        'task_decomposition',
        'quality_review',
        'error_correction',
      ],
    },
  ],

  worker: [
    {
      tier: 'worker',
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      costPerToken: 0.0008, // $0.80/1M input tokens
      capabilities: [
        'code_implementation',
        'unit_testing',
        'documentation',
        'simple_analysis',
        'data_processing',
      ],
    },
    {
      tier: 'worker',
      provider: 'openai',
      model: 'gpt-4o-mini',
      costPerToken: 0.00015, // $0.15/1M input tokens
      capabilities: [
        'rapid_prototyping',
        'script_writing',
        'basic_testing',
        'formatting',
        'simple_refactoring',
      ],
    },
  ],

  reviewer: [
    {
      tier: 'reviewer',
      provider: 'claude',
      model: 'claude-3-sonnet-20240229',
      costPerToken: 0.003, // $3/1M input tokens
      capabilities: [
        'code_review',
        'quality_assessment',
        'integration_testing',
        'performance_analysis',
        'security_review',
      ],
    },
  ],
};

export default OracleWorkerCoordinator;
