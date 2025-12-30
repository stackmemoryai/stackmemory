/**
 * Agent Task Manager - Spotify-inspired task handling for StackMemory
 *
 * Integrates Spotify's background coding agent strategies:
 * - 10-turn session limits with automatic task breakdown
 * - Strong verification loops with incremental feedback
 * - Context-aware task prioritization
 * - LLM judge for semantic validation
 */

import {
  PebblesTaskStore,
  PebblesTask,
  TaskStatus,
  TaskPriority,
} from '../../features/tasks/pebbles-task-store.js';
import { logger } from '../../core/monitoring/logger.js';
import { FrameManager } from '../../core/context/frame-manager.js';
import { TaskError, ErrorCode } from '../../core/errors/index.js';

export interface AgentTaskSession {
  id: string;
  frameId: string;
  taskId: string;
  turnCount: number;
  maxTurns: number;
  status: 'active' | 'completed' | 'failed' | 'timeout';
  startedAt: Date;
  completedAt?: Date;
  verificationResults: VerificationResult[];
  contextWindow: string[];
  feedbackLoop: FeedbackEntry[];
}

export interface VerificationResult {
  verifierId: string;
  passed: boolean;
  message: string;
  severity: 'error' | 'warning' | 'info';
  timestamp: Date;
  autoFix?: string;
}

export interface FeedbackEntry {
  turn: number;
  action: string;
  result: string;
  verificationPassed: boolean;
  contextAdjustment?: string;
}

export interface TaskBreakdown {
  parentTaskId: string;
  subtasks: SubtaskDefinition[];
  dependencies: Map<string, string[]>;
  estimatedTurns: number;
}

export interface SubtaskDefinition {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  estimatedTurns: number;
  verifiers: string[];
}

/**
 * Spotify-inspired Agent Task Manager
 */
export class AgentTaskManager {
  private taskStore: PebblesTaskStore;
  private frameManager: FrameManager;
  private activeSessions: Map<string, AgentTaskSession> = new Map();
  private sessionTimeouts: Map<string, NodeJS.Timeout> = new Map();

  // Spotify strategy constants
  private readonly MAX_TURNS_PER_SESSION = 10;
  private readonly MAX_SESSION_RETRIES = 3;
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly CONTEXT_WINDOW_SIZE = 5; // Last 5 significant events

  constructor(taskStore: PebblesTaskStore, frameManager: FrameManager) {
    this.taskStore = taskStore;
    this.frameManager = frameManager;
  }

  /**
   * Start a new agent task session with Spotify's 10-turn limit
   */
  async startTaskSession(
    taskId: string,
    frameId: string
  ): Promise<AgentTaskSession> {
    const task = this.taskStore.getTask(taskId);
    if (!task) {
      throw new TaskError(
        `Task ${taskId} not found`,
        ErrorCode.TASK_NOT_FOUND,
        { taskId }
      );
    }

    // Check if task needs breakdown (Spotify strategy)
    if (this.needsBreakdown(task)) {
      const breakdown = await this.breakdownTask(task);
      return this.startMultiTaskSession(breakdown, frameId);
    }

    const sessionId = this.generateSessionId(taskId);
    const session: AgentTaskSession = {
      id: sessionId,
      frameId,
      taskId,
      turnCount: 0,
      maxTurns: this.MAX_TURNS_PER_SESSION,
      status: 'active',
      startedAt: new Date(),
      verificationResults: [],
      contextWindow: [],
      feedbackLoop: [],
    };

    this.activeSessions.set(sessionId, session);
    this.startSessionTimeout(sessionId);

    // Update task status
    this.taskStore.updateTaskStatus(
      taskId,
      'in_progress',
      'Agent session started'
    );

    logger.info('Started agent task session', {
      sessionId,
      taskId,
      taskTitle: task.title,
      maxTurns: this.MAX_TURNS_PER_SESSION,
    });

    return session;
  }

