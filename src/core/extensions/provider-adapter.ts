/**
 * Provider Adapter Interface for StackMemory
 *
 * Philosophy: "Standardize the intersection; expose the union"
 * - Portable core stream API with shared semantics across all providers
 * - Provider-specific extensions available through explicit opt-in capabilities
 */

// =============================================================================
// Core Types - Portable across all providers
// =============================================================================

/**
 * Message role - intersection of all providers
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Content block types - intersection of all providers
 */
export type ContentBlockType = 'text' | 'image' | 'tool_use' | 'tool_result';

/**
 * Base content block
 */
export interface ContentBlock {
  type: ContentBlockType;
}

export interface TextBlock extends ContentBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock extends ContentBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface ToolUseBlock extends ContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock extends ContentBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}

export type AnyContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock;

/**
 * Message - portable message format
 */
export interface Message {
  role: MessageRole;
  content: string | AnyContentBlock[];
}

/**
 * Tool definition - portable tool schema
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Stream options - core options for all providers
 */
export interface StreamOptions {
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  system?: string;
  tools?: ToolDefinition[];
}

// =============================================================================
// Stream Events - Portable event types
// =============================================================================

export type StreamEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'error';

export interface StreamEventBase {
  type: StreamEventType;
}

export interface MessageStartEvent extends StreamEventBase {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    usage?: {
      inputTokens: number;
      outputTokens: number;
    };
  };
}

export interface ContentBlockStartEvent extends StreamEventBase {
  type: 'content_block_start';
  index: number;
  contentBlock: AnyContentBlock;
}

export interface ContentBlockDeltaEvent extends StreamEventBase {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partialJson?: string;
  };
}

export interface ContentBlockStopEvent extends StreamEventBase {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent extends StreamEventBase {
  type: 'message_delta';
  delta: {
    stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  };
  usage?: {
    outputTokens: number;
  };
}

export interface MessageStopEvent extends StreamEventBase {
  type: 'message_stop';
}

export interface ErrorEvent extends StreamEventBase {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ErrorEvent;

// =============================================================================
// Provider Capabilities - Union of provider-specific features
// =============================================================================

/**
 * Claude-specific extensions
 */
export interface ClaudeExtensions {
  /**
   * Extended thinking - deep reasoning capability
   */
  extendedThinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };

  /**
   * XML-structured output preference
   */
  xmlOutput?: {
    enabled: boolean;
    rootElement?: string;
  };

  /**
   * Computer use - desktop automation
   */
  computerUse?: {
    enabled: boolean;
    displaySize?: { width: number; height: number };
  };

  /**
   * PDF/document support
   */
  documentSupport?: {
    enabled: boolean;
    maxPages?: number;
  };
}

/**
 * OpenAI GPT-specific extensions
 */
export interface GPTExtensions {
  /**
   * Code interpreter - execute Python code
   */
  codeInterpreter?: {
    enabled: boolean;
    fileIds?: string[];
  };

  /**
   * Web browsing capability
   */
  browsing?: {
    enabled: boolean;
  };

  /**
   * DALL-E image generation
   */
  imageGeneration?: {
    enabled: boolean;
    size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
    quality?: 'standard' | 'hd';
  };

  /**
   * Function calling mode
   */
  functionCalling?: {
    mode: 'auto' | 'none' | 'required';
  };

  /**
   * JSON mode output
   */
  jsonMode?: {
    enabled: boolean;
    schema?: Record<string, unknown>;
  };
}

/**
 * All provider extensions - union type
 */
export interface ProviderExtensions {
  claude?: ClaudeExtensions;
  gpt?: GPTExtensions;
}

// =============================================================================
// Provider Adapter Interface
// =============================================================================

/**
 * Provider adapter interface - core contract for all providers
 */
export interface ProviderAdapter {
  /**
   * Unique provider identifier
   */
  readonly id: string;

  /**
   * Human-readable provider name
   */
  readonly name: string;

  /**
   * Provider version
   */
  readonly version: string;

  /**
   * Available extensions for this provider
   */
  readonly extensions: Partial<ProviderExtensions>;

  /**
   * Check if provider supports a specific extension
   */
  supportsExtension(extension: keyof ProviderExtensions): boolean;

