/**
 * Enhanced Pre-Clear Context Preservation System
 * Comprehensive session state capture before /clear or /compact operations
 */

import { EventEmitter } from 'events';
import { ClearSurvival } from '../../core/session/clear-survival';
import { HandoffGenerator } from '../../core/session/handoff-generator';
import { FrameManager } from '../../core/frame/frame-manager';
import { DatabaseManager } from '../../core/storage/database-manager';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';

export interface PreClearContext {
  // Session metadata
  sessionId: string;
  timestamp: string;
  trigger:
    | 'manual_clear'
    | 'auto_compact'
    | 'context_overflow'
    | 'user_request';

  // Context analysis
  contextUsage: {
    estimatedTokens: number;
    maxTokens: number;
    percentage: number;
    components: {
      frames: number;
      traces: number;
      conversations: number;
      codeBlocks: number;
    };
  };

  // Active work state
  workingState: {
    currentTask: string;
    activeFiles: string[];
    recentCommands: string[];
    pendingActions: string[];
    blockers: string[];
  };

  // Conversation state
  conversationState: {
    lastUserMessage: string;
    lastAssistantMessage: string;
    conversationTopic: string;
    messageCount: number;
    recentContext: string[];
  };

  // Code context
  codeContext: {
    modifiedFiles: FileContext[];
    gitStatus: GitStatus;
    testResults?: TestResults;
    buildStatus?: BuildStatus;
    dependencies: DependencyInfo[];
  };

  // Cognitive state
  cognitiveState: {
    currentFocus: string;
    mentalModel: string[];
    assumptions: string[];
    hypotheses: string[];
    explorationPaths: string[];
  };

  // Environment snapshot
  environment: {
    workingDirectory: string;
    gitBranch: string;
    nodeVersion?: string;
    packageJson?: any;
    environmentVars: Record<string, string>;
  };
}

interface FileContext {
  path: string;
  lastModified: string;
  changeType: 'created' | 'modified' | 'deleted';
  lineChanges: { added: number; removed: number };
  purpose: string;
  relatedFiles: string[];
}

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  lastCommit: {
    hash: string;
    message: string;
    timestamp: string;
  };
}

interface TestResults {
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  coverage?: number;
  failures: string[];
}

interface BuildStatus {
  success: boolean;
  errors: string[];
  warnings: string[];
  timestamp: string;
}

interface DependencyInfo {
  name: string;
  version: string;
  type: 'dependency' | 'devDependency' | 'global';
  critical: boolean;
}

export class EnhancedPreClearHooks extends EventEmitter {
  private frameManager: FrameManager;
  private dbManager: DatabaseManager;
  private clearSurvival: ClearSurvival;
  private handoffGenerator: HandoffGenerator;
  private projectRoot: string;

  constructor(
    frameManager: FrameManager,
    dbManager: DatabaseManager,
    clearSurvival: ClearSurvival,
    handoffGenerator: HandoffGenerator,
    projectRoot: string
  ) {
    super();
    this.frameManager = frameManager;
    this.dbManager = dbManager;
    this.clearSurvival = clearSurvival;
    this.handoffGenerator = handoffGenerator;
    this.projectRoot = projectRoot;
  }

  /**
   * Comprehensive pre-clear context capture
   */
  async capturePreClearContext(
    trigger: PreClearContext['trigger']
  ): Promise<PreClearContext> {
    console.log('🔍 Capturing comprehensive session context...');

    const context: PreClearContext = {
      sessionId: await this.dbManager.getCurrentSessionId(),
      timestamp: new Date().toISOString(),
      trigger,

      contextUsage: await this.analyzeContextUsage(),
      workingState: await this.captureWorkingState(),
      conversationState: await this.captureConversationState(),
      codeContext: await this.captureCodeContext(),
      cognitiveState: await this.captureCognitiveState(),
      environment: await this.captureEnvironment(),
    };

    // Save comprehensive context
    await this.saveEnhancedContext(context);

    // Emit for other systems to react
    this.emit('context:captured', context);

    console.log('✅ Comprehensive context captured');
    return context;
  }

  /**
   * Analyze current context usage with detailed breakdown
   */
  private async analyzeContextUsage(): Promise<
    PreClearContext['contextUsage']
  > {
    const sessionId = await this.dbManager.getCurrentSessionId();
    const frames = await this.dbManager.getRecentFrames(sessionId, 1000);
    const traces = await this.dbManager.getRecentTraces(sessionId, 1000);

    // Estimate token usage by component
    const frameTokens = frames.length * 200; // Average tokens per frame
    const traceTokens = traces.length * 100; // Average tokens per trace
    const conversationTokens = await this.estimateConversationTokens();
    const codeBlockTokens = await this.estimateCodeBlockTokens();

    const estimatedTokens =
      frameTokens + traceTokens + conversationTokens + codeBlockTokens;
    const maxTokens = 100000; // Claude's limit

    return {
      estimatedTokens,
      maxTokens,
      percentage: estimatedTokens / maxTokens,
      components: {
        frames: frameTokens,
        traces: traceTokens,
        conversations: conversationTokens,
        codeBlocks: codeBlockTokens,
      },
    };
  }

