/**
 * Session Handoff Generator for StackMemory
 * Inspired by Continuous-Claude's handoff documents
 *
 * Generates structured transfer documents when sessions end
 * and loads them when new sessions begin
 */

import { Frame, Trace, Context } from '../types';
import { FrameManager } from '../frame/frame-manager';
import { DatabaseManager } from '../storage/database-manager';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface HandoffDocument {
  session_id: string;
  timestamp: string;
  project: string;
  branch?: string;

  // Current state
  active_frame_path: string[];
  active_tasks: TaskSummary[];
  pending_decisions: DecisionPoint[];
  blockers: Blocker[];

  // Recent context
  recent_files: FileEdit[];
  recent_commands: CommandExecution[];
  recent_errors: ErrorContext[];

  // Key insights
  patterns_detected: string[];
  approaches_tried: ApproachSummary[];
  successful_strategies: string[];

  // Next steps
  suggested_next_actions: string[];
  warnings: string[];

  // Metrics
  session_duration_minutes: number;
  frames_created: number;
  tool_calls_made: number;
  decisions_recorded: number;
}

interface TaskSummary {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed';
  progress_percentage: number;
  blocker?: string;
}

interface DecisionPoint {
  decision: string;
  rationale: string;
  alternatives_considered?: string[];
  timestamp: string;
}

interface Blocker {
  description: string;
  attempted_solutions: string[];
  suggested_approach?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface FileEdit {
  path: string;
  operations: ('created' | 'modified' | 'deleted')[];
  line_changes: { added: number; removed: number };
}

interface CommandExecution {
  command: string;
  success: boolean;
  output_summary?: string;
}

interface ErrorContext {
  error: string;
  context: string;
  resolved: boolean;
  resolution?: string;
}

interface ApproachSummary {
  approach: string;
  outcome: 'successful' | 'failed' | 'partial';
  learnings?: string;
}

export class HandoffGenerator {
  private frameManager: FrameManager;
  private dbManager: DatabaseManager;
  private handoffDir: string;

  constructor(
    frameManager: FrameManager,
    dbManager: DatabaseManager,
    projectRoot: string
  ) {
    this.frameManager = frameManager;
    this.dbManager = dbManager;
    this.handoffDir = path.join(projectRoot, '.stackmemory', 'handoffs');
  }

  /**
   * Generate a handoff document for the current session
   */
  async generateHandoff(sessionId: string): Promise<HandoffDocument> {
    const session = await this.dbManager.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Get active frame stack
    const activeFramePath = await this.getActiveFramePath();

    // Get recent activity
    const recentTraces = await this.dbManager.getRecentTraces(sessionId, 100);
    const recentFrames = await this.dbManager.getRecentFrames(sessionId, 20);

    // Extract key information
    const tasks = await this.extractTasks(recentFrames);
    const decisions = await this.extractDecisions(recentTraces);
    const blockers = await this.extractBlockers(recentTraces, recentFrames);
    const fileEdits = await this.extractFileEdits(recentTraces);
    const commands = await this.extractCommands(recentTraces);
    const errors = await this.extractErrors(recentTraces);
    const patterns = await this.detectPatterns(recentTraces);
    const approaches = await this.extractApproaches(recentFrames);

    // Calculate metrics
    const sessionDuration = Math.floor(
      (Date.now() - new Date(session.startedAt).getTime()) / 60000
    );

    const handoff: HandoffDocument = {
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      project: session.project,
      branch: session.metadata?.branch,

      active_frame_path: activeFramePath,
      active_tasks: tasks,
      pending_decisions: decisions.filter((d) => !d.resolved),
      blockers: blockers,

      recent_files: fileEdits.slice(0, 10),
      recent_commands: commands.slice(0, 10),
      recent_errors: errors.slice(0, 5),

      patterns_detected: patterns,
      approaches_tried: approaches,
      successful_strategies: this.extractSuccessfulStrategies(approaches),

      suggested_next_actions: await this.suggestNextActions(
        tasks,
        blockers,
        activeFramePath
      ),
      warnings: await this.generateWarnings(errors, blockers),

      session_duration_minutes: sessionDuration,
      frames_created: recentFrames.length,
      tool_calls_made: recentTraces.filter((t) => t.type === 'tool_call')
        .length,
      decisions_recorded: decisions.length,
    };

    // Save to file
    await this.saveHandoff(handoff);

    return handoff;
  }

