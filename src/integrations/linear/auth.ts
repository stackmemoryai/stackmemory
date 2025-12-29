/**
 * Linear OAuth Authentication Setup
 * Handles initial OAuth flow and token management for Linear integration
 */

import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../core/monitoring/logger.js';

export interface LinearAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface LinearTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix timestamp
  scope: string[];
}

export interface LinearAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
  tokenType: string;
}

export class LinearAuthManager {
  private configPath: string;
  private tokensPath: string;
  private config?: LinearAuthConfig;

  constructor(projectRoot: string) {
    const configDir = join(projectRoot, '.stackmemory');
    this.configPath = join(configDir, 'linear-config.json');
    this.tokensPath = join(configDir, 'linear-tokens.json');
  }

  /**
   * Check if Linear integration is configured
   */
  isConfigured(): boolean {
    return existsSync(this.configPath) && existsSync(this.tokensPath);
  }

  /**
   * Save OAuth application configuration
   */
  saveConfig(config: LinearAuthConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.config = config;
    logger.info('Linear OAuth configuration saved');
  }

  /**
   * Load OAuth configuration
   */
  loadConfig(): LinearAuthConfig | null {
    if (!existsSync(this.configPath)) {
      return null;
    }

    try {
      const configData = readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      return this.config!;
    } catch (error) {
      logger.error('Failed to load Linear configuration:', error as Error);
      return null;
    }
  }

  /**
   * Generate OAuth authorization URL with PKCE
   */
  generateAuthUrl(state?: string): { url: string; codeVerifier: string } {
    if (!this.config) {
      throw new Error('Linear OAuth configuration not loaded');
    }

    // Generate PKCE parameters
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      actor: 'app', // Enable actor authorization for service accounts
    });

    if (state) {
      params.set('state', state);
    }

    const authUrl = `https://linear.app/oauth/authorize?${params.toString()}`;

    return { url: authUrl, codeVerifier };
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    authCode: string,
    codeVerifier: string
  ): Promise<LinearTokens> {
    if (!this.config) {
      throw new Error('Linear OAuth configuration not loaded');
    }

    const tokenUrl = 'https://api.linear.app/oauth/token';

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      code: authCode,
      code_verifier: codeVerifier,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as LinearAuthResult;

    // Calculate expiration time (tokens expire in 24 hours)
    const expiresAt = Date.now() + result.expiresIn * 1000;

    const tokens: LinearTokens = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt,
      scope: result.scope.split(' '),
    };

    this.saveTokens(tokens);
    return tokens;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(): Promise<LinearTokens> {
    if (!this.config) {
      throw new Error('Linear OAuth configuration not loaded');
    }

    const currentTokens = this.loadTokens();
    if (!currentTokens?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const tokenUrl = 'https://api.linear.app/oauth/token';

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: currentTokens.refreshToken,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as LinearAuthResult;

    const tokens: LinearTokens = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || currentTokens.refreshToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
      scope: result.scope.split(' '),
    };

    this.saveTokens(tokens);
    return tokens;
  }

  /**
   * Get valid access token (refresh if needed)
   */
  async getValidToken(): Promise<string> {
    const tokens = this.loadTokens();
    if (!tokens) {
      throw new Error('No Linear tokens found. Please complete OAuth setup.');
    }

    // Check if token expires in next 5 minutes
    const fiveMinutes = 5 * 60 * 1000;
    if (tokens.expiresAt - Date.now() < fiveMinutes) {
      logger.info('Linear token expiring soon, refreshing...');
      const newTokens = await this.refreshAccessToken();
      return newTokens.accessToken;
    }

    return tokens.accessToken;
  }

  /**
   * Save tokens to file
   */
  private saveTokens(tokens: LinearTokens): void {
    writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2));
    logger.info('Linear tokens saved');
  }

  /**
   * Load tokens from file
   */
  loadTokens(): LinearTokens | null {
    if (!existsSync(this.tokensPath)) {
      return null;
    }

    try {
      const tokensData = readFileSync(this.tokensPath, 'utf8');
      return JSON.parse(tokensData);
    } catch (error) {
      logger.error('Failed to load Linear tokens:', error as Error);
      return null;
    }
  }

  /**
   * Clear stored tokens and config
   */
  clearAuth(): void {
    if (existsSync(this.tokensPath)) {
      writeFileSync(this.tokensPath, '');
    }
    if (existsSync(this.configPath)) {
      writeFileSync(this.configPath, '');
    }
    logger.info('Linear authentication cleared');
  }
}

