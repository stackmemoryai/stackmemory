/**
 * Stub implementation of ClaudeCodeSubagentClient for testing
 * Used when child_process is not available (e.g., in tests)
 */

export interface SubagentRequest {
  type: string;
  task: string;
  context: Record<string, any>;
}

export interface SubagentResponse {
  success: boolean;
  result: any;
  error?: string;
  tokens?: number;
}

export class ClaudeCodeSubagentClient {
  async executeSubagent(request: SubagentRequest): Promise<SubagentResponse> {
    // Stub implementation for testing
    return {
      success: true,
      result: {
        message: `Stub execution of ${request.type} agent`,
        task: request.task,
      },
      tokens: 100,
    };
  }
}
