/**
 * Tests for LinearAuthManager and LinearOAuthSetup
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { LinearAuthManager, LinearOAuthSetup, LinearTokens } from '../auth.js';
import { join } from 'path';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { tmpdir } from 'os';

// Mock fetch for HTTP requests
global.fetch = vi.fn();

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Helper to write tokens directly to file
function writeTokensToFile(tempDir: string, tokens: LinearTokens) {
  const stackmemoryDir = join(tempDir, '.stackmemory');
  if (!existsSync(stackmemoryDir)) {
    mkdirSync(stackmemoryDir, { recursive: true });
  }
  writeFileSync(
    join(stackmemoryDir, 'linear-tokens.json'),
    JSON.stringify(tokens, null, 2)
  );
}

// Helper to write config directly to file
function writeConfigToFile(tempDir: string, config: any) {
  const stackmemoryDir = join(tempDir, '.stackmemory');
  if (!existsSync(stackmemoryDir)) {
    mkdirSync(stackmemoryDir, { recursive: true });
  }
  writeFileSync(
    join(stackmemoryDir, 'linear-config.json'),
    JSON.stringify(config, null, 2)
  );
}

describe('LinearAuthManager', () => {
  let authManager: LinearAuthManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-auth-test-'));
    // Create .stackmemory directory
    mkdirSync(join(tempDir, '.stackmemory'), { recursive: true });
    authManager = new LinearAuthManager(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('Configuration Management', () => {
    it('should save and load configuration correctly', () => {
      const config = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      };

      authManager.saveConfig(config);

      const loadedConfig = authManager.loadConfig();
      expect(loadedConfig).toEqual(config);
    });

    it('should return null when no configuration exists', () => {
      const config = authManager.loadConfig();
      expect(config).toBeNull();
    });

    it('should detect if configured correctly', () => {
      // isConfigured checks for BOTH config AND tokens files
      expect(authManager.isConfigured()).toBe(false);

      // Save config
      authManager.saveConfig({
        clientId: 'test-id',
        clientSecret: 'test-secret',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      });

      // Still not configured without tokens
      expect(authManager.isConfigured()).toBe(false);

      // Write tokens file
      writeTokensToFile(tempDir, {
        accessToken: 'test-token',
        expiresAt: Date.now() + 3600000,
        scope: ['read', 'write'],
      });

      expect(authManager.isConfigured()).toBe(true);
    });

    it('should handle corrupted configuration gracefully', () => {
      const configPath = join(tempDir, '.stackmemory', 'linear-config.json');
      writeFileSync(configPath, 'invalid json');

      expect(authManager.loadConfig()).toBeNull();
    });
  });

  describe('Token Management', () => {
    beforeEach(() => {
      // Setup configuration first
      authManager.saveConfig({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      });
    });

    it('should load tokens correctly', () => {
      const tokens: LinearTokens = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600000,
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, tokens);

      const loadedTokens = authManager.loadTokens();
      expect(loadedTokens).toEqual(tokens);
    });

    it('should return null when no tokens exist', () => {
      const tokens = authManager.loadTokens();
      expect(tokens).toBeNull();
    });

    it('should handle corrupted tokens gracefully', () => {
      const tokensPath = join(tempDir, '.stackmemory', 'linear-tokens.json');
      writeFileSync(tokensPath, 'invalid json');

      expect(authManager.loadTokens()).toBeNull();
    });

    it('should refresh access token', async () => {
      const expiredTokens: LinearTokens = {
        accessToken: 'old-access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() - 1000,
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, expiredTokens);

      const refreshResponse = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
        scope: 'read write',
      };

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(refreshResponse),
      });

      const newTokens = await authManager.refreshAccessToken();

      expect(newTokens.accessToken).toBe('new-access-token');
      expect(newTokens.refreshToken).toBe('new-refresh-token');
      expect(newTokens.expiresAt).toBeGreaterThan(Date.now());

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.linear.app/oauth/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: expect.stringContaining('grant_type=refresh_token'),
        }
      );
    });

    it('should handle refresh token errors', async () => {
      const expiredTokens: LinearTokens = {
        accessToken: 'old-access-token',
        refreshToken: 'invalid-refresh-token',
        expiresAt: Date.now() - 1000,
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, expiredTokens);

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('{"error": "invalid_grant"}'),
      });

      await expect(authManager.refreshAccessToken()).rejects.toThrow(
        'Token refresh failed'
      );
    });

    it('should throw error when refreshing without refresh token', async () => {
      const tokensWithoutRefresh: LinearTokens = {
        accessToken: 'access-token',
        expiresAt: Date.now() - 1000,
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, tokensWithoutRefresh);

      await expect(authManager.refreshAccessToken()).rejects.toThrow(
        'No refresh token available'
      );
    });
  });

  describe('Token Auto-refresh (getValidToken)', () => {
    beforeEach(() => {
      authManager.saveConfig({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      });
    });

    it('should return valid token string without refresh', async () => {
      const validTokens: LinearTokens = {
        accessToken: 'valid-access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600000, // 1 hour from now
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, validTokens);

      const token = await authManager.getValidToken();

      // getValidToken returns the access token string
      expect(token).toBe('valid-access-token');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should automatically refresh expiring tokens', async () => {
      // Token expires in 4 minutes (less than 5 minute threshold)
      const expiringTokens: LinearTokens = {
        accessToken: 'expiring-access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 4 * 60 * 1000, // 4 minutes from now
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, expiringTokens);

      const refreshResponse = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
        scope: 'read write',
      };

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(refreshResponse),
      });

      const token = await authManager.getValidToken();

      expect(token).toBe('new-access-token');
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should throw error when tokens are not available', async () => {
      await expect(authManager.getValidToken()).rejects.toThrow(
        'No Linear tokens found'
      );
    });

    it('should throw error when refresh fails', async () => {
      const expiringTokens: LinearTokens = {
        accessToken: 'expiring-access-token',
        refreshToken: 'invalid-refresh-token',
        expiresAt: Date.now() + 1000, // Almost expired
        scope: ['read', 'write'],
      };

      writeTokensToFile(tempDir, expiringTokens);

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue('Unauthorized'),
      });

      await expect(authManager.getValidToken()).rejects.toThrow(
        'Token refresh failed'
      );
    });
  });

  describe('Cleanup Operations', () => {
    beforeEach(() => {
      authManager.saveConfig({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      });

      writeTokensToFile(tempDir, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600000,
        scope: ['read', 'write'],
      });
    });

    it('should clear all authentication data', () => {
      expect(authManager.isConfigured()).toBe(true);
      expect(authManager.loadTokens()).not.toBeNull();

      authManager.clearAuth();

      // clearAuth writes empty files
      expect(authManager.loadTokens()).toBeNull();
      expect(authManager.loadConfig()).toBeNull();
    });

    it('should handle clearing when files do not exist', () => {
      authManager.clearAuth(); // Clear once

      // Should not throw when clearing again
      expect(() => authManager.clearAuth()).not.toThrow();
    });
  });

  describe('OAuth URL Generation', () => {
    beforeEach(() => {
      authManager.saveConfig({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['read', 'write'],
      });
    });

    it('should generate authorization URL with PKCE', () => {
      const { url, codeVerifier } = authManager.generateAuthUrl('test-state');

      expect(url).toContain('https://linear.app/oauth/authorize');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain('response_type=code');
      expect(url).toContain('code_challenge=');
      expect(url).toContain('code_challenge_method=S256');
      expect(url).toContain('state=test-state');
      expect(codeVerifier).toBeDefined();
      expect(codeVerifier.length).toBeGreaterThan(10);
    });

    it('should throw error when config not loaded', () => {
      const newManager = new LinearAuthManager(tempDir);
      // Don't load config
      expect(() => newManager.generateAuthUrl()).toThrow(
        'configuration not loaded'
      );
    });
  });
});

describe('LinearOAuthSetup', () => {
  let oauthSetup: LinearOAuthSetup;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-oauth-test-'));
    mkdirSync(join(tempDir, '.stackmemory'), { recursive: true });
    oauthSetup = new LinearOAuthSetup(tempDir);
    vi.clearAllMocks();
    // Clear env vars
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    delete process.env._LINEAR_CODE_VERIFIER;
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    delete process.env._LINEAR_CODE_VERIFIER;
  });

  describe('Interactive Setup', () => {
    it('should return setup instructions when env vars not set', async () => {
      const result = await oauthSetup.setupInteractive();

      expect(result.instructions).toBeDefined();
      expect(Array.isArray(result.instructions)).toBe(true);
      expect(result.instructions.length).toBeGreaterThan(0);
      // When not configured, authUrl is empty
      expect(result.authUrl).toBe('');
    });

    it('should provide authorization URL when env vars are set', async () => {
      process.env.LINEAR_CLIENT_ID = 'test-client-id';
      process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';

      const result = await oauthSetup.setupInteractive();

      expect(result.authUrl).toContain('https://linear.app/oauth/authorize');
      expect(result.authUrl).toContain('client_id=test-client-id');
      expect(result.authUrl).toContain('redirect_uri=');
      expect(result.authUrl).toContain('response_type=code');
    });

    it('should save configuration during setup', async () => {
      process.env.LINEAR_CLIENT_ID = 'test-client-id';
      process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';

      await oauthSetup.setupInteractive();

      const authManager = new LinearAuthManager(tempDir);
      const config = authManager.loadConfig();

      expect(config).toBeDefined();
      expect(config!.clientId).toBe('test-client-id');
      expect(config!.clientSecret).toBe('test-client-secret');
    });

    it('should include code_challenge for PKCE', async () => {
      process.env.LINEAR_CLIENT_ID = 'test-client-id';
      process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';

      const result = await oauthSetup.setupInteractive();

      expect(result.authUrl).toContain('code_challenge=');
      expect(result.authUrl).toContain('code_challenge_method=S256');
    });
  });

  describe('Authorization Code Exchange', () => {
    beforeEach(async () => {
      process.env.LINEAR_CLIENT_ID = 'test-client-id';
      process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';
      await oauthSetup.setupInteractive(); // Initialize configuration and set code verifier
    });

    it('should complete authorization successfully', async () => {
      const tokenResponse = {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
        scope: 'read write',
      };

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(tokenResponse),
      });

      const success = await oauthSetup.completeAuth('auth-code-123');

      expect(success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.linear.app/oauth/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: expect.stringContaining('grant_type=authorization_code'),
        }
      );

      // Check that tokens were saved
      const authManager = new LinearAuthManager(tempDir);
      const tokens = authManager.loadTokens();
      expect(tokens).toBeDefined();
      expect(tokens!.accessToken).toBe('access-token');
    });

    it('should handle authorization errors', async () => {
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('{"error": "invalid_grant"}'),
      });

      const success = await oauthSetup.completeAuth('invalid-auth-code');

      expect(success).toBe(false);
    });

    it('should handle network errors during token exchange', async () => {
      (global.fetch as Mock).mockRejectedValueOnce(new Error('Network error'));

      const success = await oauthSetup.completeAuth('auth-code-123');

      expect(success).toBe(false);
    });

    it('should fail when code verifier not found', async () => {
      delete process.env._LINEAR_CODE_VERIFIER;

      const success = await oauthSetup.completeAuth('auth-code-123');

      expect(success).toBe(false);
    });
  });

  describe('Connection Testing', () => {
    beforeEach(async () => {
      process.env.LINEAR_CLIENT_ID = 'test-client-id';
      process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';
      await oauthSetup.setupInteractive(); // Initialize configuration

      // Set up valid tokens
      writeTokensToFile(tempDir, {
        accessToken: 'valid-access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600000,
        scope: ['read', 'write'],
      });
    });

    it('should test connection successfully with valid tokens', async () => {
      const userResponse = {
        data: {
          viewer: {
            id: 'user-1',
            name: 'Test User',
            email: 'test@example.com',
          },
        },
      };

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(userResponse),
      });

      const connectionOk = await oauthSetup.testConnection();

      expect(connectionOk).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.linear.app/graphql',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer valid-access-token',
            'Content-Type': 'application/json',
          },
          body: expect.stringContaining('viewer'),
        }
      );
    });

    it('should fail connection test with invalid tokens', async () => {
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const connectionOk = await oauthSetup.testConnection();

      expect(connectionOk).toBe(false);
    });

    it('should fail connection test when not configured', async () => {
      // Create unconfigured setup in new temp dir
      const newTempDir = mkdtempSync(
        join(tmpdir(), 'stackmemory-oauth-unconfigured-')
      );
      mkdirSync(join(newTempDir, '.stackmemory'), { recursive: true });
      const unconfiguredSetup = new LinearOAuthSetup(newTempDir);

      const connectionOk = await unconfiguredSetup.testConnection();

      expect(connectionOk).toBe(false);

      rmSync(newTempDir, { recursive: true, force: true });
    });

    it('should handle GraphQL errors in connection test', async () => {
      const errorResponse = {
        errors: [{ message: 'Authentication required' }],
      };

      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(errorResponse),
      });

      const connectionOk = await oauthSetup.testConnection();

      expect(connectionOk).toBe(false);
    });

    it('should handle network errors in connection test', async () => {
      (global.fetch as Mock).mockRejectedValueOnce(
        new Error('Network timeout')
      );

      const connectionOk = await oauthSetup.testConnection();

      expect(connectionOk).toBe(false);
    });

    it('should automatically refresh expiring tokens during connection test', async () => {
      // Set up expiring tokens
      writeTokensToFile(tempDir, {
        accessToken: 'expiring-access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60000, // 1 minute from now (within 5 min threshold)
        scope: ['read', 'write'],
      });

      const refreshResponse = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
        scope: 'read write',
      };

      const userResponse = {
        data: {
          viewer: {
            id: 'user-1',
            name: 'Test User',
            email: 'test@example.com',
          },
        },
      };

      // Mock token refresh then successful API call
      (global.fetch as Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(refreshResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(userResponse),
        });

      const connectionOk = await oauthSetup.testConnection();

      expect(connectionOk).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2); // Refresh + API call
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle missing Linear environment variables gracefully', async () => {
      delete process.env.LINEAR_CLIENT_ID;
      delete process.env.LINEAR_CLIENT_SECRET;

      const result = await oauthSetup.setupInteractive();

      // Should return instructions for setting up env vars
      expect(result.instructions.length).toBeGreaterThan(0);
    });

    it('should validate authorization URL format when configured', async () => {
      process.env.LINEAR_CLIENT_ID = 'test-client-id';
      process.env.LINEAR_CLIENT_SECRET = 'test-client-secret';

      const result = await oauthSetup.setupInteractive();

      expect(result.authUrl).toMatch(
        /^https:\/\/linear\.app\/oauth\/authorize\?/
      );

      const url = new URL(result.authUrl);
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBeDefined();
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBeDefined();
    });
  });
});