  /**
   * Capture current working state
   */
  private async captureWorkingState(): Promise<
    PreClearContext['workingState']
  > {
    const activeFrame = await this.getCurrentActiveFrame();
    const recentTraces = await this.dbManager.getRecentTraces(
      await this.dbManager.getCurrentSessionId(),
      50
    );

    // Extract active files from recent operations
    const activeFiles = this.extractActiveFiles(recentTraces);

    // Get recent commands
    const recentCommands = recentTraces
      .filter((t) => t.type === 'bash' || t.type === 'command')
      .map((t) => t.content.command)
      .slice(0, 10);

    // Identify pending actions from frame metadata
    const pendingActions = this.extractPendingActions(activeFrame);

    // Identify blockers
    const blockers = this.extractBlockers(recentTraces);

    return {
      currentTask: activeFrame?.description || 'No active task',
      activeFiles,
      recentCommands,
      pendingActions,
      blockers,
    };
  }

  /**
   * Capture conversation state and recent context
   */
  private async captureConversationState(): Promise<
    PreClearContext['conversationState']
  > {
    const sessionId = await this.dbManager.getCurrentSessionId();
    const recentTraces = await this.dbManager.getRecentTraces(sessionId, 100);

    // Find last user and assistant messages
    const userMessages = recentTraces
      .filter((t) => t.type === 'user_message' || t.type === 'input')
      .slice(0, 5);

    const assistantMessages = recentTraces
      .filter((t) => t.type === 'assistant_message' || t.type === 'response')
      .slice(0, 5);

    // Extract conversation topic from recent interactions
    const conversationTopic = this.inferConversationTopic(recentTraces);

    // Build recent context summary
    const recentContext = this.buildRecentContextSummary(recentTraces);

    return {
      lastUserMessage:
        userMessages[0]?.content.message || 'No recent user message',
      lastAssistantMessage:
        assistantMessages[0]?.content.message || 'No recent assistant message',
      conversationTopic,
      messageCount: userMessages.length + assistantMessages.length,
      recentContext,
    };
  }

  /**
   * Capture comprehensive code context
   */
  private async captureCodeContext(): Promise<PreClearContext['codeContext']> {
    const gitStatus = await this.captureGitStatus();
    const modifiedFiles = await this.captureModifiedFiles();
    const testResults = await this.captureTestResults();
    const buildStatus = await this.captureBuildStatus();
    const dependencies = await this.captureDependencies();

    return {
      modifiedFiles,
      gitStatus,
      testResults,
      buildStatus,
      dependencies,
    };
  }

  /**
   * Capture cognitive state and mental model
   */
  private async captureCognitiveState(): Promise<
    PreClearContext['cognitiveState']
  > {
    const sessionId = await this.dbManager.getCurrentSessionId();
    const recentTraces = await this.dbManager.getRecentTraces(sessionId, 100);

    // Extract cognitive elements from traces and frames
    const currentFocus = await this.extractCurrentFocus();
    const mentalModel = this.extractMentalModel(recentTraces);
    const assumptions = this.extractAssumptions(recentTraces);
    const hypotheses = this.extractHypotheses(recentTraces);
    const explorationPaths = this.extractExplorationPaths(recentTraces);

    return {
      currentFocus,
      mentalModel,
      assumptions,
      hypotheses,
      explorationPaths,
    };
  }

  /**
   * Capture environment snapshot
   */
  private async captureEnvironment(): Promise<PreClearContext['environment']> {
    const gitBranch = await this.getCurrentGitBranch();
    const packageJson = await this.getPackageJson();
    const environmentVars = this.getRelevantEnvVars();

    return {
      workingDirectory: this.projectRoot,
      gitBranch,
      nodeVersion: process.version,
      packageJson,
      environmentVars,
    };
  }

  /**
   * Save enhanced context to multiple locations for reliability
   */
  private async saveEnhancedContext(context: PreClearContext): Promise<void> {
    const timestamp = context.timestamp.replace(/[:.]/g, '-');

    // Save to primary location
    const primaryPath = path.join(
      this.projectRoot,
      '.stackmemory',
      'pre-clear',
      `context-${timestamp}.json`
    );

    // Save to backup location
    const backupPath = path.join(
      this.projectRoot,
      '.stackmemory',
      'pre-clear',
      'latest-context.json'
    );

    // Create markdown summary
    const markdownPath = path.join(
      this.projectRoot,
      '.stackmemory',
      'pre-clear',
      `context-${timestamp}.md`
    );

    await fs.mkdir(path.dirname(primaryPath), { recursive: true });

    // Save JSON
    await fs.writeFile(primaryPath, JSON.stringify(context, null, 2), 'utf-8');
    await fs.writeFile(backupPath, JSON.stringify(context, null, 2), 'utf-8');

    // Save markdown summary
    const markdown = this.generateMarkdownSummary(context);
    await fs.writeFile(markdownPath, markdown, 'utf-8');

    console.log(
      `📁 Context saved to ${path.relative(this.projectRoot, primaryPath)}`
    );
  }

