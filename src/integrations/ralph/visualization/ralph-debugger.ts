/**
 * Advanced Ralph Loop Debugger and Visualizer
 * Provides detailed debugging, monitoring, and visualization for Ralph loops
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../core/monitoring/logger.js';
import { FrameManager } from '../../../core/context/index.js';
import { sessionManager } from '../../../core/session/index.js';
import {
  DebugSession,
  LoopVisualization,
  IterationTrace,
  ContextFlowDiagram,
  _PerformanceMetrics,
  DebugReport,
} from '../types.js';

export interface DebuggerConfig {
  enableRealTimeMonitoring: boolean;
  captureDetailedTrace: boolean;
  generateVisualization: boolean;
  exportFormat: 'json' | 'html' | 'markdown';
  maxTraceDepth: number;
}

export class RalphDebugger {
  private frameManager?: FrameManager;
  private activeSessions: Map<string, DebugSession> = new Map();
  private config: DebuggerConfig;

  constructor(config?: Partial<DebuggerConfig>) {
    this.config = {
      enableRealTimeMonitoring: true,
      captureDetailedTrace: true,
      generateVisualization: true,
      exportFormat: 'html',
      maxTraceDepth: 50,
      ...config,
    };

    logger.info('Ralph debugger initialized', this.config);
  }

  async initialize(): Promise<void> {
    try {
      await sessionManager.initialize();

      const session = await sessionManager.getOrCreateSession({});
      if (session.database) {
        this.frameManager = new FrameManager(
          session.database,
          session.projectId
        );
      }

      logger.info('Debugger initialized successfully');
    } catch (error: unknown) {
      logger.error('Failed to initialize debugger', error as Error);
      throw error;
    }
  }

  /**
   * Start debugging a Ralph loop
   */
  async startDebugSession(
    loopId: string,
    ralphDir: string
  ): Promise<DebugSession> {
    logger.info('Starting debug session', { loopId, ralphDir });

    const session: DebugSession = {
      id: `debug-${Date.now()}`,
      loopId,
      ralphDir,
      startTime: Date.now(),
      iterations: [],
      contextFlow: [],
      performance: {
        iterationTimes: [],
        memoryUsage: [],
        contextSizes: [],
        averageIterationTime: 0,
        peakMemory: 0,
        contextEfficiency: 0,
      },
      realTimeMonitoring: this.config.enableRealTimeMonitoring,
    };

    this.activeSessions.set(loopId, session);

    if (this.config.enableRealTimeMonitoring) {
      await this.startRealTimeMonitoring(session);
    }

    return session;
  }

  /**
   * Generate comprehensive debug report
   */
  async generateDebugReport(loopId: string): Promise<DebugReport> {
    const session = this.activeSessions.get(loopId);
    if (!session) {
      throw new Error(`No debug session found for loop ${loopId}`);
    }

    logger.info('Generating debug report', { loopId });

    const report: DebugReport = {
      sessionId: session.id,
      loopId,
      generatedAt: Date.now(),
      summary: await this.generateSummary(session),
      iterationAnalysis: await this.analyzeIterations(session),
      contextAnalysis: await this.analyzeContextFlow(session),
      performanceAnalysis: await this.analyzePerformance(session),
      visualization: this.config.generateVisualization
        ? await this.generateVisualization(session)
        : undefined,
      recommendations: await this.generateRecommendations(session),
      exportPath: '',
    };

    // Export report
    const exportPath = await this.exportReport(report);
    report.exportPath = exportPath;

    logger.info('Debug report generated', { loopId, exportPath });
    return report;
  }

  /**
   * Create visual timeline of loop execution
   */
  async generateLoopTimeline(loopId: string): Promise<string> {
    const session = this.activeSessions.get(loopId);
    if (!session) {
      throw new Error(`No debug session found for loop ${loopId}`);
    }

    const timeline = {
      title: `Ralph Loop Timeline: ${loopId}`,
      startTime: session.startTime,
      iterations: session.iterations.map((iter) => ({
        iteration: iter.iteration,
        startTime: iter.startTime,
        endTime: iter.endTime,
        duration: iter.endTime - iter.startTime,
        success: iter.success,
        changes: iter.changes?.length || 0,
        errors: iter.errors?.length || 0,
        contextSize: iter.contextSize,
        phase: iter.phase,
      })),
      totalDuration: session.performance.iterationTimes.reduce(
        (sum, time) => sum + time,
        0
      ),
    };

    // Generate HTML visualization
    const html = await this.generateTimelineHTML(timeline);

    const timelinePath = path.join('.ralph-debug', `timeline-${loopId}.html`);
    await fs.mkdir(path.dirname(timelinePath), { recursive: true });
    await fs.writeFile(timelinePath, html);

    return timelinePath;
  }

  /**
   * Create context flow diagram
   */
  async generateContextFlowDiagram(
    loopId: string
  ): Promise<ContextFlowDiagram> {
    const session = this.activeSessions.get(loopId);
    if (!session) {
      throw new Error(`No debug session found for loop ${loopId}`);
    }

    const diagram: ContextFlowDiagram = {
      id: `context-flow-${loopId}`,
      nodes: [],
      edges: [],
      metrics: {
        totalNodes: 0,
        totalEdges: 0,
        avgContextSize: 0,
        maxContextSize: 0,
      },
    };

    // Build context flow graph
    for (let i = 0; i < session.iterations.length; i++) {
      const iteration = session.iterations[i];

      // Add iteration node
      diagram.nodes.push({
        id: `iter-${iteration.iteration}`,
        type: 'iteration',
        label: `Iteration ${iteration.iteration}`,
        size: iteration.contextSize || 100,
        color: iteration.success ? '#4CAF50' : '#F44336',
        metadata: {
          duration: iteration.endTime - iteration.startTime,
          changes: iteration.changes?.length || 0,
          errors: iteration.errors?.length || 0,
        },
      });

      // Add edge to next iteration
      if (i < session.iterations.length - 1) {
        diagram.edges.push({
          id: `edge-${i}-${i + 1}`,
          from: `iter-${iteration.iteration}`,
          to: `iter-${session.iterations[i + 1].iteration}`,
          type: 'sequence',
          weight: iteration.contextSize || 1,
        });
      }
    }

    diagram.metrics = {
      totalNodes: diagram.nodes.length,
      totalEdges: diagram.edges.length,
      avgContextSize:
        session.performance.contextSizes.length > 0
          ? session.performance.contextSizes.reduce(
              (sum, size) => sum + size,
              0
            ) / session.performance.contextSizes.length
          : 0,
      maxContextSize: Math.max(...session.performance.contextSizes),
    };

    return diagram;
  }

  /**
   * Real-time monitoring of loop execution
   */
  private async startRealTimeMonitoring(session: DebugSession): Promise<void> {
    const monitoringInterval = setInterval(async () => {
      try {
        await this.captureIterationTrace(session);
        await this.updatePerformanceMetrics(session);
      } catch (error: unknown) {
        logger.error('Monitoring error', error as Error);
      }
    }, 1000); // Monitor every second

    // Store interval reference for cleanup
    (session as any).monitoringInterval = monitoringInterval;
  }

  /**
   * Capture detailed trace of current iteration
   */
  private async captureIterationTrace(session: DebugSession): Promise<void> {
    try {
      // Read current Ralph state
      const statePath = path.join(session.ralphDir, 'state.json');
      const iterationPath = path.join(session.ralphDir, 'iteration.txt');

      let _currentState: any = {};
      let currentIteration = 0;

      try {
        const stateData = await fs.readFile(statePath, 'utf8');
        _currentState = JSON.parse(stateData);

        const iterData = await fs.readFile(iterationPath, 'utf8');
        currentIteration = parseInt(iterData.trim()) || 0;
      } catch {
        // Files might not exist yet
        return;
      }

      // Check if this is a new iteration
      const lastTrace = session.iterations[session.iterations.length - 1];
      if (lastTrace?.iteration === currentIteration) {
        return; // Same iteration, update existing trace
      }

      // Create new iteration trace
      const trace: IterationTrace = {
        iteration: currentIteration,
        startTime: Date.now(),
        endTime: Date.now(), // Will be updated when iteration completes
        phase: this.determineIterationPhase(session.ralphDir),
        contextSize: await this.calculateContextSize(session.ralphDir),
        success: false, // Will be updated
        changes: [],
        errors: [],
        memoryUsage: process.memoryUsage().heapUsed,
        stackTrace: this.captureStackTrace(),
      };

      session.iterations.push(trace);
    } catch (error: unknown) {
      logger.debug('Failed to capture iteration trace', error as Error);
    }
  }

  /**
   * Update performance metrics
   */
  private async updatePerformanceMetrics(session: DebugSession): Promise<void> {
    const currentMemory = process.memoryUsage().heapUsed;
    session.performance.memoryUsage.push(currentMemory);
    session.performance.peakMemory = Math.max(
      session.performance.peakMemory,
      currentMemory
    );

    // Update context sizes
    const contextSize = await this.calculateContextSize(session.ralphDir);
    session.performance.contextSizes.push(contextSize);

    // Calculate averages
    if (session.performance.iterationTimes.length > 0) {
      session.performance.averageIterationTime =
        session.performance.iterationTimes.reduce(
          (sum, time) => sum + time,
          0
        ) / session.performance.iterationTimes.length;
    }

    // Calculate context efficiency
    if (session.performance.contextSizes.length > 0) {
      const avgContextSize =
        session.performance.contextSizes.reduce((sum, size) => sum + size, 0) /
        session.performance.contextSizes.length;
      session.performance.contextEfficiency = Math.max(
        0,
        1 - avgContextSize / 10000
      ); // Assume 10K is max context
    }
  }

  /**
   * Generate executive summary
   */
  private async generateSummary(session: DebugSession): Promise<any> {
    const totalIterations = session.iterations.length;
    const successfulIterations = session.iterations.filter(
      (i) => i.success
    ).length;
    const totalDuration = session.performance.iterationTimes.reduce(
      (sum, time) => sum + time,
      0
    );

    return {
      loopId: session.loopId,
      totalIterations,
      successfulIterations,
      successRate:
        totalIterations > 0 ? successfulIterations / totalIterations : 0,
      totalDuration,
      averageIterationTime: session.performance.averageIterationTime,
      peakMemoryUsage: session.performance.peakMemory,
      contextEfficiency: session.performance.contextEfficiency,
      status:
        totalIterations > 0 &&
        session.iterations[session.iterations.length - 1].success
          ? 'completed'
          : 'in_progress',
    };
  }

  /**
   * Analyze iteration patterns
   */
  private async analyzeIterations(session: DebugSession): Promise<any> {
    if (session.iterations.length === 0) return { patterns: [], insights: [] };

    const patterns: string[] = [];
    const insights: string[] = [];

    // Analyze iteration durations
    const durations = session.iterations.map((i) => i.endTime - i.startTime);
    const avgDuration =
      durations.reduce((sum, d) => sum + d, 0) / durations.length;

    if (durations.some((d) => d > avgDuration * 2)) {
      patterns.push('Variable iteration times detected');
      insights.push(
        'Some iterations took significantly longer than average - investigate bottlenecks'
      );
    }

    // Analyze success patterns
    const consecutiveFailures = this.findConsecutiveFailures(
      session.iterations
    );
    if (consecutiveFailures.length > 2) {
      patterns.push('Multiple consecutive failures detected');
      insights.push(
        'Consider adjusting approach or criteria after consecutive failures'
      );
    }

    // Analyze context growth
    if (session.performance.contextSizes.length > 1) {
      const contextGrowth =
        session.performance.contextSizes[
          session.performance.contextSizes.length - 1
        ] - session.performance.contextSizes[0];

      if (contextGrowth > 1000) {
        patterns.push('Significant context growth');
        insights.push(
          'Context is growing rapidly - consider context pruning strategies'
        );
      }
    }

    return { patterns, insights };
  }

  /**
   * Analyze context flow
   */
  private async analyzeContextFlow(session: DebugSession): Promise<any> {
    return {
      avgContextSize:
        session.performance.contextSizes.length > 0
          ? session.performance.contextSizes.reduce(
              (sum, size) => sum + size,
              0
            ) / session.performance.contextSizes.length
          : 0,
      maxContextSize: Math.max(...session.performance.contextSizes),
      contextGrowthRate: this.calculateGrowthRate(
        session.performance.contextSizes
      ),
      efficiency: session.performance.contextEfficiency,
    };
  }

  /**
   * Analyze performance metrics
   */
  private async analyzePerformance(session: DebugSession): Promise<any> {
    return {
      memoryEfficiency: this.calculateMemoryEfficiency(
        session.performance.memoryUsage
      ),
      iterationEfficiency: session.performance.averageIterationTime,
      resourceUtilization: {
        cpu: 'N/A', // Would need CPU monitoring
        memory: session.performance.peakMemory,
        context: session.performance.contextEfficiency,
      },
    };
  }

  /**
   * Generate visualization HTML
   */
  private async generateVisualization(
    session: DebugSession
  ): Promise<LoopVisualization> {
    const htmlContent = await this.generateVisualizationHTML(session);

    const vizPath = path.join(
      '.ralph-debug',
      `visualization-${session.loopId}.html`
    );
    await fs.mkdir(path.dirname(vizPath), { recursive: true });
    await fs.writeFile(vizPath, htmlContent);

    return {
      id: `viz-${session.loopId}`,
      type: 'interactive_timeline',
      htmlPath: vizPath,
      data: {
        iterations: session.iterations,
        performance: session.performance,
        contextFlow: session.contextFlow,
      },
      metadata: {
        generatedAt: Date.now(),
        format: 'html',
        interactive: true,
      },
    };
  }

  /**
   * Generate recommendations
   */
  private async generateRecommendations(
    session: DebugSession
  ): Promise<string[]> {
    const recommendations: string[] = [];

    // Performance recommendations
    if (session.performance.averageIterationTime > 30000) {
      // > 30 seconds
      recommendations.push(
        'Consider breaking down complex tasks into smaller iterations'
      );
    }

    if (session.performance.contextEfficiency < 0.7) {
      recommendations.push(
        'Optimize context management - consider using context budgeting'
      );
    }

    // Success rate recommendations
    const successRate =
      session.iterations.filter((i) => i.success).length /
      Math.max(1, session.iterations.length);
    if (successRate < 0.5) {
      recommendations.push(
        'Low success rate detected - review task criteria and approach'
      );
    }

    // Memory recommendations
    if (session.performance.peakMemory > 500 * 1024 * 1024) {
      // > 500MB
      recommendations.push(
        'High memory usage detected - investigate memory leaks'
      );
    }

    return recommendations;
  }

  /**
   * Export report in specified format
   */
  private async exportReport(report: DebugReport): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ralph-debug-${report.loopId}-${timestamp}`;

    let content: string;
    let extension: string;

    switch (this.config.exportFormat) {
      case 'json':
        content = JSON.stringify(report, null, 2);
        extension = 'json';
        break;
      case 'markdown':
        content = this.generateMarkdownReport(report);
        extension = 'md';
        break;
      case 'html':
      default:
        content = this.generateHTMLReport(report);
        extension = 'html';
        break;
    }

    const exportPath = path.join('.ralph-debug', `${filename}.${extension}`);
    await fs.mkdir(path.dirname(exportPath), { recursive: true });
    await fs.writeFile(exportPath, content);

    return exportPath;
  }

  // Helper methods
  private determineIterationPhase(
    _ralphDir: string
  ): 'starting' | 'working' | 'reviewing' | 'completed' {
    // Determine current phase based on file states
    return 'working'; // Simplified implementation
  }

  private async calculateContextSize(ralphDir: string): Promise<number> {
    try {
      const feedbackPath = path.join(ralphDir, 'feedback.txt');
      const feedback = await fs.readFile(feedbackPath, 'utf8');
      return feedback.length;
    } catch {
      return 0;
    }
  }

  private captureStackTrace(): string {
    const stack = new Error().stack || '';
    return stack.split('\n').slice(1, 6).join('\n'); // First 5 stack frames
  }

  private findConsecutiveFailures(iterations: IterationTrace[]): number[] {
    const failures: number[] = [];
    let currentStreak = 0;

    for (const iteration of iterations) {
      if (!iteration.success) {
        currentStreak++;
      } else {
        if (currentStreak > 0) {
          failures.push(currentStreak);
        }
        currentStreak = 0;
      }
    }

    if (currentStreak > 0) {
      failures.push(currentStreak);
    }

    return failures;
  }

  private calculateGrowthRate(sizes: number[]): number {
    if (sizes.length < 2) return 0;

    const first = sizes[0];
    const last = sizes[sizes.length - 1];

    return first > 0 ? (last - first) / first : 0;
  }

  private calculateMemoryEfficiency(memoryUsage: number[]): number {
    if (memoryUsage.length < 2) return 1;

    const min = Math.min(...memoryUsage);
    const max = Math.max(...memoryUsage);

    return max > 0 ? min / max : 1;
  }

  private generateTimelineHTML(timeline: any): string {
    // Generate interactive HTML timeline
    return `