  /**
   * Load the most recent handoff document
   */
  async loadHandoff(): Promise<HandoffDocument | null> {
    try {
      await fs.mkdir(this.handoffDir, { recursive: true });

      const files = await fs.readdir(this.handoffDir);
      const handoffFiles = files
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

      if (handoffFiles.length === 0) return null;

      const mostRecent = handoffFiles[0];
      const content = await fs.readFile(
        path.join(this.handoffDir, mostRecent),
        'utf-8'
      );

      return JSON.parse(content) as HandoffDocument;
    } catch (error) {
      console.error('Error loading handoff:', error);
      return null;
    }
  }

  /**
   * Generate a markdown summary of the handoff
   */
  async generateMarkdownSummary(handoff: HandoffDocument): Promise<string> {
    const lines: string[] = [
      `# Session Handoff`,
      `**Generated**: ${new Date(handoff.timestamp).toLocaleString()}`,
      `**Project**: ${handoff.project}`,
      handoff.branch ? `**Branch**: ${handoff.branch}` : '',
      `**Duration**: ${handoff.session_duration_minutes} minutes`,
      '',

      `## Current Context`,
      `**Active Frame Path**: ${handoff.active_frame_path.join(' → ')}`,
      '',

      `## Active Tasks (${handoff.active_tasks.length})`,
      ...handoff.active_tasks.map(
        (t) =>
          `- [${t.status}] ${t.title} (${t.progress_percentage}%)${
            t.blocker ? ` ⚠️ Blocked: ${t.blocker}` : ''
          }`
      ),
      '',

      handoff.blockers.length > 0 ? '## Blockers' : '',
      ...handoff.blockers.map(
        (b) =>
          `- **${b.severity}**: ${b.description}\n  Tried: ${b.attempted_solutions.join(
            ', '
          )}`
      ),
      '',

      handoff.pending_decisions.length > 0 ? '## Pending Decisions' : '',
      ...handoff.pending_decisions.map(
        (d) => `- **${d.decision}**\n  Rationale: ${d.rationale}`
      ),
      '',

      '## Recent Activity',
      `- Files edited: ${handoff.recent_files.length}`,
      `- Commands run: ${handoff.recent_commands.length}`,
      `- Errors encountered: ${handoff.recent_errors.length}`,
      '',

      handoff.patterns_detected.length > 0 ? '## Patterns Detected' : '',
      ...handoff.patterns_detected.map((p) => `- ${p}`),
      '',

      handoff.successful_strategies.length > 0
        ? '## Successful Strategies'
        : '',
      ...handoff.successful_strategies.map((s) => `- ${s}`),
      '',

      '## Suggested Next Actions',
      ...handoff.suggested_next_actions.map((a) => `1. ${a}`),
      '',

      handoff.warnings.length > 0 ? '## ⚠️ Warnings' : '',
      ...handoff.warnings.map((w) => `- ${w}`),
    ];

    return lines.filter((l) => l !== '').join('\n');
  }

  /**
   * Auto-detect session end and trigger handoff
   */
  async detectSessionEnd(sessionId: string): Promise<boolean> {
    const idleThreshold = 5 * 60 * 1000; // 5 minutes
    const lastActivity = await this.dbManager.getLastActivityTime(sessionId);

    if (!lastActivity) return false;

    const idleTime = Date.now() - lastActivity.getTime();
    if (idleTime > idleThreshold) {
      await this.generateHandoff(sessionId);
      return true;
    }

    return false;
  }

  // Private helper methods

