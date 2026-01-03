/**
 * Session Monitor for StackMemory
 * Automatically triggers features based on session events
 */

import { EventEmitter } from 'events';
import { ClearSurvival } from '../session/clear-survival.js';
import { HandoffGenerator } from '../session/handoff-generator.js';
import { FrameManager } from '../frame/frame-manager.js';
import { DatabaseManager } from '../storage/database-manager.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface MonitorConfig {
  // Context thresholds
  contextWarningThreshold: number; // Default 0.6 (60%)
  contextCriticalThreshold: number; // Default 0.7 (70%)
  contextAutoSaveThreshold: number; // Default 0.85 (85%)

  // Handoff triggers
  idleTimeoutMinutes: number; // Default 5 minutes
  sessionEndHandoff: boolean; // Default true

  // Monitoring intervals
  checkIntervalSeconds: number; // Default 30 seconds

  // Auto actions
  autoSaveLedger: boolean; // Default true
  autoGenerateHandoff: boolean; // Default true
  autoCompactOnThreshold: boolean; // Default false
}

export class SessionMonitor extends EventEmitter {
  private config: MonitorConfig;
  private clearSurvival: ClearSurvival;
  private handoffGenerator: HandoffGenerator;
  private frameManager: FrameManager;
  private dbManager: DatabaseManager;
  private monitorInterval?: NodeJS.Timeout;
  private lastActivityTime: Date;
  private isMonitoring: boolean = false;
  private projectRoot: string;

  // Track context state to avoid duplicate saves
  private lastContextCheck: {
    tokens: number;
    percentage: number;
    savedAt?: Date;
  } = { tokens: 0, percentage: 0 };

  constructor(
    frameManager: FrameManager,
    dbManager: DatabaseManager,
    projectRoot: string,
    config?: Partial<MonitorConfig>
  ) {
    super();

    this.frameManager = frameManager;
    this.dbManager = dbManager;
    this.projectRoot = projectRoot;
    this.lastActivityTime = new Date();

    // Initialize config with defaults
    this.config = {
      contextWarningThreshold: 0.6,
      contextCriticalThreshold: 0.7,
      contextAutoSaveThreshold: 0.85,
      idleTimeoutMinutes: 5,
      sessionEndHandoff: true,
      checkIntervalSeconds: 30,
      autoSaveLedger: true,
      autoGenerateHandoff: true,
      autoCompactOnThreshold: false,
      ...config,
    };

    // Initialize components
    this.clearSurvival = new ClearSurvival(
      frameManager,
      dbManager,
      new HandoffGenerator(frameManager, dbManager, projectRoot),
      projectRoot
    );

    this.handoffGenerator = new HandoffGenerator(
      frameManager,
      dbManager,
      projectRoot
    );
  }

  /**
   * Start monitoring session
   */
  async start(): Promise<void> {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.lastActivityTime = new Date();

    // Start monitoring loop
    this.monitorInterval = setInterval(
      () => this.checkSession(),
      this.config.checkIntervalSeconds * 1000
    );

    // Register exit handlers
    this.registerExitHandlers();

    this.emit('monitor:started');
    console.log('🔍 Session monitor started');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }

    // Generate final handoff if configured
    if (this.config.sessionEndHandoff) {
      await this.generateHandoff('session_end');
    }

