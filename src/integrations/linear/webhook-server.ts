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
import { Logger } from '../../utils/logger.js';
import chalk from 'chalk';

export interface WebhookServerConfig {
  port?: number;
  host?: string;
  webhookSecret?: string;
  maxPayloadSize?: string;
  rateLimit?: {
    windowMs?: number;
    max?: number;
  };
}

export class LinearWebhookServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private logger: Logger;
  private syncService: LinearSyncService;
  private config: WebhookServerConfig;
  private eventQueue: LinearWebhookPayload[] = [];
  private isProcessing = false;

  constructor(config?: WebhookServerConfig) {
    this.app = express();
    this.logger = new Logger('LinearWebhook');
    this.syncService = new LinearSyncService();

    this.config = {
      port: config?.port || parseInt(process.env.WEBHOOK_PORT || '3456'),
      host: config?.host || process.env.WEBHOOK_HOST || 'localhost',
      webhookSecret: config?.webhookSecret || process.env.LINEAR_WEBHOOK_SECRET,
      maxPayloadSize: config?.maxPayloadSize || '10mb',
      rateLimit: {
        windowMs: config?.rateLimit?.windowMs || 60000,
        max: config?.rateLimit?.max || 100,
      },
    };

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
      res.json({
        status: 'healthy',
        service: 'linear-webhook',
        timestamp: new Date().toISOString(),
        queue: this.eventQueue.length,
        processing: this.isProcessing,
      });
    });

    this.app.post('/webhook/linear', async (req, res) => {
      try {
        if (!this.verifyWebhookSignature(req)) {
          this.logger.warn('Invalid webhook signature');
          return res.status(401).json({ error: 'Unauthorized' });
        }

        const payload = JSON.parse(req.body.toString()) as LinearWebhookPayload;

        this.logger.info(
          `Received webhook: ${payload.type} - ${payload.action}`
        );

        this.eventQueue.push(payload);
        this.processQueue();

        res.status(200).json({
          status: 'accepted',
          queued: true,
        });
      } catch (error) {
        this.logger.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  }

  private verifyWebhookSignature(req: express.Request): boolean {
    if (!this.config.webhookSecret) {
      this.logger.warn('No webhook secret configured, accepting all webhooks');
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

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.eventQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!;

      try {
        await this.handleWebhookEvent(event);
      } catch (error) {
        this.logger.error(`Failed to process event: ${event.type}`, error);
      }
    }

    this.isProcessing = false;
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
        this.logger.debug(`Unhandled event type: ${type}`);
    }
  }

  private async handleIssueEvent(
    action: string,
    data: LinearIssue
  ): Promise<void> {
    const issue = data as ClientLinearIssue;

    switch (action) {
      case 'create':
        this.logger.info(
          `New issue created: ${issue.identifier} - ${issue.title}`
        );
        await this.syncService.syncIssueToLocal(issue);
        break;
      case 'update':
        this.logger.info(`Issue updated: ${issue.identifier} - ${issue.title}`);
        await this.syncService.syncIssueToLocal(issue);
        break;
      case 'remove':
        this.logger.info(`Issue removed: ${issue.identifier}`);
        await this.syncService.removeLocalIssue(issue.identifier);
        break;
      default:
        this.logger.debug(`Unhandled issue action: ${action}`);
    }
  }

  private async handleCommentEvent(
    action: string,
    data: LinearComment
  ): Promise<void> {
    this.logger.debug(`Comment event: ${action}`, { issueId: data.issue?.id });
  }

  private async handleProjectEvent(
    action: string,
    data: LinearProject
  ): Promise<void> {
    this.logger.debug(`Project event: ${action}`, { projectId: data.id });
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(
        this.config.port!,
        this.config.host!,
        () => {
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
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Webhook server stopped');
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