/**
 * Default Linear OAuth scopes for task management
 */
export const DEFAULT_LINEAR_SCOPES = [
  'read', // Read issues, projects, teams
  'write', // Create and update issues
  'admin', // Manage team settings and workflows
];

/**
 * Linear OAuth setup helper
 */
export class LinearOAuthSetup {
  private authManager: LinearAuthManager;

  constructor(projectRoot: string) {
    this.authManager = new LinearAuthManager(projectRoot);
  }

  /**
   * Interactive setup for Linear OAuth
   */
  async setupInteractive(): Promise<{
    authUrl: string;
    instructions: string[];
  }> {
    // For now, we'll provide manual setup instructions
    // In a full implementation, this could open a browser or use a local server

    const config: LinearAuthConfig = {
      clientId: process.env.LINEAR_CLIENT_ID || '',
      clientSecret: process.env.LINEAR_CLIENT_SECRET || '',
      redirectUri:
        process.env.LINEAR_REDIRECT_URI ||
        'http://localhost:3456/auth/linear/callback',
      scopes: DEFAULT_LINEAR_SCOPES,
    };

    if (!config.clientId || !config.clientSecret) {
      return {
        authUrl: '',
        instructions: [
          '1. Create a Linear OAuth application at https://linear.app/settings/api',
          '2. Set redirect URI to: http://localhost:3456/auth/linear/callback',
          '3. Copy your Client ID and Client Secret',
          '4. Set environment variables:',
          '   export LINEAR_CLIENT_ID="your_client_id"',
          '   export LINEAR_CLIENT_SECRET="your_client_secret"',
          '5. Re-run this setup command',
        ],
      };
    }

    this.authManager.saveConfig(config);

    const { url, codeVerifier } = this.authManager.generateAuthUrl();

    // Store code verifier temporarily (in a real app, this would be in a secure session store)
    process.env._LINEAR_CODE_VERIFIER = codeVerifier;

    return {
      authUrl: url,
      instructions: [
        '1. Open this URL in your browser:',
        url,
        '',
        '2. Approve the StackMemory integration',
        '3. Copy the authorization code from the redirect URL',
        '4. Run: stackmemory linear authorize <code>',
      ],
    };
  }

  /**
   * Complete OAuth flow with authorization code
   */
  async completeAuth(authCode: string): Promise<boolean> {
    try {
      const codeVerifier = process.env._LINEAR_CODE_VERIFIER;
      if (!codeVerifier) {
        throw new Error(
          'Code verifier not found. Please restart the setup process.'
        );
      }

      await this.authManager.exchangeCodeForToken(authCode, codeVerifier);
      delete process.env._LINEAR_CODE_VERIFIER;

      logger.info('Linear OAuth setup completed successfully!');
      return true;
    } catch (error) {
      logger.error('Failed to complete Linear OAuth setup:', error as Error);
      return false;
    }
  }

  /**
   * Test the Linear connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const token = await this.authManager.getValidToken();

      // Test with a simple GraphQL query
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: 'query { viewer { id name email } }',
        }),
      });

      if (response.ok) {
        const result = (await response.json()) as {
          data?: { viewer?: { id: string; name: string; email: string } };
        };
        if (result.data?.viewer) {
          logger.info(
            `Connected to Linear as: ${result.data.viewer.name} (${result.data.viewer.email})`
          );
          return true;
        }
      }

      return false;
    } catch (error) {
      logger.error('Linear connection test failed:', error as Error);
      return false;
    }
  }
}
