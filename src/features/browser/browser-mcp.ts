/**
 * Browser MCP Integration for StackMemory
 * Provides browser automation capabilities through MCP
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import puppeteer, { Browser, Page } from 'puppeteer';
import { logger } from '../../core/monitoring/logger.js';

export interface BrowserAction {
  type: 'navigate' | 'click' | 'type' | 'screenshot' | 'evaluate' | 'wait';
  selector?: string;
  value?: string;
  script?: string;
  timeout?: number;
}

export interface BrowserSession {
  id: string;
  browser: Browser;
  page: Page;
  createdAt: Date;
  lastActivity: Date;
  url?: string;
}

export class BrowserMCPIntegration {
  private sessions: Map<string, BrowserSession> = new Map();
  private server?: Server;
  private maxSessions = 5;
  private sessionTimeout = 30 * 60 * 1000; // 30 minutes

  constructor(
    private config: {
      headless?: boolean;
      defaultViewport?: { width: number; height: number };
      userDataDir?: string;
      executablePath?: string;
    } = {}
  ) {
    this.startCleanupInterval();
  }

  /**
   * Initialize the Browser MCP server
   */
  async initialize(mcpServer?: Server): Promise<void> {
    this.server =
      mcpServer ||
      new Server(
        {
          name: 'stackmemory-browser',
          version: '1.0.0',
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

    this.setupHandlers();
    logger.info('Browser MCP integration initialized');
  }

  /**
   * Set up MCP request handlers
   */
  private setupHandlers(): void {
    if (!this.server) return;

    // List available browser tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'browser_navigate',
          description: 'Navigate to a URL in the browser',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to navigate to' },
              sessionId: { type: 'string', description: 'Optional session ID' },
            },
            required: ['url'],
          },
        },
        {
          name: 'browser_screenshot',
          description: 'Take a screenshot of the current page',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              fullPage: { type: 'boolean', description: 'Capture full page' },
              selector: {
                type: 'string',
                description: 'CSS selector to screenshot',
              },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'browser_click',
          description: 'Click an element on the page',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              selector: {
                type: 'string',
                description: 'CSS selector to click',
              },
            },
            required: ['sessionId', 'selector'],
          },
        },
        {
          name: 'browser_type',
          description: 'Type text into an input field',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              selector: {
                type: 'string',
                description: 'CSS selector of input',
              },
              text: { type: 'string', description: 'Text to type' },
            },
            required: ['sessionId', 'selector', 'text'],
          },
        },
        {
          name: 'browser_evaluate',
          description: 'Execute JavaScript in the browser context',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              script: {
                type: 'string',
                description: 'JavaScript code to execute',
              },
            },
            required: ['sessionId', 'script'],
          },
        },
        {
          name: 'browser_wait',
          description: 'Wait for an element or condition',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              selector: {
                type: 'string',
                description: 'CSS selector to wait for',
              },
              timeout: {
                type: 'number',
                description: 'Timeout in milliseconds',
              },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'browser_get_content',
          description: 'Get the text content of the page or element',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              selector: {
                type: 'string',
                description: 'CSS selector (optional)',
              },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'browser_close',
          description: 'Close a browser session',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID to close' },
            },
            required: ['sessionId'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'browser_navigate':
            return await this.navigate(
              String(args.url),
              args.sessionId as string
            );

          case 'browser_screenshot':
            return await this.screenshot(
              String(args.sessionId),
              args.fullPage as boolean,
              args.selector as string
            );

          case 'browser_click':
            return await this.click(
              String(args.sessionId),
              String(args.selector)
            );

          case 'browser_type':
            return await this.type(
              String(args.sessionId),
              String(args.selector),
              String(args.text)
            );

          case 'browser_evaluate':
            return await this.evaluate(
              String(args.sessionId),
              String(args.script)
            );

          case 'browser_wait':
            return await this.waitFor(
              String(args.sessionId),
              args.selector as string,
              args.timeout as number
            );

          case 'browser_get_content':
            return await this.getContent(
              String(args.sessionId),
              args.selector as string
            );

          case 'browser_close':
            return await this.closeSession(String(args.sessionId));

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error: any) {
        logger.error('Browser MCP tool error', error);
        throw new McpError(ErrorCode.InternalError, error.message);
      }
    });
  }

  /**
   * Navigate to a URL
   */
  private async navigate(url: string, sessionId?: string): Promise<any> {
    const session = await this.getOrCreateSession(sessionId);

    await session.page.goto(url, { waitUntil: 'networkidle2' });
    session.url = url;
    session.lastActivity = new Date();

    logger.info(`Browser navigated to ${url}`, { sessionId: session.id });

    return {
      content: [
        {
          type: 'text',
          text: `Navigated to ${url}`,
        },
      ],
      sessionId: session.id,
      url,
    };
  }

  /**
   * Take a screenshot
   */
  private async screenshot(
    sessionId: string,
    fullPage = false,
    selector?: string
  ): Promise<any> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    let screenshot: Buffer;

    if (selector) {
      const element = await session.page.$(selector);
      if (!element) {
        throw new Error(`Element ${selector} not found`);
      }
      screenshot = Buffer.from(await element.screenshot());
    } else {
      screenshot = Buffer.from(await session.page.screenshot({ fullPage }));
    }

    session.lastActivity = new Date();

    return {
      content: [
        {
          type: 'image',
          data: screenshot.toString('base64'),
        },
      ],
      sessionId: session.id,
    };
  }

  /**
   * Click an element
   */
  private async click(sessionId: string, selector: string): Promise<any> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    await session.page.click(selector);
    session.lastActivity = new Date();

    return {
      content: [
        {
          type: 'text',
          text: `Clicked element: ${selector}`,
        },
      ],
      sessionId: session.id,
    };
  }

  /**
   * Type text into an input
   */
  private async type(
    sessionId: string,
    selector: string,
    text: string
  ): Promise<any> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    await session.page.type(selector, text);
    session.lastActivity = new Date();

    return {
      content: [
        {
          type: 'text',
          text: `Typed "${text}" into ${selector}`,
        },
      ],
      sessionId: session.id,
    };
  }

  /**
   * Execute JavaScript in page context
   */
  private async evaluate(sessionId: string, script: string): Promise<any> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const result = await session.page.evaluate(script);
    session.lastActivity = new Date();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      sessionId: session.id,
      result,
    };
  }

  /**
   * Wait for element or timeout
   */
  private async waitFor(
    sessionId: string,
    selector?: string,
    timeout = 5000
  ): Promise<any> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (selector) {
      await session.page.waitForSelector(selector, { timeout });
    } else {
      await new Promise((resolve) => setTimeout(resolve, timeout));
    }

    session.lastActivity = new Date();

    return {
      content: [
        {
          type: 'text',
          text: selector ? `Element ${selector} found` : `Waited ${timeout}ms`,
        },
      ],
      sessionId: session.id,
    };
  }

  /**
   * Get page content
   */
  private async getContent(sessionId: string, selector?: string): Promise<any> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    let content: string;

    if (selector) {
      content = await session.page.$eval(
        selector,
        (el) => el.textContent || ''
      );
    } else {
      content = await session.page.content();
    }

    session.lastActivity = new Date();

    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
      sessionId: session.id,
    };
  }

  /**
   * Get or create a browser session
   */
  private async getOrCreateSession(
    sessionId?: string
  ): Promise<BrowserSession> {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.lastActivity = new Date();
        return existing;
      }
    }

    // Clean up old sessions if at max
    if (this.sessions.size >= this.maxSessions) {
      const oldest = Array.from(this.sessions.values()).sort(
        (a, b) => a.lastActivity.getTime() - b.lastActivity.getTime()
      )[0];
      await this.closeSession(oldest.id);
    }

    // Create new session
    const browser = await puppeteer.launch({
      headless: this.config.headless ?? true,
      defaultViewport: this.config.defaultViewport || {
        width: 1280,
        height: 720,
      },
      userDataDir: this.config.userDataDir,
      executablePath: this.config.executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // For Railway/Docker
    });

    const page = await browser.newPage();
    const id = sessionId || `session-${Date.now()}`;

    const session: BrowserSession = {
      id,
      browser,
      page,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.sessions.set(id, session);
    logger.info(`Created browser session ${id}`);

    return session;
  }

  /**
   * Get existing session
   */
  private getSession(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Close a browser session
   */
  private async closeSession(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: `Session ${sessionId} not found`,
          },
        ],
      };
    }

    await session.browser.close();
    this.sessions.delete(sessionId);

    logger.info(`Closed browser session ${sessionId}`);

    return {
      content: [
        {
          type: 'text',
          text: `Session ${sessionId} closed`,
        },
      ],
    };
  }

  /**
   * Clean up inactive sessions
   */
  private startCleanupInterval(): void {
    setInterval(async () => {
      const now = Date.now();

      for (const [id, session] of this.sessions.entries()) {
        const inactiveTime = now - session.lastActivity.getTime();

        if (inactiveTime > this.sessionTimeout) {
          logger.info(`Cleaning up inactive session ${id}`);
          await this.closeSession(id);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Close all sessions
   */
  async cleanup(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      await this.closeSession(sessionId);
    }
  }
}