  /**
   * Core streaming API - portable across all providers
   */
  stream(
    messages: Message[],
    options: StreamOptions
  ): AsyncIterable<StreamEvent>;

  /**
   * Non-streaming completion
   */
  complete(
    messages: Message[],
    options: StreamOptions
  ): Promise<{
    content: AnyContentBlock[];
    usage: { inputTokens: number; outputTokens: number };
    stopReason: string;
  }>;

  /**
   * Validate API key / connection
   */
  validateConnection(): Promise<boolean>;

  /**
   * Get available models for this provider
   */
  listModels(): Promise<string[]>;
}

// =============================================================================
// Claude Adapter Implementation
// =============================================================================

/**
 * Extended stream options for Claude
 */
export interface ClaudeStreamOptions extends StreamOptions {
  extensions?: ClaudeExtensions;
}

/**
 * Claude-specific stream events
 */
export interface ThinkingBlockStartEvent extends StreamEventBase {
  type: 'content_block_start';
  index: number;
  contentBlock: {
    type: 'thinking';
    thinking: string;
  };
}

export interface ThinkingBlockDeltaEvent extends StreamEventBase {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'thinking_delta';
    thinking: string;
  };
}

/**
 * Claude adapter - full implementation with extensions
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude';
  readonly name = 'Anthropic Claude';
  readonly version = '1.0.0';

  readonly extensions: ProviderExtensions = {
    claude: {
      extendedThinking: { enabled: true, budgetTokens: 10000 },
      xmlOutput: { enabled: true },
      computerUse: { enabled: true },
      documentSupport: { enabled: true, maxPages: 100 },
    },
  };

  private apiKey: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
  }

  supportsExtension(extension: keyof ProviderExtensions): boolean {
    return extension === 'claude';
  }

  async *stream(
    messages: Message[],
    options: ClaudeStreamOptions
  ): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(messages, options);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(options.extensions),
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!response.ok) {
      yield {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Claude API error: ${response.status} ${response.statusText}`,
        },
      };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield {
        type: 'error',
        error: { type: 'stream_error', message: 'No response body' },
      };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            const event = JSON.parse(data) as StreamEvent;
            yield this.normalizeEvent(event);
          } catch {
            // Skip malformed events
          }
        }
      }
    }
  }

  async complete(
    messages: Message[],
    options: ClaudeStreamOptions
  ): Promise<{
    content: AnyContentBlock[];
    usage: { inputTokens: number; outputTokens: number };
    stopReason: string;
  }> {
    const body = this.buildRequestBody(messages, options);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(options.extensions),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Claude API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();

    return {
      content: data.content as AnyContentBlock[],
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      stopReason: data.stop_reason ?? 'end_turn',
    };
  }

  async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-20250514',
      'claude-3-5-haiku-20241022',
    ];
  }

  private buildRequestBody(
    messages: Message[],
    options: ClaudeStreamOptions
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options.stopSequences?.length) {
      body.stop_sequences = options.stopSequences;
    }
    if (options.system) {
      body.system = options.system;
    }
    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    // Claude extensions
    if (options.extensions?.extendedThinking?.enabled) {
      body.thinking = {
        type: 'enabled',
        budget_tokens:
          options.extensions.extendedThinking.budgetTokens || 10000,
      };
      // Extended thinking requires temperature = 1
      body.temperature = 1;
    }

    return body;
  }

  private getHeaders(extensions?: ClaudeExtensions): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };

    const flags: string[] = [];
    if (extensions?.extendedThinking?.enabled) {
      flags.push('interleaved-thinking-2025-05-14');
    }
    if (extensions?.computerUse?.enabled) {
      flags.push('computer-use-2024-10-22');
    }
    if (extensions?.documentSupport?.enabled) {
      flags.push('pdfs-2024-09-25');
    }

    if (flags.length > 0) {
      headers['anthropic-beta'] = flags.join(',');
    }

    return headers;
  }

  private normalizeEvent(event: StreamEvent): StreamEvent {
    // Normalize Claude-specific events to portable format
    return event;
  }
}

// =============================================================================
// GPT Adapter Stub
// =============================================================================

/**
 * Extended stream options for GPT
 */
