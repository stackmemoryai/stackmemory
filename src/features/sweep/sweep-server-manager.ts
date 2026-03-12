/**
 * Sweep Server Manager
 *
 * Manages the llama-server process for Sweep predictions.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  SweepServerConfig,
  SweepServerStatus,
  DEFAULT_SERVER_CONFIG,
} from './types.js';
import { createPredictionClient } from './prediction-client.js';
import { logger } from '../../core/monitoring/logger.js';
import { isProcessAlive } from '../../utils/process-cleanup.js';

const HOME = process.env['HOME'] || '/tmp';
const PID_FILE = join(HOME, '.stackmemory', 'sweep', 'server.pid');
const LOG_FILE = join(HOME, '.stackmemory', 'sweep', 'server.log');

export class SweepServerManager {
  private config: SweepServerConfig;
  private process: ChildProcess | null = null;

  constructor(config: Partial<SweepServerConfig> = {}) {
    this.config = { ...DEFAULT_SERVER_CONFIG, ...config };

    // Set default model path if not provided
    if (!this.config.modelPath) {
      this.config.modelPath = join(
        HOME,
        '.stackmemory',
        'models',
        'sweep',
        'sweep-next-edit-1.5b.q8_0.v2.gguf'
      );
    }
  }

  /**
   * Find llama-server executable
   */
  private findLlamaServer(): string | null {
    const candidates = [
      'llama-server',
      'llama.cpp/llama-server',
      '/usr/local/bin/llama-server',
      '/opt/homebrew/bin/llama-server',
      join(HOME, '.local', 'bin', 'llama-server'),
    ];

    for (const cmd of candidates) {
      try {
        execSync(`which ${cmd}`, { stdio: 'ignore' });
        return cmd;
      } catch {
        if (existsSync(cmd)) {
          return cmd;
        }
      }
    }

    return null;
  }

  /**
   * Start the llama-server
   */
  async startServer(): Promise<SweepServerStatus> {
    // Check if already running
    const status = await this.getStatus();
    if (status.running) {
      return status;
    }

    // Check model exists
    if (!existsSync(this.config.modelPath)) {
      throw new Error(
        `Model not found: ${this.config.modelPath}\n` +
          'Download with: huggingface-cli download sweepai/sweep-next-edit-1.5B sweep-next-edit-1.5b.q8_0.v2.gguf --local-dir ~/.stackmemory/models/sweep'
      );
    }

    // Find llama-server
    const llamaServer = this.findLlamaServer();
    if (!llamaServer) {
      throw new Error(
        'llama-server not found. Install with:\n' +
          '  brew install llama.cpp\n' +
          'or build from source: https://github.com/ggerganov/llama.cpp'
      );
    }

    // Ensure log directory exists
    const logDir = dirname(LOG_FILE);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Build command args
    const args = [
      '-m',
      this.config.modelPath,
      '--port',
      String(this.config.port),
      '--host',
      this.config.host,
      '-c',
      String(this.config.contextSize),
    ];

    if (this.config.threads) {
      args.push('-t', String(this.config.threads));
    }

    if (this.config.gpuLayers && this.config.gpuLayers > 0) {
      args.push('-ngl', String(this.config.gpuLayers));
    }

    logger.info('Starting Sweep server', { llamaServer, args });

    // Start the process
    this.process = spawn(llamaServer, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Write PID file
    if (this.process.pid) {
      const pidDir = dirname(PID_FILE);
      if (!existsSync(pidDir)) {
        mkdirSync(pidDir, { recursive: true });
      }
      writeFileSync(
        PID_FILE,
        JSON.stringify({
          pid: this.process.pid,
          port: this.config.port,
          host: this.config.host,
          modelPath: this.config.modelPath,
          startedAt: Date.now(),
        })
      );
    }

    // Unref to allow parent to exit
    this.process.unref();

    // Wait for server to be ready
    const ready = await this.waitForReady(10000);
    if (!ready) {
      await this.stopServer();
      throw new Error('Server failed to start within timeout');
    }

    return this.getStatus();
  }

  /**
   * Wait for server to be ready
   */
  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const client = createPredictionClient({
      port: this.config.port,
      host: this.config.host,
    });

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (await client.checkHealth()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return false;
  }

  /**
   * Stop the server
   */
  async stopServer(): Promise<void> {
    const status = await this.getStatus();

    if (!status.running || !status.pid) {
      return;
    }

    try {
      process.kill(status.pid, 'SIGTERM');

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!isProcessAlive(status.pid!)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);

        // Force kill after 5 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          try {
            process.kill(status.pid!, 'SIGKILL');
          } catch {
            // Already dead
          }
          resolve();
        }, 5000);
      });
    } catch (error) {
      // Process may already be dead
      logger.warn('Error stopping server', { error });
    }

    // Clean up PID file
    try {
      if (existsSync(PID_FILE)) {
        const { unlinkSync } = await import('fs');
        unlinkSync(PID_FILE);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<SweepServerStatus> {
    // Check PID file
    if (!existsSync(PID_FILE)) {
      return { running: false };
    }

    try {
      const data = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      const { pid, port, host, modelPath, startedAt } = data;

      // Check if process is still running
      if (!isProcessAlive(pid)) {
        return { running: false };
      }

      // Verify server is responsive
      const client = createPredictionClient({ port, host });
      const healthy = await client.checkHealth();

      return {
        running: healthy,
        pid,
        port,
        host,
        modelPath,
        startedAt,
      };
    } catch {
      return { running: false };
    }
  }

  /**
   * Check server health
   */
  async checkHealth(): Promise<boolean> {
    const client = createPredictionClient({
      port: this.config.port,
      host: this.config.host,
    });
    return client.checkHealth();
  }
}

/**
 * Create a server manager with default config
 */
export function createServerManager(
  config?: Partial<SweepServerConfig>
): SweepServerManager {
  return new SweepServerManager(config);
}