    this.emit('monitor:stopped');
    console.log('🛑 Session monitor stopped');
  }

  /**
   * Main monitoring check
   */
  private async checkSession(): Promise<void> {
    try {
      // Check context usage
      await this.checkContextUsage();

      // Check for idle timeout
      await this.checkIdleTimeout();

      // Check for other triggers
      await this.checkCustomTriggers();
    } catch (error) {
      console.error('Monitor check failed:', error);
      this.emit('monitor:error', error);
    }
  }

  /**
   * Check context usage and trigger actions
   */
  private async checkContextUsage(): Promise<void> {
    const currentTokens = await this.estimateTokens();
    const maxTokens = 100000; // Claude's approximate limit
    const percentage = currentTokens / maxTokens;

    // Store for comparison
    this.lastContextCheck = {
      tokens: currentTokens,
      percentage,
      savedAt: this.lastContextCheck.savedAt,
    };

    // Emit usage update
    this.emit('context:usage', {
      tokens: currentTokens,
      maxTokens,
      percentage,
      status: this.getContextStatus(percentage),
    });

    // Check thresholds and take action
    if (percentage >= this.config.contextAutoSaveThreshold) {
      await this.handleCriticalContext();
    } else if (percentage >= this.config.contextCriticalThreshold) {
      await this.handleHighContext();
    } else if (percentage >= this.config.contextWarningThreshold) {
      this.handleWarningContext();
    }
  }

  /**
   * Handle critical context (>85%)
   */
  private async handleCriticalContext(): Promise<void> {
    // Avoid duplicate saves within 5 minutes
    if (this.lastContextCheck.savedAt) {
      const minsSinceLastSave =
        (Date.now() - this.lastContextCheck.savedAt.getTime()) / 60000;
      if (minsSinceLastSave < 5) return;
    }

    console.log('🔴 Critical context usage - auto-saving ledger');

    if (this.config.autoSaveLedger) {
      const ledger = await this.clearSurvival.saveContinuityLedger();
      this.lastContextCheck.savedAt = new Date();

      this.emit('context:ledger_saved', {
        compression: ledger.compression_ratio,
        frames: ledger.active_frame_stack.length,
        tasks: ledger.active_tasks.length,
      });

      // Suggest clear
      console.log('💡 Ledger saved. Run /clear to reset context');

      if (this.config.autoCompactOnThreshold) {
        // This would trigger actual compaction
        // For now, just emit event for external handling
        this.emit('context:suggest_clear');
      }
    }
  }

  /**
   * Handle high context (70-85%)
   */
  private async handleHighContext(): Promise<void> {
    console.log('⚠️ High context usage - consider saving ledger');

    this.emit('context:high', {
      percentage: this.lastContextCheck.percentage,
      suggestion: 'Run: stackmemory clear --save',
    });
  }

  /**
   * Handle warning context (60-70%)
   */
  private handleWarningContext(): void {
    this.emit('context:warning', {
      percentage: this.lastContextCheck.percentage,
    });
  }

  /**
   * Check for idle timeout
   */
  private async checkIdleTimeout(): Promise<void> {
    const idleMinutes = (Date.now() - this.lastActivityTime.getTime()) / 60000;

    if (idleMinutes >= this.config.idleTimeoutMinutes) {
      if (this.config.autoGenerateHandoff) {
        await this.generateHandoff('idle_timeout');
      }
    }
  }

  /**
   * Generate handoff document
   */
  private async generateHandoff(trigger: string): Promise<void> {
    try {
      const sessionId = await this.dbManager.getCurrentSessionId();
      const handoff = await this.handoffGenerator.generateHandoff(sessionId);

      this.emit('handoff:generated', {
        trigger,
        sessionDuration: handoff.session_duration_minutes,
        tasksActive: handoff.active_tasks.filter(
          (t) => t.status !== 'completed'
        ).length,
      });

      console.log(`📋 Handoff generated (trigger: ${trigger})`);
    } catch (error) {
      console.error('Failed to generate handoff:', error);
    }
  }

  /**
   * Register process exit handlers
   */
  private registerExitHandlers(): void {
    const exitHandler = async (signal: string) => {
      console.log(`\n📦 Received ${signal}, saving session state...`);

      try {
        // Save ledger if context is significant
        if (this.lastContextCheck.percentage > 0.3) {
          await this.clearSurvival.saveContinuityLedger();
          console.log('✅ Continuity ledger saved');
        }

        // Generate handoff
        if (this.config.sessionEndHandoff) {
          await this.generateHandoff('process_exit');
          console.log('✅ Handoff document generated');
        }
      } catch (error) {
        console.error('Error during exit handling:', error);
      } finally {
        process.exit(0);
      }
    };

    // Handle various exit signals
    process.once('SIGINT', () => exitHandler('SIGINT'));
    process.once('SIGTERM', () => exitHandler('SIGTERM'));
    process.once('beforeExit', () => exitHandler('beforeExit'));
  }

  /**
   * Update last activity time
   */
  updateActivity(): void {
    this.lastActivityTime = new Date();
  }

  /**
   * Check custom triggers (extensible)
   */
  private async checkCustomTriggers(): Promise<void> {
    // Load custom triggers from hooks directory
    const hooksDir = path.join(this.projectRoot, '.stackmemory', 'hooks');

    try {
      await fs.access(hooksDir);
      const hooks = await fs.readdir(hooksDir);

      for (const hook of hooks) {
        if (hook.startsWith('monitor_') && hook.endsWith('.js')) {
          try {
            const hookPath = path.join(hooksDir, hook);
            const hookModule = await import(hookPath);

            if (hookModule.check) {
              const shouldTrigger = await hookModule.check({
                contextPercentage: this.lastContextCheck.percentage,
                idleMinutes:
                  (Date.now() - this.lastActivityTime.getTime()) / 60000,
                frameCount: (await this.frameManager.getStack()).frames.length,
              });

              if (shouldTrigger && hookModule.action) {
                await hookModule.action({
                  clearSurvival: this.clearSurvival,
                  handoffGenerator: this.handoffGenerator,
                  frameManager: this.frameManager,
                });
              }
            }
          } catch (error) {
            console.error(`Hook ${hook} failed:`, error);
          }
        }
      }
    } catch {
      // No hooks directory
    }
  }

  /**
   * Estimate current token usage
   */
  private async estimateTokens(): Promise<number> {
    const sessionId = await this.dbManager.getCurrentSessionId();
    const frames = await this.dbManager.getRecentFrames(sessionId, 100);
    const traces = await this.dbManager.getRecentTraces(sessionId, 100);

    // Rough estimation
    return frames.length * 200 + traces.length * 100;
  }

  /**
   * Get context status based on percentage
   */
  private getContextStatus(percentage: number): string {
    if (percentage >= this.config.contextAutoSaveThreshold) return 'critical';
    if (percentage >= this.config.contextCriticalThreshold) return 'high';
    if (percentage >= this.config.contextWarningThreshold) return 'warning';
    return 'ok';
  }

  /**
   * Get current monitor status
   */
  getStatus(): {
    isMonitoring: boolean;
    lastActivity: Date;
    contextUsage: typeof this.lastContextCheck;
    config: MonitorConfig;
  } {
    return {
      isMonitoring: this.isMonitoring,
      lastActivity: this.lastActivityTime,
      contextUsage: this.lastContextCheck,
      config: this.config,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MonitorConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config:updated', this.config);
  }
}
