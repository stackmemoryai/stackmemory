/**
 * Recursive Language Model (RLM) Orchestrator for StackMemory
 *
 * Implements recursive task decomposition with parallel Claude API execution
 * Based on "Recursive Language Models" paper concepts
 *
 * Key Features:
 * - Parallel subagent execution via Claude API
 * - Automatic test generation and validation
 * - Multi-stage code review and improvement
 * - Large codebase processing through chunking
 * - Full operation transparency
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../core/monitoring/logger.js';
import { estimateTokens } from '../core/cache/token-estimator.js';
import { FrameManager } from '../core/context/index.js';
import { DualStackManager } from '../core/context/dual-stack-manager.js';
import { ContextRetriever } from '../core/retrieval/context-retriever.js';
import { LinearTaskManager } from '../features/tasks/linear-task-manager.js';
import { ParallelExecutor } from '../core/execution/parallel-executor.js';
import { RecursiveContextManager } from '../core/context/recursive-context-manager.js';
import { ClaudeCodeSubagentClient } from '../integrations/claude-code/subagent-client.js';
import { STRUCTURED_RESPONSE_SUFFIX } from '../orchestrators/multimodal/constants.js';

// Subagent types
export type SubagentType =
  | 'planning'
  | 'code'
  | 'testing'
  | 'linting'
  | 'review'
  | 'context'
  | 'publish'
  | 'improve';

import type { ModelProvider } from '../core/models/model-router.js';

// Subagent model target — either a Claude model string or provider+model pair
export type SubagentModelTarget =
  | 'claude-sonnet-4-5-20250929'
  | 'claude-haiku-4-5-20251001'
  | 'claude-opus-4-6'
  | { provider: ModelProvider; model: string };

// Subagent configuration
export interface SubagentConfig {
  type: SubagentType;
  model: SubagentModelTarget;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  capabilities: string[];
}

// Task decomposition node
export interface TaskNode {
  id: string;
  type: 'task' | 'parallel' | 'sequential';
  description: string;
  agent: SubagentType;
  dependencies: string[];
  context: Record<string, unknown>;
  children?: TaskNode[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: Error;
  attempts: number;
  startTime?: Date;
  endTime?: Date;
  tokens?: number;
  cost?: number;
}

// Execution result
export interface ExecutionResult {
  success: boolean;
  rootNode: TaskNode;
  totalTokens: number;
  totalCost: number;
  duration: number;
  improvements: string[];
  testsGenerated: number;
  issuesFound: number;
  issuesFixed: number;
}

// RLM Options
export interface RLMOptions {
  maxParallel?: number;
  maxRecursionDepth?: number;
  maxTokensPerAgent?: number;
  maxTotalCost?: number;
  timeoutPerAgent?: number;
  retryFailedAgents?: boolean;
  shareContextRealtime?: boolean;
  testGenerationMode?: 'unit' | 'integration' | 'e2e' | 'all';
  reviewStages?: number;
  qualityThreshold?: number;
  verboseLogging?: boolean;
}

/**
 * Main RLM Orchestrator
 */
export class RecursiveAgentOrchestrator {
  private frameManager: FrameManager;
  private contextRetriever: ContextRetriever;
  private taskStore: LinearTaskManager;
  private parallelExecutor: ParallelExecutor;
  private contextManager: RecursiveContextManager;
  private subagentClient: ClaudeCodeSubagentClient;

  // Subagent configurations
  private subagentConfigs: Map<SubagentType, SubagentConfig>;

  // Execution tracking
  private activeExecutions: Map<string, TaskNode> = new Map();
  private executionHistory: ExecutionResult[] = [];

  // Default options
  private defaultOptions: Required<RLMOptions> = {
    maxParallel: 5,
    maxRecursionDepth: 4,
    maxTokensPerAgent: 30000,
    maxTotalCost: 50.0, // Quality over cost
    timeoutPerAgent: 300,
    retryFailedAgents: true,
    shareContextRealtime: true,
    testGenerationMode: 'all',
    reviewStages: 3, // Multi-stage review
    qualityThreshold: 0.85,
    verboseLogging: true, // Full transparency
  };