  /**
   * Execute a turn in the session with verification
   */
  async executeTurn(
    sessionId: string,
    action: string,
    context: Record<string, any>
  ): Promise<{
    success: boolean;
    feedback: string;
    shouldContinue: boolean;
    verificationResults: VerificationResult[];
  }> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.status !== 'active') {
      throw new TaskError(
        'Invalid or inactive session',
        ErrorCode.TASK_INVALID_STATE,
        { sessionId }
      );
    }

    session.turnCount++;

    // Check turn limit (Spotify strategy)
    if (session.turnCount >= session.maxTurns) {
      return this.handleTurnLimitReached(session);
    }

    // Execute action with verification loop
    const verificationResults = await this.runVerificationLoop(
      action,
      context,
      session
    );

    // Update context window (keep last N significant events)
    this.updateContextWindow(session, action, verificationResults);

    // Generate feedback based on verification
    const feedback = this.generateFeedback(verificationResults);
    const success = verificationResults.every(
      (r) => r.passed || r.severity !== 'error'
    );

    // Record in feedback loop
    session.feedbackLoop.push({
      turn: session.turnCount,
      action,
      result: feedback,
      verificationPassed: success,
      contextAdjustment: this.suggestContextAdjustment(verificationResults),
    });

    // Determine if should continue
    const shouldContinue = success && session.turnCount < session.maxTurns;

    if (!shouldContinue && success) {
      await this.completeSession(session);
    }

    return {
      success,
      feedback,
      shouldContinue,
      verificationResults,
    };
  }

  /**
   * Run Spotify-style verification loop
   */
  private async runVerificationLoop(
    action: string,
    context: Record<string, any>,
    session: AgentTaskSession
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];

    // Get applicable verifiers based on context
    const verifiers = this.getApplicableVerifiers(context);

    for (const verifier of verifiers) {
      const result = await this.runVerifier(verifier, action, context);
      results.push(result);
      session.verificationResults.push(result);

      // Stop on critical errors (Spotify strategy)
      if (!result.passed && result.severity === 'error') {
        logger.warn('Verification failed, stopping execution', {
          verifier: result.verifierId,
          message: result.message,
        });
        break;
      }
    }

    return results;
  }

  /**
   * Get verifiers applicable to current context
   */
  private getApplicableVerifiers(context: Record<string, any>): string[] {
    const verifiers: string[] = [];

    // Add verifiers based on context (Spotify's context-aware approach)
    if (context.codeChange) {
      verifiers.push('formatter', 'linter', 'type-checker');
    }
    if (context.testsPresent) {
      verifiers.push('test-runner');
    }
    if (context.hasDocumentation) {
      verifiers.push('doc-validator');
    }
    if (context.performanceCritical) {
      verifiers.push('performance-analyzer');
    }

    // Always include semantic validator (LLM judge from Spotify)
    verifiers.push('semantic-validator');

    return verifiers;
  }

  /**
   * Run a single verifier
   */
  private async runVerifier(
    verifierId: string,
    action: string,
    context: Record<string, any>
  ): Promise<VerificationResult> {
    // This would integrate with actual verifiers
    // For now, return mock result
    const mockResults: Record<string, () => VerificationResult> = {
      formatter: () => ({
        verifierId: 'formatter',
        passed: Math.random() > 0.1,
        message: 'Code formatting check',
        severity: 'warning',
        timestamp: new Date(),
        autoFix: 'prettier --write',
      }),
      linter: () => ({
        verifierId: 'linter',
        passed: Math.random() > 0.2,
        message: 'Linting check',
        severity: 'error',
        timestamp: new Date(),
      }),
      'test-runner': () => ({
        verifierId: 'test-runner',
        passed: Math.random() > 0.3,
        message: 'Test execution',
        severity: 'error',
        timestamp: new Date(),
      }),
      'semantic-validator': () => ({
        verifierId: 'semantic-validator',
        passed: Math.random() > 0.25, // ~75% pass rate like Spotify
        message: 'Semantic validation against original requirements',
        severity: 'error',
        timestamp: new Date(),
      }),
    };

    const verifierFn =
      mockResults[verifierId] ||
      (() => ({
        verifierId,
        passed: true,
        message: 'Unknown verifier',
        severity: 'info' as const,
        timestamp: new Date(),
      }));

    return verifierFn();
  }

  /**
   * Check if task needs breakdown (Spotify strategy for complex tasks)
   */
  private needsBreakdown(task: PebblesTask): boolean {
    // Heuristics for determining if task is too complex
    const indicators = {
      hasMultipleComponents:
        (task.description?.match(/\band\b/gi)?.length || 0) > 2,
      longDescription: (task.description?.length || 0) > 500,
      highComplexityTags: task.tags.some((tag) =>
        ['refactor', 'migration', 'architecture', 'redesign'].includes(
          tag.toLowerCase()
        )
      ),
      hasManydependencies: task.depends_on.length > 3,
    };

    const complexityScore = Object.values(indicators).filter(Boolean).length;
    return complexityScore >= 2;
  }

  /**
   * Break down complex task into subtasks
   */
  private async breakdownTask(task: PebblesTask): Promise<TaskBreakdown> {
    // This would use LLM to intelligently break down the task
    // For now, return a simple breakdown
    const subtasks: SubtaskDefinition[] = [
      {
        title: `Analyze requirements for ${task.title}`,
        description: 'Understand and document requirements',
        acceptanceCriteria: [
          'Requirements documented',
          'Constraints identified',
        ],
        estimatedTurns: 2,
        verifiers: ['semantic-validator'],
      },
      {
        title: `Implement core functionality for ${task.title}`,
        description: 'Build the main implementation',
        acceptanceCriteria: ['Core logic implemented', 'Tests passing'],
        estimatedTurns: 5,
        verifiers: ['linter', 'test-runner'],
      },
      {
        title: `Verify and refine ${task.title}`,
        description: 'Final verification and improvements',
        acceptanceCriteria: ['All tests passing', 'Documentation complete'],
        estimatedTurns: 3,
        verifiers: ['formatter', 'linter', 'test-runner', 'semantic-validator'],
      },
    ];

    return {
      parentTaskId: task.id,
      subtasks,
      dependencies: new Map([
        [subtasks[1].title, [subtasks[0].title]],
        [subtasks[2].title, [subtasks[1].title]],
      ]),
      estimatedTurns: subtasks.reduce((sum, st) => sum + st.estimatedTurns, 0),
    };
  }

  /**
   * Start multi-task session for complex tasks
   */
  private async startMultiTaskSession(
    breakdown: TaskBreakdown,
    frameId: string
  ): Promise<AgentTaskSession> {
    // Create subtasks in task store
    const subtaskIds: string[] = [];

    for (const subtask of breakdown.subtasks) {
      const subtaskId = this.taskStore.createTask({
        title: subtask.title,
        description: subtask.description,
        frameId,
        parentId: breakdown.parentTaskId,
        tags: ['agent-subtask', ...subtask.verifiers],
        estimatedEffort: subtask.estimatedTurns * 5, // Rough conversion to minutes
      });
      subtaskIds.push(subtaskId);
    }

    // Add dependencies
    const titleToId = new Map(
      breakdown.subtasks.map((st, i) => [st.title, subtaskIds[i]])
    );

    for (const [title, deps] of breakdown.dependencies) {
      const taskId = titleToId.get(title);
      if (taskId) {
        for (const dep of deps) {
          const depId = titleToId.get(dep);
          if (depId) {
            this.taskStore.addDependency(taskId, depId);
          }
        }
      }
    }

    // Start session for first subtask
    return this.startTaskSession(subtaskIds[0], frameId);
  }

  /**
   * Update context window with significant events
   */
  private updateContextWindow(
    session: AgentTaskSession,
    action: string,
    verificationResults: VerificationResult[]
  ): void {
    const significantEvent = {
      turn: session.turnCount,
      action: action.substring(0, 100),
      verificationSummary: verificationResults.map((r) => ({
        verifier: r.verifierId,
        passed: r.passed,
      })),
      timestamp: new Date().toISOString(),
    };

    session.contextWindow.push(JSON.stringify(significantEvent));

    // Keep only last N events (Spotify's context window optimization)
    if (session.contextWindow.length > this.CONTEXT_WINDOW_SIZE) {
      session.contextWindow = session.contextWindow.slice(
        -this.CONTEXT_WINDOW_SIZE
      );
    }
  }

  /**
   * Generate feedback from verification results
   */
  private generateFeedback(results: VerificationResult[]): string {
    const failed = results.filter((r) => !r.passed);
    const warnings = results.filter(
      (r) => !r.passed && r.severity === 'warning'
    );
    const errors = results.filter((r) => !r.passed && r.severity === 'error');

    if (errors.length > 0) {
      const errorMessages = errors.map((e) => `- ${e.message}`).join('\n');
      return `Verification failed with ${errors.length} error(s):\n${errorMessages}`;
    }

    if (warnings.length > 0) {
      const warningMessages = warnings.map((w) => `- ${w.message}`).join('\n');
      return `Verification passed with ${warnings.length} warning(s):\n${warningMessages}`;
    }

    return 'All verifications passed successfully';
  }

  /**
   * Suggest context adjustment based on verification results
   */
  private suggestContextAdjustment(
    results: VerificationResult[]
  ): string | undefined {
    const failed = results.filter((r) => !r.passed && r.severity === 'error');

    if (failed.length === 0) {
      return undefined;
    }

    // Generate suggestions based on failure patterns
    const suggestions: string[] = [];

    if (failed.some((r) => r.verifierId === 'test-runner')) {
      suggestions.push('Focus on fixing failing tests');
    }
    if (failed.some((r) => r.verifierId === 'linter')) {
      suggestions.push('Address linting errors before proceeding');
    }
    if (failed.some((r) => r.verifierId === 'semantic-validator')) {
      suggestions.push('Review original requirements and adjust approach');
    }

    return suggestions.length > 0 ? suggestions.join('; ') : undefined;
  }

  /**
   * Handle turn limit reached
   */
  private async handleTurnLimitReached(session: AgentTaskSession): Promise<{
    success: boolean;
    feedback: string;
    shouldContinue: boolean;
    verificationResults: VerificationResult[];
  }> {
    logger.warn('Session reached turn limit', {
      sessionId: session.id,
      taskId: session.taskId,
      turnCount: session.turnCount,
    });

    // Check if task can be considered complete
    const task = this.taskStore.getTask(session.taskId);
    const isComplete = this.assessTaskCompletion(session);

    if (isComplete) {
      await this.completeSession(session);
      return {
        success: true,
        feedback: 'Task completed successfully within turn limit',
        shouldContinue: false,
        verificationResults: [],
      };
    }

    // Mark session as timeout
    session.status = 'timeout';
    this.taskStore.updateTaskStatus(
      session.taskId,
      'blocked',
      'Session timeout - manual review needed'
    );

    return {
      success: false,
      feedback: `Session reached ${this.MAX_TURNS_PER_SESSION} turn limit. Task requires manual review or retry.`,
      shouldContinue: false,
      verificationResults: [],
    };
  }

  /**
   * Assess if task is complete enough
   */
  private assessTaskCompletion(session: AgentTaskSession): boolean {
    // Check if recent verifications are passing
    const recentResults = session.verificationResults.slice(-5);
    const recentPassRate =
      recentResults.filter((r) => r.passed).length / recentResults.length;

    // Check if semantic validator passed recently (Spotify's LLM judge)
    const semanticPassed = recentResults.some(
      (r) => r.verifierId === 'semantic-validator' && r.passed
    );

    return recentPassRate >= 0.8 && semanticPassed;
  }

  /**
   * Complete a session
   */
  private async completeSession(session: AgentTaskSession): Promise<void> {
    session.status = 'completed';
    session.completedAt = new Date();

    // Update task status
    this.taskStore.updateTaskStatus(
      session.taskId,
      'completed',
      'Agent session completed'
    );

    // Clear timeout
    const timeout = this.sessionTimeouts.get(session.id);
    if (timeout) {
      clearTimeout(timeout);
      this.sessionTimeouts.delete(session.id);
    }

    // Generate and save session summary to frame
    const summary = this.generateSessionSummary(session);
    this.frameManager.addEvent('observation', {
      type: 'session_summary',
      frameId: session.frameId,
      summary,
    });

    logger.info('Session completed', {
      sessionId: session.id,
      taskId: session.taskId,
      turnCount: session.turnCount,
      duration: session.completedAt.getTime() - session.startedAt.getTime(),
    });
  }

  /**
   * Generate session summary for frame digest
   */
  private generateSessionSummary(
    session: AgentTaskSession
  ): Record<string, any> {
    const verificationStats = {
      total: session.verificationResults.length,
      passed: session.verificationResults.filter((r) => r.passed).length,
      failed: session.verificationResults.filter((r) => !r.passed).length,
    };

    return {
      sessionId: session.id,
      taskId: session.taskId,
      status: session.status,
      turnCount: session.turnCount,
      duration: session.completedAt
        ? session.completedAt.getTime() - session.startedAt.getTime()
        : 0,
      verificationStats,
      feedbackLoop: session.feedbackLoop.slice(-3), // Last 3 feedback entries
      contextWindow: session.contextWindow.slice(-2), // Last 2 context entries
    };
  }

  /**
   * Start timeout for session
   */
  private startSessionTimeout(sessionId: string): void {
    const timeout = setTimeout(() => {
      const session = this.activeSessions.get(sessionId);
      if (session && session.status === 'active') {
        session.status = 'timeout';
        this.taskStore.updateTaskStatus(
          session.taskId,
          'blocked',
          'Session timeout - no activity'
        );
        logger.warn('Session timed out due to inactivity', { sessionId });
      }
    }, this.SESSION_TIMEOUT_MS);

    this.sessionTimeouts.set(sessionId, timeout);
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(taskId: string): string {
    return `session-${taskId}-${Date.now()}`;
  }

  /**
   * Get active sessions summary
   */
  getActiveSessions(): Array<{
    sessionId: string;
    taskId: string;
    turnCount: number;
    status: string;
    startedAt: Date;
  }> {
    return Array.from(this.activeSessions.values()).map((session) => ({
      sessionId: session.id,
      taskId: session.taskId,
      turnCount: session.turnCount,
      status: session.status,
      startedAt: session.startedAt,
    }));
  }

  /**
   * Retry a failed session (Spotify's 3-retry strategy)
   */
  async retrySession(sessionId: string): Promise<AgentTaskSession | null> {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.status === 'active') {
      return null;
    }

    // Count previous retries
    const retryCount = Array.from(this.activeSessions.values()).filter(
      (s) => s.taskId === session.taskId && s.status === 'failed'
    ).length;

    if (retryCount >= this.MAX_SESSION_RETRIES) {
      logger.warn('Max retries reached for task', {
        taskId: session.taskId,
        retries: retryCount,
      });
      return null;
    }

    // Start new session with learned context
    const newSession = await this.startTaskSession(
      session.taskId,
      session.frameId
    );

    // Transfer learned context from previous session
    newSession.contextWindow = session.contextWindow.slice(-3);
    newSession.feedbackLoop = [
      {
        turn: 0,
        action: 'Session retry with learned context',
        result: `Retrying after ${retryCount} previous attempts`,
        verificationPassed: true,
        contextAdjustment: session.feedbackLoop
          .filter((f) => f.contextAdjustment)
          .map((f) => f.contextAdjustment)
          .join('; '),
      },
    ];

    return newSession;
  }
}
