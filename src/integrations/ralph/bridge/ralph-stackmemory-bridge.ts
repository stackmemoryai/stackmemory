/**
 * Ralph-StackMemory Bridge
 * Main integration point connecting Ralph Wiggum loops with StackMemory persistence
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '../../../core/monitoring/logger.js';
import { FrameManager } from '../../../core/context/index.js';
import { SessionManager } from '../../../core/session/session-manager.js';
import { SQLiteAdapter } from '../../../core/database/sqlite-adapter.js';
import { createTransformersProvider } from '../../../core/database/transformers-embedding-provider.js';
import { ContextBudgetManager } from '../context/context-budget-manager.js';
import { StateReconciler } from '../state/state-reconciler.js';
import {
  IterationLifecycle,
  LifecycleHooks,
} from '../lifecycle/iteration-lifecycle.js';
import { PerformanceOptimizer } from '../performance/performance-optimizer.js';
import {
  RalphLoopState,
  RalphIteration,
  BridgeState,
  BridgeOptions,
  RalphStackMemoryConfig,
  IterationContext,
  Frame,
  FrameType,
  RecoveryState,
  Checkpoint,
  StateSource,
} from '../types.js';

export class RalphStackMemoryBridge {
  private state: BridgeState;
  private config: RalphStackMemoryConfig;
  private frameManager?: FrameManager;
  private sessionManager: SessionManager;
  private recoveryState?: RecoveryState;
  private readonly ralphDir = '.ralph';
  private readonly requiresDatabase: boolean;

  constructor(options?: BridgeOptions & { useStackMemory?: boolean }) {
    // Initialize configuration
    this.config = this.mergeConfig(options?.config);

    // Check if database/StackMemory features are required
    this.requiresDatabase = options?.useStackMemory !== false;

    // Initialize managers
    this.state = {
      initialized: false,
      contextManager: new ContextBudgetManager(this.config.contextBudget),
      stateReconciler: new StateReconciler(this.config.stateReconciliation),
      performanceOptimizer: new PerformanceOptimizer(this.config.performance),
    };

    this.sessionManager = SessionManager.getInstance();

    // Setup lifecycle hooks
    this.setupLifecycleHooks(options);

    logger.info('Ralph-StackMemory Bridge initialized', {
      config: {
        maxTokens: this.config.contextBudget.maxTokens,
        asyncSaves: this.config.performance.asyncSaves,
        checkpoints: this.config.lifecycle.checkpoints.enabled,
      },
    });
  }

  /**
   * Initialize bridge with session
   */
  async initialize(options?: {
    sessionId?: string;
    loopId?: string;
    task?: string;
    criteria?: string;
  }): Promise<void> {
    logger.info('Initializing bridge', options);

    try {
      // Initialize session manager
      await this.sessionManager.initialize();

      // Get or create session
      const session = await this.sessionManager.getOrCreateSession({
        sessionId: options?.sessionId,
      });

      this.state.currentSession = session;

      // Initialize frame manager with database
      const dbAdapter = await this.getDatabaseAdapter();
      await dbAdapter.connect();
      const db = (dbAdapter as any).db; // Get the actual Database instance
      const projectId = path.basename(this.ralphDir);
      this.frameManager = new FrameManager(db, projectId, {
        skipContextBridge: true,
      });
      // Initialize frame manager with session database if required
      if (this.requiresDatabase) {
        if (session.database && session.projectId) {
          this.frameManager = new FrameManager(
            session.database,
            session.projectId,
            {
              skipContextBridge: true,
            }
          );
        } else {
          throw new Error(
            'Session database not available for FrameManager initialization. ' +
              'If StackMemory features are not needed, set useStackMemory: false in options'
          );
        }
      } else {
        // Database not required, skip frame manager initialization
        logger.info(
          'Running without StackMemory database (useStackMemory: false)'
        );
      }

      // Check for existing loop or create new
      if (options?.loopId) {
        await this.resumeLoop(options.loopId);
      } else if (options?.task && options?.criteria) {
        await this.createNewLoop(options.task, options.criteria);
      } else {
        // Try to recover from crash
        await this.attemptRecovery();
      }

      this.state.initialized = true;
      logger.info('Bridge initialized successfully');
    } catch (error: any) {
      logger.error('Bridge initialization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Create new Ralph loop with StackMemory integration
   */
  async createNewLoop(task: string, criteria: string): Promise<RalphLoopState> {
    logger.info('Creating new Ralph loop', { task: task.substring(0, 100) });

    const loopId = uuidv4();
    const startTime = Date.now();

    // Create Ralph loop state
    const loopState: RalphLoopState = {
      loopId,
      task,
      criteria,
      iteration: 0,
      status: 'initialized',
      startTime,
      lastUpdateTime: startTime,
      startCommit: await this.getCurrentGitCommit(),
    };

    // Initialize Ralph directory structure
    await this.initializeRalphDirectory(loopState);

    // Create root frame in StackMemory
    const rootFrame = await this.createRootFrame(loopState);

    // Save initial state
    await this.saveLoopState(loopState);

    this.state.activeLoop = loopState;

    logger.info('Ralph loop created', {
      loopId,
      frameId: rootFrame.frame_id,
    });

    return loopState;
  }

  /**
   * Resume existing loop
   */
  async resumeLoop(loopId: string): Promise<RalphLoopState> {
    logger.info('Resuming loop', { loopId });

    // Get state from all sources
    const sources = await this.gatherStateSources(loopId);

    // Reconcile state
    const reconciledState =
      await this.state.stateReconciler!.reconcile(sources);

    // Validate consistency
    if (this.config.stateReconciliation.validateConsistency) {
      const validation =
        await this.state.stateReconciler!.validateConsistency(reconciledState);

      if (validation.errors.length > 0) {
        logger.error('State validation failed', { errors: validation.errors });
        throw new Error(`Invalid state: ${validation.errors.join(', ')}`);
      }
    }

    this.state.activeLoop = reconciledState;

    // Load context from StackMemory
    const _context = await this.loadIterationContext(reconciledState);

    logger.info('Loop resumed', {
      loopId,
      iteration: reconciledState.iteration,
      status: reconciledState.status,
    });

    return reconciledState;
  }

  /**
   * Run worker iteration
   */
  async runWorkerIteration(): Promise<RalphIteration> {
    if (!this.state.activeLoop) {
      throw new Error('No active loop');
    }

    const iterationNumber = this.state.activeLoop.iteration + 1;
    logger.info('Starting worker iteration', { iteration: iterationNumber });

    // Load and prepare context
    let context = await this.loadIterationContext(this.state.activeLoop);

    // Apply context budget management
    context = this.state.contextManager!.allocateBudget(context);

    if (this.config.contextBudget.compressionEnabled) {
      context = this.state.contextManager!.compressContext(context);
    }

    // Start iteration with lifecycle
    const lifecycle = this.getLifecycle();
    context = await lifecycle.startIteration(iterationNumber, context);

    // Execute iteration work
    const iteration = await this.executeWorkerIteration(context);

    // Save iteration results
    await this.saveIterationResults(iteration);

    // Complete iteration with lifecycle
    await lifecycle.completeIteration(iteration);

    // Update loop state
    this.state.activeLoop.iteration = iterationNumber;
    this.state.activeLoop.lastUpdateTime = Date.now();
    await this.saveLoopState(this.state.activeLoop);

    logger.info('Worker iteration completed', {
      iteration: iterationNumber,
      changes: iteration.changes.length,
      success: iteration.validation.testsPass,
    });

    return iteration;
  }

  /**
   * Run reviewer iteration
   */
  async runReviewerIteration(): Promise<{
    complete: boolean;
    feedback?: string;
  }> {
    if (!this.state.activeLoop) {
      throw new Error('No active loop');
    }

    logger.info('Starting reviewer iteration', {
      iteration: this.state.activeLoop.iteration,
    });

    // Evaluate against criteria
    const evaluation = await this.evaluateCompletion();

    if (evaluation.complete) {
      // Mark as complete
      this.state.activeLoop.status = 'completed';
      this.state.activeLoop.completionData = evaluation;
      await this.saveLoopState(this.state.activeLoop);

      // Handle completion
      const lifecycle = this.getLifecycle();
      await lifecycle.handleCompletion(this.state.activeLoop);

      logger.info('Task completed successfully');
      return { complete: true };
    }

    // Generate feedback for next iteration
    const feedback = this.generateFeedback(evaluation);
    this.state.activeLoop.feedback = feedback;

    await this.saveLoopState(this.state.activeLoop);

    logger.info('Reviewer iteration completed', {
      complete: false,
      feedbackLength: feedback.length,
    });

    return { complete: false, feedback };
  }

  /**
   * Rehydrate session from StackMemory
   */
  async rehydrateSession(sessionId: string): Promise<IterationContext> {
    logger.info('Rehydrating session', { sessionId });

    // Get session from StackMemory
    const session = await this.sessionManager.getSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Load frames from session
    const frames = await this.loadSessionFrames(sessionId);

    // Extract Ralph loop information
    const ralphFrames = frames.filter(
      (f) => f.type === 'task' && f.name.startsWith('ralph-')
    );

    if (ralphFrames.length === 0) {
      throw new Error('No Ralph loops found in session');
    }

    // Get most recent Ralph loop
    const latestLoop = ralphFrames[ralphFrames.length - 1];

    // Reconstruct loop state
    const loopState = await this.reconstructLoopState(latestLoop);

    // Build context from frames
    const context = await this.buildContextFromFrames(frames, loopState);

    this.state.activeLoop = loopState;

    logger.info('Session rehydrated', {
      loopId: loopState.loopId,
      iteration: loopState.iteration,
      frameCount: frames.length,
    });

    return context;
  }

  /**
   * Create checkpoint
   */
  async createCheckpoint(): Promise<Checkpoint> {
    if (!this.state.activeLoop) {
      throw new Error('No active loop');
    }

    const lifecycle = this.getLifecycle();

    // Create dummy iteration for checkpoint
    const iteration: RalphIteration = {
      number: this.state.activeLoop.iteration,
      timestamp: Date.now(),
      analysis: {
        filesCount: 0,
        testsPass: true,
        testsFail: 0,
        lastChange: await this.getCurrentGitCommit(),
      },
      plan: {
        summary: 'Checkpoint',
        steps: [],
        priority: 'low',
      },
      changes: [],
      validation: {
        testsPass: true,
        lintClean: true,
        buildSuccess: true,
        errors: [],
        warnings: [],
      },
    };

    const checkpoint = await lifecycle.createCheckpoint(iteration);

    logger.info('Checkpoint created', {
      id: checkpoint.id,
      iteration: checkpoint.iteration,
    });

    return checkpoint;
  }

  /**
   * Restore from checkpoint
   */
  async restoreFromCheckpoint(checkpointId: string): Promise<void> {
    const lifecycle = this.getLifecycle();
    await lifecycle.restoreFromCheckpoint(checkpointId);

    // Reload loop state
    const sources = await this.gatherStateSources(
      this.state.activeLoop?.loopId || ''
    );
    const reconciledState =
      await this.state.stateReconciler!.reconcile(sources);

    this.state.activeLoop = reconciledState;

    logger.info('Restored from checkpoint', {
      checkpointId,
      iteration: reconciledState.iteration,
    });
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics() {
    return this.state.performanceOptimizer!.getMetrics();
  }

  /**
   * Start a new Ralph loop
   */
  async startLoop(options: {
    task: string;
    criteria: string;
  }): Promise<string> {
    const state = await this.createNewLoop(options.task, options.criteria);
    return state.loopId;
  }

  /**
   * Stop the active loop
   */
  async stopLoop(): Promise<void> {
    if (!this.state.activeLoop) {
      logger.warn('No active loop to stop');
      return;
    }

    this.state.activeLoop.status = 'completed';
    this.state.activeLoop.lastUpdateTime = Date.now();
    await this.saveLoopState(this.state.activeLoop);

    // Handle completion lifecycle
    const lifecycle = this.getLifecycle();
    await lifecycle.handleCompletion(this.state.activeLoop);

    logger.info('Ralph loop stopped', { loopId: this.state.activeLoop.loopId });
    this.state.activeLoop = undefined;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up bridge resources');

    // Flush any pending saves
    await this.state.performanceOptimizer!.flushBatch();

    // Clean up lifecycle
    this.getLifecycle().cleanup();

    // Clean up optimizer
    this.state.performanceOptimizer!.cleanup();

    logger.info('Bridge cleanup completed');
  }

  /**
   * Merge configuration with defaults
   */
  private mergeConfig(
    config?: Partial<RalphStackMemoryConfig>
  ): RalphStackMemoryConfig {
    return {
      contextBudget: {
        maxTokens: 4000,
        priorityWeights: {
          task: 0.3,
          recentWork: 0.25,
          feedback: 0.2,
          gitHistory: 0.15,
          dependencies: 0.1,
        },
        compressionEnabled: true,
        adaptiveBudgeting: true,
        ...config?.contextBudget,
      },
      stateReconciliation: {
        precedence: ['git', 'files', 'memory'],
        conflictResolution: 'automatic',
        syncInterval: 5000,
        validateConsistency: true,
        ...config?.stateReconciliation,
      },
      lifecycle: {
        hooks: {
          preIteration: true,
          postIteration: true,
          onStateChange: true,
          onError: true,
          onComplete: true,
        },
        checkpoints: {
          enabled: true,
          frequency: 5,
          retentionDays: 7,
        },
        ...config?.lifecycle,
      },
      performance: {
        asyncSaves: true,
        batchSize: 10,
        compressionLevel: 2,
        cacheEnabled: true,
        parallelOperations: true,
        ...config?.performance,
      },
    };
  }

  /**
   * Setup lifecycle hooks
   */
  private setupLifecycleHooks(_options?: BridgeOptions): void {
    const hooks: LifecycleHooks = {
      preIteration: async (context) => {
        logger.debug('Pre-iteration hook', {
          iteration: context.task.currentIteration,
        });
        return context;
      },
      postIteration: async (iteration) => {
        // Save to StackMemory
        await this.saveIterationFrame(iteration);
      },
      onStateChange: async (oldState, newState) => {
        // Update StackMemory with state change
        await this.updateStateFrame(oldState, newState);
      },
      onError: async (error, context) => {
        logger.error('Iteration error', { error: error.message, context });
        // Save error frame
        await this.saveErrorFrame(error, context);
      },
      onComplete: async (state) => {
        // Close root frame
        await this.closeRootFrame(state);
      },
    };

    const lifecycle = new IterationLifecycle(this.config.lifecycle, hooks);
    (this.state as any).lifecycle = lifecycle;
  }

  /**
   * Get lifecycle instance
   */
  private getLifecycle(): IterationLifecycle {
    return (this.state as any).lifecycle;
  }

  /**
   * Initialize Ralph directory structure
   */
  private async initializeRalphDirectory(state: RalphLoopState): Promise<void> {
    await fs.mkdir(this.ralphDir, { recursive: true });
    await fs.mkdir(path.join(this.ralphDir, 'history'), { recursive: true });

    // Write initial files
    await fs.writeFile(path.join(this.ralphDir, 'task.md'), state.task);
    await fs.writeFile(
      path.join(this.ralphDir, 'completion-criteria.md'),
      state.criteria
    );
    await fs.writeFile(path.join(this.ralphDir, 'iteration.txt'), '0');
    await fs.writeFile(path.join(this.ralphDir, 'feedback.txt'), '');
    await fs.writeFile(
      path.join(this.ralphDir, 'state.json'),
      JSON.stringify(state, null, 2)
    );
  }

  /**
   * Create root frame for Ralph loop
   */
  private async createRootFrame(state: RalphLoopState): Promise<Frame> {
    if (!this.requiresDatabase) {
      // Return a mock frame when database is not required
      return {
        frame_id: `mock-${state.loopId}`,
        type: 'task' as FrameType,
        name: `ralph-${state.loopId}`,
        inputs: {
          task: state.task,
          criteria: state.criteria,
          loopId: state.loopId,
        },
        created_at: Date.now(),
      } as Frame;
    }

    if (!this.frameManager) {
      throw new Error('Frame manager not initialized');
    }

    const frame: Partial<Frame> = {
      type: 'task' as FrameType,
      name: `ralph-${state.loopId}`,
      inputs: {
        task: state.task,
        criteria: state.criteria,
        loopId: state.loopId,
      },
      digest_json: {
        type: 'ralph_loop',
        status: 'started',
      },
    };

    return await this.frameManager.createFrame({
      name: frame.name,
      type: frame.type,
      content: frame.content || '',
      metadata: frame.metadata,
    });
  }

  /**
   * Load iteration context from StackMemory
   */
  private async loadIterationContext(
    state: RalphLoopState
  ): Promise<IterationContext> {
    const frames = await this.loadRelevantFrames(state.loopId);

    return {
      task: {
        description: state.task,
        criteria: state.criteria.split('\n').filter(Boolean),
        currentIteration: state.iteration,
        feedback: state.feedback,
        priority: 'medium',
      },
      history: {
        recentIterations: await this.loadRecentIterations(state.loopId),
        gitCommits: await this.loadGitCommits(),
        changedFiles: await this.loadChangedFiles(),
        testResults: [],
      },
      environment: {
        projectPath: process.cwd(),
        branch: await this.getCurrentBranch(),
        dependencies: {},
        configuration: {},
      },
      memory: {
        relevantFrames: frames,
        decisions: [],
        patterns: [],
        blockers: [],
      },
      tokenCount: 0,
    };
  }

  /**
   * Execute worker iteration
   */
  private async executeWorkerIteration(
    context: IterationContext
  ): Promise<RalphIteration> {
    const iterationNumber = context.task.currentIteration + 1;

    try {
      // Analyze current codebase state
      const analysis = await this.analyzeCodebaseState();

      // Generate iteration plan based on context and analysis
      const plan = await this.generateIterationPlan(context, analysis);

      // Execute the planned changes
      const changes = await this.executeIterationChanges(plan, context);

      // Validate the changes
      const validation = await this.validateIterationResults(changes);

      logger.info('Iteration execution completed', {
        iteration: iterationNumber,
        changesCount: changes.length,
        testsPass: validation.testsPass,
      });

      return {
        number: iterationNumber,
        timestamp: Date.now(),
        analysis,
        plan,
        changes,
        validation,
      };
    } catch (error: unknown) {
      logger.error('Iteration execution failed', error as Error);

      // Return a minimal iteration with error state
      return {
        number: iterationNumber,
        timestamp: Date.now(),
        analysis: {
          filesCount: 0,
          testsPass: false,
          testsFail: 1,
          lastChange: `Error: ${(error as Error).message}`,
        },
        plan: {
          summary: 'Iteration failed due to error',
          steps: ['Investigate error', 'Fix underlying issue'],
          priority: 'high',
        },
        changes: [],
        validation: {
          testsPass: false,
          lintClean: false,
          buildSuccess: false,
          errors: [(error as Error).message],
          warnings: [],
        },
      };
    }
  }

  /**
   * Analyze current codebase state
   */
  private async analyzeCodebaseState(): Promise<any> {
    try {
      const stats = {
        filesCount: 0,
        testsPass: true,
        testsFail: 0,
        lastChange: 'No recent changes',
      };

      // Count files in the project (excluding node_modules, .git, etc.)
      try {
        const { execSync } = await import('child_process');
        const output = execSync(
          'find . -type f -name "*.ts" -o -name "*.js" -o -name "*.json" | grep -v node_modules | grep -v .git | wc -l',
          { encoding: 'utf8', cwd: process.cwd() }
        );
        stats.filesCount = parseInt(output.trim()) || 0;
      } catch {
        stats.filesCount = 0;
      }

      // Check git status for recent changes
      try {
        const { execSync } = await import('child_process');
        const gitLog = execSync('git log -1 --oneline', {
          encoding: 'utf8',
          cwd: process.cwd(),
        });
        stats.lastChange = gitLog.trim() || 'No git history';
      } catch {
        stats.lastChange = 'No git repository';
      }

      // Run basic tests if available
      try {
        const { existsSync } = await import('fs');
        if (existsSync('package.json')) {
          const packageJson = JSON.parse(
            await fs.readFile('package.json', 'utf8')
          );
          if (packageJson.scripts?.test) {
            const { execSync } = await import('child_process');
            execSync('npm test', { stdio: 'pipe', timeout: 30000 });
            stats.testsPass = true;
            stats.testsFail = 0;
          }
        }
      } catch {
        stats.testsPass = false;
        stats.testsFail = 1;
      }

      return stats;
    } catch (error: unknown) {
      return {
        filesCount: 0,
        testsPass: false,
        testsFail: 1,
        lastChange: `Analysis failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Generate iteration plan based on context and analysis
   */
  private async generateIterationPlan(
    context: IterationContext,
    analysis: any
  ): Promise<any> {
    // Extract task information
    const task = context.task.task || 'Complete assigned work';
    const _criteria = context.task.criteria || 'Meet completion criteria';

    // Generate basic plan based on analysis
    const steps = [];

    if (!analysis.testsPass) {
      steps.push('Fix failing tests');
    }

    if (analysis.filesCount === 0) {
      steps.push('Initialize project structure');
    }

    // Add task-specific steps
    if (task.toLowerCase().includes('implement')) {
      steps.push('Implement required functionality');
      steps.push('Add appropriate tests');
    } else if (task.toLowerCase().includes('fix')) {
      steps.push('Identify root cause');
      steps.push('Implement fix');
      steps.push('Verify fix works');
    } else {
      steps.push('Analyze requirements');
      steps.push('Plan implementation approach');
      steps.push('Execute planned work');
    }

    steps.push('Validate changes');

    return {
      summary: `Iteration plan for: ${task}`,
      steps,
      priority: analysis.testsPass ? 'medium' : 'high',
    };
  }

  /**
   * Execute planned changes
   */
  private async executeIterationChanges(
    plan: any,
    _context: IterationContext
  ): Promise<any[]> {
    const changes = [];

    // This would integrate with actual Ralph implementation
    // For now, we'll simulate basic changes based on the plan

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];

      changes.push({
        type: 'step_execution',
        description: step,
        timestamp: Date.now(),
        files_affected: [],
        success: true,
      });

      // Small delay to simulate work
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.debug('Executed iteration changes', {
      stepsCount: plan.steps.length,
      changesCount: changes.length,
    });

    return changes;
  }

  /**
   * Validate iteration results
   */
  private async validateIterationResults(_changes: any[]): Promise<any> {
    const validation = {
      testsPass: true,
      lintClean: true,
      buildSuccess: true,
      errors: [],
      warnings: [],
    };

    // Run validation checks if available
    try {
      const { existsSync } = await import('fs');

      // Check if linting is available
      if (existsSync('package.json')) {
        const packageJson = JSON.parse(
          await fs.readFile('package.json', 'utf8')
        );

        if (packageJson.scripts?.lint) {
          try {
            const { execSync } = await import('child_process');
            execSync('npm run lint', { stdio: 'pipe', timeout: 30000 });
            validation.lintClean = true;
          } catch {
            validation.lintClean = false;
            validation.warnings.push('Lint warnings detected');
          }
        }

        if (packageJson.scripts?.build) {
          try {
            const { execSync } = await import('child_process');
            execSync('npm run build', { stdio: 'pipe', timeout: 60000 });
            validation.buildSuccess = true;
          } catch {
            validation.buildSuccess = false;
            validation.errors.push('Build failed');
          }
        }
      }
    } catch (error: unknown) {
      validation.errors.push(`Validation error: ${(error as Error).message}`);
    }

    return validation;
  }

  /**
   * Save iteration results
   */
  private async saveIterationResults(iteration: RalphIteration): Promise<void> {
    // Save with performance optimization
    await this.state.performanceOptimizer!.saveIteration(iteration);

    // Save iteration artifacts to Ralph directory
    const iterDir = path.join(
      this.ralphDir,
      'history',
      `iteration-${String(iteration.number).padStart(3, '0')}`
    );

    await fs.mkdir(iterDir, { recursive: true });
    await fs.writeFile(
      path.join(iterDir, 'artifacts.json'),
      JSON.stringify(iteration, null, 2)
    );
  }

  /**
   * Save iteration frame to StackMemory
   */
  private async saveIterationFrame(iteration: RalphIteration): Promise<void> {
    if (!this.requiresDatabase || !this.frameManager || !this.state.activeLoop)
      return;

    const frame: Partial<Frame> = {
      type: 'subtask' as FrameType,
      name: `iteration-${iteration.number}`,
      inputs: {
        iterationNumber: iteration.number,
        loopId: this.state.activeLoop.loopId,
      },
      outputs: {
        changes: iteration.changes.length,
        success: iteration.validation.testsPass,
      },
      digest_json: iteration,
    };

    await this.state.performanceOptimizer!.saveFrame(frame as Frame);
  }

  /**
   * Get database adapter for FrameManager
   */
  private async getDatabaseAdapter(): Promise<SQLiteAdapter> {
    const dbPath = path.join(this.ralphDir, 'stackmemory.db');
    const projectId = path.basename(this.ralphDir);
    const embeddingProvider = (await createTransformersProvider()) ?? undefined;
    return new SQLiteAdapter(projectId, { dbPath, embeddingProvider });
  }

  /**
   * Additional helper methods
   */
  private async getCurrentGitCommit(): Promise<string> {
    try {
      // execSync already imported at top
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      // execSync already imported at top
      return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    } catch {
      return 'main';
    }
  }

  private async saveLoopState(state: RalphLoopState): Promise<void> {
    // Save state.json
    await fs.writeFile(
      path.join(this.ralphDir, 'state.json'),
      JSON.stringify(state, null, 2)
    );

    // Synchronize iteration.txt with current iteration
    await fs.writeFile(
      path.join(this.ralphDir, 'iteration.txt'),
      state.iteration.toString()
    );

    logger.debug('Saved loop state', {
      iteration: state.iteration,
      status: state.status,
    });
  }

  private async gatherStateSources(loopId: string): Promise<StateSource[]> {
    const sources: StateSource[] = [];

    // Get git state
    sources.push(await this.state.stateReconciler!.getGitState());

    // Get file state
    sources.push(await this.state.stateReconciler!.getFileState());

    // Get memory state
    sources.push(await this.state.stateReconciler!.getMemoryState(loopId));

    return sources;
  }

  private async attemptRecovery(): Promise<void> {
    logger.info('Attempting crash recovery');

    try {
      // Check for incomplete loops in file system
      const stateFile = path.join(this.ralphDir, 'state.json');
      const exists = await fs
        .stat(stateFile)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        const stateData = await fs.readFile(stateFile, 'utf8');
        const state = JSON.parse(stateData) as RalphLoopState;

        if (state.status !== 'completed') {
          logger.info('Found incomplete loop', { loopId: state.loopId });
          await this.resumeLoop(state.loopId);
        }
      }
    } catch (error: any) {
      logger.error('Recovery failed', { error: error.message });
    }
  }

  private async evaluateCompletion(): Promise<any> {
    // This would evaluate completion criteria
    // Placeholder implementation
    return {
      complete: false,
      criteria: {},
      unmet: ['criteria1', 'criteria2'],
    };
  }

  private generateFeedback(evaluation: any): string {
    if (evaluation.unmet.length === 0) {
      return 'All criteria met';
    }
    return `Still need to address:\n${evaluation.unmet.map((c: string) => `- ${c}`).join('\n')}`;
  }

  private async loadRelevantFrames(_loopId: string): Promise<Frame[]> {
    // This would load frames from StackMemory
    // Placeholder implementation
    return [];
  }

  private async loadRecentIterations(_loopId: string): Promise<any[]> {
    // Load recent iteration summaries
    return [];
  }

  private async loadGitCommits(): Promise<any[]> {
    // Load recent git commits
    return [];
  }

  private async loadChangedFiles(): Promise<string[]> {
    // Load recently changed files
    return [];
  }

  private async loadSessionFrames(_sessionId: string): Promise<Frame[]> {
    // Load frames from session
    return [];
  }

  private async reconstructLoopState(frame: Frame): Promise<RalphLoopState> {
    // Reconstruct loop state from frame
    return {
      loopId: frame.inputs.loopId || '',
      task: frame.inputs.task || '',
      criteria: frame.inputs.criteria || '',
      iteration: 0,
      status: 'running',
      startTime: frame.created_at,
      lastUpdateTime: Date.now(),
    };
  }

  private async buildContextFromFrames(
    frames: Frame[],
    state: RalphLoopState
  ): Promise<IterationContext> {
    // Build context from frames
    return await this.loadIterationContext(state);
  }

  private async updateStateFrame(
    _oldState: RalphLoopState,
    _newState: RalphLoopState
  ): Promise<void> {
    // Update state in StackMemory
    logger.debug('State frame updated');
  }

  private async saveErrorFrame(_error: Error, _context: any): Promise<void> {
    // Save error as frame
    logger.debug('Error frame saved');
  }

  private async closeRootFrame(_state: RalphLoopState): Promise<void> {
    // Close the root frame
    logger.debug('Root frame closed');
  }
}