  constructor(
    frameManager: FrameManager,
    dualStackManager: DualStackManager,
    contextRetriever: ContextRetriever,
    taskStore: LinearTaskManager
  ) {
    this.frameManager = frameManager;
    this.contextRetriever = contextRetriever;
    this.taskStore = taskStore;

    // Initialize components
    this.parallelExecutor = new ParallelExecutor(
      this.defaultOptions.maxParallel
    );
    this.contextManager = new RecursiveContextManager(
      dualStackManager,
      contextRetriever
    );
    this.subagentClient = new ClaudeCodeSubagentClient();

    // Initialize subagent configurations
    this.subagentConfigs = this.initializeSubagentConfigs();

    logger.info('RLM Orchestrator initialized', {
      maxParallel: this.defaultOptions.maxParallel,
      maxRecursion: this.defaultOptions.maxRecursionDepth,
      reviewStages: this.defaultOptions.reviewStages,
    });
  }

  /**
   * Initialize subagent configurations with specialized prompts
   */
  private initializeSubagentConfigs(): Map<SubagentType, SubagentConfig> {
    const configs = new Map<SubagentType, SubagentConfig>();

    // Planning Agent - Task decomposer
    configs.set('planning', {
      type: 'planning',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 20000,
      temperature: 0.3,
      systemPrompt:
        `You decompose tasks into parallel/sequential subtask trees.
Output JSON: { subtasks: [{ id, description, agent, dependencies[], parallel: bool }] }
Rules:
- Maximize parallelism — independent tasks run concurrently
- Each subtask names its agent type: planning, code, testing, linting, review, improve, context, publish
- Include failure modes and rollback steps for risky operations
- Keep subtask descriptions actionable (verb + object + constraint)` +
        STRUCTURED_RESPONSE_SUFFIX,
      capabilities: ['decompose', 'analyze', 'strategize', 'prioritize'],
    });

    // Code Agent - Implementation specialist
    configs.set('code', {
      type: 'code',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 30000,
      temperature: 0.2,
      systemPrompt:
        `You implement code changes. Read existing code before modifying.
Output JSON: { success: bool, filesChanged: string[], changes: string[], notes: string[] }
Rules:
- Follow existing project conventions (naming, imports, patterns)
- Add .js extensions to relative TypeScript imports (ESM)
- Return undefined over throwing; log+continue over crash
- No emojis, no unnecessary comments, functions under 20 lines
- Validate inputs at system boundaries only` + STRUCTURED_RESPONSE_SUFFIX,
      capabilities: ['implement', 'refactor', 'optimize', 'document'],
    });

    // Testing Agent - Test generation and validation
    configs.set('testing', {
      type: 'testing',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 25000,
      temperature: 0.1,
      systemPrompt:
        `You generate and run tests using the project's test framework.
Output JSON: { success: bool, tests: [{ name, type, file }], coverage: string, notes: string[] }
Rules:
- Use vitest (describe/it/expect) — check existing tests for patterns
- Prioritize: critical paths > edge cases > happy paths
- Each test should assert meaningful behavior, not implementation details
- Use parameterized tests (it.each) to consolidate similar cases
- Run tests after writing: npm run test:run` + STRUCTURED_RESPONSE_SUFFIX,
      capabilities: [
        'generate-tests',
        'validate',
        'coverage-analysis',
        'test-execution',
      ],
    });

    // Linting Agent - Code quality enforcer
    configs.set('linting', {
      type: 'linting',
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 15000,
      temperature: 0,
      systemPrompt:
        `You run lint checks and fix issues.
Output JSON: { success: bool, issuesFound: number, issuesFixed: number, remaining: string[] }
Rules:
- Run: npm run lint (ESLint + Prettier)
- Auto-fix: npm run lint:fix
- ESM imports require .js extension on relative paths
- Report unfixable issues with file:line format` + STRUCTURED_RESPONSE_SUFFIX,
      capabilities: ['lint', 'format', 'type-check', 'security-scan'],
    });

    // Review Agent - Multi-stage code reviewer
    configs.set('review', {
      type: 'review',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 25000,
      temperature: 0.2,
      systemPrompt:
        `You review code changes for quality, security, and correctness.
Output JSON: { qualityScore: 0-1, issues: [{ severity, file, line, description, suggestion }], approved: bool }
Rules:
- Score 0.85+ = approved, below = needs improvement
- Flag: SQL injection, XSS, secret exposure, command injection
- Flag: functions > 20 lines, cyclomatic complexity > 5
- Flag: missing error handling at system boundaries
- Suggest specific fixes, not vague improvements` + STRUCTURED_RESPONSE_SUFFIX,
      capabilities: [
        'review',
        'critique',
        'suggest-improvements',
        'quality-scoring',
      ],
    });

    // Improvement Agent - Code enhancer
    configs.set('improve', {
      type: 'improve',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 30000,
      temperature: 0.3,
      systemPrompt:
        `You implement review feedback and improve code quality.
Output JSON: { success: bool, improvements: string[], filesChanged: string[] }
Rules:
- Apply only the specific improvements requested — no scope creep
- Maintain backward compatibility unless explicitly breaking
- Run lint + tests after changes to verify nothing regressed
- Keep changes minimal and focused` + STRUCTURED_RESPONSE_SUFFIX,
      capabilities: ['enhance', 'refactor', 'optimize', 'polish'],
    });

    // Context Agent - Information retriever
    configs.set('context', {
      type: 'context',
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 10000,
      temperature: 0,
      systemPrompt:
        `You retrieve relevant context from the codebase and specs.
Output JSON: { context: string, sources: string[], relevanceScore: 0-1 }
Rules:
- Check docs/specs/ for ONE_PAGER.md, DEV_SPEC.md, PROMPT_PLAN.md
- Check CLAUDE.md and AGENTS.md for project conventions
- Search src/ for relevant implementations
- Return concise summaries, not full file contents` +
        STRUCTURED_RESPONSE_SUFFIX,
      capabilities: ['search', 'retrieve', 'summarize', 'contextualize'],
    });

    // Publish Agent - Release and deployment
    configs.set('publish', {
      type: 'publish',
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 15000,
      temperature: 0,
      systemPrompt:
        `You handle releases and publishing.
Output JSON: { success: bool, version: string, actions: string[] }
Rules:
- Verify lint + tests + build pass before any publish
- Follow semver: breaking=major, feature=minor, fix=patch
- Generate changelog from git log since last tag
- Never force-push or skip pre-publish hooks` + STRUCTURED_RESPONSE_SUFFIX,
      capabilities: ['publish-npm', 'github-release', 'deploy', 'document'],
    });

    return configs;
  }

