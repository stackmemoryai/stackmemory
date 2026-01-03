/**
 * Clear Survival System for StackMemory
 * Inspired by Continuous-Claude's "Clear, don't compact" philosophy
 *
 * Allows StackMemory to survive /clear operations by:
 * 1. Detecting when context is getting full (>70%)
 * 2. Saving critical state to external ledgers
 * 3. Restoring from ledgers after /clear
 * 4. Maintaining continuity across session resets
 */

import { Frame, Trace, Context, Digest } from '../types';
import { FrameManager } from '../frame/frame-manager';
import { DatabaseManager } from '../storage/database-manager';
import { HandoffGenerator } from './handoff-generator';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ContinuityLedger {
  version: '1.0.0';
  timestamp: string;
  session_id: string;
  project: string;
  branch?: string;

  // Critical state to preserve
  active_frame_stack: FrameSummary[];
  key_decisions: Decision[];
  active_tasks: Task[];
  critical_context: string[];
  recent_achievements: Achievement[];

  // Navigation aids
  current_focus: string;
  next_actions: string[];
  warnings: string[];

  // Metrics for restoration
  original_token_count: number;
  compressed_token_count: number;
  compression_ratio: number;
}

interface FrameSummary {
  id: string;
  type: string;
  description: string;
  depth: number;
  key_events: string[];
  digest?: string;
}

interface Decision {
  id: string;
  decision: string;
  rationale: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  still_applies: boolean;
}

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  context: string;
}

interface Achievement {
  description: string;
  impact: string;
  timestamp: string;
}

export class ClearSurvival {
  private frameManager: FrameManager;
  private dbManager: DatabaseManager;
  private handoffGenerator: HandoffGenerator;
  private ledgerPath: string;
  private continuityPath: string;

  // Thresholds
  private readonly CONTEXT_WARNING_THRESHOLD = 0.6; // 60%
  private readonly CONTEXT_CRITICAL_THRESHOLD = 0.7; // 70%
  private readonly CONTEXT_MAX_THRESHOLD = 0.85; // 85% - force save

  constructor(
    frameManager: FrameManager,
    dbManager: DatabaseManager,
    handoffGenerator: HandoffGenerator,
    projectRoot: string
  ) {
    this.frameManager = frameManager;
    this.dbManager = dbManager;
    this.handoffGenerator = handoffGenerator;
    this.ledgerPath = path.join(projectRoot, '.stackmemory', 'ledgers');
    this.continuityPath = path.join(projectRoot, '.stackmemory', 'continuity');
  }

  /**
   * Monitor context usage and trigger saves when needed
   */
  async monitorContextUsage(
    currentTokens: number,
    maxTokens: number
  ): Promise<'ok' | 'warning' | 'critical' | 'saved'> {
    const usage = currentTokens / maxTokens;

    if (usage < this.CONTEXT_WARNING_THRESHOLD) {
      return 'ok';
    }

    if (usage >= this.CONTEXT_MAX_THRESHOLD) {
      // Force save at 85%
      await this.saveContinuityLedger();
      return 'saved';
    }

    if (usage >= this.CONTEXT_CRITICAL_THRESHOLD) {
      // Suggest save at 70%
      console.warn(
        `⚠️ Context at ${Math.round(usage * 100)}% - Consider /clear after saving`
      );
      return 'critical';
    }

    // Warning at 60%
    console.warn(`Context at ${Math.round(usage * 100)}% - Approaching limit`);
    return 'warning';
  }

  /**
   * Save continuity ledger before /clear
   */
  async saveContinuityLedger(): Promise<ContinuityLedger> {
    const sessionId = await this.dbManager.getCurrentSessionId();
    const session = await this.dbManager.getSession(sessionId);

    // Get current state
    const frameStack = await this.getCompressedFrameStack();
    const decisions = await this.getCriticalDecisions();
    const tasks = await this.getActiveTasks();
    const context = await this.getCriticalContext();
    const achievements = await this.getRecentAchievements();

    // Calculate token counts (simplified)
    const originalTokens = await this.estimateCurrentTokens();
    const compressedTokens = this.estimateLedgerTokens(
      frameStack,
      decisions,
      tasks
    );

    const ledger: ContinuityLedger = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      project: session?.project || 'unknown',
      branch: session?.metadata?.branch,

      active_frame_stack: frameStack,
      key_decisions: decisions,
      active_tasks: tasks,
      critical_context: context,
      recent_achievements: achievements,

      current_focus: await this.getCurrentFocus(),
      next_actions: await this.suggestNextActions(tasks),
      warnings: await this.getWarnings(),

      original_token_count: originalTokens,
      compressed_token_count: compressedTokens,
      compression_ratio: originalTokens / compressedTokens,
    };

