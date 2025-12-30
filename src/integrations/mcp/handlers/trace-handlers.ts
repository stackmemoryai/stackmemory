/**
 * Trace and debugging MCP tool handlers
 * Handles trace detection, analysis, and debugging tools
 */

import { TraceDetector } from '../../../core/trace/trace-detector.js';
import { ToolCall } from '../../../core/trace/types.js';
import { BrowserMCPIntegration } from '../../../features/browser/browser-mcp.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface TraceHandlerDependencies {
  traceDetector: TraceDetector;
  browserMCP: BrowserMCPIntegration;
}

export class TraceHandlers {
  constructor(private deps: TraceHandlerDependencies) {}

  /**
   * Get traces with optional filtering
   */
  async handleGetTraces(args: any): Promise<any> {
    try {
      const { 
        limit = 20, 
        pattern, 
        start_time,
        end_time,
        include_context = false 
      } = args;

      const filters: any = { limit };
      
      if (pattern) {
        filters.pattern = pattern;
      }
      
      if (start_time) {
        filters.startTime = new Date(start_time);
      }
      
      if (end_time) {
        filters.endTime = new Date(end_time);
      }

      const traces = await this.deps.traceDetector.getTraces(filters);

      if (traces.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No traces found matching criteria',
            },
          ],
        };
      }

      const tracesSummary = traces.map(trace => {
        const duration = trace.endTime ? trace.endTime.getTime() - trace.startTime.getTime() : 'ongoing';
        return {
          id: trace.id,
          pattern: trace.pattern,
          toolCount: trace.toolCalls.length,
          duration: typeof duration === 'number' ? `${duration}ms` : duration,
          status: trace.status,
          startTime: trace.startTime.toISOString(),
        };
      });

      const summaryText = tracesSummary.map(t => 
        `${t.id}: ${t.pattern} (${t.toolCount} tools, ${t.duration}) [${t.status}]`
      ).join('\n');

      const result: any = {
        content: [
          {
            type: 'text',
            text: `Traces (${traces.length}):\n${summaryText}`,
          },
        ],
        metadata: {
          traces: tracesSummary,
          totalCount: traces.length,
          filters,
        },
      };

      // Include full context if requested
      if (include_context) {
        result.metadata.fullTraces = traces;
      }

      return result;
    } catch (error) {
      logger.error('Error getting traces', error);
      throw error;
    }
  }

  /**
   * Analyze trace patterns
   */
  async handleAnalyzeTraces(args: any): Promise<any> {
    try {
      const { 
        trace_id, 
        analysis_type = 'performance',
        include_recommendations = true 
      } = args;

      let analysis;

      if (trace_id) {
        // Analyze specific trace
        const trace = await this.deps.traceDetector.getTrace(trace_id);
        if (!trace) {
          throw new Error(`Trace not found: ${trace_id}`);
        }
        analysis = await this.deps.traceDetector.analyzeTrace(trace, analysis_type);
      } else {
        // Analyze all recent traces
        analysis = await this.deps.traceDetector.analyzeRecentTraces(analysis_type);
      }

      let analysisText = `Trace Analysis (${analysis_type}):\n\n`;

      switch (analysis_type) {
        case 'performance':
          analysisText += `Performance Metrics:
- Avg duration: ${analysis.avgDuration}ms
- Slowest operation: ${analysis.slowestOperation?.name} (${analysis.slowestOperation?.duration}ms)
- Tool usage: ${analysis.toolUsageStats}
- Bottlenecks: ${analysis.bottlenecks?.join(', ') || 'None detected'}`;
          break;

        case 'patterns':
          analysisText += `Pattern Analysis:
- Common sequences: ${analysis.commonSequences?.join(', ') || 'None'}
- Repetitive operations: ${analysis.repetitiveOps?.join(', ') || 'None'}
- Success rate: ${analysis.successRate}%
- Failure patterns: ${analysis.failurePatterns?.join(', ') || 'None'}`;
          break;

        case 'errors':
          analysisText += `Error Analysis:
- Error rate: ${analysis.errorRate}%
- Common errors: ${analysis.commonErrors?.join(', ') || 'None'}
- Error sources: ${analysis.errorSources?.join(', ') || 'None'}
- Recovery patterns: ${analysis.recoveryPatterns?.join(', ') || 'None'}`;
          break;

        default:
          analysisText += JSON.stringify(analysis, null, 2);
      }

      if (include_recommendations && analysis.recommendations) {
        analysisText += '\n\nRecommendations:\n';
        analysisText += analysis.recommendations.map((rec: string, i: number) => 
          `${i + 1}. ${rec}`
        ).join('\n');
      }

      return {
        content: [
          {
            type: 'text',
            text: analysisText,
          },
        ],
        metadata: {
          analysis,
          analysisType: analysis_type,
          traceId: trace_id,
        },
      };
    } catch (error) {
      logger.error('Error analyzing traces', error);
      throw error;
    }
  }

  /**
   * Start browser debugging session
   */
  async handleStartBrowserDebug(args: any): Promise<any> {
    try {
      const { 
        url, 
        headless = false,
        width = 1280,
        height = 720,
        capture_screenshots = true 
      } = args;

      if (!url) {
        throw new Error('URL is required for browser debugging');
      }

      const sessionId = await this.deps.browserMCP.startSession({
        headless,
        viewport: { width, height },
        captureScreenshots: capture_screenshots,
      });

      await this.deps.browserMCP.navigate(sessionId, url);

      logger.info('Started browser debug session', { sessionId, url });

      return {
        content: [
          {
            type: 'text',
            text: `Started browser debug session: ${sessionId}\nNavigated to: ${url}`,
          },
        ],
        metadata: {
          sessionId,
          url,
          options: { headless, width, height, capture_screenshots },
        },
      };
    } catch (error) {
      logger.error('Error starting browser debug session', error);
      throw error;
    }
  }

  /**
   * Take screenshot for debugging
   */
  async handleTakeScreenshot(args: any): Promise<any> {
    try {
      const { session_id, selector, full_page = false } = args;

      if (!session_id) {
        throw new Error('Session ID is required');
      }

      const screenshot = await this.deps.browserMCP.screenshot(session_id, {
        selector,
        fullPage: full_page,
      });

      return {
        content: [
          {
            type: 'text',
            text: 'Screenshot captured successfully',
          },
          {
            type: 'image',
            data: screenshot.data,
            mimeType: 'image/png',
          },
        ],
        metadata: {
          sessionId: session_id,
          selector,
          fullPage: full_page,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      logger.error('Error taking screenshot', error);
      throw error;
    }
  }

  /**
   * Execute JavaScript in browser for debugging
   */
  async handleExecuteScript(args: any): Promise<any> {
    try {
      const { session_id, script, args: scriptArgs = [] } = args;

      if (!session_id) {
        throw new Error('Session ID is required');
      }

      if (!script) {
        throw new Error('Script is required');
      }

      const result = await this.deps.browserMCP.executeScript(session_id, script, scriptArgs);

      return {
        content: [
          {
            type: 'text',
            text: `Script executed successfully:\nResult: ${JSON.stringify(result, null, 2)}`,
          },
        ],
        metadata: {
          sessionId: session_id,
          script,
          result,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      logger.error('Error executing script', error);
      throw error;
    }
  }

  /**
   * Stop browser debugging session
   */
  async handleStopBrowserDebug(args: any): Promise<any> {
    try {
      const { session_id } = args;

      if (!session_id) {
        throw new Error('Session ID is required');
      }

      await this.deps.browserMCP.closeSession(session_id);

      logger.info('Stopped browser debug session', { sessionId: session_id });

      return {
        content: [
          {
            type: 'text',
            text: `Stopped browser debug session: ${session_id}`,
          },
        ],
        metadata: {
          sessionId: session_id,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      logger.error('Error stopping browser debug session', error);
      throw error;
    }
  }
}