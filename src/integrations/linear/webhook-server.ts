#!/usr/bin/env node

import express from 'express';
import crypto from 'crypto';
import http from 'http';
import {
  LinearWebhookPayload,
  LinearIssue,
  LinearComment,
  LinearProject,
} from './types.js';
import { LinearSyncService } from './sync-service.js';
import { LinearIssue as ClientLinearIssue } from './client.js';
import { IntegrationError, ErrorCode } from '../../core/errors/index.js';
import { logger } from '../../core/monitoring/logger.js';
import { WebhookDeliveryQueue } from './webhook-retry.js';
import chalk from 'chalk';
import { join } from 'path';
import { homedir } from 'os';
// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new IntegrationError(
      `Environment variable ${key} is required`,
      ErrorCode.LINEAR_WEBHOOK_FAILED
    );
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

export interface WebhookServerConfig {
  port?: number;
  host?: string;
  webhookSecret?: string;
  maxPayloadSize?: string;
  dbPath?: string;
  rateLimit?: {
    windowMs?: number;
    max?: number;
  };
}

export class LinearWebhookServer {
  private app: express.Application;
  private server: http.Server | null = null;
  // Using singleton logger from monitoring
  private syncService: LinearSyncService;
  private config: WebhookServerConfig;
  private deliveryQueue: WebhookDeliveryQueue;

  constructor(config?: WebhookServerConfig) {
    this.app = express();
    // Use singleton logger
    this.syncService = new LinearSyncService();

    const dbPath =
      config?.dbPath ||
      join(homedir(), '.stackmemory', 'webhook-deliveries.db');

    this.config = {
      port: config?.port || parseInt(process.env['WEBHOOK_PORT'] || '3456'),
      host: config?.host || process.env['WEBHOOK_HOST'] || 'localhost',
      webhookSecret:
        config?.webhookSecret || process.env['LINEAR_WEBHOOK_SECRET'],
      maxPayloadSize: config?.maxPayloadSize || '10mb',
      dbPath,
      rateLimit: {
        windowMs: config?.rateLimit?.windowMs || 60000,
        max: config?.rateLimit?.max || 100,
      },
    };

    this.deliveryQueue = new WebhookDeliveryQueue(dbPath);
    this.deliveryQueue.setHandler(
      async (eventType: string, payload: unknown) => {
        await this.handleWebhookEvent(payload as LinearWebhookPayload);
      }
    );

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(
      express.raw({
        type: 'application/json',
        limit: this.config.maxPayloadSize,
      })
    );

    this.app.use((req, res, next) => {
      res.setHeader('X-Powered-By', 'StackMemory');
      next();
    });
  }

  private setupRoutes(): void {
    this.app.get('/health', (req, res) => {
      const stats = this.deliveryQueue.getStats();
      res.json({
        status: 'healthy',
        service: 'linear-webhook',
        timestamp: new Date().toISOString(),
        deliveries: stats,
      });
    });

    this.app.post('/webhook/linear', async (req, res) => {
      try {
        if (!this.verifyWebhookSignature(req)) {
          logger.warn('Invalid webhook signature');
          return res.status(401).json({ error: 'Unauthorized' });
        }

        const payload = JSON.parse(req.body.toString()) as LinearWebhookPayload;

        logger.info(`Received webhook: ${payload.type} - ${payload.action}`);

        const deliveryId = this.deliveryQueue.enqueue(payload.type, payload);

        return res.status(200).json({
          status: 'accepted',
          deliveryId,
        });
      } catch (error: unknown) {
        logger.error('Webhook processing error:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  private verifyWebhookSignature(req: express.Request): boolean {
    if (!this.config.webhookSecret) {
      logger.warn('No webhook secret configured, accepting all webhooks');
      return true;
    }

    const signature = req.headers['linear-signature'] as string;
    if (!signature) {
      return false;
    }

    const hash = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(req.body)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
  }

  private async handleWebhookEvent(
    payload: LinearWebhookPayload
  ): Promise<void> {
    const { type, action, data } = payload;

    switch (type) {
      case 'Issue':
        await this.handleIssueEvent(action, data as LinearIssue);
        break;
      case 'Comment':
        await this.handleCommentEvent(action, data as LinearComment);
        break;
      case 'Project':
        await this.handleProjectEvent(action, data as LinearProject);
        break;
      default:
        logger.debug(`Unhandled event type: ${type}`);
    }
  }

  private async handleIssueEvent(
    action: string,
    data: LinearIssue
  ): Promise<void> {
    const issue = data as ClientLinearIssue;

    switch (action) {
      case 'create':
        logger.info(`New issue created: ${issue.identifier} - ${issue.title}`);
        await this.syncService.syncIssueToLocal(issue);
        break;
      case 'update':
        logger.info(`Issue updated: ${issue.identifier} - ${issue.title}`);
        await this.syncService.syncIssueToLocal(issue);
        break;
      case 'remove':
        logger.info(`Issue removed: ${issue.identifier}`);
        await this.syncService.removeLocalIssue(issue.identifier);
        break;
      default:
        logger.debug(`Unhandled issue action: ${action}`);
    }
  }

  private async handleCommentEvent(
    action: string,
    data: LinearComment
  ): Promise<void> {
    logger.debug(`Comment event: ${action}`, { issueId: data.issue?.id });
  }

  private async handleProjectEvent(
    action: string,
    data: LinearProject
  ): Promise<void> {
    logger.debug(`Project event: ${action}`, { projectId: data.id });
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(
        this.config.port!,
        this.config.host!,
        () => {
          this.deliveryQueue.startWorker();

          console.log(
            chalk.green('✓') + chalk.bold(' Linear Webhook Server Started')
          );
          console.log(
            chalk.cyan('  URL: ') +
              `http://${this.config.host}:${this.config.port}/webhook/linear`
          );
          console.log(
            chalk.cyan('  Health: ') +
              `http://${this.config.host}:${this.config.port}/health`
          );

          if (!this.config.webhookSecret) {
            console.log(
              chalk.yellow(
                '  ⚠ Warning: No webhook secret configured (insecure)'
              )
            );
          }

          resolve();
        }
      );
    });
  }

  public async stop(): Promise<void> {
    this.deliveryQueue.close();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Webhook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// Standalone execution support
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = new LinearWebhookServer();

  server.start().catch((error) => {
    console.error(chalk.red('Failed to start webhook server:'), error);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\nShutting down webhook server...'));
    await server.stop();
    process.exit(0);
  });
}