  /**
   * Generate human-readable markdown summary
   */
  private generateMarkdownSummary(context: PreClearContext): string {
    const lines = [
      `# Pre-Clear Context Snapshot`,
      `**Timestamp**: ${new Date(context.timestamp).toLocaleString()}`,
      `**Trigger**: ${context.trigger}`,
      `**Session ID**: ${context.sessionId}`,
      '',

      `## 📊 Context Usage`,
      `- **Total Tokens**: ${context.contextUsage.estimatedTokens.toLocaleString()} / ${context.contextUsage.maxTokens.toLocaleString()} (${Math.round(context.contextUsage.percentage * 100)}%)`,
      `- **Frames**: ${context.contextUsage.components.frames} tokens`,
      `- **Traces**: ${context.contextUsage.components.traces} tokens`,
      `- **Conversations**: ${context.contextUsage.components.conversations} tokens`,
      `- **Code Blocks**: ${context.contextUsage.components.codeBlocks} tokens`,
      '',

      `## 🎯 Current Work State`,
      `**Task**: ${context.workingState.currentTask}`,
      `**Active Files** (${context.workingState.activeFiles.length}):`,
      ...context.workingState.activeFiles.slice(0, 10).map((f) => `- ${f}`),
      '',
      `**Recent Commands**:`,
      ...context.workingState.recentCommands
        .slice(0, 5)
        .map((c) => `- \`${c}\``),
      '',

      `## 💬 Conversation State`,
      `**Topic**: ${context.conversationState.conversationTopic}`,
      `**Messages**: ${context.conversationState.messageCount}`,
      `**Last User**: ${context.conversationState.lastUserMessage.substring(0, 100)}...`,
      '',

      `## 📝 Code Context`,
      `**Git Branch**: ${context.codeContext.gitStatus.branch}`,
      `**Modified Files**: ${context.codeContext.modifiedFiles.length}`,
      `**Staged**: ${context.codeContext.gitStatus.staged.length}`,
      `**Unstaged**: ${context.codeContext.gitStatus.unstaged.length}`,
      '',

      `## 🧠 Cognitive State`,
      `**Current Focus**: ${context.cognitiveState.currentFocus}`,
      `**Mental Model**:`,
      ...context.cognitiveState.mentalModel.slice(0, 5).map((m) => `- ${m}`),
      '',

      `## 🌍 Environment`,
      `**Directory**: ${context.environment.workingDirectory}`,
      `**Node Version**: ${context.environment.nodeVersion}`,
      `**Git Branch**: ${context.environment.gitBranch}`,
      '',
    ];

    return lines.filter((l) => l !== undefined).join('\n');
  }

  // Helper methods (simplified implementations)

  private async estimateConversationTokens(): Promise<number> {
    // Simplified - would analyze recent conversation history
    return 15000;
  }

  private async estimateCodeBlockTokens(): Promise<number> {
    // Simplified - would analyze code blocks in context
    return 8000;
  }

  private async getCurrentActiveFrame(): Promise<any> {
    const stack = await this.frameManager.getStack();
    return stack.frames.find((f) => f.status === 'open');
  }

  private extractActiveFiles(traces: any[]): string[] {
    const files = new Set<string>();
    traces.forEach((trace) => {
      if (trace.content?.file_path) files.add(trace.content.file_path);
      if (trace.content?.path) files.add(trace.content.path);
    });
    return Array.from(files).slice(0, 20);
  }

  private extractPendingActions(frame: any): string[] {
    if (!frame?.metadata?.pendingActions) return [];
    return frame.metadata.pendingActions;
  }

  private extractBlockers(traces: any[]): string[] {
    return traces
      .filter((t) => t.type === 'error' && !t.metadata?.resolved)
      .map((t) => t.content.error || 'Unknown error')
      .slice(0, 5);
  }

  private inferConversationTopic(traces: any[]): string {
    // Simplified - would use NLP to infer topic
    return 'Code implementation and debugging';
  }

  private buildRecentContextSummary(traces: any[]): string[] {
    return traces
      .slice(0, 10)
      .map(
        (t) =>
          `${t.type}: ${t.content.summary || t.content.description || 'No description'}`
      )
      .filter((s) => s.length > 10);
  }

