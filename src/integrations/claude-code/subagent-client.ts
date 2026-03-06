/**
 * Claude Code Subagent Client
 *
 * Uses Claude Code's Task tool to spawn subagents instead of direct API calls
 * This leverages the Claude Code Max plan for unlimited subagent execution
 */

import { logger } from '../../core/monitoring/logger.js';
import { STRUCTURED_RESPONSE_SUFFIX } from '../../orchestrators/multimodal/constants.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isFeatureEnabled } from '../../core/config/feature-flags.js';
import {
  getOptimalProvider,
  type TaskType,
} from '../../core/models/model-router.js';
import { scoreComplexity } from '../../core/models/complexity-scorer.js';
import {
  createProvider,
  type ProviderId,
  type TextBlock,
} from '../../core/extensions/provider-adapter.js';
import { AnthropicBatchClient } from '../anthropic/batch-client.js';
import type { BatchRequest } from '../anthropic/batch-client.js';

export interface SubagentRequest {
  type:
    | 'planning'
    | 'code'
    | 'testing'
    | 'linting'
    | 'review'
    | 'improve'
    | 'context'
    | 'publish';
  task: string;
  context: Record<string, any>;
  systemPrompt?: string;
  files?: string[];
  timeout?: number;
}

export interface SubagentResponse {
  success: boolean;
  result: any;
  output?: string;
  error?: string;
  tokens?: number;
  duration: number;
  subagentType: string;
}

/**
 * Claude Code Subagent Client
 * Spawns subagents using Claude Code's Task tool
 */
export class ClaudeCodeSubagentClient {
  private tempDir: string;
  private mockMode: boolean;

  constructor(mockMode: boolean = false) {
    this.mockMode = mockMode;

    // Create temp directory for subagent communication
    this.tempDir = path.join(os.tmpdir(), 'stackmemory-rlm');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    logger.info('Claude Code Subagent Client initialized', {
      tempDir: this.tempDir,
      mockMode: this.mockMode,
    });
  }