  /**
   * Execute a task with recursive decomposition
   */
  async execute(
    task: string,
    context: Record<string, unknown>,
    options?: RLMOptions
  ): Promise<ExecutionResult> {
    const opts = { ...this.defaultOptions, ...options };
    const executionId = this.generateExecutionId();
    const startTime = Date.now();

    logger.info('Starting RLM execution', {
      executionId,
      task: task.slice(0, 100),
      options: opts,
    });

    try {
      // Create root frame for execution
      const rootFrameId = await this.createExecutionFrame(executionId, task);

      // Step 1: Planning - Decompose task into subtasks
      const rootNode = await this.planTask(task, context, opts);
      this.activeExecutions.set(executionId, rootNode);

      // Log execution tree for transparency
      if (opts.verboseLogging) {
        this.logExecutionTree(rootNode);
      }

      // Step 2: Execute task tree recursively with parallelization
      await this.executeTaskTree(rootNode, context, opts, 0);

      // Step 3: Multi-stage review and improvement
      const improvements = await this.performMultiStageReview(
        rootNode,
        opts.reviewStages,
        opts.qualityThreshold
      );

      // Step 4: Aggregate results
      const result: ExecutionResult = {
        success: rootNode.status === 'completed',
        rootNode,
        totalTokens: this.calculateTotalTokens(rootNode),
        totalCost: this.calculateTotalCost(rootNode),
        duration: Date.now() - startTime,
        improvements,
        testsGenerated: this.countGeneratedTests(rootNode),
        issuesFound: this.countIssuesFound(rootNode),
        issuesFixed: this.countIssuesFixed(rootNode),
      };

      // Store execution history
      this.executionHistory.push(result);

      // Update frame with results
      await this.updateExecutionFrame(rootFrameId, result);

      logger.info('RLM execution completed', {
        executionId,
        success: result.success,
        duration: result.duration,
        totalCost: result.totalCost,
        testsGenerated: result.testsGenerated,
        improvements: improvements.length,
      });

      return result;
    } catch (error) {
      logger.error('RLM execution failed', { executionId, error });
      throw error;
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  /**
   * Plan task decomposition
   */
  private async planTask(
    task: string,
    context: Record<string, unknown>,
    options: Required<RLMOptions>
  ): Promise<TaskNode> {
    // Call planning agent using Claude Code Task tool
    const response = await this.subagentClient.executeSubagent({
      type: 'planning',
      task: task,
      context: {
        ...context,
        requirements: options,
      },
    });

    // Parse response into task tree
    const taskTree = this.parseTaskTree(JSON.stringify(response.result));

    // Add automatic test generation nodes
    this.injectTestGenerationNodes(taskTree, options.testGenerationMode);

    // Add review stages
    this.injectReviewStages(taskTree, options.reviewStages);

    return taskTree;
  }

  /**
   * Execute task tree recursively with parallelization
   */
  private async executeTaskTree(
    node: TaskNode,
    context: Record<string, unknown>,
    options: Required<RLMOptions>,
    depth: number
  ): Promise<void> {
    // Check recursion depth
    if (depth >= options.maxRecursionDepth) {
      logger.warn('Max recursion depth reached', { nodeId: node.id, depth });
      node.status = 'failed';
      node.error = new Error('Max recursion depth exceeded');
      return;
    }

    // Log execution start for transparency
    if (options.verboseLogging) {
      logger.info(`Executing node: ${node.description}`, {
        id: node.id,
        type: node.type,
        agent: node.agent,
        depth,
      });
    }

    node.status = 'running';
    node.startTime = new Date();

    try {
      if (node.type === 'parallel' && node.children) {
        // Execute children in parallel
        await this.parallelExecutor.executeParallel(
          node.children,
          async (child) => {
            await this.executeTaskTree(child, context, options, depth + 1);
          }
        );
      } else if (node.type === 'sequential' && node.children) {
        // Execute children sequentially
        for (const child of node.children) {
          await this.executeTaskTree(child, context, options, depth + 1);

          // Pass results to next child
          if (child.result) {
            context[`${child.id}_result`] = child.result;
          }
        }
      } else {
        // Leaf node - execute with appropriate agent
        await this.executeLeafNode(node, context, options);
      }

      node.status = 'completed';
    } catch (error) {
      logger.error(`Node execution failed: ${node.description}`, { error });

      if (options.retryFailedAgents && node.attempts < 3) {
        node.attempts++;
        logger.info(`Retrying node: ${node.description}`, {
          attempt: node.attempts,
        });
        await this.executeTaskTree(node, context, options, depth);
      } else {
        node.status = 'failed';
        node.error = error as Error;
      }
    } finally {
      node.endTime = new Date();

      // Log completion for transparency
      if (options.verboseLogging) {
        const duration =
          node.endTime.getTime() - (node.startTime?.getTime() ?? 0);
        logger.info(`Completed node: ${node.description}`, {
          id: node.id,
          status: node.status,
          duration,
          tokens: node.tokens,
          cost: node.cost,
        });
      }
    }
  }

  /**
   * Execute a leaf node with the appropriate agent
   */
  private async executeLeafNode(
    node: TaskNode,
    context: Record<string, unknown>,
    options: Required<RLMOptions>
  ): Promise<void> {
    const agentConfig = this.subagentConfigs.get(node.agent);
    if (!agentConfig) {
      throw new Error(`Unknown agent type: ${node.agent}`);
    }

    // Prepare agent-specific context
    const agentContext = await this.contextManager.prepareAgentContext(
      node.agent,
      context,
      options.maxTokensPerAgent
    );

    // Build task description for agent
    const taskDescription = this.buildAgentPrompt(node, agentContext);

    // Call agent via Claude Code Task tool
    const response = await this.subagentClient.executeSubagent({
      type: node.agent,
      task: taskDescription,
      context: agentContext,
    });

    // Process agent response
    node.result = response.result;
    node.tokens = response.tokens || estimateTokens(JSON.stringify(response));
    node.cost = this.calculateNodeCost(node.tokens, agentConfig.model);

    // Share results with other agents if real-time sharing is enabled
    if (options.shareContextRealtime) {
      await this.shareAgentResults(node);
    }
  }

  /**
   * Perform multi-stage review and improvement
   */
  private async performMultiStageReview(
    rootNode: TaskNode,
    stages: number,
    qualityThreshold: number
  ): Promise<string[]> {
    const improvements: string[] = [];
    let currentQuality = 0;

    for (let stage = 1; stage <= stages; stage++) {
      logger.info(`Starting review stage ${stage}/${stages}`);

      // Review stage
      const reviewNode: TaskNode = {
        id: `review-stage-${stage}`,
        type: 'task',
        description: `Review stage ${stage}`,
        agent: 'review',
        dependencies: [],
        context: { rootNode, stage },
        status: 'pending',
        attempts: 0,
      };

      // Execute review via Claude Code subagent
      const reviewResponse = await this.subagentClient.executeSubagent({
        type: 'review',
        task: `Review stage ${stage}: Analyze code quality and suggest improvements`,
        context: { rootNode, stage },
      });

      reviewNode.result = reviewResponse.result;
      reviewNode.status = reviewResponse.success ? 'completed' : 'failed';

      const reviewResult = reviewResponse.result as {
        quality: number;
        issues: string[];
        suggestions: string[];
      };

      currentQuality = reviewResult.quality || 0.5; // Default quality if missing

      // Safely handle suggestions array
      if (reviewResult.suggestions && Array.isArray(reviewResult.suggestions)) {
        improvements.push(...reviewResult.suggestions);
      } else {
        // Fallback for mock/test results
        improvements.push(
          `Stage ${stage}: Review completed with quality ${currentQuality}`
        );
      }

      logger.info(`Review stage ${stage} complete`, {
        quality: currentQuality,
        issues: reviewResult.issues?.length || 0,
        suggestions: reviewResult.suggestions?.length || 0,
      });

      // If quality meets threshold, stop
      if (currentQuality >= qualityThreshold) {
        logger.info(
          `Quality threshold met: ${currentQuality} >= ${qualityThreshold}`
        );
        break;
      }

      // Improvement stage
      if (stage < stages) {
        const improveNode: TaskNode = {
          id: `improve-stage-${stage}`,
          type: 'task',
          description: `Improvement stage ${stage}`,
          agent: 'improve',
          dependencies: [reviewNode.id],
          context: { reviewResult, rootNode },
          status: 'pending',
          attempts: 0,
        };

        // Execute improvement via Claude Code subagent
        const improveResponse = await this.subagentClient.executeSubagent({
          type: 'improve',
          task: `Improvement stage ${stage}: Implement suggested improvements`,
          context: { reviewResult, rootNode },
        });

        improveNode.result = improveResponse.result;
        improveNode.status = improveResponse.success ? 'completed' : 'failed';

        // Apply improvements to root node
        this.applyImprovements(rootNode, improveNode.result);
      }
    }

    return improvements;
  }

  /**
   * Helper methods
   */

  private generateExecutionId(): string {
    return `rlm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async createExecutionFrame(
    executionId: string,
    task: string
  ): Promise<string> {
    return this.frameManager.createFrame({
      name: `RLM: ${task.slice(0, 50)}`,
      type: 'task',
      inputs: { executionId, task, type: 'rlm-execution' },
    });
  }

  private async updateExecutionFrame(
    frameId: string,
    result: ExecutionResult
  ): Promise<void> {
    // Close the frame with the execution result
    this.frameManager.closeFrame(frameId, {
      type: 'rlm-result',
      content: JSON.stringify(result, null, 2),
      success: result.success,
      duration: result.duration,
      totalTokens: result.totalTokens,
      totalCost: result.totalCost,
    });
  }

  private logExecutionTree(node: TaskNode, depth: number = 0): void {
    const indent = '  '.repeat(depth);
    const status =
      node.status === 'completed'
        ? '✓'
        : node.status === 'failed'
          ? '✗'
          : node.status === 'running'
            ? '⟳'
            : '○';

    console.log(`${indent}${status} ${node.description} [${node.agent}]`);

    if (node.children) {
      for (const child of node.children) {
        this.logExecutionTree(child, depth + 1);
      }
    }
  }

  private parseTaskTree(_response: string): TaskNode {
    // Parse LLM response into structured task tree
    // This would need sophisticated parsing logic
    // For now, return a mock structure
    return {
      id: 'root',
      type: 'sequential',
      description: 'Root task',
      agent: 'planning',
      dependencies: [],
      context: {},
      status: 'pending',
      attempts: 0,
      children: [],
    };
  }

  private injectTestGenerationNodes(node: TaskNode, _mode: string): void {
    // Inject test generation nodes based on mode
    // Initialize children array if it doesn't exist
    if (!node.children) {
      node.children = [];
    }

    const testNode: TaskNode = {
      id: `${node.id}-test`,
      type: 'task',
      description: `Generate ${_mode} tests for ${node.description}`,
      agent: 'testing',
      dependencies: [node.id],
      context: { testMode: _mode },
      status: 'pending',
      attempts: 0,
    };

    node.children.push(testNode);
  }

  private injectReviewStages(_node: TaskNode, _stages: number): void {
    // Inject review stages into task tree
    // Implementation would add review nodes at appropriate points
  }

  private loadSpecContext(): string {
    const specDir = path.join(process.cwd(), 'docs', 'specs');
    if (!fs.existsSync(specDir)) return '';

    const specFiles = ['ONE_PAGER.md', 'DEV_SPEC.md', 'PROMPT_PLAN.md'];
    const sections: string[] = [];

    for (const file of specFiles) {
      const filePath = path.join(specDir, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Truncate to first 2000 chars to stay within token budgets
        const truncated =
          content.length > 2000
            ? content.slice(0, 2000) + '\n...[truncated]'
            : content;
        sections.push(`### ${file}\n${truncated}`);
      }
    }

    return sections.length > 0
      ? `\n## Project Specs\n${sections.join('\n\n')}`
      : '';
  }

