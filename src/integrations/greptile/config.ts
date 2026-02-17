/**
 * Greptile Integration Configuration
 * Environment-driven config for Greptile MCP proxy
 */

export interface GreptileIntegrationConfig {
  enabled: boolean;
  mcpEndpoint: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_GREPTILE_CONFIG: GreptileIntegrationConfig = {
  enabled: !!process.env.GREPTILE_API_KEY,
  mcpEndpoint:
    process.env.GREPTILE_MCP_ENDPOINT || 'https://api.greptile.com/mcp',
  apiKey: process.env.GREPTILE_API_KEY || '',
  timeoutMs: 15000,
  maxRetries: 2,
};