  private async getActiveFramePath(): Promise<string[]> {
    const stack = await this.frameManager.getStack();
    return stack.frames.map((f) => f.description || f.type);
  }

  private async extractTasks(frames: Frame[]): Promise<TaskSummary[]> {
    return frames
      .filter((f) => f.type === 'task')
      .map((f) => ({
        id: f.id,
        title: f.description || 'Untitled task',
        status: this.getTaskStatus(f),
        progress_percentage: f.metadata?.progress || 0,
        blocker: f.metadata?.blocker,
      }));
  }

  private getTaskStatus(frame: Frame): TaskSummary['status'] {
    if (frame.status === 'closed') return 'completed';
    if (frame.metadata?.blocker) return 'blocked';
    if (frame.status === 'open') return 'in_progress';
    return 'pending';
  }

  private async extractDecisions(traces: Trace[]): Promise<DecisionPoint[]> {
    return traces
      .filter((t) => t.type === 'decision')
      .map((t) => ({
        decision: t.content.decision || '',
        rationale: t.content.rationale || '',
        alternatives_considered: t.content.alternatives,
        timestamp: t.timestamp,
        resolved: t.metadata?.resolved || false,
      }));
  }

  private async extractBlockers(
    traces: Trace[],
    frames: Frame[]
  ): Promise<Blocker[]> {
    const blockers: Blocker[] = [];

    // Extract from error traces
    const errorTraces = traces.filter(
      (t) => t.type === 'error' && !t.metadata?.resolved
    );

    for (const trace of errorTraces) {
      blockers.push({
        description: trace.content.error || 'Unknown error',
        attempted_solutions: trace.metadata?.attempts || [],
        suggested_approach: trace.metadata?.suggestion,
        severity: this.getErrorSeverity(trace),
      });
    }

    // Extract from blocked frames
    const blockedFrames = frames.filter((f) => f.metadata?.blocker);
    for (const frame of blockedFrames) {
      blockers.push({
        description: frame.metadata.blocker,
        attempted_solutions: frame.metadata.attempts || [],
        severity: 'medium',
      });
    }

    return blockers;
  }

  private getErrorSeverity(trace: Trace): Blocker['severity'] {
    const error = trace.content.error?.toLowerCase() || '';
    if (error.includes('critical') || error.includes('fatal'))
      return 'critical';
    if (error.includes('error') || error.includes('fail')) return 'high';
    if (error.includes('warning')) return 'medium';
    return 'low';
  }

  private async extractFileEdits(traces: Trace[]): Promise<FileEdit[]> {
    const fileMap = new Map<string, FileEdit>();

    const editTraces = traces.filter((t) =>
      ['edit', 'write', 'create', 'delete'].includes(t.type)
    );

    for (const trace of editTraces) {
      const path = trace.content.file_path || trace.content.path;
      if (!path) continue;

      if (!fileMap.has(path)) {
        fileMap.set(path, {
          path,
          operations: [],
          line_changes: { added: 0, removed: 0 },
        });
      }

      const file = fileMap.get(path)!;
      const op = this.getFileOperation(trace.type);
      if (!file.operations.includes(op)) {
        file.operations.push(op);
      }

      file.line_changes.added += trace.metadata?.lines_added || 0;
      file.line_changes.removed += trace.metadata?.lines_removed || 0;
    }

    return Array.from(fileMap.values());
  }

  private getFileOperation(traceType: string): FileEdit['operations'][0] {
    switch (traceType) {
      case 'create':
      case 'write':
        return 'created';
      case 'edit':
        return 'modified';
      case 'delete':
        return 'deleted';
      default:
        return 'modified';
    }
  }

  private async extractCommands(traces: Trace[]): Promise<CommandExecution[]> {
    return traces
      .filter((t) => t.type === 'bash' || t.type === 'command')
      .map((t) => ({
        command: t.content.command || '',
        success: !t.metadata?.error,
        output_summary: t.content.output?.substring(0, 100),
      }));
  }