  /**
   * Execute a subagent task.
   * When multiProvider is enabled, routes cheap tasks to external providers.
   * Falls back to Claude Code CLI path when disabled or for complex tasks.
   */
  async executeSubagent(request: SubagentRequest): Promise<SubagentResponse> {
    const startTime = Date.now();
    const subagentId = `${request.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    logger.info(`Spawning ${request.type} subagent`, {
      subagentId,
      task: request.task.slice(0, 100),
      mockMode: this.mockMode,
    });

    // Return mock responses for testing
    if (this.mockMode) {
      return this.getMockResponse(request, startTime, subagentId);
    }

    // Route to external providers when multiProvider is enabled
    if (isFeatureEnabled('multiProvider')) {
      const taskType = request.type as TaskType;
      const complexity = scoreComplexity(request.task, request.context);
      const optimal = getOptimalProvider(taskType, undefined, {
        task: request.task,
        context: request.context,
      });

      logger.debug('Complexity-based routing', {
        subagentId,
        taskType,
        complexity: complexity.tier,
        score: complexity.score,
        signals: complexity.signals,
        routed: optimal.provider,
      });

      if (
        optimal.provider !== 'anthropic' &&
        optimal.provider !== 'anthropic-batch'
      ) {
        return this.executeDirectAPI(request, optimal, startTime, subagentId);
      }

      if (optimal.provider === 'anthropic-batch') {
        return this.executeBatch(request, startTime, subagentId);
      }
    }

    // Default path: use Claude Code CLI
    return this.executeSubagentViaCLI(request, startTime, subagentId);
  }

  /**
   * Execute via external provider (Cerebras, DeepInfra, etc.) using OpenAI-compatible API
   */
  private async executeDirectAPI(
    request: SubagentRequest,
    optimal: {
      provider: string;
      model: string;
      baseUrl?: string;
      apiKeyEnv: string;
    },
    startTime: number,
    subagentId: string
  ): Promise<SubagentResponse> {
    try {
      const apiKey = process.env[optimal.apiKeyEnv] || '';
      if (!apiKey) {
        logger.warn(
          `No API key for ${optimal.provider}, falling back to Claude`
        );
        return this.executeSubagentViaCLI(request, startTime, subagentId);
      }

      const adapter = createProvider(optimal.provider as ProviderId, {
        apiKey,
        baseUrl: optimal.baseUrl,
      });

      const prompt = this.buildSubagentPrompt(request);
      const result = await adapter.complete(
        [{ role: 'user', content: prompt }],
        { model: optimal.model, maxTokens: 4096 }
      );

      const text = result.content
        .filter((c): c is TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { rawOutput: text };
      }

      return {
        success: true,
        result: parsed,
        output: text,
        duration: Date.now() - startTime,
        subagentType: request.type,
        tokens: result.usage.inputTokens + result.usage.outputTokens,
      };
    } catch (error: any) {
      logger.warn(`Direct API failed for ${optimal.provider}, falling back`, {
        error: error.message,
      });
      return this.executeSubagentViaCLI(request, startTime, subagentId);
    }
  }

  /**
   * Execute via Anthropic Batch API (async, 50% discount)
   */
  private async executeBatch(
    request: SubagentRequest,
    startTime: number,
    subagentId: string
  ): Promise<SubagentResponse> {
    try {
      const batchClient = new AnthropicBatchClient();
      const prompt = this.buildSubagentPrompt(request);

      const batchReq: BatchRequest = {
        custom_id: subagentId,
        params: {
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        },
      };

      const batchId = await batchClient.submit([batchReq], request.type);

      // Return the batch ID immediately — caller can poll later
      return {
        success: true,
        result: { batchId, status: 'submitted', custom_id: subagentId },
        output: `Batch submitted: ${batchId}`,
        duration: Date.now() - startTime,
        subagentType: request.type,
      };
    } catch (error: any) {
      logger.warn('Batch submit failed, falling back to sync', {
        error: error.message,
      });
      return this.executeSubagentViaCLI(request, startTime, subagentId);
    }
  }

  /**
   * Execute subagent via Claude Code CLI (`claude -p --output-format stream-json`).
   * Spawns a real Claude Code process with full tool use.
   */
  private async executeSubagentViaCLI(
    request: SubagentRequest,
    startTime: number,
    subagentId: string
  ): Promise<SubagentResponse> {
    try {
      const prompt = this.buildSubagentPrompt(request);
      const contextFile = path.join(this.tempDir, `${subagentId}-context.json`);
      await fs.promises.writeFile(
        contextFile,
        JSON.stringify(request.context, null, 2)
      );

      const fullPrompt = `${prompt}\n\nContext (JSON): ${JSON.stringify(request.context)}`;
      const result = await this.spawnClaude(fullPrompt, request.timeout);

      this.cleanup(subagentId);

      let parsed: any;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = { rawOutput: result.text };
      }

      return {
        success: true,
        result: parsed,
        output: result.text,
        duration: Date.now() - startTime,
        subagentType: request.type,
        tokens: this.estimateTokens(fullPrompt + result.text),
      };
    } catch (error: any) {
      logger.error(`Subagent CLI execution failed: ${request.type}`, {
        error,
        subagentId,
      });

      return {
        success: false,
        result: null,
        error: error.message,
        duration: Date.now() - startTime,
        subagentType: request.type,
      };
    }
  }

  /**
   * Execute multiple subagents in parallel
   */
  async executeParallel(
    requests: SubagentRequest[]
  ): Promise<SubagentResponse[]> {
    logger.info(`Executing ${requests.length} subagents in parallel`);

    const promises = requests.map((request) => this.executeSubagent(request));
    const results = await Promise.allSettled(promises);

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          success: false,
          result: null,
          error: result.reason?.message || 'Unknown error',
          duration: 0,
          subagentType: requests[index].type,
        };
      }
    });
  }

  /**
   * Build subagent prompt based on type
   */
  private buildSubagentPrompt(request: SubagentRequest): string {
    const prompts: Record<string, string> = {
      planning: `You are a Planning Subagent. Your role is to decompose complex tasks into manageable subtasks.
        
        Task: ${request.task}
        
        Instructions:
        1. Analyze the task and identify all components
        2. Create a dependency graph of subtasks
        3. Assign appropriate agent types to each subtask
        4. Consider parallel execution opportunities
        5. Include comprehensive testing at each stage
        
        Context is available in the provided file.
        
        Output a JSON structure with the task decomposition.`,

      code: `You are a Code Generation Subagent. Your role is to implement high-quality, production-ready code.
        
        Task: ${request.task}
        
        Instructions:
        1. Write clean, maintainable code
        2. Follow project conventions (check context)
        3. Include comprehensive error handling
        4. Add clear comments for complex logic
        5. Ensure code is testable
        
        Context and requirements are in the provided file.
        
        Output the implementation code.`,

      testing: `You are a Testing Subagent specializing in comprehensive test generation.
        
        Task: ${request.task}
        
        Instructions:
        1. Generate unit tests for all functions/methods
        2. Create integration tests for API endpoints
        3. Add E2E tests for critical user flows
        4. Include edge cases and error scenarios
        5. Ensure high code coverage (aim for 100%)
        6. Validate that all tests pass
        
        Context and code to test are in the provided file.
        
        Output a complete test suite.`,

      linting: `You are a Linting Subagent ensuring code quality and standards.
        
        Task: ${request.task}
        
        Instructions:
        1. Check for syntax errors and type issues
        2. Verify code formatting and style
        3. Identify security vulnerabilities
        4. Find performance anti-patterns
        5. Detect unused imports and dead code
        6. Provide specific fixes for each issue
        
        Code to analyze is in the context file.
        
        Output a JSON report with issues and fixes.`,

      review: `You are a Code Review Subagent performing thorough multi-stage reviews.
        
        Task: ${request.task}
        
        Instructions:
        1. Evaluate architecture and design patterns
        2. Assess code quality and maintainability
        3. Check performance implications
        4. Review security considerations
        5. Verify test coverage adequacy
        6. Suggest specific improvements with examples
        7. Rate quality on a 0-1 scale
        
        Code and context are in the provided file.
        
        Output a detailed review with quality score and improvements.`,

      improve: `You are an Improvement Subagent enhancing code based on reviews.
        
        Task: ${request.task}
        
        Instructions:
        1. Implement all suggested improvements
        2. Refactor for better architecture
        3. Optimize performance bottlenecks
        4. Enhance error handling
        5. Improve code clarity and documentation
        6. Add missing test cases
        7. Ensure backward compatibility
        
        Review feedback and code are in the context file.
        
        Output the improved code.`,

      context: `You are a Context Retrieval Subagent finding relevant information.
        
        Task: ${request.task}
        
        Instructions:
        1. Search project codebase for relevant code
        2. Find similar implementations
        3. Locate relevant documentation
        4. Identify dependencies and patterns
        5. Retrieve best practices
        
        Search parameters are in the context file.
        
        Output relevant context snippets.`,

      publish: `You are a Publishing Subagent handling releases and deployments.
        
        Task: ${request.task}
        
        Instructions:
        1. Prepare package for publishing
        2. Update version numbers
        3. Generate changelog
        4. Create GitHub release
        5. Publish to NPM if applicable
        6. Update documentation
        
        Release details are in the context file.
        
        Output the release plan and commands.`,
    };

    return (
      (request.systemPrompt || prompts[request.type] || prompts.planning) +
      STRUCTURED_RESPONSE_SUFFIX
    );
  }

  /**
   * Spawn `claude -p --output-format stream-json` and collect the result.
   * Parses stream-json events to extract the final assistant text.
   */
  private spawnClaude(
    prompt: string,
    timeout?: number
  ): Promise<{ text: string; toolUseCount: number }> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'stream-json', prompt];

      const claude = spawn('claude', args, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timeoutMs = timeout || 300000; // 5 minutes default
      const timer = setTimeout(() => {
        claude.kill('SIGTERM');
        reject(new Error(`Subagent timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      let lastAssistantText = '';
      let toolUseCount = 0;
      let lineBuffer = '';
      let stderr = '';

      claude.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            if (event.type === 'assistant' && event.message) {
              const textBlocks = (event.message.content || [])
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text);
              if (textBlocks.length > 0) {
                lastAssistantText = textBlocks.join('\n');
              }
              const toolBlocks = (event.message.content || []).filter(
                (b: any) => b.type === 'tool_use'
              );
              toolUseCount += toolBlocks.length;
            }