  private buildAgentPrompt(
    node: TaskNode,
    context: Record<string, unknown>
  ): string {
    const depResults = node.dependencies
      .map((id) => {
        const dep = this.activeExecutions.get(id);
        if (!dep?.result) return null;
        return { id, agent: dep.agent, result: dep.result };
      })
      .filter(Boolean);

    const specContext =
      node.agent === 'planning' || node.agent === 'code'
        ? this.loadSpecContext()
        : '';

    return [
      `## Task`,
      node.description,
      '',
      `## Agent Role: ${node.agent}`,
      `Config: ${JSON.stringify(this.subagentConfigs.get(node.agent)?.capabilities || [])}`,
      '',
      `## Context`,
      JSON.stringify(context, null, 2),
      '',
      ...(depResults.length > 0
        ? [`## Dependency Results`, JSON.stringify(depResults, null, 2), '']
        : []),
      ...(specContext ? [specContext, ''] : []),
      `## Constraints`,
      `- ESM imports: use .js extensions on relative imports`,
      `- Testing: vitest (not jest)`,
      `- Lint: npm run lint (eslint + prettier)`,
      `- Output structured JSON when possible`,
    ].join('\n');
  }

  private async shareAgentResults(_node: TaskNode): Promise<void> {
    // Share results with other agents via Redis or shared context
    logger.debug('Sharing agent results', { nodeId: _node.id });
  }