    // Save to file (overwrites previous continuity ledger)
    await this.saveLedgerToFile(ledger);

    // Also create a timestamped backup
    await this.saveBackupLedger(ledger);

    console.log(
      `✅ Continuity ledger saved (${Math.round(ledger.compression_ratio)}x compression)`
    );

    return ledger;
  }

  /**
   * Restore from continuity ledger after /clear
   */
  async restoreFromLedger(): Promise<boolean> {
    try {
      const ledger = await this.loadLatestLedger();
      if (!ledger) {
        console.log('No continuity ledger found');
        return false;
      }

      console.log(`📚 Restoring from ledger (${ledger.timestamp})`);

      // Restore frame stack structure (not full content)
      await this.restoreFrameStructure(ledger.active_frame_stack);

      // Restore key decisions as anchors
      await this.restoreDecisions(ledger.key_decisions);

      // Restore active tasks
      await this.restoreTasks(ledger.active_tasks);

      // Log restoration summary
      console.log(`✅ Restored:`);
      console.log(`  - ${ledger.active_frame_stack.length} frames`);
      console.log(`  - ${ledger.key_decisions.length} decisions`);
      console.log(`  - ${ledger.active_tasks.length} tasks`);
      console.log(`  - Current focus: ${ledger.current_focus}`);

      if (ledger.warnings.length > 0) {
        console.warn(`⚠️ Warnings:`, ledger.warnings);
      }

      return true;
    } catch (error) {
      console.error('Failed to restore from ledger:', error);
      return false;
    }
  }

  /**
   * Generate markdown summary for human review
   */
  async generateLedgerMarkdown(ledger: ContinuityLedger): Promise<string> {
    const lines: string[] = [
      `# Continuity Ledger`,
      `**Saved**: ${new Date(ledger.timestamp).toLocaleString()}`,
      `**Project**: ${ledger.project}${ledger.branch ? ` (${ledger.branch})` : ''}`,
      `**Compression**: ${Math.round(ledger.compression_ratio)}x (${ledger.original_token_count} → ${ledger.compressed_token_count} tokens)`,
      '',

      `## 🎯 Current Focus`,
      ledger.current_focus,
      '',

      `## 📚 Active Frame Stack (${ledger.active_frame_stack.length})`,
      ...ledger.active_frame_stack.map(
        (f) => `${'  '.repeat(f.depth)}└─ ${f.type}: ${f.description}`
      ),
      '',

      `## 🎯 Active Tasks (${ledger.active_tasks.filter((t) => t.status !== 'completed').length})`,
      ...ledger.active_tasks
        .filter((t) => t.status !== 'completed')
        .sort((a, b) => {
          const priority = { critical: 0, high: 1, medium: 2, low: 3 };
          return priority[a.priority] - priority[b.priority];
        })
        .map((t) => `- [${t.priority}] ${t.title} (${t.status})`),
      '',

      `## 🔑 Key Decisions`,
      ...ledger.key_decisions
        .filter((d) => d.still_applies)
        .map((d) => `- **${d.decision}**\n  ${d.rationale}`),
      '',

      `## ✅ Recent Achievements`,
      ...ledger.recent_achievements.map(
        (a) => `- ${a.description} → ${a.impact}`
      ),
      '',

      `## ➡️ Next Actions`,
      ...ledger.next_actions.map((a, i) => `${i + 1}. ${a}`),
      '',

      ledger.warnings.length > 0 ? `## ⚠️ Warnings` : '',
      ...ledger.warnings.map((w) => `- ${w}`),
    ];

    return lines.filter((l) => l !== '').join('\n');
  }

  /**
   * Check if /clear is recommended
   */
  async shouldClear(
    currentTokens: number,
    maxTokens: number
  ): Promise<{
    recommended: boolean;
    reason?: string;
    alternative?: string;
  }> {
    const usage = currentTokens / maxTokens;

    if (usage < this.CONTEXT_WARNING_THRESHOLD) {
      return { recommended: false };
    }

    // Check if we have redundant frames
    const frameStack = await this.frameManager.getStack();
    const redundantFrames = frameStack.frames.filter(
      (f) => f.status === 'closed' && !f.metadata?.critical
    ).length;

    if (usage >= this.CONTEXT_CRITICAL_THRESHOLD) {
      if (redundantFrames > 5) {
        return {
          recommended: true,
          reason: `Context at ${Math.round(usage * 100)}% with ${redundantFrames} closed frames`,
          alternative: 'Consider saving ledger and clearing',
        };
      }
    }

    return {
      recommended: false,
      alternative: `Context at ${Math.round(usage * 100)}% but manageable`,
    };
  }

  // Private helper methods

  private async getCompressedFrameStack(): Promise<FrameSummary[]> {
    const stack = await this.frameManager.getStack();

    return stack.frames.map((frame, index) => ({
      id: frame.id,
      type: frame.type,
      description: frame.description || 'Unnamed frame',
      depth: index,
      key_events: this.extractKeyEvents(frame),
      digest: frame.digest?.summary,
    }));
  }

  private extractKeyEvents(frame: Frame): string[] {
    const events: string[] = [];

    // Extract from metadata
    if (frame.metadata?.decision) {
      events.push(`Decision: ${frame.metadata.decision}`);
    }
    if (frame.metadata?.error) {
      events.push(`Error: ${frame.metadata.error}`);
    }
    if (frame.metadata?.achievement) {
      events.push(`Achievement: ${frame.metadata.achievement}`);
    }

    return events;
  }

  private async getCriticalDecisions(): Promise<Decision[]> {
    const traces = await this.dbManager.getRecentTraces(
      await this.dbManager.getCurrentSessionId(),
      100
    );

    return traces
      .filter((t) => t.type === 'decision')
      .map((t) => ({
        id: t.id,
        decision: t.content.decision || '',
        rationale: t.content.rationale || '',
        impact: this.assessImpact(t),
        still_applies: !t.metadata?.superseded,
      }))
      .filter((d) => d.impact !== 'low');
  }

  private assessImpact(trace: Trace): Decision['impact'] {
    const content = JSON.stringify(trace.content).toLowerCase();

    if (content.includes('architecture') || content.includes('critical')) {
      return 'critical';
    }
    if (content.includes('important') || content.includes('significant')) {
      return 'high';
    }
    if (content.includes('minor') || content.includes('small')) {
      return 'low';
    }

    return 'medium';
  }

  private async getActiveTasks(): Promise<Task[]> {
    const frames = await this.dbManager.getRecentFrames(
      await this.dbManager.getCurrentSessionId(),
      50
    );

    return frames
      .filter((f) => f.type === 'task')
      .map((f) => ({
        id: f.id,
        title: f.description || 'Untitled task',
        status: this.getTaskStatus(f),
        priority: this.getTaskPriority(f),
        context: f.metadata?.context || '',
      }));
  }

  private getTaskStatus(frame: Frame): Task['status'] {
    if (frame.status === 'closed' && frame.metadata?.completed) {
      return 'completed';
    }
    if (frame.metadata?.blocked) return 'blocked';
    if (frame.status === 'open') return 'in_progress';
    return 'pending';
  }

  private getTaskPriority(frame: Frame): Task['priority'] {
    const priority = frame.metadata?.priority;
    if (['critical', 'high', 'medium', 'low'].includes(priority)) {
      return priority as Task['priority'];
    }
    return 'medium';
  }

  private async getCriticalContext(): Promise<string[]> {
    const context: string[] = [];

    // Add project-specific context
    const session = await this.dbManager.getSession(
      await this.dbManager.getCurrentSessionId()
    );
    if (session?.metadata?.key_facts) {
      context.push(...session.metadata.key_facts);
    }

    // Add recent important discoveries
    const traces = await this.dbManager.getRecentTraces(
      await this.dbManager.getCurrentSessionId(),
      50
    );

    const discoveries = traces
      .filter((t) => t.metadata?.important || t.type === 'discovery')
      .map((t) => t.content.summary || t.content.description)
      .filter(Boolean)
      .slice(0, 5);

    context.push(...discoveries);

    return context;
  }

  private async getRecentAchievements(): Promise<Achievement[]> {
    const frames = await this.dbManager.getRecentFrames(
      await this.dbManager.getCurrentSessionId(),
      20
    );

    return frames
      .filter((f) => f.status === 'closed' && f.metadata?.achievement)
      .map((f) => ({
        description: f.metadata.achievement,
        impact: f.metadata.impact || 'completed task',
        timestamp: f.closedAt || f.createdAt,
      }))
      .slice(0, 5);
  }

  private async getCurrentFocus(): Promise<string> {
    const stack = await this.frameManager.getStack();
    const activeFrame = stack.frames.find((f) => f.status === 'open');

    if (!activeFrame) {
      return 'No active focus';
    }

    return `${activeFrame.type}: ${activeFrame.description || 'In progress'}`;
  }

  private async suggestNextActions(tasks: Task[]): Promise<string[]> {
    const suggestions: string[] = [];

    // Continue in-progress tasks
    const inProgress = tasks.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 0) {
      suggestions.push(`Continue: ${inProgress[0].title}`);
    }

    // Start high-priority pending tasks
    const highPriority = tasks.filter(
      (t) => t.status === 'pending' && t.priority === 'high'
    );
    if (highPriority.length > 0) {
      suggestions.push(`Start: ${highPriority[0].title}`);
    }

    // Unblock blocked tasks
    const blocked = tasks.filter((t) => t.status === 'blocked');
    if (blocked.length > 0) {
      suggestions.push(`Unblock: ${blocked[0].title}`);
    }

    return suggestions.slice(0, 3);
  }

  private async getWarnings(): Promise<string[]> {
    const warnings: string[] = [];

    const tasks = await this.getActiveTasks();
    const blocked = tasks.filter((t) => t.status === 'blocked');

    if (blocked.length > 0) {
      warnings.push(`${blocked.length} tasks blocked`);
    }

    const critical = tasks.filter(
      (t) => t.priority === 'critical' && t.status !== 'completed'
    );
    if (critical.length > 0) {
      warnings.push(`${critical.length} critical tasks pending`);
    }

    return warnings;
  }

  private async estimateCurrentTokens(): Promise<number> {
    // Simplified estimation
    const frames = await this.frameManager.getStack();
    const traces = await this.dbManager.getRecentTraces(
      await this.dbManager.getCurrentSessionId(),
      100
    );

    const frameTokens = frames.frames.length * 200; // Rough estimate
    const traceTokens = traces.length * 100; // Rough estimate

    return frameTokens + traceTokens;
  }

  private estimateLedgerTokens(
    frames: FrameSummary[],
    decisions: Decision[],
    tasks: Task[]
  ): number {
    // Rough estimation
    return frames.length * 50 + decisions.length * 30 + tasks.length * 20;
  }

  private async saveLedgerToFile(ledger: ContinuityLedger): Promise<void> {
    await fs.mkdir(this.continuityPath, { recursive: true });

    // Save as CONTINUITY_CLAUDE-latest.json (overwrites)
    const latestPath = path.join(
      this.continuityPath,
      'CONTINUITY_CLAUDE-latest.json'
    );
    await fs.writeFile(latestPath, JSON.stringify(ledger, null, 2), 'utf-8');

    // Also save markdown version
    const markdown = await this.generateLedgerMarkdown(ledger);
    const mdPath = path.join(
      this.continuityPath,
      'CONTINUITY_CLAUDE-latest.md'
    );
    await fs.writeFile(mdPath, markdown, 'utf-8');
  }

  private async saveBackupLedger(ledger: ContinuityLedger): Promise<void> {
    await fs.mkdir(this.ledgerPath, { recursive: true });

    const timestamp = ledger.timestamp.replace(/[:.]/g, '-');
    const backupPath = path.join(this.ledgerPath, `ledger-${timestamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(ledger, null, 2), 'utf-8');
  }

  private async loadLatestLedger(): Promise<ContinuityLedger | null> {
    try {
      const latestPath = path.join(
        this.continuityPath,
        'CONTINUITY_CLAUDE-latest.json'
      );
      const content = await fs.readFile(latestPath, 'utf-8');
      return JSON.parse(content) as ContinuityLedger;
    } catch (error) {
      return null;
    }
  }

  private async restoreFrameStructure(frames: FrameSummary[]): Promise<void> {
    // Create lightweight frame references (not full frames)
    for (const summary of frames) {
      await this.frameManager.push({
        type: summary.type,
        description: summary.description,
        metadata: {
          restored_from_ledger: true,
          original_id: summary.id,
          key_events: summary.key_events,
          digest: summary.digest,
        },
      });
    }
  }

  private async restoreDecisions(decisions: Decision[]): Promise<void> {
    for (const decision of decisions) {
      if (decision.still_applies) {
        await this.dbManager.addAnchor({
          type: 'decision',
          content: {
            decision: decision.decision,
            rationale: decision.rationale,
            impact: decision.impact,
          },
          metadata: {
            restored_from_ledger: true,
            original_id: decision.id,
          },
        });
      }
    }
  }

  private async restoreTasks(tasks: Task[]): Promise<void> {
    for (const task of tasks) {
      if (task.status !== 'completed') {
        await this.frameManager.push({
          type: 'task',
          description: task.title,
          metadata: {
            status: task.status,
            priority: task.priority,
            context: task.context,
            restored_from_ledger: true,
            original_id: task.id,
          },
        });
      }
    }
  }
}