  private async extractErrors(traces: Trace[]): Promise<ErrorContext[]> {
    return traces
      .filter((t) => t.type === 'error')
      .map((t) => ({
        error: t.content.error || '',
        context: t.content.context || '',
        resolved: t.metadata?.resolved || false,
        resolution: t.metadata?.resolution,
      }));
  }

  private async detectPatterns(traces: Trace[]): Promise<string[]> {
    const patterns: string[] = [];

    // Detect TDD pattern
    const testFirst = traces.some(
      (t) =>
        t.type === 'test' &&
        traces.some(
          (t2) => t2.type === 'implement' && t2.timestamp > t.timestamp
        )
    );
    if (testFirst) patterns.push('Test-Driven Development');

    // Detect refactoring pattern
    const refactoring =
      traces.filter(
        (t) =>
          t.content.description?.includes('refactor') ||
          t.metadata?.operation === 'refactor'
      ).length > 3;
    if (refactoring) patterns.push('Active Refactoring');

    // Detect debugging pattern
    const debugging =
      traces.filter((t) => t.type === 'error' || t.type === 'debug').length > 5;
    if (debugging) patterns.push('Deep Debugging Session');

    return patterns;
  }

  private async extractApproaches(frames: Frame[]): Promise<ApproachSummary[]> {
    return frames
      .filter((f) => f.metadata?.approach)
      .map((f) => ({
        approach: f.metadata.approach,
        outcome: this.getApproachOutcome(f),
        learnings: f.metadata.learnings,
      }));
  }

  private getApproachOutcome(frame: Frame): ApproachSummary['outcome'] {
    if (frame.status === 'closed' && frame.metadata?.success)
      return 'successful';
    if (frame.status === 'closed' && !frame.metadata?.success) return 'failed';
    return 'partial';
  }

  private extractSuccessfulStrategies(approaches: ApproachSummary[]): string[] {
    return approaches
      .filter((a) => a.outcome === 'successful')
      .map((a) => a.approach);
  }

  private async suggestNextActions(
    tasks: TaskSummary[],
    blockers: Blocker[],
    framePath: string[]
  ): Promise<string[]> {
    const suggestions: string[] = [];

    // Resume in-progress tasks
    const inProgress = tasks.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 0) {
      suggestions.push(`Resume task: ${inProgress[0].title}`);
    }

    // Address critical blockers
    const criticalBlockers = blockers.filter((b) => b.severity === 'critical');
    if (criticalBlockers.length > 0) {
      suggestions.push(
        `Resolve critical blocker: ${criticalBlockers[0].description}`
      );
    }

    // Complete nearly done tasks
    const nearlyDone = tasks.filter((t) => t.progress_percentage >= 80);
    if (nearlyDone.length > 0) {
      suggestions.push(
        `Complete task: ${nearlyDone[0].title} (${nearlyDone[0].progress_percentage}% done)`
      );
    }

    return suggestions;
  }

  private async generateWarnings(
    errors: ErrorContext[],
    blockers: Blocker[]
  ): Promise<string[]> {
    const warnings: string[] = [];

    // Unresolved errors
    const unresolved = errors.filter((e) => !e.resolved);
    if (unresolved.length > 0) {
      warnings.push(`${unresolved.length} unresolved errors`);
    }

    // Critical blockers
    const critical = blockers.filter((b) => b.severity === 'critical');
    if (critical.length > 0) {
      warnings.push(
        `${critical.length} critical blockers need immediate attention`
      );
    }

    return warnings;
  }

  private async saveHandoff(handoff: HandoffDocument): Promise<void> {
    await fs.mkdir(this.handoffDir, { recursive: true });

    const filename = `${handoff.timestamp.replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(this.handoffDir, filename);

    await fs.writeFile(filepath, JSON.stringify(handoff, null, 2), 'utf-8');

    // Also save markdown summary
    const markdown = await this.generateMarkdownSummary(handoff);
    const mdPath = filepath.replace('.json', '.md');
    await fs.writeFile(mdPath, markdown, 'utf-8');
  }
}
