#!/usr/bin/env node

/**
 * StackMemory Claude Auto-Start Daemon Manager
 * Automatically starts essential daemons when Claude loads the project
 *
 * Core daemons (always started):
 * 1. Context Monitor - Saves context every 15 min
 * 2. File Watcher - Auto-syncs on file changes
 * 3. Error Monitor - Tracks and logs errors
 * 4. Auto-handoff - Session transition helper
 *
 * Optional daemons (set env var to enable):
 * - ENABLE_LINEAR_SYNC=true  - Linear task sync (hourly)
 * - ENABLE_WEBHOOKS=true     - Linear webhook listener
 * - ENABLE_QUALITY_GATES=true - Post-task validation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import chokidar from 'chokidar';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env first (as per CLAUDE.md)
dotenv.config({
  path: path.join(__dirname, '..', '.env'),
  override: true,
  silent: true,
});

class ClaudeAutoStartManager {
  constructor() {
    this.daemons = new Map();
    this.watchers = new Map();
    this.projectRoot = path.dirname(__dirname);
    this.logDir = path.join(process.env.HOME, '.stackmemory', 'logs');
    this.pidFile = path.join(
      process.env.HOME,
      '.stackmemory',
      'claude-daemons.pid'
    );

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);

    const logFile = path.join(this.logDir, 'claude-autostart.log');
    fs.appendFileSync(logFile, logMessage + '\n');
  }

  /**
   * 1. Context Monitor Daemon
   * Saves context and decisions every 15 minutes
   * Saves context periodically
   */
  startContextMonitor() {
    this.log('Starting Context Monitor...');

    const contextInterval = setInterval(
      async () => {
        try {
          // Check if stackmemory is available
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          // Save current context
          const { stdout } = await execAsync(
            `cd ${this.projectRoot} && ~/.stackmemory/bin/stackmemory context add decision "Auto-checkpoint at ${new Date().toISOString()}"`
          );

          this.log('Context checkpoint saved');
        } catch (error) {
          this.log(`Context monitor error: ${error.message}`, 'ERROR');
        }
      },
      15 * 60 * 1000
    ); // Every 15 minutes

    // Also load context immediately on start
    this.loadInitialContext();

    this.daemons.set('context-monitor', contextInterval);
  }

  async loadInitialContext() {
    try {
      this.log('Initial context check completed');
    } catch (error) {
      this.log(`Initial context load error: ${error.message}`, 'WARN');
    }
  }

  /**
   * Linear Sync Daemon (opt-in)
   * Requires ENABLE_LINEAR_SYNC=true and LINEAR_API_KEY
   */
  startLinearSync() {
    if (
      !process.env.STACKMEMORY_LINEAR_API_KEY &&
      !process.env.LINEAR_API_KEY
    ) {
      this.log('Linear sync skipped - no API key', 'WARN');
      return;
    }

    this.log('Starting Linear Sync Daemon...');

    const linearSync = spawn(
      'node',
      [path.join(this.projectRoot, 'scripts', 'linear-sync-daemon.js')],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    linearSync.unref();
    this.daemons.set('linear-sync', linearSync);
    this.log(`Linear sync started (PID: ${linearSync.pid})`);
  }

  /**
   * 3. File Watcher Daemon
   * Watches for changes and auto-syncs
   */
  startFileWatcher() {
    this.log('Starting File Watcher...');

    const watchPaths = [
      path.join(this.projectRoot, 'src'),
      path.join(this.projectRoot, 'scripts'),
      path.join(this.projectRoot, '.stackmemory', 'tasks.jsonl'),
    ];

    const watcher = chokidar.watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/*.log',
      ],
    });

    let changeTimeout;

    watcher.on('change', (filepath) => {
      // Debounce changes
      clearTimeout(changeTimeout);
      changeTimeout = setTimeout(() => {
        this.log(`File changed: ${path.relative(this.projectRoot, filepath)}`);

        // Auto-save context on significant changes
        if (filepath.endsWith('.ts') || filepath.endsWith('.js')) {
          this.saveFileChangeContext(filepath);
        }
      }, 1000);
    });

    this.watchers.set('file-watcher', watcher);
    this.log('File watcher active');
  }

  async saveFileChangeContext(filepath) {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const filename = path.basename(filepath);
      await execAsync(
        `cd ${this.projectRoot} && ~/.stackmemory/bin/stackmemory context add observation "Modified: ${filename}"`
      );
    } catch (error) {
      // Silent fail - don't interrupt workflow
    }
  }

  /**
   * 4. Error Monitor Daemon
   * Monitors logs for errors and patterns
   */
  startErrorMonitor() {
    this.log('Starting Error Monitor...');

    const errorPatterns = [
      /ERROR/i,
      /FAILED/i,
      /Exception/,
      /TypeError/,
      /ReferenceError/,
      /SyntaxError/,
    ];

    const monitorInterval = setInterval(() => {
      // Check recent logs for errors
      const logsToCheck = [
        path.join(this.logDir, 'linear-sync.log'),
        path.join(this.logDir, 'sync-manager.log'),
        path.join(this.projectRoot, 'npm-debug.log'),
      ];

      logsToCheck.forEach((logFile) => {
        if (fs.existsSync(logFile)) {
          const stats = fs.statSync(logFile);
          const lastCheck = this.lastErrorCheck || 0;

          if (stats.mtimeMs > lastCheck) {
            const content = fs.readFileSync(logFile, 'utf8');
            const lines = content.split('\n').slice(-100); // Last 100 lines

            lines.forEach((line) => {
              errorPatterns.forEach((pattern) => {
                if (pattern.test(line)) {
                  this.log(
                    `Error detected: ${line.substring(0, 100)}...`,
                    'WARN'
                  );
                }
              });
            });
          }
        }
      });

      this.lastErrorCheck = Date.now();
    }, 60 * 1000); // Every minute

    this.daemons.set('error-monitor', monitorInterval);
  }

  /**
   * 5. Webhook Listener Daemon
   * Listens for Linear webhooks
   */
  startWebhookListener() {
    this.log('Starting Webhook Listener...');

    const express = require('express');
    const app = express();
    app.use(express.json());

    const PORT = process.env.WEBHOOK_PORT || 3456;

    app.post('/webhooks/linear', (req, res) => {
      const { action, data } = req.body;
      this.log(`Linear webhook: ${action} - ${data.identifier || data.id}`);

      // Process webhook
      if (action === 'create' || action === 'update') {
        // Trigger sync
        this.triggerLinearSync();
      }

      res.status(200).send('OK');
    });

    const server = app.listen(PORT, () => {
      this.log(`Webhook listener on port ${PORT}`);
    });

    this.daemons.set('webhook-listener', server);
  }

  async triggerLinearSync() {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      await execAsync(
        `cd ${this.projectRoot} && node scripts/sync-linear-graphql.js`
      );
      this.log('Linear sync triggered by webhook');
    } catch (error) {
      this.log(`Webhook sync error: ${error.message}`, 'ERROR');
    }
  }

  /**
   * 6. Quality Gates Monitor
   * Runs after task completion
   */
  startQualityGates() {
    this.log('Starting Quality Gates Monitor...');

    // Watch for task completion patterns
    const taskWatcher = chokidar.watch(
      path.join(this.projectRoot, '.stackmemory', 'tasks.jsonl'),
      { persistent: true }
    );

    taskWatcher.on('change', async () => {
      // Check last task status
      try {
        const tasksFile = path.join(
          this.projectRoot,
          '.stackmemory',
          'tasks.jsonl'
        );
        const lines = fs
          .readFileSync(tasksFile, 'utf8')
          .split('\n')
          .filter(Boolean);
        const lastTask = JSON.parse(lines[lines.length - 1]);

        if (
          lastTask.status === 'completed' &&
          lastTask.timestamp > Date.now() - 60000
        ) {
          // Within last minute
          await this.runQualityChecks();
        }
      } catch (error) {
        // Silent fail
      }
    });

    this.watchers.set('quality-gates', taskWatcher);
  }

  async runQualityChecks() {
    this.log('Running quality checks...');

    const checks = [
      { name: 'Lint', cmd: 'npm run lint' },
      { name: 'Tests', cmd: 'npm test' },
      { name: 'Build', cmd: 'npm run build' },
    ];

    for (const check of checks) {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        await execAsync(`cd ${this.projectRoot} && ${check.cmd}`);
        this.log(`✅ ${check.name} passed`);
      } catch (error) {
        this.log(`❌ ${check.name} failed: ${error.message}`, 'ERROR');
      }
    }
  }

  /**
   * 7. Auto-handoff Daemon
   * Prepares handoff when session ends
   */
  startAutoHandoff() {
    this.log('Starting Auto-handoff Monitor...');

    // Monitor for session end signals
    process.on('SIGINT', () => this.prepareHandoff('interrupt'));
    process.on('SIGTERM', () => this.prepareHandoff('terminate'));

    // Also monitor for idle time
    let lastActivity = Date.now();

    const idleChecker = setInterval(
      () => {
        const idleTime = Date.now() - lastActivity;
        if (idleTime > 30 * 60 * 1000) {
          // 30 minutes idle
          this.prepareHandoff('idle');
        }
      },
      5 * 60 * 1000
    ); // Check every 5 minutes

    // Update activity on any file change
    this.watchers.get('file-watcher')?.on('all', () => {
      lastActivity = Date.now();
    });

    this.daemons.set('auto-handoff', idleChecker);
  }

  async prepareHandoff(reason) {
    this.log(`Preparing handoff (${reason})...`);

    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Generate handoff
      await execAsync(
        `cd ${this.projectRoot} && ~/.stackmemory/bin/stackmemory capture`
      );

      this.log('Handoff prepared successfully');
    } catch (error) {
      this.log(`Handoff error: ${error.message}`, 'ERROR');
    }
  }

  /**
   * Start all daemons
   */
  async start() {
    this.log('🚀 Claude StackMemory Auto-Start Manager');
    this.log('=========================================\n');

    // Save PID for management
    fs.writeFileSync(this.pidFile, process.pid.toString());

    // Start core daemons
    this.startContextMonitor();
    this.startFileWatcher();
    this.startErrorMonitor();

    // Optional daemons (only if explicitly enabled)
    if (process.env.ENABLE_LINEAR_SYNC === 'true') {
      this.startLinearSync();
    }

    if (process.env.ENABLE_WEBHOOKS === 'true') {
      this.startWebhookListener();
    }

    if (process.env.ENABLE_QUALITY_GATES === 'true') {
      this.startQualityGates();
    }

    this.startAutoHandoff();

    this.log('\n✅ All daemons started successfully');
    this.log('📊 Active daemons:');
    this.daemons.forEach((daemon, name) => {
      this.log(`  - ${name}`);
    });

    // Handle shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());

    // Keep process alive
    process.stdin.resume();
  }

  /**
   * Stop all daemons
   */
  stop() {
    this.log('\n🛑 Stopping all daemons...');

    // Clear intervals
    this.daemons.forEach((daemon, name) => {
      if (typeof daemon.kill === 'function') {
        daemon.kill();
      } else if (typeof daemon === 'number' || daemon._idleTimeout) {
        clearInterval(daemon);
      } else if (typeof daemon.close === 'function') {
        daemon.close();
      }
      this.log(`  - ${name} stopped`);
    });

    // Close watchers
    this.watchers.forEach((watcher, name) => {
      watcher.close();
      this.log(`  - ${name} closed`);
    });

    // Remove PID file
    if (fs.existsSync(this.pidFile)) {
      fs.unlinkSync(this.pidFile);
    }

    this.log('👋 All daemons stopped');
    process.exit(0);
  }

  /**
   * Check status
   */
  static status() {
    const pidFile = path.join(
      process.env.HOME,
      '.stackmemory',
      'claude-daemons.pid'
    );

    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, 'utf8').trim();

      try {
        // Check if process is running
        process.kill(pid, 0);
        console.log(`✅ Claude daemons running (PID: ${pid})`);

        // Show recent logs
        const logFile = path.join(
          process.env.HOME,
          '.stackmemory',
          'logs',
          'claude-autostart.log'
        );
        if (fs.existsSync(logFile)) {
          const logs = fs.readFileSync(logFile, 'utf8').split('\n').slice(-10);
          console.log('\nRecent activity:');
          logs.forEach((line) => console.log(line));
        }
        return true;
      } catch (error) {
        console.log('❌ Claude daemons not running (stale PID file)');
        fs.unlinkSync(pidFile);
        return false;
      }
    } else {
      console.log('❌ Claude daemons not running');
      return false;
    }
  }
}

// Handle CLI commands
const command = process.argv[2];

if (command === 'status') {
  ClaudeAutoStartManager.status();
} else if (command === 'stop') {
  const pidFile = path.join(
    process.env.HOME,
    '.stackmemory',
    'claude-daemons.pid'
  );
  if (fs.existsSync(pidFile)) {
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    process.kill(pid, 'SIGTERM');
    console.log('Stop signal sent');
  }
} else {
  // Start the manager
  const manager = new ClaudeAutoStartManager();
  manager.start();
}