export interface GPTStreamOptions extends StreamOptions {
  extensions?: GPTExtensions;
}

/**
 * GPT adapter - stub implementation
 */
export class GPTAdapter implements ProviderAdapter {
  readonly id = 'gpt';
  readonly name = 'OpenAI GPT';
  readonly version = '1.0.0';

  readonly extensions: ProviderExtensions = {
    gpt: {
      codeInterpreter: { enabled: true },
      browsing: { enabled: true },
      imageGeneration: {
        enabled: true,
        size: '1024x1024',
        quality: 'standard',
      },
      functionCalling: { mode: 'auto' },
      jsonMode: { enabled: true },
    },
  };

  protected apiKey: string;
  protected baseUrl: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com';
  }

  supportsExtension(extension: keyof ProviderExtensions): boolean {
    return extension === 'gpt';
  }

  async *stream(
    messages: Message[],
    options: GPTStreamOptions
  ): AsyncIterable<StreamEvent> {
    // Convert messages to OpenAI format
    const openaiMessages = messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((c): c is TextBlock => c.type === 'text')
              .map((c) => c.text)
              .join(''),
    }));

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: openaiMessages,
      stream: true,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }

    // GPT extensions
    if (options.extensions?.jsonMode?.enabled) {
      body.response_format = { type: 'json_object' };
    }

    if (options.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));

      if (options.extensions?.functionCalling?.mode) {
        body.tool_choice = options.extensions.functionCalling.mode;
      }
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      yield {
        type: 'error',
        error: {
          type: 'api_error',
          message: `GPT API error: ${response.status} ${response.statusText}`,
        },
      };
      return;
    }

    // Yield message start
    yield {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        model: options.model,
        role: 'assistant',
      },
    };

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';
    const blockIndex = 0;
    let blockStarted = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            if (blockStarted) {
              yield { type: 'content_block_stop', index: blockIndex };
            }
            yield { type: 'message_stop' };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content && !blockStarted) {
              blockStarted = true;
              yield {
                type: 'content_block_start',
                index: blockIndex,
                contentBlock: { type: 'text', text: '' },
              };
            }

            if (delta?.content) {
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: delta.content },
              };
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    }
  }

  async complete(
    messages: Message[],
    options: GPTStreamOptions
  ): Promise<{
    content: AnyContentBlock[];
    usage: { inputTokens: number; outputTokens: number };
    stopReason: string;
  }> {
    const openaiMessages = messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter((c): c is TextBlock => c.type === 'text')
              .map((c) => c.text)
              .join(''),
    }));

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: openaiMessages,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `GPT API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      content: [{ type: 'text', text: choice?.message?.content ?? '' }],
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      stopReason: choice?.finish_reason ?? 'stop',
    };
  }

  async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o4-mini'];
  }
}

// =============================================================================
// Provider Factory
// =============================================================================

/**
 * Provider IDs accepted by createProvider().
 * Aligned with ModelProvider from model-router — no translation needed.
 */
export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'qwen'
  | 'cerebras'
  | 'deepinfra'
  | 'openrouter'
  | 'ollama';

/**
 * Provider configuration
 */
export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Create a provider adapter.
 *
 * CerebrasAdapter / DeepInfraAdapter live in separate files but import from
 * this module — using them here would create a circular dep. Instead we
 * construct GPTAdapter with the correct defaults inline. The dedicated
 * subclasses are still available for direct import when needed.
 */
export function createProvider(
  id: ProviderId,
  config: ProviderConfig
): ProviderAdapter {
  switch (id) {
    case 'anthropic':
      return new ClaudeAdapter(config);
    case 'openai':
    case 'qwen':
    case 'ollama':
      return new GPTAdapter(config);
    case 'cerebras':
      return new GPTAdapter({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || 'https://api.cerebras.ai/v1',
      });
    case 'deepinfra':
      return new GPTAdapter({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || 'https://api.deepinfra.com/v1/openai',
      });
    case 'openrouter':
      return new GPTAdapter({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl || 'https://openrouter.ai/api',
      });
    default:
      throw new Error(`No adapter for provider: ${id}`);
  }
}