  private async captureGitStatus(): Promise<GitStatus> {
    try {
      const branch = execSync('git branch --show-current', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      }).trim();
      const staged = execSync('git diff --cached --name-only', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      })
        .trim()
        .split('\n')
        .filter(Boolean);
      const unstaged = execSync('git diff --name-only', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      })
        .trim()
        .split('\n')
        .filter(Boolean);
      const untracked = execSync('git ls-files --others --exclude-standard', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      })
        .trim()
        .split('\n')
        .filter(Boolean);

      return {
        branch,
        ahead: 0, // Would implement git status parsing
        behind: 0,
        staged,
        unstaged,
        untracked,
        lastCommit: {
          hash: 'abc123', // Would get from git log
          message: 'Recent commit',
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        branch: 'unknown',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        lastCommit: { hash: '', message: '', timestamp: '' },
      };
    }
  }

  private async captureModifiedFiles(): Promise<FileContext[]> {
    try {
      const output = execSync('git diff --name-status', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      });
      return output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [status, path] = line.split('\t');
          return {
            path,
            lastModified: new Date().toISOString(),
            changeType:
              status === 'A'
                ? 'created'
                : status === 'D'
                  ? 'deleted'
                  : 'modified',
            lineChanges: { added: 0, removed: 0 }, // Would get from git diff --stat
            purpose: 'Code changes',
            relatedFiles: [],
          };
        });
    } catch (error) {
      return [];
    }
  }

  private async captureTestResults(): Promise<TestResults | undefined> {
    // Would implement test result parsing
    return undefined;
  }

  private async captureBuildStatus(): Promise<BuildStatus | undefined> {
    // Would implement build status checking
    return undefined;
  }

  private async captureDependencies(): Promise<DependencyInfo[]> {
    try {
      const packageJsonPath = path.join(this.projectRoot, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);

      const deps: DependencyInfo[] = [];

      Object.entries(packageJson.dependencies || {}).forEach(
        ([name, version]) => {
          deps.push({
            name,
            version: version as string,
            type: 'dependency',
            critical: ['react', 'express', 'next'].includes(name),
          });
        }
      );

      return deps;
    } catch (error) {
      return [];
    }
  }

  private async extractCurrentFocus(): Promise<string> {
    const activeFrame = await this.getCurrentActiveFrame();
    return activeFrame?.description || 'No current focus';
  }

  private extractMentalModel(traces: any[]): string[] {
    // Would extract mental model concepts from traces
    return [
      'Component architecture',
      'Data flow patterns',
      'Error handling strategy',
    ];
  }

  private extractAssumptions(traces: any[]): string[] {
    // Would extract assumptions from traces
    return [
      'User input is validated',
      'Database is available',
      'Network is stable',
    ];
  }

  private extractHypotheses(traces: any[]): string[] {
    // Would extract hypotheses being tested
    return [
      'Bug is in validation logic',
      'Performance issue is database-related',
    ];
  }

  private extractExplorationPaths(traces: any[]): string[] {
    // Would extract different approaches being explored
    return [
      'Try different algorithm',
      'Refactor data structure',
      'Add caching layer',
    ];
  }

  private async getCurrentGitBranch(): Promise<string> {
    try {
      return execSync('git branch --show-current', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      }).trim();
    } catch (error) {
      return 'unknown';
    }
  }

  private async getPackageJson(): Promise<any> {
    try {
      const content = await fs.readFile(
        path.join(this.projectRoot, 'package.json'),
        'utf-8'
      );
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  private getRelevantEnvVars(): Record<string, string> {
    const relevantVars = ['NODE_ENV', 'DEBUG', 'PORT', 'DATABASE_URL'];
    const result: Record<string, string> = {};

    relevantVars.forEach((varName) => {
      if (process.env[varName]) {
        result[varName] = process.env[varName]!;
      }
    });

    return result;
  }

  /**
   * Restore context after /clear
   */
  async restoreFromEnhancedContext(): Promise<boolean> {
    const latestPath = path.join(
      this.projectRoot,
      '.stackmemory',
      'pre-clear',
      'latest-context.json'
    );

    try {
      const content = await fs.readFile(latestPath, 'utf-8');
      const context: PreClearContext = JSON.parse(content);

      console.log('📚 Restoring enhanced context...');
      console.log(`  Session: ${context.sessionId}`);
      console.log(`  Task: ${context.workingState.currentTask}`);
      console.log(`  Files: ${context.workingState.activeFiles.length}`);
      console.log(`  Focus: ${context.cognitiveState.currentFocus}`);

      // Restore using existing systems
      await this.clearSurvival.restoreFromLedger();

      // Additional restoration logic would go here

      return true;
    } catch (error) {
      console.error('Failed to restore enhanced context:', error);
      return false;
    }
  }
}
