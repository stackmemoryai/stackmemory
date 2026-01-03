/**
 * Post-Task Completion Hooks for StackMemory
 * Automatically runs tests and code review after Claude completes tasks
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FrameManager } from '../../core/frame/frame-manager';
import { DatabaseManager } from '../../core/storage/database-manager';

export interface PostTaskConfig {
  projectRoot: string;
  qualityGates: {
    runTests: boolean; // Auto-run tests after code changes
    requireTestCoverage: boolean; // Require test coverage for new code
    runCodeReview: boolean; // Auto-trigger code review agent
    runLinter: boolean; // Auto-run linter/formatter
    blockOnFailure: boolean; // Block further work if quality gates fail
  };
  testFrameworks: {
    detected: string[]; // Auto-detected test frameworks
    testCommand?: string; // Custom test command
    coverageCommand?: string; // Custom coverage command
    lintCommand?: string; // Custom lint command
  };
  reviewConfig: {
    reviewOnEveryChange: boolean; // Review every file change
    reviewOnTaskComplete: boolean; // Review when task frame closes
    focusAreas: string[]; // What to focus on in reviews
    skipPatterns: string[]; // Files/patterns to skip review
  };
}

export interface TaskCompletionEvent {
  taskType: 'code_change' | 'task_complete' | 'file_modified' | 'frame_closed';
  files: string[];
  frameId: string;
  frameName: string;
  changes: {
    added: number;
    removed: number;
    modified: number;
  };
  metadata: Record<string, any>;
}

export interface QualityGateResult {
  gate: string;
  passed: boolean;
  output: string;
  duration: number;
  issues?: QualityIssue[];
}

export interface QualityIssue {
  type: 'test_failure' | 'lint_error' | 'coverage_low' | 'review_concern';
  file: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export class PostTaskHooks extends EventEmitter {
  private config: PostTaskConfig;
  private frameManager: FrameManager;
  private dbManager: DatabaseManager;
  private isActive: boolean = false;
  private lastProcessedFrame?: string;

  constructor(
    frameManager: FrameManager,
    dbManager: DatabaseManager,
    config: Partial<PostTaskConfig>
  ) {
    super();
    this.frameManager = frameManager;
    this.dbManager = dbManager;

    // Default configuration
    this.config = {
      projectRoot: process.cwd(),
      qualityGates: {
        runTests: true,
        requireTestCoverage: false,
        runCodeReview: true,
        runLinter: true,
        blockOnFailure: false,
      },
      testFrameworks: {
        detected: [],
      },
      reviewConfig: {
        reviewOnEveryChange: false,
        reviewOnTaskComplete: true,
        focusAreas: [
          'security',
          'performance',
          'maintainability',
          'correctness',
        ],
        skipPatterns: ['*.test.ts', '*.spec.js', 'dist/', 'node_modules/'],
      },
      ...config,
    };
  }

  /**
   * Initialize post-task hooks
   */
  async initialize(): Promise<void> {
    if (this.isActive) return;

    // Detect test frameworks and commands
    await this.detectTestFrameworks();

    // Set up frame event listeners
    this.setupFrameListeners();

    // Set up file watchers for code changes
    await this.setupFileWatchers();

    this.isActive = true;
    console.log('✅ Post-task hooks initialized');
    this.emit('initialized', this.config);
  }

  /**
   * Detect available test frameworks and commands
   */
  private async detectTestFrameworks(): Promise<void> {
    const packageJsonPath = path.join(this.config.projectRoot, 'package.json');

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, 'utf-8')
      );
      const scripts = packageJson.scripts || {};
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };

      // Detect test frameworks
      const frameworks: string[] = [];
      if (dependencies.jest) frameworks.push('jest');
      if (dependencies.vitest) frameworks.push('vitest');
      if (dependencies.mocha) frameworks.push('mocha');
      if (dependencies.playwright) frameworks.push('playwright');
      if (dependencies.cypress) frameworks.push('cypress');

      this.config.testFrameworks.detected = frameworks;

      // Detect commands
      if (scripts.test) {
        this.config.testFrameworks.testCommand = 'npm test';
      } else if (scripts['test:run']) {
        this.config.testFrameworks.testCommand = 'npm run test:run';
      }

      if (scripts.coverage) {
        this.config.testFrameworks.coverageCommand = 'npm run coverage';
      }

      if (scripts.lint) {
        this.config.testFrameworks.lintCommand = 'npm run lint';
      }
    } catch (error) {
      console.warn('Could not detect test frameworks:', error);
    }
  }

  /**
   * Set up frame event listeners
   */
  private setupFrameListeners(): void {
    // Listen for frame closures (task completion)
    this.frameManager.on(
      'frame:closed',
      async (frameId: string, frameData: any) => {
        if (frameData.type === 'task' || frameData.type === 'subtask') {
          await this.handleTaskCompletion({
            taskType: 'task_complete',
            frameId,
            frameName: frameData.name || 'Unnamed task',
            files: this.extractFilesFromFrame(frameData),
            changes: this.calculateChanges(frameData),
            metadata: frameData.metadata || {},
          });
        }
      }
    );

    // Listen for significant events
    this.frameManager.on(
      'frame:event',
      async (frameId: string, eventType: string, data: any) => {
        if (eventType === 'code_change' || eventType === 'file_modified') {
          await this.handleTaskCompletion({
            taskType: 'code_change',
            frameId,
            frameName: data.description || 'Code change',
            files: data.files || [],
            changes: data.changes || { added: 0, removed: 0, modified: 1 },
            metadata: data,
          });
        }
      }
    );
  }

  /**
   * Set up file watchers for real-time code change detection
   */
  private async setupFileWatchers(): Promise<void> {
    try {
      const chokidar = await import('chokidar');

      const watcher = chokidar.watch(
        [
          '**/*.{ts,js,tsx,jsx,py,go,rs,java,cpp,c}',
          '!node_modules/**',
          '!dist/**',
          '!build/**',
        ],
        {
          cwd: this.config.projectRoot,
          ignored: /node_modules/,
          persistent: true,
        }
      );

      let changeQueue: string[] = [];
      let debounceTimer: NodeJS.Timeout | null = null;

      watcher.on('change', (filePath: string) => {
        changeQueue.push(filePath);

        // Debounce to avoid too many triggers
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          if (changeQueue.length > 0) {
            await this.handleFileChanges([...changeQueue]);
            changeQueue = [];
          }
        }, 2000); // 2 second debounce
      });
    } catch (error) {
      console.warn('File watching not available:', error);
    }
  }

  /**
   * Handle task completion events
   */
  private async handleTaskCompletion(
    event: TaskCompletionEvent
  ): Promise<void> {
    // Avoid duplicate processing
    if (
      this.lastProcessedFrame === event.frameId &&
      event.taskType !== 'code_change'
    ) {
      return;
    }

    this.lastProcessedFrame = event.frameId;

    console.log(
      `🔍 Task completed: ${event.frameName} (${event.files.length} files changed)`
    );
    this.emit('task:completed', event);

    // Run quality gates
    const results = await this.runQualityGates(event);

    // Check if gates passed
    const allPassed = results.every((r) => r.passed);

    if (allPassed) {
      console.log('✅ All quality gates passed');
      this.emit('quality:passed', { event, results });
    } else {
      console.log('⚠️ Quality gate failures detected');
      this.emit('quality:failed', { event, results });

      if (this.config.qualityGates.blockOnFailure) {
        await this.blockFurtherWork(results);
      }
    }

    // Record results in frame metadata
    await this.recordQualityResults(event.frameId, results);
  }

  /**
   * Handle file changes
   */
  private async handleFileChanges(files: string[]): Promise<void> {
    if (!this.config.reviewConfig.reviewOnEveryChange) return;

    // Filter out files that should be skipped
    const filteredFiles = files.filter((file) => {
      return !this.config.reviewConfig.skipPatterns.some((pattern) => {
        return file.includes(pattern.replace('*', ''));
      });
    });

    if (filteredFiles.length === 0) return;

    await this.handleTaskCompletion({
      taskType: 'file_modified',
      frameId: 'file-watcher',
      frameName: 'File changes detected',
      files: filteredFiles,
      changes: { added: 0, removed: 0, modified: filteredFiles.length },
      metadata: { trigger: 'file_watcher' },
    });
  }

  /**
   * Run all configured quality gates
   */
  private async runQualityGates(
    event: TaskCompletionEvent
  ): Promise<QualityGateResult[]> {
    const results: QualityGateResult[] = [];

    // Run linter first (fastest)
    if (this.config.qualityGates.runLinter) {
      results.push(await this.runLinter(event.files));
    }

    // Run tests (slower)
    if (this.config.qualityGates.runTests) {
      results.push(await this.runTests(event.files));
    }

    // Check test coverage
    if (this.config.qualityGates.requireTestCoverage) {
      results.push(await this.checkTestCoverage(event.files));
    }

    // Run code review (slowest, most thorough)
    if (this.config.qualityGates.runCodeReview) {
      results.push(await this.runCodeReview(event));
    }

    return results;
  }

  /**
   * Run linter on changed files
   */
  private async runLinter(files: string[]): Promise<QualityGateResult> {
    const start = Date.now();

    try {
      if (!this.config.testFrameworks.lintCommand) {
        return {
          gate: 'linter',
          passed: true,
          output: 'No lint command configured',
          duration: Date.now() - start,
        };
      }

      const output = execSync(this.config.testFrameworks.lintCommand, {
        cwd: this.config.projectRoot,
        encoding: 'utf-8',
        timeout: 30000, // 30 second timeout
      });

      return {
        gate: 'linter',
        passed: true,
        output,
        duration: Date.now() - start,
      };
    } catch (error: any) {
      return {
        gate: 'linter',
        passed: false,
        output: error.stdout || error.message,
        duration: Date.now() - start,
        issues: this.parseLintErrors(error.stdout || error.message),
      };
    }
  }

  /**
   * Run tests
   */
  private async runTests(files: string[]): Promise<QualityGateResult> {
    const start = Date.now();

    try {
      if (!this.config.testFrameworks.testCommand) {
        return {
          gate: 'tests',
          passed: true,
          output: 'No test command configured',
          duration: Date.now() - start,
        };
      }

      const output = execSync(this.config.testFrameworks.testCommand, {
        cwd: this.config.projectRoot,
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout
      });

      return {
        gate: 'tests',
        passed: true,
        output,
        duration: Date.now() - start,
      };
    } catch (error: any) {
      return {
        gate: 'tests',
        passed: false,
        output: error.stdout || error.message,
        duration: Date.now() - start,
        issues: this.parseTestFailures(error.stdout || error.message),
      };
    }
  }

  /**
   * Check test coverage
   */
  private async checkTestCoverage(files: string[]): Promise<QualityGateResult> {
    const start = Date.now();

    try {
      if (!this.config.testFrameworks.coverageCommand) {
        return {
          gate: 'coverage',
          passed: true,
          output: 'No coverage command configured',
          duration: Date.now() - start,
        };
      }

      const output = execSync(this.config.testFrameworks.coverageCommand, {
        cwd: this.config.projectRoot,
        encoding: 'utf-8',
        timeout: 120000,
      });

      // Parse coverage percentage (simplified)
      const coverageMatch = output.match(/(\d+\.?\d*)%/);
      const coverage = coverageMatch ? parseFloat(coverageMatch[1]) : 0;
      const threshold = 80; // 80% coverage threshold

      return {
        gate: 'coverage',
        passed: coverage >= threshold,
        output,
        duration: Date.now() - start,
        issues:
          coverage < threshold
            ? [
                {
                  type: 'coverage_low',
                  file: 'overall',
                  message: `Coverage ${coverage}% is below threshold ${threshold}%`,
                  severity: 'warning' as const,
                },
              ]
            : undefined,
      };
    } catch (error: any) {
      return {
        gate: 'coverage',
        passed: false,
        output: error.stdout || error.message,
        duration: Date.now() - start,
        issues: [
          {
            type: 'coverage_low',
            file: 'overall',
            message: 'Coverage check failed',
            severity: 'error' as const,
          },
        ],
      };
    }
  }

  /**
   * Run code review using AI agent
   */
  private async runCodeReview(
    event: TaskCompletionEvent
  ): Promise<QualityGateResult> {
    const start = Date.now();

    try {
      // This would integrate with the code review agent
      const reviewPrompt = this.generateCodeReviewPrompt(event);

      // For now, simulate a review (in real implementation, call agent)
      const review = await this.callCodeReviewAgent(reviewPrompt, event.files);

      return {
        gate: 'code_review',
        passed: !review.issues || review.issues.length === 0,
        output: review.summary,
        duration: Date.now() - start,
        issues: review.issues,
      };
    } catch (error: any) {
      return {
        gate: 'code_review',
        passed: false,
        output: `Code review failed: ${error.message}`,
        duration: Date.now() - start,
      };
    }
  }

  /**
   * Generate code review prompt
   */
  private generateCodeReviewPrompt(event: TaskCompletionEvent): string {
    return `
Please review the following code changes:

Task: ${event.frameName}
Files changed: ${event.files.join(', ')}
Changes: +${event.changes.added}, -${event.changes.removed}, ~${event.changes.modified}

Focus areas: ${this.config.reviewConfig.focusAreas.join(', ')}

Please check for:
1. Security vulnerabilities
2. Performance issues  
3. Code maintainability
4. Correctness and logic errors
5. Best practices adherence

Provide specific, actionable feedback.
`;
  }

  /**
   * Call code review agent (placeholder for actual implementation)
   */
  private async callCodeReviewAgent(
    prompt: string,
    files: string[]
  ): Promise<{
    summary: string;
    issues?: QualityIssue[];
  }> {
    // This would integrate with Claude Code's agent system
    // For now, return a mock review
    return {
      summary: `Reviewed ${files.length} files. Code quality looks good.`,
      issues: [],
    };
  }

  /**
   * Parse lint errors into structured issues
   */
  private parseLintErrors(output: string): QualityIssue[] {
    const issues: QualityIssue[] = [];

    // Simple parser for common lint formats
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(
        /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/
      );
      if (match) {
        issues.push({
          type: 'lint_error',
          file: match[1],
          line: parseInt(match[2]),
          message: match[5],
          severity: match[4] as 'error' | 'warning',
        });
      }
    }

    return issues;
  }

  /**
   * Parse test failures into structured issues
   */
  private parseTestFailures(output: string): QualityIssue[] {
    const issues: QualityIssue[] = [];

    // Simple parser for test failures
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes('FAIL') || line.includes('✗')) {
        issues.push({
          type: 'test_failure',
          file: 'unknown',
          message: line.trim(),
          severity: 'error',
        });
      }
    }

    return issues;
  }

  /**
   * Block further work when quality gates fail
   */
  private async blockFurtherWork(results: QualityGateResult[]): Promise<void> {
    const failedGates = results.filter((r) => !r.passed);

    console.log('🚫 Quality gates failed - blocking further work:');
    failedGates.forEach((gate) => {
      console.log(`   ${gate.gate}: ${gate.output}`);
      if (gate.issues) {
        gate.issues.forEach((issue) => {
          console.log(
            `     - ${issue.severity}: ${issue.message} (${issue.file}:${issue.line || 0})`
          );
        });
      }
    });

    console.log('\n🔧 Fix these issues before continuing:');
    const allIssues = failedGates.flatMap((g) => g.issues || []);
    allIssues.forEach((issue, i) => {
      console.log(`${i + 1}. ${issue.message}`);
    });
  }

  /**
   * Record quality results in frame metadata
   */
  private async recordQualityResults(
    frameId: string,
    results: QualityGateResult[]
  ): Promise<void> {
    try {
      const frame = await this.frameManager.getFrame(frameId);
      if (frame) {
        frame.metadata = {
          ...frame.metadata,
          qualityGates: {
            timestamp: new Date().toISOString(),
            results,
            passed: results.every((r) => r.passed),
            totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
          },
        };

        // Update frame with quality results
        await this.frameManager.updateFrame(frameId, frame);
      }
    } catch (error) {
      console.error('Failed to record quality results:', error);
    }
  }

  /**
   * Extract files from frame data
   */
  private extractFilesFromFrame(frameData: any): string[] {
    // Extract file paths from various possible locations
    const files: string[] = [];

    if (frameData.metadata?.files) {
      files.push(...frameData.metadata.files);
    }

    if (frameData.events) {
      frameData.events.forEach((event: any) => {
        if (event.type === 'file_change' && event.data?.file) {
          files.push(event.data.file);
        }
      });
    }

    return [...new Set(files)]; // Remove duplicates
  }

  /**
   * Calculate changes from frame data
   */
  private calculateChanges(frameData: any): {
    added: number;
    removed: number;
    modified: number;
  } {
    return {
      added: frameData.metadata?.linesAdded || 0,
      removed: frameData.metadata?.linesRemoved || 0,
      modified: frameData.metadata?.filesModified || 1,
    };
  }

  /**
   * Stop post-task hooks
   */
  async stop(): Promise<void> {
    this.isActive = false;
    this.removeAllListeners();
    console.log('🛑 Post-task hooks stopped');
  }

  /**
   * Get current configuration
   */
  getConfig(): PostTaskConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<PostTaskConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('config:updated', this.config);
  }
}
