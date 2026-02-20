/**
 * Code Execution MCP Handlers
 * Provides controlled Python/JavaScript code execution with safety measures
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  outputFile?: string;
}

const MAX_OUTPUT_SIZE = 50000; // Maximum output size before truncation
const EXECUTION_TIMEOUT = 30000; // 30 seconds timeout

export class CodeExecutionHandler {
  private readonly allowedLanguages = ['python', 'javascript', 'typescript'];
  private readonly sandboxDir: string;

  constructor() {
    // Create a sandbox directory for code execution
    this.sandboxDir = join(tmpdir(), 'stackmemory-sandbox');
    this.ensureSandboxDir();
  }

  private async ensureSandboxDir(): Promise<void> {
    try {
      await fs.mkdir(this.sandboxDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create sandbox directory:', error);
    }
  }

  /**
   * Execute code in a controlled environment
   */
  async executeCode(params: {
    language: string;
    code: string;
    workingDirectory?: string;
    timeout?: number;
  }): Promise<ExecutionResult> {
    const {
      language,
      code,
      workingDirectory,
      timeout = EXECUTION_TIMEOUT,
    } = params;

    // Validate language
    if (!this.allowedLanguages.includes(language.toLowerCase())) {
      return {
        success: false,
        stdout: '',
        stderr: `Language '${language}' is not allowed. Use: ${this.allowedLanguages.join(', ')}`,
        exitCode: 1,
        truncated: false,
      };
    }

    // Create temporary file for code
    const tempFile = join(
      this.sandboxDir,
      `code_${randomBytes(8).toString('hex')}.${this.getFileExtension(language)}`
    );

    try {
      // Write code to temporary file
      await fs.writeFile(tempFile, code, 'utf-8');

      // Execute code
      const result = await this.runCode(
        language,
        tempFile,
        workingDirectory || this.sandboxDir,
        timeout
      );

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      return result;
    } catch (error) {
      return {
        success: false,
        stdout: '',
        stderr: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
        truncated: false,
      };
    }
  }

  /**
   * Run code with appropriate interpreter
   */
  private async runCode(
    language: string,
    filePath: string,
    workingDirectory: string,
    timeout: number
  ): Promise<ExecutionResult> {
    const command = this.getCommand(language);
    const args = this.getArgs(language, filePath);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;

      const child = spawn(command, args, {
        cwd: workingDirectory,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1', // Don't create .pyc files
          NODE_ENV: 'sandbox',
        },
      });

      // Set timeout
      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        stderr += '\n[Process killed due to timeout]';
      }, timeout);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          truncated = true;
          child.kill('SIGTERM');
        }
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          truncated = true;
          child.kill('SIGTERM');
        }
      });

      child.on('close', async (code) => {
        clearTimeout(timeoutId);

        // If output is truncated, save to file
        let outputFile: string | undefined;
        if (truncated) {
          outputFile = join(
            this.sandboxDir,
            `output_${randomBytes(8).toString('hex')}.txt`
          );
          await fs
            .writeFile(
              outputFile,
              stdout + '\n---STDERR---\n' + stderr,
              'utf-8'
            )
            .catch(() => {});
        }

        resolve({
          success: code === 0,
          stdout: truncated
            ? stdout.slice(0, MAX_OUTPUT_SIZE) + '\n[Output truncated]'
            : stdout,
          stderr: truncated
            ? stderr.slice(0, MAX_OUTPUT_SIZE) + '\n[Output truncated]'
            : stderr,
          exitCode: code,
          truncated,
          outputFile,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          stdout: '',
          stderr: `Failed to start process: ${error.message}`,
          exitCode: null,
          truncated: false,
        });
      });
    });
  }

  /**
   * Get file extension for language
   */
  private getFileExtension(language: string): string {
    switch (language.toLowerCase()) {
      case 'python':
        return 'py';
      case 'javascript':
        return 'js';
      case 'typescript':
        return 'ts';
      default:
        return 'txt';
    }
  }

  /**
   * Get command for language
   */
  private getCommand(language: string): string {
    switch (language.toLowerCase()) {
      case 'python':
        return 'python3';
      case 'javascript':
        return 'node';
      case 'typescript':
        return 'npx';
      default:
        return 'echo';
    }
  }

  /**
   * Get arguments for language
   */
  private getArgs(language: string, filePath: string): string[] {
    switch (language.toLowerCase()) {
      case 'python':
        return [filePath];
      case 'javascript':
        return [filePath];
      case 'typescript':
        return ['tsx', filePath];
      default:
        return ['Unsupported language'];
    }
  }

  /**
   * Validate code for dangerous patterns
   */
  validateCode(code: string): { safe: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const dangerousPatterns = [
      { pattern: /import\s+os/i, message: 'Importing os module detected' },
      {
        pattern: /import\s+subprocess/i,
        message: 'Subprocess module detected',
      },
      { pattern: /exec\s*\(/i, message: 'exec() function detected' },
      { pattern: /eval\s*\(/i, message: 'eval() function detected' },
      { pattern: /__import__/i, message: '__import__ detected' },
      {
        pattern: /open\s*\([^)]*['"]\//i,
        message: 'Absolute path file access detected',
      },
      {
        pattern: /require\s*\([^)]*child_process/i,
        message: 'child_process module detected',
      },
      { pattern: /require\s*\([^)]*fs/i, message: 'fs module access detected' },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(code)) {
        warnings.push(message);
      }
    }

    return {
      safe: warnings.length === 0,
      warnings,
    };
  }

  /**
   * Get sandbox status
   */
  async getSandboxStatus(): Promise<{
    sandboxDir: string;
    tempFiles: number;
    totalSize: number;
  }> {
    try {
      const files = await fs.readdir(this.sandboxDir);
      let totalSize = 0;

      for (const file of files) {
        const stat = await fs.stat(join(this.sandboxDir, file));
        totalSize += stat.size;
      }

      return {
        sandboxDir: this.sandboxDir,
        tempFiles: files.length,
        totalSize,
      };
    } catch {
      return {
        sandboxDir: this.sandboxDir,
        tempFiles: 0,
        totalSize: 0,
      };
    }
  }

  /**
   * Clean sandbox directory
   */
  async cleanSandbox(): Promise<void> {
    try {
      const files = await fs.readdir(this.sandboxDir);
      for (const file of files) {
        await fs.unlink(join(this.sandboxDir, file)).catch(() => {});
      }
    } catch (error) {
      console.error('Failed to clean sandbox:', error);
    }
  }
}

// Export MCP tool handlers
export const codeExecutionHandlers = {
  'code.execute': async (params: any) => {
    const handler = new CodeExecutionHandler();

    // Validate code before execution
    const validation = handler.validateCode(params.code);
    if (!validation.safe && !params.force) {
      return {
        error: 'Code validation failed',
        warnings: validation.warnings,
        hint: 'Add force: true to execute anyway',
      };
    }

    return await handler.executeCode(params);
  },

  'code.validate': async (params: any) => {
    const handler = new CodeExecutionHandler();
    return handler.validateCode(params.code);
  },

  'code.sandbox_status': async () => {
    const handler = new CodeExecutionHandler();
    return await handler.getSandboxStatus();
  },

  'code.clean_sandbox': async () => {
    const handler = new CodeExecutionHandler();
    await handler.cleanSandbox();
    return { success: true, message: 'Sandbox cleaned' };
  },
};
