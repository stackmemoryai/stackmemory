/**
 * OAuth Callback Server for Linear Integration
 * Handles the OAuth callback redirect and completes the authentication flow
 */

import express from 'express';
import http from 'http';
import { URL } from 'url';
import { logger } from '../../core/monitoring/logger.js';
import { LinearAuthManager } from './auth.js';
import chalk from 'chalk';
import { IntegrationError, ErrorCode } from '../../core/errors/index.js';
// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new IntegrationError(
      `Environment variable ${key} is required`,
      ErrorCode.LINEAR_AUTH_FAILED
    );
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

export interface OAuthServerConfig {
  port?: number;
  host?: string;
  redirectPath?: string;
  autoShutdown?: boolean;
  shutdownDelay?: number;
}

export class LinearOAuthServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private authManager: LinearAuthManager;
  private config: OAuthServerConfig;
  private pendingCodeVerifiers: Map<string, string> = new Map();
  private authCompleteCallbacks: Map<string, (success: boolean) => void> =
    new Map();

  constructor(projectRoot: string, config?: OAuthServerConfig) {
    this.app = express();
    this.authManager = new LinearAuthManager(projectRoot);

    this.config = {
      port: config?.port || 3456,
      host: config?.host || 'localhost',
      redirectPath: config?.redirectPath || '/auth/linear/callback',
      autoShutdown: config?.autoShutdown !== false,
      shutdownDelay: config?.shutdownDelay || 5000,
    };

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        service: 'linear-oauth',
        timestamp: new Date().toISOString(),
      });
    });

    // OAuth callback endpoint
    this.app.get(this.config.redirectPath!, async (req, res) => {
      const { code, state, error, error_description } = req.query;

      // Handle OAuth errors
      if (error) {
        logger.error(`OAuth error: ${error} - ${error_description}`);
        res.send(
          this.generateErrorPage(
            'Authorization Failed',
            `${error}: ${error_description || 'An error occurred during authorization'}`
          )
        );

        if (state && this.authCompleteCallbacks.has(state as string)) {
          this.authCompleteCallbacks.get(state as string)!(false);
          this.authCompleteCallbacks.delete(state as string);
        }

        this.scheduleShutdown();
        return;
      }

      // Validate required parameters
      if (!code) {
        res.send(
          this.generateErrorPage(
            'Missing Authorization Code',
            'No authorization code was provided in the callback'
          )
        );
        this.scheduleShutdown();
        return;
      }

      try {
        // Get the code verifier for this session
        const codeVerifier = state
          ? this.pendingCodeVerifiers.get(state as string)
          : process.env['_LINEAR_CODE_VERIFIER'];

        if (!codeVerifier) {
          throw new IntegrationError(
            'Code verifier not found. Please restart the authorization process.',
            ErrorCode.LINEAR_AUTH_FAILED
          );
        }

        // Exchange code for tokens
        logger.info('Exchanging authorization code for tokens...');
        await this.authManager.exchangeCodeForToken(
          code as string,
          codeVerifier
        );

        // Clean up
        if (state) {
          this.pendingCodeVerifiers.delete(state as string);
        }
        delete process.env['_LINEAR_CODE_VERIFIER'];

        // Test the connection
        const testSuccess = await this.testConnection();

        if (testSuccess) {
          res.send(this.generateSuccessPage());
          logger.info('Linear OAuth authentication completed successfully!');
        } else {
          throw new IntegrationError(
            'Failed to verify Linear connection',
            ErrorCode.LINEAR_AUTH_FAILED
          );
        }

        // Notify callback if registered
        if (state && this.authCompleteCallbacks.has(state as string)) {
          this.authCompleteCallbacks.get(state as string)!(true);
          this.authCompleteCallbacks.delete(state as string);
        }

        // Schedule server shutdown if auto-shutdown is enabled
        this.scheduleShutdown();
      } catch (error: unknown) {
        logger.error('Failed to complete OAuth flow:', error as Error);
        res.send(
          this.generateErrorPage(
            'Authentication Failed',
            (error as Error).message
          )
        );

        if (state && this.authCompleteCallbacks.has(state as string)) {
          this.authCompleteCallbacks.get(state as string)!(false);
          this.authCompleteCallbacks.delete(state as string);
        }

        this.scheduleShutdown();
      }
    });

    // Start OAuth flow endpoint
    this.app.get('/auth/linear/start', (req, res) => {
      try {
        const config = this.authManager.loadConfig();
        if (!config) {
          res
            .status(400)
            .send(
              this.generateErrorPage(
                'Configuration Missing',
                'Linear OAuth configuration not found. Please configure your client ID and secret.'
              )
            );
          return;
        }

        // Generate state for CSRF protection
        const state = this.generateState();
        const { url, codeVerifier } = this.authManager.generateAuthUrl(state);

        // Store code verifier for this session
        this.pendingCodeVerifiers.set(state, codeVerifier);

        // Redirect to Linear OAuth page
        res.redirect(url);
      } catch (error: unknown) {
        logger.error('Failed to start OAuth flow:', error as Error);
        res
          .status(500)
          .send(
            this.generateErrorPage(
              'OAuth Start Failed',
              (error as Error).message
            )
          );
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  private generateState(): string {
    return (
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15)
    );
  }

  private generateSuccessPage(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Linear Authorization Successful</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
          }
          h1 {
            color: #2d3748;
            margin-bottom: 1rem;
          }
          .success-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
          }
          p {
            color: #4a5568;
            line-height: 1.6;
            margin: 1rem 0;
          }
          .close-note {
            color: #718096;
            font-size: 0.875rem;
            margin-top: 2rem;
          }
          code {
            background: #f7fafc;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success-icon">✅</div>
          <h1>Authorization Successful!</h1>
          <p>Your Linear account has been successfully connected to StackMemory.</p>
          <p>You can now use Linear integration features:</p>
          <p><code>stackmemory linear sync</code></p>
          <p><code>stackmemory linear create</code></p>
          <p class="close-note">You can safely close this window and return to your terminal.</p>
        </div>
      </body>
      </html>
    `;
  }

  private generateErrorPage(title: string, message: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          }
          .container {
            background: white;
            padding: 3rem;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
          }
          h1 {
            color: #e53e3e;
            margin-bottom: 1rem;
          }
          .error-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
          }
          p {
            color: #4a5568;
            line-height: 1.6;
            margin: 1rem 0;
          }
          .error-message {
            background: #fff5f5;
            border: 1px solid #fed7d7;
            color: #742a2a;
            padding: 1rem;
            border-radius: 6px;
            margin-top: 1rem;
            font-size: 0.875rem;
          }
          .retry-note {
            color: #718096;
            font-size: 0.875rem;
            margin-top: 2rem;
          }
          code {
            background: #f7fafc;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error-icon">❌</div>
          <h1>${title}</h1>
          <p>Unable to complete Linear authorization.</p>
          <div class="error-message">${message}</div>
          <p class="retry-note">
            Please try again with:<br>
            <code>stackmemory linear auth</code>
          </p>
        </div>
      </body>
      </html>
    `;
  }

  private async testConnection(): Promise<boolean> {
    try {
      const token = await this.authManager.getValidToken();

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
    } catch (error: unknown) {
      logger.error('Linear connection test failed:', error as Error);
      return false;
    }
  }

  private scheduleShutdown(): void {
    if (this.config.autoShutdown && this.server) {
      setTimeout(() => {
        logger.info('Auto-shutting down OAuth server...');
        this.stop();
      }, this.config.shutdownDelay);
    }
  }

  public async start(): Promise<{ url: string; codeVerifier?: string }> {
    return new Promise((resolve, reject) => {
      try {
        // Load config and generate auth URL
        const config = this.authManager.loadConfig();
        if (!config) {
          // If no config, provide setup instructions
          const setupUrl = `http://${this.config.host}:${this.config.port}/auth/linear/start`;

          this.server = this.app.listen(
            this.config.port!,
            this.config.host!,
            () => {
              console.log(
                chalk.green('✓') + chalk.bold(' Linear OAuth Server Started')
              );
              console.log(chalk.cyan('  Authorization URL: ') + setupUrl);
              console.log(
                chalk.cyan('  Callback URL: ') +
                  `http://${this.config.host}:${this.config.port}${this.config.redirectPath}`
              );
              console.log('');
              console.log(chalk.yellow('  ⚠ Configuration Required:'));
              console.log(
                '  1. Create a Linear OAuth app at: https://linear.app/settings/api'
              );
              console.log(
                `  2. Set redirect URI to: http://${this.config.host}:${this.config.port}${this.config.redirectPath}`
              );
              console.log('  3. Set environment variables:');
              console.log('     export LINEAR_CLIENT_ID="your_client_id"');
              console.log(
                '     export LINEAR_CLIENT_SECRET="your_client_secret"'
              );
              console.log('  4. Restart the auth process');

              resolve({ url: setupUrl });
            }
          );
          return;
        }

        // Generate state and auth URL
        const state = this.generateState();
        const { url, codeVerifier } = this.authManager.generateAuthUrl(state);

        // Store code verifier
        this.pendingCodeVerifiers.set(state, codeVerifier);

        this.server = this.app.listen(
          this.config.port!,
          this.config.host!,
          () => {
            console.log(
              chalk.green('✓') + chalk.bold(' Linear OAuth Server Started')
            );
            console.log(chalk.cyan('  Open this URL in your browser:'));
            console.log('  ' + chalk.underline(url));
            console.log('');
            console.log(
              chalk.gray(
                '  The server will automatically shut down after authorization completes.'
              )
            );

            resolve({ url, codeVerifier });
          }
        );

        // Register auth complete callback
        this.authCompleteCallbacks.set(state, (success) => {
          if (success) {
            console.log(
              chalk.green('\n✓ Linear authorization completed successfully!')
            );
          } else {
            console.log(chalk.red('\n✗ Linear authorization failed'));
          }
        });
      } catch (error: unknown) {
        reject(error);
      }
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('OAuth server stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public async waitForAuth(
    state: string,
    timeout: number = 300000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.authCompleteCallbacks.delete(state);
        resolve(false);
      }, timeout);

      this.authCompleteCallbacks.set(state, (success) => {
        clearTimeout(timeoutId);
        resolve(success);
      });
    });
  }
}

// Standalone execution support
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const projectRoot = process.cwd();
  const server = new LinearOAuthServer(projectRoot, {
    autoShutdown: true,
    shutdownDelay: 5000,
  });

  server
    .start()
    .then(({ url }) => {
      if (url) {
        console.log(chalk.cyan('\nWaiting for authorization...'));
        console.log(chalk.gray('Press Ctrl+C to cancel\n'));
      }
    })
    .catch((error) => {
      console.error(chalk.red('Failed to start OAuth server:'), error);
      process.exit(1);
    });

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\nShutting down OAuth server...'));
    await server.stop();
    process.exit(0);
  });
}
