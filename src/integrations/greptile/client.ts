/**
 * Greptile MCP Client
 * Wraps @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport
 * to proxy tool calls to the Greptile MCP endpoint.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GreptileIntegrationConfig } from './config.js';
import { DEFAULT_GREPTILE_CONFIG } from './config.js';

export class GreptileClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'GreptileClientError';
  }
}

export class GreptileClient {
  private readonly config: GreptileIntegrationConfig;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting: Promise<void> | null = null;

  constructor(config: Partial<GreptileIntegrationConfig> = {}) {
    this.config = { ...DEFAULT_GREPTILE_CONFIG, ...config };

    if (!this.config.enabled || !this.config.apiKey) {
      throw new GreptileClientError(
        'Greptile integration disabled (GREPTILE_API_KEY not set)',
        'DISABLED'
      );
    }
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;

    // Deduplicate concurrent connection attempts
    if (this.connecting) {
      await this.connecting;
      return this.client!;
    }

    this.connecting = this.connect();
    try {
      await this.connecting;
      return this.client!;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.mcpEndpoint),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        },
        reconnectionOptions: {
          maxRetries: this.config.maxRetries,
          initialReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1.5,
          maxReconnectionDelay: 10000,
        },
      }
    );

    const client = new Client(
      { name: 'stackmemory-greptile', version: '1.0.0' },
      { capabilities: {} }
    );

    transport.onclose = () => {
      this.client = null;
      this.transport = null;
    };

    await client.connect(transport);

    this.client = client;
    this.transport = transport;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const client = await this.ensureConnected();

    const result = await client.callTool({ name, arguments: args });

    // Extract text content from MCP result
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter(
          (c: { type: string; text?: string }) =>
            c.type === 'text' && typeof c.text === 'string'
        )
        .map((c: { type: string; text?: string }) => c.text!);

      if (textParts.length === 0) return result;

      const combined = textParts.join('\n');
      try {
        return JSON.parse(combined);
      } catch {
        return combined;
      }
    }

    return result;
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
    }
    this.client = null;
    this.transport = null;
    this.connecting = null;
  }
}
