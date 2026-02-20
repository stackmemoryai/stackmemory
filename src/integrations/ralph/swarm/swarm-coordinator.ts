/**
 * Swarm Coordination System for StackMemory
 * Orchestrates multiple specialized agents working together on the same codebase
 * Addresses multi-agent coordination challenges with role specialization and dynamic planning
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../core/monitoring/logger.js';
import { FrameManager } from '../../../core/context/index.js';
import { sessionManager } from '../../../core/session/index.js';
import { sharedContextLayer } from '../../../core/context/shared-context-layer.js';
import { RalphStackMemoryBridge } from '../bridge/ralph-stackmemory-bridge.js';
import { GitWorkflowManager } from './git-workflow-manager.js';
import { SwarmRegistry } from '../monitoring/swarm-registry.js';
import {
  SwarmConfiguration,
  Agent,
  AgentRole,
  SwarmTask,
  CoordinationEvent,
  SwarmState,
  TaskAllocation,
  AgentSpecialization,
} from '../types.js';

export class SwarmCoordinationError extends Error {
  constructor(
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SwarmCoordinationError';
  }
}

export class AgentExecutionError extends Error {
  constructor(
    message: string,
    public agentId: string,
    public taskId: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

export class TaskAllocationError extends Error {
  constructor(
    message: string,
    public taskId: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TaskAllocationError';
  }
}

export interface SwarmCoordinatorConfig {
  maxAgents: number;
  coordinationInterval: number;
  driftDetectionThreshold: number;
  freshStartInterval: number;
  conflictResolutionStrategy: 'democratic' | 'hierarchical' | 'expertise';
  enableDynamicPlanning: boolean;
  pathologicalBehaviorDetection: boolean;
}

export class SwarmCoordinator {
  private frameManager?: FrameManager;
  private activeAgents: Map<string, Agent> = new Map();
  private swarmState: SwarmState;
  private config: SwarmCoordinatorConfig;
  private coordinationTimer?: NodeJS.Timeout;
  private plannerWakeupQueue: Map<string, () => void> = new Map();
  private gitWorkflowManager: GitWorkflowManager;
  private registeredSwarmId?: string;

  get swarmId(): string | undefined {
    return this.registeredSwarmId;
  }

  get agents(): Agent[] {
    return Array.from(this.activeAgents.values());
  }

  constructor(config?: Partial<SwarmCoordinatorConfig>) {
    this.config = {
      maxAgents: 10,
      coordinationInterval: 30000, // 30 seconds
      driftDetectionThreshold: 5, // 5 failed iterations before considering drift
      freshStartInterval: 3600000, // 1 hour
      conflictResolutionStrategy: 'expertise',
      enableDynamicPlanning: true,
      pathologicalBehaviorDetection: true,
      ...config,
    };

    this.swarmState = {
      id: uuidv4(),
      status: 'idle',
      startTime: Date.now(),
      activeTaskCount: 0,
      completedTaskCount: 0,
      coordination: {
        events: [],
        conflicts: [],
        resolutions: [],
      },
      performance: {
        throughput: 0,
        efficiency: 0,
        coordination_overhead: 0,
      },
    };

    // Initialize git workflow manager
    this.gitWorkflowManager = new GitWorkflowManager({
      enableGitWorkflow: true,
      branchStrategy: 'agent',
      autoCommit: true,
      commitFrequency: 5,
      mergStrategy: 'squash',
    });

    logger.info('Swarm coordinator initialized', this.config);
  }

  async initialize(): Promise<void> {
    try {
      await sessionManager.initialize();
      await sharedContextLayer.initialize();

      const session = await sessionManager.getOrCreateSession({});
      if (session.database) {
        this.frameManager = new FrameManager(
          session.database,
          session.projectId
        );
      }

      // Start coordination monitoring
      this.startCoordinationLoop();

      // Register with global swarm registry for TUI monitoring
      const registry = SwarmRegistry.getInstance();
      this.registeredSwarmId = registry.registerSwarm(
        this,
        `Swarm ${this.swarmState.id.substring(0, 8)}`
      );

      logger.info('Swarm coordinator initialized successfully');
    } catch (error: unknown) {
      logger.error('Failed to initialize swarm coordinator', error as Error);
      throw error;
    }
  }

  /**
   * Launch a swarm of agents to work on a complex project
   */
  async launchSwarm(
    projectDescription: string,
    agents: AgentSpecialization[],
    coordination?: SwarmConfiguration
  ): Promise<string> {
    logger.info('Launching swarm', {
      project: projectDescription.substring(0, 100),
      agentCount: agents.length,
    });

    const swarmId = uuidv4();

    try {
      // 1. Validate swarm configuration
      if (agents.length > this.config.maxAgents) {
        throw new Error(
          `Too many agents requested: ${agents.length} > ${this.config.maxAgents}`
        );
      }

      // 2. Break down project into swarm tasks
      const swarmTasks =
        await this.decomposeProjectIntoSwarmTasks(projectDescription);

      // 3. Initialize specialized agents
      const initializedAgents = await this.initializeSpecializedAgents(
        agents,
        swarmTasks
      );

      // 4. Create task allocation plan
      const allocation = await this.allocateTasksToAgents(
        swarmTasks,
        initializedAgents
      );

      // 5. Begin swarm execution
      this.swarmState = {
        ...this.swarmState,
        id: swarmId,
        status: 'active',
        activeTaskCount: swarmTasks.length,
        project: projectDescription,
        agents: initializedAgents,
        tasks: swarmTasks,
        allocation,
      };

      // 6. Start agent execution
      await this.executeSwarmTasks(allocation);

      logger.info('Swarm launched successfully', {
        swarmId,
        agentCount: initializedAgents.length,
      });
      return swarmId;
    } catch (error: unknown) {
      logger.error('Failed to launch swarm', error as Error);
      throw error;
    }
  }

  /**
   * Decompose project into tasks suitable for swarm execution
   */
  private async decomposeProjectIntoSwarmTasks(
    projectDescription: string
  ): Promise<SwarmTask[]> {
    const tasks: SwarmTask[] = [];

    // Analyze project complexity and decompose based on patterns
    const complexity = this.analyzeProjectComplexity(projectDescription);

    // Pattern 1: Architecture and Planning
    if (complexity.needsArchitecture) {
      tasks.push({
        id: uuidv4(),
        type: 'architecture',
        title: 'System Architecture Design',
        description:
          'Design overall system architecture and component relationships',
        priority: 1,
        estimatedEffort: 'high',
        requiredRoles: ['architect', 'system_designer'],
        dependencies: [],
        acceptanceCriteria: [
          'Architecture diagram created',
          'Component interfaces defined',
          'Data flow documented',
        ],
      });
    }

    // Pattern 2: Core Implementation Tasks
    const coreFeatures = this.extractCoreFeatures(projectDescription);
    for (const feature of coreFeatures) {
      tasks.push({
        id: uuidv4(),
        type: 'implementation',
        title: `Implement ${feature.name}`,
        description: feature.description,
        priority: 2,
        estimatedEffort: feature.complexity,
        requiredRoles: ['developer', feature.specialization || 'fullstack'],
        dependencies: complexity.needsArchitecture ? [tasks[0].id] : [],
        acceptanceCriteria: feature.criteria,
      });
    }

    // Pattern 3: Testing and Validation
    if (complexity.needsTesting) {
      tasks.push({
        id: uuidv4(),
        type: 'testing',
        title: 'Comprehensive Testing Suite',
        description: 'Create unit, integration, and end-to-end tests',
        priority: 3,
        estimatedEffort: 'medium',
        requiredRoles: ['qa_engineer', 'test_automation'],
        dependencies: tasks
          .filter((t) => t.type === 'implementation')
          .map((t) => t.id),
        acceptanceCriteria: [
          'Unit tests achieve >90% coverage',
          'Integration tests pass',
          'Performance benchmarks met',
        ],
      });
    }

    // Pattern 4: Documentation and Polish
    if (complexity.needsDocumentation) {
      tasks.push({
        id: uuidv4(),
        type: 'documentation',
        title: 'Documentation and Examples',
        description: 'Create user documentation, API docs, and usage examples',
        priority: 4,
        estimatedEffort: 'low',
        requiredRoles: ['technical_writer', 'developer'],
        dependencies: [], // Can run in parallel
        acceptanceCriteria: [
          'README with setup instructions',
          'API documentation complete',
          'Usage examples provided',
        ],
      });
    }

    return tasks;
  }

  /**
   * Initialize specialized agents with role-specific configurations
   */
  private async initializeSpecializedAgents(
    specifications: AgentSpecialization[],
    tasks: SwarmTask[]
  ): Promise<Agent[]> {
    const agents: Agent[] = [];

    for (const spec of specifications) {
      const agent: Agent = {
        id: uuidv4(),
        role: spec.role,
        specialization: spec,
        status: 'initializing',
        capabilities: this.defineCapabilities(spec.role),
        workingDirectory: `.swarm/${spec.role}-${Date.now()}`,
        currentTask: null,
        performance: {
          tasksCompleted: 0,
          successRate: 1.0,
          averageTaskTime: 0,
          driftDetected: false,
          lastFreshStart: Date.now(),
        },
        coordination: {
          communicationStyle: this.defineCommuncationStyle(spec.role),
          conflictResolution: spec.conflictResolution || 'defer_to_expertise',
          collaborationPreferences: spec.collaborationPreferences || [],
        },
      };

      // Initialize agent's working environment
      await this.setupAgentEnvironment(agent);

      // Configure role-specific prompting strategies
      await this.configureAgentPrompts(agent);

      agents.push(agent);
      this.activeAgents.set(agent.id, agent);
    }

    logger.info(`Initialized ${agents.length} specialized agents`);
    return agents;
  }

  /**
   * Allocate tasks to agents based on specialization and workload
   */
  private async allocateTasksToAgents(
    tasks: SwarmTask[],
    agents: Agent[]
  ): Promise<TaskAllocation> {
    const allocation: TaskAllocation = {
      assignments: new Map(),
      loadBalancing: 'capability_based',
      conflictResolution: this.config.conflictResolutionStrategy,
    };

    // Sort tasks by priority and dependencies
    const sortedTasks = this.topologicalSort(tasks);

    for (const task of sortedTasks) {
      // Find best-suited agents for this task
      const suitableAgents = agents.filter((agent) =>
        task.requiredRoles.some((role) => this.agentCanHandle(agent, role))
      );

      if (suitableAgents.length === 0) {
        logger.warn(`No suitable agents found for task: ${task.title}`);
        continue;
      }

      // Select agent based on workload and expertise
      const selectedAgent = this.selectOptimalAgent(suitableAgents, task);

      allocation.assignments.set(task.id, {
        agentId: selectedAgent.id,
        taskId: task.id,
        assignedAt: Date.now(),
        estimatedCompletion: Date.now() + this.estimateTaskDuration(task),
        coordination: {
          collaborators: this.findCollaborators(selectedAgent, task, agents),
          reviewers: this.findReviewers(selectedAgent, task, agents),
        },
      });

      // Update agent workload
      selectedAgent.currentTask = task.id;
    }

    return allocation;
  }

  /**
   * Execute swarm tasks with coordination
   */
  private async executeSwarmTasks(allocation: TaskAllocation): Promise<void> {
    const executionPromises: Promise<void>[] = [];

    for (const [taskId, assignment] of allocation.assignments) {
      const agent = this.activeAgents.get(assignment.agentId);
      const task = this.swarmState.tasks?.find((t) => t.id === taskId);

      if (!agent || !task) continue;

      // Create execution promise for each agent
      const executionPromise = this.executeAgentTask(agent, task, assignment);
      executionPromises.push(executionPromise);
    }

    // Monitor all executions
    await Promise.allSettled(executionPromises);
  }

  /**
   * Execute a single agent task with coordination
   */
  private async executeAgentTask(
    agent: Agent,
    task: SwarmTask,
    assignment: TaskAllocation['assignments'] extends Map<string, infer T>
      ? T
      : any
  ): Promise<void> {
    logger.info(`Agent ${agent.role} starting task: ${task.title}`);

    try {
      agent.status = 'active';

      // Initialize git workflow for this agent
      await this.gitWorkflowManager.initializeAgentWorkflow(agent, task);

      // Create Ralph loop for this agent/task
      const ralph = new RalphStackMemoryBridge({
        baseDir: path.join(agent.workingDirectory, task.id),
        maxIterations: this.calculateMaxIterations(task),
        useStackMemory: true,
      });

      // Initialize with context from other agents
      const contextualPrompt = await this.synthesizeContextualPrompt(
        agent,
        task
      );

      await ralph.initialize({
        task: contextualPrompt,
        criteria: task.acceptanceCriteria.join('\n'),
      });

      // Set up coordination hooks
      this.setupAgentCoordination(agent, ralph, assignment);

      // Run the task using worker iterations
      let iteration = 1;
      const maxIterations = this.calculateMaxIterations(task);

      while (iteration <= maxIterations) {
        try {
          const result = await ralph.runWorkerIteration();
          if (result.isComplete) {
            logger.info(`Task completed in ${iteration} iterations`);
            break;
          }
          iteration++;
        } catch (error: unknown) {
          logger.error(`Iteration ${iteration} failed:`, error as Error);
          if (iteration >= maxIterations) {
            throw error;
          }
          iteration++;
        }
      }

      // Commit agent's work
      await this.gitWorkflowManager.commitAgentWork(agent, task);

      // Update performance metrics
      this.updateAgentPerformance(agent, true);

      // Merge agent's work back
      await this.gitWorkflowManager.mergeAgentWork(agent, task);

      // Notify planners and collaborators
      await this.notifyTaskCompletion(agent, task, true);

      agent.status = 'idle';
      logger.info(`Agent ${agent.role} completed task: ${task.title}`);
    } catch (error: unknown) {
      logger.error(
        `Agent ${agent.role} failed task: ${task.title}`,
        error as Error
      );

      // Update performance metrics
      this.updateAgentPerformance(agent, false);

      // Trigger conflict resolution or reassignment
      await this.handleTaskFailure(agent, task, error as Error);

      agent.status = 'error';
    }
  }

  /**
   * Synthesize contextual prompt incorporating swarm knowledge
   */
  private async synthesizeContextualPrompt(
    agent: Agent,
    task: SwarmTask
  ): Promise<string> {
    const basePrompt = task.description;
    const roleSpecificInstructions = this.getRoleSpecificInstructions(
      agent.role
    );
    const swarmContext = await this.getSwarmContext(task);
    const coordinationInstructions = this.getCoordinationInstructions(agent);

    return `
${roleSpecificInstructions}

TASK: ${basePrompt}

SWARM CONTEXT:
${swarmContext}

COORDINATION GUIDELINES:
${coordinationInstructions}

Remember:
- You are part of a swarm working on: ${this.swarmState.project}
- Other agents are working on related tasks
- Communicate findings through StackMemory shared context
- Focus on your specialization while being aware of the bigger picture
- Detect and avoid pathological behaviors (infinite loops, tunnel vision)
- Request fresh starts if you detect drift in your approach

ACCEPTANCE CRITERIA:
${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}
`;
  }

  /**
   * Start coordination monitoring loop
   */
  private startCoordinationLoop(): void {
    this.coordinationTimer = setInterval(() => {
      this.performCoordinationCycle().catch((error) => {
        logger.error('Coordination cycle failed', error as Error);
      });
    }, this.config.coordinationInterval);
  }

  /**
   * Perform coordination cycle
   */
  private async performCoordinationCycle(): Promise<void> {
    if (this.swarmState.status !== 'active') return;

    logger.debug('Performing coordination cycle');

    // 1. Detect pathological behaviors
    if (this.config.pathologicalBehaviorDetection) {
      await this.detectPathologicalBehaviors();
    }

    // 2. Check for task completion and wake planners
    if (this.config.enableDynamicPlanning) {
      await this.wakeUpPlanners();
    }

    // 3. Resolve conflicts
    await this.resolveActiveConflicts();

    // 4. Rebalance workload if needed
    await this.rebalanceWorkload();

    // 5. Trigger fresh starts if needed
    await this.triggerFreshStartsIfNeeded();

    // 6. Update swarm performance metrics
    this.updateSwarmMetrics();
  }

  /**
   * Detect pathological behaviors in agents
   */
  private async detectPathologicalBehaviors(): Promise<void> {
    for (const agent of this.activeAgents.values()) {
      if (agent.status !== 'active') continue;

      // Check for drift (repeated failures)
      if (agent.performance.driftDetected) {
        logger.warn(
          `Drift detected in agent ${agent.role}, triggering fresh start`
        );
        await this.triggerFreshStart(agent);
        continue;
      }

      // Check for tunnel vision (same approach repeated)
      if (await this.detectTunnelVision(agent)) {
        logger.warn(
          `Tunnel vision detected in agent ${agent.role}, providing alternative approach`
        );
        await this.provideAlternativeApproach(agent);
      }

      // Check for excessive runtime (running too long)
      if (await this.detectExcessiveRuntime(agent)) {
        logger.warn(
          `Excessive runtime detected in agent ${agent.role}, requesting checkpoint`
        );
        await this.requestCheckpoint(agent);
      }
    }
  }

  /**
   * Wake up planners when their tasks complete
   */
  private async wakeUpPlanners(): Promise<void> {
    for (const [agentId, wakeupCallback] of this.plannerWakeupQueue) {
      const agent = this.activeAgents.get(agentId);
      if (!agent || agent.status !== 'idle') continue;

      logger.info(`Waking up planner agent: ${agent.role}`);
      wakeupCallback();
      this.plannerWakeupQueue.delete(agentId);
    }
  }

  /**
   * Get status of a specific swarm
   */
  getSwarmStatus(swarmId: string): any {
    const registry = SwarmRegistry.getInstance();
    const swarm = registry.getSwarm(swarmId);

    if (!swarm) {
      return null;
    }

    return {
      id: swarmId,
      state: swarm.status || 'running',
      activeAgents: swarm.agents?.length || 0,
      startTime: swarm.startTime || Date.now(),
      agents: swarm.agents?.map((agent: any) => ({
        role: agent.role,
        status: agent.status || 'active',
        task: agent.task || 'Working',
      })),
    };
  }

  /**
   * Get all active swarms
   */
  getAllActiveSwarms(): any[] {
    const registry = SwarmRegistry.getInstance();
    const activeSwarms = registry.listActiveSwarms();

    return activeSwarms.map((swarm) => ({
      id: swarm.id,
      description: swarm.description,
      agentCount: swarm.agents?.length || 0,
      status: swarm.status || 'running',
      startTime: swarm.startTime || Date.now(),
    }));
  }

  /**
   * Stop a specific swarm gracefully
   */
  async stopSwarm(swarmId?: string): Promise<void> {
    const targetId = swarmId || this.swarmId;

    if (!targetId) {
      throw new Error('No swarm ID provided');
    }

    logger.info('Stopping swarm', { swarmId: targetId });

    // Stop all agents
    for (const agent of this.agents) {
      try {
        await this.stopAgent(agent);
      } catch (error: any) {
        logger.error('Failed to stop agent', {
          agent: agent.id,
          error: error.message,
        });
      }
    }

    // Cleanup git workflow if enabled
    if (this.gitWorkflowManager) {
      try {
        await this.gitWorkflowManager.cleanup();
      } catch (error: any) {
        logger.error('Git cleanup failed', { error: error.message });
      }
    }

    // Unregister from registry
    const registry = SwarmRegistry.getInstance();
    registry.unregisterSwarm(targetId);

    logger.info('Swarm stopped', { swarmId: targetId });
  }

  /**
   * Force stop a swarm without saving state
   */
  async forceStopSwarm(swarmId: string): Promise<void> {
    logger.info('Force stopping swarm', { swarmId });

    const registry = SwarmRegistry.getInstance();

    // Force unregister
    registry.unregisterSwarm(swarmId);

    // Kill all agent processes if any
    this.activeAgents.clear();

    logger.info('Swarm force stopped', { swarmId });
  }

  /**
   * Cleanup all resources
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up SwarmCoordinator resources');

    // Stop all active swarms
    const activeSwarms = this.getAllActiveSwarms();
    for (const swarm of activeSwarms) {
      try {
        await this.stopSwarm(swarm.id);
      } catch (error: any) {
        logger.error('Failed to stop swarm during cleanup', {
          swarmId: swarm.id,
          error: error.message,
        });
      }
    }

    // Clear registries
    const registry = SwarmRegistry.getInstance();
    registry.cleanup();

    // Clear agent list
    this.activeAgents.clear();

    logger.info('SwarmCoordinator cleanup completed');
  }

  /**
   * Stop an individual agent
   */
  private async stopAgent(agent: any): Promise<void> {
    logger.debug('Stopping agent', { agentId: agent.id, role: agent.role });

    // Mark agent as stopped
    agent.status = 'stopped';

    // Clean up any agent-specific resources
    if (agent.ralphBridge) {
      try {
        await agent.ralphBridge.cleanup();
      } catch (error: any) {
        logger.error('Failed to cleanup agent bridge', {
          error: error.message,
        });
      }
    }
  }

  // Helper methods for role specialization and coordination
  private defineCapabilities(role: AgentRole): string[] {
    const capabilityMap: Record<AgentRole, string[]> = {
      architect: [
        'system_design',
        'component_modeling',
        'architecture_validation',
      ],
      planner: [
        'task_decomposition',
        'dependency_analysis',
        'resource_planning',
      ],
      developer: ['code_implementation', 'debugging', 'refactoring'],
      reviewer: [
        'code_review',
        'quality_assessment',
        'best_practice_enforcement',
      ],
      tester: ['test_design', 'automation', 'validation'],
      optimizer: [
        'performance_analysis',
        'resource_optimization',
        'bottleneck_identification',
      ],
      documenter: [
        'technical_writing',
        'api_documentation',
        'example_creation',
      ],
      coordinator: [
        'task_coordination',
        'conflict_resolution',
        'progress_tracking',
      ],
    };

    return capabilityMap[role] || [];
  }

  private defineCommuncationStyle(role: AgentRole): string {
    const styleMap: Record<AgentRole, string> = {
      architect: 'high_level_design_focused',
      planner: 'structured_and_methodical',
      developer: 'implementation_focused',
      reviewer: 'quality_focused_constructive',
      tester: 'validation_focused',
      optimizer: 'performance_metrics_focused',
      documenter: 'clarity_focused',
      coordinator: 'facilitative_and_diplomatic',
    };

    return styleMap[role] || 'collaborative';
  }

  private getRoleSpecificInstructions(role: AgentRole): string {
    const instructionMap: Record<AgentRole, string> = {
      architect: `
You are a SYSTEM ARCHITECT. Your role is to:
- Design high-level system architecture
- Define component interfaces and relationships
- Ensure architectural consistency across the project
- Think in terms of scalability, maintainability, and extensibility
- Collaborate with developers to validate feasibility`,

      planner: `
You are a PROJECT PLANNER. Your role is to:
- Break down complex tasks into manageable steps
- Identify dependencies and critical path
- Coordinate with other agents on sequencing
- Wake up when tasks complete to plan next steps
- Adapt plans based on actual progress`,

      developer: `
You are a SPECIALIZED DEVELOPER. Your role is to:
- Implement features according to specifications
- Write clean, maintainable code
- Follow established patterns and conventions
- Integrate with other components
- Communicate implementation details clearly`,

      reviewer: `
You are a CODE REVIEWER. Your role is to:
- Review code for quality, correctness, and best practices
- Provide constructive feedback
- Ensure consistency with project standards
- Identify potential issues before they become problems
- Approve or request changes`,

      tester: `
You are a QA ENGINEER. Your role is to:
- Design comprehensive test strategies
- Implement automated tests
- Validate functionality and performance
- Report bugs clearly and reproducibly
- Ensure quality gates are met`,

      optimizer: `
You are a PERFORMANCE OPTIMIZER. Your role is to:
- Analyze system performance and identify bottlenecks
- Implement optimizations
- Monitor resource usage
- Establish performance benchmarks
- Ensure scalability requirements are met`,

      documenter: `
You are a TECHNICAL WRITER. Your role is to:
- Create clear, comprehensive documentation
- Write API documentation and usage examples
- Ensure documentation stays up-to-date
- Focus on user experience and clarity
- Collaborate with developers to understand features`,

      coordinator: `
You are a PROJECT COORDINATOR. Your role is to:
- Facilitate communication between agents
- Resolve conflicts and blockers
- Track overall project progress
- Ensure no tasks fall through cracks
- Maintain project timeline and quality`,
    };

    return (
      instructionMap[role] ||
      'You are a specialized agent contributing to a larger project.'
    );
  }

  // Additional helper methods would be implemented here...
  private analyzeProjectComplexity(description: string): any {
    // Analyze project description to determine decomposition strategy
    return {
      needsArchitecture:
        description.length > 500 ||
        description.includes('system') ||
        description.includes('platform'),
      needsTesting: true, // Almost all projects need testing
      needsDocumentation:
        description.includes('API') || description.includes('library'),
      complexity: 'medium',
    };
  }

  private extractCoreFeatures(description: string): any[] {
    // Extract core features from project description
    // This would use NLP in a real implementation
    return [
      {
        name: 'Core Feature',
        description: 'Main functionality implementation',
        complexity: 'medium',
        criteria: [
          'Feature works correctly',
          'Handles edge cases',
          'Follows coding standards',
        ],
      },
    ];
  }

  // Implement remaining helper methods...
  private async setupAgentEnvironment(agent: Agent): Promise<void> {
    // Create working directory for agent
    try {
      await fs.mkdir(agent.workingDirectory, { recursive: true });
      logger.debug(
        `Created working directory for agent ${agent.id}: ${agent.workingDirectory}`
      );
    } catch (error: unknown) {
      logger.warn(
        `Could not create working directory for agent ${agent.id}`,
        error as Error
      );
    }
  }

  private async configureAgentPrompts(agent: Agent): Promise<void> {
    // Configure agent with role-specific prompts
    // This would be expanded with actual prompt templates
    logger.debug(`Configured prompts for agent ${agent.role}`);
  }

  private topologicalSort(tasks: SwarmTask[]): SwarmTask[] {
    // Simple topological sort for task dependencies
    const sorted: SwarmTask[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (task: SwarmTask) => {
      if (visited.has(task.id)) return;
      if (visiting.has(task.id)) {
        logger.warn(`Circular dependency detected for task: ${task.id}`);
        return;
      }

      visiting.add(task.id);

      for (const depId of task.dependencies) {
        const depTask = tasks.find((t) => t.id === depId);
        if (depTask) visit(depTask);
      }

      visiting.delete(task.id);
      visited.add(task.id);
      sorted.push(task);
    };

    tasks.forEach(visit);
    return sorted;
  }

  private agentCanHandle(agent: Agent, role: string): boolean {
    return agent.role === role || agent.capabilities.includes(role);
  }

  private selectOptimalAgent(agents: Agent[], task: SwarmTask): Agent {
    // Select agent with lowest workload
    return agents.reduce((best, current) => {
      const bestLoad = best.currentTask ? 1 : 0;
      const currentLoad = current.currentTask ? 1 : 0;
      return currentLoad < bestLoad ? current : best;
    });
  }

  private estimateTaskDuration(task: SwarmTask): number {
    // Estimate based on complexity
    const durations: Record<string, number> = {
      low: 60000, // 1 minute
      medium: 300000, // 5 minutes
      high: 900000, // 15 minutes
    };
    return durations[task.estimatedEffort] || 300000;
  }

  private findCollaborators(
    agent: Agent,
    task: SwarmTask,
    agents: Agent[]
  ): string[] {
    // Find other agents working on related tasks
    return agents
      .filter((a) => a.id !== agent.id && a.currentTask)
      .map((a) => a.id)
      .slice(0, 2); // Limit to 2 collaborators
  }

  private findReviewers(
    agent: Agent,
    task: SwarmTask,
    agents: Agent[]
  ): string[] {
    // Find agents with reviewer role
    return agents
      .filter((a) => a.role === 'reviewer' && a.id !== agent.id)
      .map((a) => a.id);
  }

  private calculateMaxIterations(task: SwarmTask): number {
    // Calculate based on task complexity
    const iterations: Record<string, number> = {
      low: 5,
      medium: 10,
      high: 20,
    };
    return iterations[task.estimatedEffort] || 10;
  }

  private async getSwarmContext(task: SwarmTask): Promise<string> {
    // Get relevant context from other swarm members
    const relatedTasks = Array.from(this.activeAgents.values())
      .filter((a) => a.currentTask)
      .map((a) => `- Agent ${a.role} is working on task ${a.currentTask}`)
      .join('\n');

    return relatedTasks || 'No other agents currently active';
  }

  private getCoordinationInstructions(agent: Agent): string {
    return `
- Save progress to shared context regularly
- Check for updates from collaborators
- Request help if blocked for more than 2 iterations
- Report completion immediately`;
  }

  private setupAgentCoordination(
    agent: Agent,
    ralph: any,
    assignment: any
  ): void {
    // Setup coordination hooks
    logger.debug(`Setting up coordination for agent ${agent.id}`);
  }

  private updateAgentPerformance(agent: Agent, success: boolean): void {
    agent.performance.tasksCompleted++;
    if (!success) {
      agent.performance.successRate =
        (agent.performance.successRate *
          (agent.performance.tasksCompleted - 1)) /
        agent.performance.tasksCompleted;
    }
  }

  private async notifyTaskCompletion(
    agent: Agent,
    task: SwarmTask,
    success: boolean
  ): Promise<void> {
    const event: CoordinationEvent = {
      type: 'task_completion',
      agentId: agent.id,
      timestamp: Date.now(),
      data: {
        taskId: task.id,
        success,
        agent: agent.role,
      },
    };

    this.swarmState.coordination?.events.push(event);
    logger.info(
      `Task ${task.id} completed by agent ${agent.role}: ${success ? 'SUCCESS' : 'FAILED'}`
    );
  }

  private async handleTaskFailure(
    agent: Agent,
    task: SwarmTask,
    error: Error
  ): Promise<void> {
    logger.error(`Agent ${agent.role} failed task ${task.id}`, error);

    // Record conflict
    if (this.swarmState.coordination) {
      this.swarmState.coordination.conflicts.push({
        type: 'task_failure',
        agents: [agent.id],
        timestamp: Date.now(),
        description: error.message,
      });
    }
  }

  private async detectTunnelVision(agent: Agent): Promise<boolean> {
    // Check if agent is stuck in same approach
    // Simplified implementation
    return false;
  }

  private async provideAlternativeApproach(agent: Agent): Promise<void> {
    logger.info(`Providing alternative approach to agent ${agent.role}`);
  }

  private async detectExcessiveRuntime(agent: Agent): Promise<boolean> {
    // Check if agent has been running too long
    if (!agent.performance.lastFreshStart) return false;
    return Date.now() - agent.performance.lastFreshStart > 3600000; // 1 hour
  }

  private async requestCheckpoint(agent: Agent): Promise<void> {
    logger.info(`Requesting checkpoint from agent ${agent.role}`);
  }

  private async triggerFreshStart(agent: Agent): Promise<void> {
    logger.info(`Triggering fresh start for agent ${agent.role}`);
    agent.performance.lastFreshStart = Date.now();
    agent.performance.driftDetected = false;
  }

  private async resolveActiveConflicts(): Promise<void> {
    // Resolve any active conflicts
    if (this.swarmState.coordination?.conflicts.length) {
      logger.debug(
        `Resolving ${this.swarmState.coordination.conflicts.length} conflicts`
      );
    }
  }

  private async rebalanceWorkload(): Promise<void> {
    // Rebalance workload among agents
    const activeAgents = Array.from(this.activeAgents.values()).filter(
      (a) => a.status === 'active'
    );
    if (activeAgents.length > 0) {
      logger.debug(
        `Rebalancing workload among ${activeAgents.length} active agents`
      );
    }
  }

  private async triggerFreshStartsIfNeeded(): Promise<void> {
    for (const agent of this.activeAgents.values()) {
      if (agent.performance.driftDetected) {
        await this.triggerFreshStart(agent);
      }
    }
  }

  private updateSwarmMetrics(): void {
    if (!this.swarmState.performance) return;

    const activeCount = Array.from(this.activeAgents.values()).filter(
      (a) => a.status === 'active'
    ).length;

    this.swarmState.performance.throughput =
      this.swarmState.completedTaskCount /
      ((Date.now() - this.swarmState.startTime) / 1000);

    this.swarmState.performance.efficiency =
      activeCount > 0 ? this.swarmState.completedTaskCount / activeCount : 0;
  }

  /**
   * Cleanup completed swarms and their resources
   */
  async cleanupCompletedSwarms(): Promise<void> {
    if (this.swarmState.status !== 'completed') {
      return;
    }

    try {
      logger.info('Cleaning up completed swarm resources');

      // Clear coordination timer
      if (this.coordinationTimer) {
        clearInterval(this.coordinationTimer);
        this.coordinationTimer = undefined;
      }

      // Clean up agent working directories
      for (const agent of this.activeAgents.values()) {
        try {
          await fs.rmdir(agent.workingDirectory, { recursive: true });
          logger.debug(`Cleaned up working directory for agent ${agent.id}`);
        } catch (error: unknown) {
          logger.warn(
            `Could not clean up directory for agent ${agent.id}`,
            error as Error
          );
        }
      }

      // Clean up git branches
      await this.gitWorkflowManager.coordinateMerges(
        Array.from(this.activeAgents.values())
      );

      // Clear active agents
      this.activeAgents.clear();

      // Reset state
      this.swarmState = {
        id: uuidv4(),
        status: 'idle',
        startTime: Date.now(),
        activeTaskCount: 0,
        completedTaskCount: 0,
        coordination: {
          events: [],
          conflicts: [],
          resolutions: [],
        },
        performance: {
          throughput: 0,
          efficiency: 0,
          coordination_overhead: 0,
        },
      };

      logger.info('Swarm cleanup completed successfully');
    } catch (error: unknown) {
      logger.error('Failed to cleanup completed swarm', error as Error);
      throw new SwarmCoordinationError('Cleanup failed', {
        swarmId: this.swarmState.id,
        error,
      });
    }
  }

  /**
   * Force cleanup of a swarm (for emergency situations)
   */
  async forceCleanup(): Promise<void> {
    logger.warn('Force cleanup initiated');

    try {
      if (this.coordinationTimer) {
        clearInterval(this.coordinationTimer);
        this.coordinationTimer = undefined;
      }

      // Force stop all agents
      for (const agent of this.activeAgents.values()) {
        agent.status = 'stopped';
      }

      this.swarmState.status = 'stopped';
      await this.cleanupCompletedSwarms();
    } catch (error: unknown) {
      logger.error('Force cleanup failed', error as Error);
    }
  }

  /**
   * Get swarm resource usage and cleanup recommendations
   */
  getResourceUsage(): {
    activeAgents: number;
    workingDirectories: string[];
    memoryEstimate: number;
    cleanupRecommended: boolean;
    recommendations: string[];
  } {
    const workingDirs = Array.from(this.activeAgents.values()).map(
      (a) => a.workingDirectory
    );
    const memoryEstimate = this.activeAgents.size * 50; // 50MB per agent estimate
    const isStale = Date.now() - this.swarmState.startTime > 3600000; // 1 hour
    const hasCompletedTasks =
      this.swarmState.completedTaskCount > 0 &&
      this.swarmState.activeTaskCount === 0;

    const recommendations: string[] = [];
    let cleanupRecommended = false;

    if (isStale) {
      recommendations.push(
        'Swarm has been running for over 1 hour - consider cleanup'
      );
      cleanupRecommended = true;
    }

    if (hasCompletedTasks) {
      recommendations.push('All tasks completed - cleanup is recommended');
      cleanupRecommended = true;
    }

    if (this.activeAgents.size > 5) {
      recommendations.push('High agent count - monitor resource usage');
    }

    return {
      activeAgents: this.activeAgents.size,
      workingDirectories: workingDirs,
      memoryEstimate,
      cleanupRecommended,
      recommendations,
    };
  }

  [Symbol.toStringTag] = 'SwarmCoordinator';
}

// Export default instance
export const swarmCoordinator = new SwarmCoordinator();