            if (event.type === 'result' && event.result) {
              lastAssistantText = event.result;
            }
          } catch {
            // non-JSON line, ignore
          }
        }
      });

      claude.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      claude.on('close', (code: number | null) => {
        clearTimeout(timer);

        // Process remaining buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer);
            if (event.type === 'result' && event.result) {
              lastAssistantText = event.result;
            }
          } catch {
            // ignore
          }
        }

        logger.info('Claude subagent completed', {
          code,
          toolUseCount,
          outputLength: lastAssistantText.length,
        });

        if (code === 0 && lastAssistantText) {
          resolve({ text: lastAssistantText, toolUseCount });
        } else if (code === 0) {
          resolve({
            text: '(Claude completed but produced no text output)',
            toolUseCount,
          });
        } else {
          reject(
            new Error(`Claude exited code ${code}: ${stderr.slice(0, 500)}`)
          );
        }
      });

      claude.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }

  /**
   * Get mock response for testing
   */
  private async getMockResponse(
    request: SubagentRequest,
    startTime: number,
    subagentId: string
  ): Promise<SubagentResponse> {
    // Simulate some processing time
    await new Promise((resolve) =>
      setTimeout(resolve, Math.random() * 20 + 10)
    );

    const mockResponses: Record<string, any> = {
      planning: {
        tasks: [
          { id: 'task-1', name: 'Analyze requirements', type: 'analysis' },
          { id: 'task-2', name: 'Design solution', type: 'design' },
          { id: 'task-3', name: 'Implement solution', type: 'implementation' },
        ],
        dependencies: [],
        estimated_time: 300,
      },

      code: {
        implementation: `function greetUser(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid name parameter');
  }
  return \`Hello, \${name}!\`;
}`,
        files_modified: ['src/greet.ts'],
        lines_added: 6,
        lines_removed: 0,
      },

      testing: {
        tests: [
          {
            name: 'greetUser should return greeting',
            code: `test('greetUser should return greeting', () => {
  expect(greetUser('Alice')).toBe('Hello, Alice!');
});`,
            type: 'unit',
          },
        ],
        coverage: { lines: 100, branches: 100, functions: 100 },
      },

      linting: {
        issues: [],
        fixes: [],
        passed: true,
      },

      review: {
        quality: 0.85,
        issues: [
          'Consider adding JSDoc comments',
          'Could add more edge case tests',
        ],
        suggestions: [
          'Add documentation for the function',
          'Consider adding internationalization support',
          'Add performance tests for large inputs',
        ],
        improvements: [],
      },

      improve: {
        improved_code: `/**
 * Greets a user with their name
 * @param name - The name of the user to greet
 * @returns A greeting message
 * @throws {Error} If name is invalid
 */
function greetUser(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid name parameter: name must be a non-empty string');
  }
  return \`Hello, \${name}!\`;
}`,
        changes_made: ['Added JSDoc documentation', 'Improved error message'],
      },

      context: {
        relevant_files: ['src/greet.ts', 'test/greet.test.ts'],
        patterns: ['greeting functions', 'input validation'],
        dependencies: [],
      },

      publish: {
        version: '1.0.0',
        changelog: 'Initial release',
        published: false,
        reason: 'Mock mode - no actual publishing',
      },
    };

    const result = mockResponses[request.type] || {};

    return {
      success: true,
      result,
      output: `Mock ${request.type} subagent completed successfully`,
      duration: Date.now() - startTime,
      subagentType: request.type,
      tokens: this.estimateTokens(JSON.stringify(result)),
    };
  }

  /**
   * Estimate token usage
   */
  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Cleanup temporary files
   */
  private cleanup(subagentId: string): void {
    const patterns = [
      `${subagentId}-context.json`,
      `${subagentId}-result.json`,
      `${subagentId}-script.sh`,
    ];

    for (const pattern of patterns) {
      const filePath = path.join(this.tempDir, pattern);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Get active subagent statistics
   */
  getStats() {
    return {
      tempDir: this.tempDir,
    };
  }

  /**
   * Cleanup all resources
   */
  async cleanupAll(): Promise<void> {
    // Clean temp directory
    if (fs.existsSync(this.tempDir)) {
      const files = await fs.promises.readdir(this.tempDir);
      for (const file of files) {
        await fs.promises.unlink(path.join(this.tempDir, file));
      }
    }

    logger.info('Claude Code Subagent Client cleaned up');
  }
}