  private applyImprovements(_rootNode: TaskNode, improvements: unknown): void {
    // Apply improvements to the task tree
    logger.debug('Applying improvements', { improvements });
  }

  private calculateTotalTokens(node: TaskNode): number {
    let total = node.tokens || 0;
    if (node.children) {
      for (const child of node.children) {
        total += this.calculateTotalTokens(child);
      }
    }
    return total;
  }

  private calculateTotalCost(node: TaskNode): number {
    let total = node.cost || 0;
    if (node.children) {
      for (const child of node.children) {
        total += this.calculateTotalCost(child);
      }
    }
    return total;
  }

  private calculateNodeCost(
    tokens: number,
    model: SubagentModelTarget
  ): number {
    // Pricing per 1M tokens (input+output blended approximate)
    const pricing: Record<string, number> = {
      'claude-sonnet-4-5-20250929': 15.0,
      'claude-haiku-4-5-20251001': 1.0,
      'claude-opus-4-6': 75.0,
      // External providers — much cheaper
      'llama-4-scout-17b-16e-instruct': 0.35,
      'THUDM/glm-4-9b-chat': 0.06,
    };
    const modelName = typeof model === 'string' ? model : model.model;
    return (tokens / 1000000) * (pricing[modelName] || 10);
  }

  private countGeneratedTests(node: TaskNode): number {
    let count = 0;
    if (node.agent === 'testing' && node.result?.tests) {
      count += node.result.tests.length;
    }
    if (node.children) {
      for (const child of node.children) {
        count += this.countGeneratedTests(child);
      }
    }
    return count;
  }

  private countIssuesFound(node: TaskNode): number {
    let count = 0;
    if (
      (node.agent === 'review' || node.agent === 'linting') &&
      node.result?.issues
    ) {
      count += node.result.issues.length;
    }
    if (node.children) {
      for (const child of node.children) {
        count += this.countIssuesFound(child);
      }
    }
    return count;
  }

  private countIssuesFixed(node: TaskNode): number {
    let count = 0;
    if (node.agent === 'improve' && node.result?.fixed) {
      count += node.result.fixed.length;
    }
    if (node.children) {
      for (const child of node.children) {
        count += this.countIssuesFixed(child);
      }
    }
    return count;
  }
}
