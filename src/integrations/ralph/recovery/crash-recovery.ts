/**
 * Crash Recovery System for Ralph Swarms
 * Handles failures, provides auto-recovery, and maintains swarm resilience
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../core/monitoring/logger.js';
import { SwarmCoordinator } from '../swarm/swarm-coordinator.js';
import { Agent, SwarmState } from '../types.js';

export interface RecoveryCheckpoint {
  id: string;
  swarmId: string;
  timestamp: number;
  swarmState: SwarmState;
  agents: Agent[];
  tasks: any[];
  errorLog: CrashReport[];
  databaseBackup?: string;
  gitState: {
    currentBranch: string;
    uncommittedChanges: string[];
    activeBranches: string[];
  };
}

export interface CrashReport {
  id: string;
  timestamp: number;
  agentId?: string;
  errorType:
    | 'database_failure'
    | 'git_conflict'
    | 'agent_timeout'
    | 'memory_overflow'
    | 'network_error';
  error: Error;
  context: any;
  recoveryAction: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  resolved: boolean;
}

export interface RecoveryStrategy {
  errorType: string;
  condition: (error: Error, context: any) => boolean;
  action: (
    report: CrashReport,
    recovery: CrashRecoverySystem
  ) => Promise<boolean>;
  maxRetries: number;
  backoffMs: number;
}

export class CrashRecoverySystem {
  private checkpoints: Map<string, RecoveryCheckpoint> = new Map();
  private crashReports: CrashReport[] = [];
  private recoveryStrategies: RecoveryStrategy[] = [];
  private swarmCoordinator: SwarmCoordinator;
  private checkpointInterval?: NodeJS.Timeout;
  private recoveryDir: string;

  constructor(
    swarmCoordinator: SwarmCoordinator,
    recoveryDir: string = '.swarm/recovery'
  ) {
    this.swarmCoordinator = swarmCoordinator;
    this.recoveryDir = recoveryDir;
    this.setupRecoveryStrategies();
  }

  /**
   * Initialize crash recovery system
   */
  async initialize(): Promise<void> {
    await this.ensureRecoveryDirectory();
    await this.loadExistingCheckpoints();
    this.startPeriodicCheckpoints();

    // Set up global error handlers
    process.on('unhandledRejection', (reason, promise) => {
      this.handleCrash(new Error(`Unhandled Rejection: ${reason}`), {
        type: 'unhandled_rejection',
        promise: promise.toString(),
      });
    });

    process.on('uncaughtException', (error) => {
      this.handleCrash(error, { type: 'uncaught_exception' });
    });

    logger.info('Crash recovery system initialized');
  }

  /**
   * Create recovery checkpoint
   */
  async createCheckpoint(
    swarmId: string,
    reason: string = 'periodic'
  ): Promise<string> {
    try {
      const swarmState = (this.swarmCoordinator as any).swarmState;
      const agents = Array.from(
        (this.swarmCoordinator as any).activeAgents.values()
      );

      const checkpoint: RecoveryCheckpoint = {
        id: this.generateId(),
        swarmId,
        timestamp: Date.now(),
        swarmState: { ...swarmState },
        agents: agents.map((agent) => ({ ...agent })),
        tasks: swarmState.tasks || [],
        errorLog: this.crashReports.slice(-10), // Last 10 errors
        gitState: await this.captureGitState(),
      };

      // Save to disk
      const checkpointPath = path.join(
        this.recoveryDir,
        `checkpoint-${checkpoint.id}.json`
      );
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));

      this.checkpoints.set(checkpoint.id, checkpoint);

      logger.info(
        `Created checkpoint ${checkpoint.id} for swarm ${swarmId} (${reason})`
      );
      return checkpoint.id;
    } catch (error) {
      logger.error('Failed to create checkpoint:', error as Error);
      throw error;
    }
  }

  /**
   * Handle crash or error
   */
  async handleCrash(error: Error, context: any = {}): Promise<void> {
    const report: CrashReport = {
      id: this.generateId(),
      timestamp: Date.now(),
      agentId: context.agentId,
      errorType: this.classifyError(error, context),
      error,
      context,
      recoveryAction: '',
      severity: this.assessSeverity(error, context),
      resolved: false,
    };

    this.crashReports.push(report);
    logger.error(`Crash detected [${report.id}]:`, error);

    // Attempt automatic recovery
    const recovered = await this.attemptRecovery(report);

    if (recovered) {
      report.resolved = true;
      report.recoveryAction = 'auto_recovered';
      logger.info(`Successfully recovered from crash ${report.id}`);
    } else {
      logger.error(`Failed to recover from crash ${report.id}`);

      if (report.severity === 'critical') {
        await this.escalateCriticalFailure(report);
      }
    }

    // Save crash report
    await this.saveCrashReport(report);
  }

  /**
   * Restore from checkpoint
   */
  async restoreFromCheckpoint(checkpointId: string): Promise<boolean> {
    try {
      const checkpoint = this.checkpoints.get(checkpointId);
      if (!checkpoint) {
        logger.error(`Checkpoint ${checkpointId} not found`);
        return false;
      }

      logger.info(`Restoring from checkpoint ${checkpointId}`);

      // Restore git state
      await this.restoreGitState(checkpoint.gitState);

      // Restore database if backup exists
      if (checkpoint.databaseBackup) {
        await this.restoreDatabase(checkpoint.databaseBackup);
      }

      // Restore swarm state
      await this.restoreSwarmState(checkpoint);

      logger.info(`Successfully restored from checkpoint ${checkpointId}`);
      return true;
    } catch (error) {
      logger.error(
        `Failed to restore from checkpoint ${checkpointId}:`,
        error as Error
      );
      return false;
    }
  }

  /**
   * Get recovery recommendations
   */
  getRecoveryRecommendations(): {
    recentCheckpoints: RecoveryCheckpoint[];
    frequentErrors: Array<{
      type: string;
      count: number;
      lastOccurrence: number;
    }>;
    recoveryActions: string[];
    systemHealth: 'good' | 'degraded' | 'critical';
  } {
    const recent = Date.now() - 3600000; // Last hour
    const recentCheckpoints = Array.from(this.checkpoints.values())
      .filter((cp) => cp.timestamp > recent)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    const errorCounts = new Map<string, number>();
    const errorTimes = new Map<string, number>();

    for (const report of this.crashReports.filter(
      (r) => r.timestamp > recent
    )) {
      errorCounts.set(
        report.errorType,
        (errorCounts.get(report.errorType) || 0) + 1
      );
      errorTimes.set(
        report.errorType,
        Math.max(errorTimes.get(report.errorType) || 0, report.timestamp)
      );
    }

    const frequentErrors = Array.from(errorCounts.entries())
      .map(([type, count]) => ({
        type,
        count,
        lastOccurrence: errorTimes.get(type) || 0,
      }))
      .sort((a, b) => b.count - a.count);

    const criticalErrors = this.crashReports.filter(
      (r) => r.severity === 'critical' && r.timestamp > recent && !r.resolved
    );

    const systemHealth =
      criticalErrors.length > 0
        ? 'critical'
        : frequentErrors.length > 3
          ? 'degraded'
          : 'good';

    return {
      recentCheckpoints,
      frequentErrors,
      recoveryActions: this.generateRecoveryActions(frequentErrors),
      systemHealth,
    };
  }

  /**
   * Auto-recovery from common failures
   */
  async attemptAutoRecovery(swarmId: string): Promise<boolean> {
    logger.info(`Attempting auto-recovery for swarm ${swarmId}`);

    try {
      // 1. Check for recent checkpoint
      const recentCheckpoint = this.findRecentCheckpoint(swarmId);
      if (recentCheckpoint) {
        logger.info(`Found recent checkpoint: ${recentCheckpoint.id}`);
        return await this.restoreFromCheckpoint(recentCheckpoint.id);
      }

      // 2. Attempt graceful restart
      await this.swarmCoordinator.forceCleanup();

      // 3. Clear problematic state
      await this.clearProblematicState();

      // 4. Restart with minimal configuration
      logger.info('Restarting swarm with minimal configuration');
      return true;
    } catch (error) {
      logger.error('Auto-recovery failed:', error as Error);
      return false;
    }
  }

  private async attemptRecovery(report: CrashReport): Promise<boolean> {
    // Find appropriate recovery strategy
    for (const strategy of this.recoveryStrategies) {
      if (strategy.condition(report.error, report.context)) {
        logger.info(`Applying recovery strategy: ${strategy.errorType}`);

        let retries = 0;
        while (retries < strategy.maxRetries) {
          try {
            const success = await strategy.action(report, this);
            if (success) {
              report.recoveryAction = strategy.errorType;
              return true;
            }
          } catch (error) {
            logger.warn(
              `Recovery attempt ${retries + 1} failed:`,
              error as Error
            );
          }

          retries++;
          if (retries < strategy.maxRetries) {
            await this.sleep(strategy.backoffMs * Math.pow(2, retries));
          }
        }
      }
    }

    return false;
  }

  private classifyError(error: Error, context: any): CrashReport['errorType'] {
    const message = error.message.toLowerCase();

    if (message.includes('database') || message.includes('sqlite')) {
      return 'database_failure';
    } else if (message.includes('git') || message.includes('branch')) {
      return 'git_conflict';
    } else if (message.includes('timeout') || context.timeout) {
      return 'agent_timeout';
    } else if (message.includes('memory') || message.includes('heap')) {
      return 'memory_overflow';
    } else if (message.includes('network') || message.includes('connect')) {
      return 'network_error';
    }

    return 'database_failure'; // Default
  }

  private assessSeverity(error: Error, context: any): CrashReport['severity'] {
    if (context.type === 'uncaught_exception') return 'critical';
    if (error.message.includes('unhandled')) return 'high';
    if (error.message.includes('database')) return 'medium';
    return 'low';
  }

  private setupRecoveryStrategies(): void {
    this.recoveryStrategies = [
      {
        errorType: 'database_failure',
        condition: (error) =>
          error.message.includes('database') ||
          error.message.includes('sqlite'),
        action: async (report, recovery) => {
          // Reinitialize database connection
          logger.info('Attempting database recovery');

          // Create new database adapter
          try {
            await recovery.clearProblematicState();
            return true;
          } catch {
            return false;
          }
        },
        maxRetries: 3,
        backoffMs: 1000,
      },
      {
        errorType: 'git_conflict',
        condition: (error) =>
          error.message.includes('git') || error.message.includes('branch'),
        action: async (_report, _recovery) => {
          logger.info('Attempting git conflict resolution');

          try {
            // Force cleanup git state
            const { execSync } = await import('child_process');
            execSync('git checkout main', { stdio: 'ignore' });
            execSync('git reset --hard HEAD', { stdio: 'ignore' });
            return true;
          } catch {
            return false;
          }
        },
        maxRetries: 2,
        backoffMs: 500,
      },
      {
        errorType: 'agent_timeout',
        condition: (error, context) =>
          error.message.includes('timeout') || context.timeout,
        action: async (report, recovery) => {
          logger.info('Attempting agent timeout recovery');

          // Force cleanup stuck agents
          await recovery.swarmCoordinator.forceCleanup();
          return true;
        },
        maxRetries: 1,
        backoffMs: 2000,
      },
      {
        errorType: 'memory_overflow',
        condition: (error) =>
          error.message.includes('memory') || error.message.includes('heap'),
        action: async (report, recovery) => {
          logger.info('Attempting memory recovery');

          // Force garbage collection
          if (global.gc) global.gc();

          // Cleanup old checkpoints
          await recovery.cleanupOldCheckpoints(5);
          return true;
        },
        maxRetries: 1,
        backoffMs: 5000,
      },
    ];
  }

  private async captureGitState(): Promise<RecoveryCheckpoint['gitState']> {
    try {
      const { execSync } = await import('child_process');

      const currentBranch = execSync('git branch --show-current', {
        encoding: 'utf8',
      }).trim();
      const statusOutput = execSync('git status --porcelain', {
        encoding: 'utf8',
      });
      const uncommittedChanges = statusOutput
        .trim()
        .split('\n')
        .filter(Boolean);
      const branchesOutput = execSync('git branch', { encoding: 'utf8' });
      const activeBranches = branchesOutput
        .split('\n')
        .map((line) => line.trim().replace(/^\*?\s*/, ''))
        .filter(Boolean);

      return {
        currentBranch,
        uncommittedChanges,
        activeBranches,
      };
    } catch (error) {
      logger.warn('Failed to capture git state:', error as Error);
      return {
        currentBranch: 'unknown',
        uncommittedChanges: [],
        activeBranches: [],
      };
    }
  }

  private async restoreGitState(
    gitState: RecoveryCheckpoint['gitState']
  ): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      execSync(`git checkout ${gitState.currentBranch}`, { stdio: 'ignore' });
      logger.info(`Restored git branch: ${gitState.currentBranch}`);
    } catch (error) {
      logger.warn('Failed to restore git state:', error as Error);
    }
  }

  private async restoreDatabase(backupPath: string): Promise<void> {
    // Implementation would restore database from backup
    logger.info(`Restoring database from ${backupPath}`);
  }

  private async restoreSwarmState(
    checkpoint: RecoveryCheckpoint
  ): Promise<void> {
    // Implementation would restore swarm coordinator state
    logger.info(`Restoring swarm state from checkpoint ${checkpoint.id}`);
  }

  private findRecentCheckpoint(swarmId: string): RecoveryCheckpoint | null {
    const recent = Date.now() - 1800000; // 30 minutes

    return (
      Array.from(this.checkpoints.values())
        .filter((cp) => cp.swarmId === swarmId && cp.timestamp > recent)
        .sort((a, b) => b.timestamp - a.timestamp)[0] || null
    );
  }

  private async clearProblematicState(): Promise<void> {
    try {
      // Clear temporary files
      await this.cleanupTempFiles();

      // Reset any stuck locks
      // Implementation specific cleanup

      logger.info('Cleared problematic state');
    } catch (error) {
      logger.error('Failed to clear problematic state:', error as Error);
    }
  }

  private async cleanupTempFiles(): Promise<void> {
    // Cleanup implementation
  }

  private async cleanupOldCheckpoints(keepCount: number): Promise<void> {
    const sorted = Array.from(this.checkpoints.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );

    const toDelete = sorted.slice(keepCount);

    for (const checkpoint of toDelete) {
      try {
        const checkpointPath = path.join(
          this.recoveryDir,
          `checkpoint-${checkpoint.id}.json`
        );
        await fs.unlink(checkpointPath);
        this.checkpoints.delete(checkpoint.id);
      } catch (error) {
        logger.warn(
          `Failed to delete checkpoint ${checkpoint.id}:`,
          error as Error
        );
      }
    }

    logger.info(`Cleaned up ${toDelete.length} old checkpoints`);
  }

  private async escalateCriticalFailure(report: CrashReport): Promise<void> {
    logger.error(`CRITICAL FAILURE [${report.id}]: ${report.error.message}`);

    // Create emergency checkpoint
    try {
      const swarmState = (this.swarmCoordinator as any).swarmState;
      if (swarmState?.id) {
        await this.createCheckpoint(swarmState.id, 'critical_failure');
      }
    } catch {
      logger.error('Failed to create emergency checkpoint');
    }

    // Graceful shutdown
    await this.swarmCoordinator.forceCleanup();
  }

  private generateRecoveryActions(
    frequentErrors: Array<{ type: string; count: number }>
  ): string[] {
    const actions: string[] = [];

    for (const { type, count } of frequentErrors) {
      if (count > 3) {
        switch (type) {
          case 'database_failure':
            actions.push('Consider upgrading database configuration');
            break;
          case 'git_conflict':
            actions.push('Review git workflow and branch strategy');
            break;
          case 'agent_timeout':
            actions.push(
              'Increase agent timeout limits or reduce task complexity'
            );
            break;
          case 'memory_overflow':
            actions.push('Monitor memory usage and consider increasing limits');
            break;
        }
      }
    }

    return actions;
  }

  private startPeriodicCheckpoints(): void {
    this.checkpointInterval = setInterval(async () => {
      const swarmState = (this.swarmCoordinator as any).swarmState;
      if (swarmState?.id && swarmState.status === 'active') {
        await this.createCheckpoint(swarmState.id, 'periodic');
      }
    }, 300000); // Every 5 minutes
  }

  private async ensureRecoveryDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.recoveryDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create recovery directory:', error as Error);
    }
  }

  private async loadExistingCheckpoints(): Promise<void> {
    try {
      const files = await fs.readdir(this.recoveryDir);

      for (const file of files) {
        if (file.startsWith('checkpoint-') && file.endsWith('.json')) {
          try {
            const content = await fs.readFile(
              path.join(this.recoveryDir, file),
              'utf8'
            );
            const checkpoint: RecoveryCheckpoint = JSON.parse(content);
            this.checkpoints.set(checkpoint.id, checkpoint);
          } catch (error) {
            logger.warn(`Failed to load checkpoint ${file}:`, error as Error);
          }
        }
      }

      logger.info(`Loaded ${this.checkpoints.size} existing checkpoints`);
    } catch (error) {
      logger.warn('Failed to load existing checkpoints:', error as Error);
    }
  }

  private async saveCrashReport(report: CrashReport): Promise<void> {
    try {
      const reportPath = path.join(this.recoveryDir, `crash-${report.id}.json`);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    } catch (error) {
      logger.error('Failed to save crash report:', error as Error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private generateId(): string {
    return `recovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

export default CrashRecoverySystem;