<!DOCTYPE html>
<html>
<head>
    <title>${timeline.title}</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .timeline { margin: 20px 0; }
        .iteration { margin: 10px 0; padding: 10px; border-left: 4px solid #ccc; }
        .success { border-left-color: #4CAF50; }
        .failure { border-left-color: #F44336; }
    </style>
</head>
<body>
    <h1>${timeline.title}</h1>
    <div class="timeline">
        ${timeline.iterations
          .map(
            (iter: any) => `
            <div class="iteration ${iter.success ? 'success' : 'failure'}">
                <h3>Iteration ${iter.iteration}</h3>
                <p>Duration: ${iter.duration}ms</p>
                <p>Changes: ${iter.changes} | Errors: ${iter.errors}</p>
                <p>Context Size: ${iter.contextSize}</p>
            </div>
        `
          )
          .join('')}
    </div>
</body>
</html>
    `;
  }

  private generateVisualizationHTML(session: DebugSession): string {
    // Generate comprehensive visualization
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Ralph Loop Visualization - ${session.loopId}</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .chart { margin: 20px 0; }
        .metric { display: inline-block; margin: 10px; padding: 10px; border: 1px solid #ccc; }
    </style>
</head>
<body>
    <h1>Ralph Loop Debug Visualization</h1>
    <div id="metrics">
        <div class="metric">
            <h3>Iterations</h3>
            <p>${session.iterations.length}</p>
        </div>
        <div class="metric">
            <h3>Avg Time</h3>
            <p>${Math.round(session.performance.averageIterationTime)}ms</p>
        </div>
        <div class="metric">
            <h3>Context Efficiency</h3>
            <p>${Math.round(session.performance.contextEfficiency * 100)}%</p>
        </div>
    </div>
    <div id="timeline" class="chart"></div>
    <script>
        // D3.js visualization code would go here
        console.log('Visualization data:', ${JSON.stringify(session)});
    </script>
</body>
</html>
    `;
  }

  private generateMarkdownReport(report: DebugReport): string {
    return `
# Ralph Loop Debug Report

**Loop ID:** ${report.loopId}
**Generated:** ${new Date(report.generatedAt).toLocaleString()}

## Summary
- **Total Iterations:** ${report.summary.totalIterations}
- **Success Rate:** ${Math.round(report.summary.successRate * 100)}%
- **Total Duration:** ${report.summary.totalDuration}ms
- **Average Iteration Time:** ${Math.round(report.summary.averageIterationTime)}ms

## Performance Analysis
- **Peak Memory:** ${Math.round(report.performanceAnalysis.resourceUtilization.memory / 1024 / 1024)}MB
- **Context Efficiency:** ${Math.round(report.performanceAnalysis.resourceUtilization.context * 100)}%

## Recommendations
${report.recommendations.map((r) => `- ${r}`).join('\n')}
    `;
  }

  private generateHTMLReport(report: DebugReport): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>Ralph Debug Report - ${report.loopId}</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        .summary { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .metric { display: inline-block; margin: 10px; padding: 15px; background: white; border-radius: 4px; }
        .recommendations { background: #e3f2fd; padding: 15px; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>Ralph Loop Debug Report</h1>
    <div class="summary">
        <h2>Executive Summary</h2>
        <div class="metric">
            <h3>${report.summary.totalIterations}</h3>
            <p>Total Iterations</p>
        </div>
        <div class="metric">
            <h3>${Math.round(report.summary.successRate * 100)}%</h3>
            <p>Success Rate</p>
        </div>
        <div class="metric">
            <h3>${Math.round(report.summary.averageIterationTime)}ms</h3>
            <p>Avg Iteration Time</p>
        </div>
    </div>
    
    <div class="recommendations">
        <h2>Recommendations</h2>
        <ul>
            ${report.recommendations.map((r) => `<li>${r}</li>`).join('')}
        </ul>
    </div>
</body>
</html>
    `;
  }

  /**
   * Stop debug session and cleanup
   */
  async stopDebugSession(loopId: string): Promise<void> {
    const session = this.activeSessions.get(loopId);
    if (!session) return;

    // Stop real-time monitoring
    if ((session as any).monitoringInterval) {
      clearInterval((session as any).monitoringInterval);
    }

    // Generate final report
    await this.generateDebugReport(loopId);

    this.activeSessions.delete(loopId);
    logger.info('Debug session stopped', { loopId });
  }
}

// Export default instance
export const ralphDebugger = new RalphDebugger();
