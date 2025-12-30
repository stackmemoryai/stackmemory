/**
 * Formatter Verifier - Code formatting verification
 * Based on Spotify's formatting verifier pattern
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import {
  BaseVerifier,
  VerifierContext,
  VerifierResult,
  VerifierConfig,
} from './base-verifier.js';
import { logger } from '../../core/monitoring/logger.js';

const execAsync = promisify(exec);

export class FormatterVerifier extends BaseVerifier {
  private formatters: Map<string, FormatterCommand> = new Map();

  constructor(config?: Partial<VerifierConfig>) {
    super({
      id: 'formatter',
      name: 'Code Formatter',
      type: 'style',
      enabled: true,
      stopOnError: false,
      timeout: 10000,
      ...config,
    });

    this.initializeFormatters();
  }

  private initializeFormatters() {
    // Common formatters for different languages
    this.formatters.set('typescript', {
      checkCommand: 'npx prettier --check',
      fixCommand: 'npx prettier --write',
      patterns: [/\[error\]/gi, /File not formatted/gi],
    });

    this.formatters.set('javascript', {
      checkCommand: 'npx prettier --check',
      fixCommand: 'npx prettier --write',
      patterns: [/\[error\]/gi, /File not formatted/gi],
    });

    this.formatters.set('python', {
      checkCommand: 'black --check',
      fixCommand: 'black',
      patterns: [/would reformat/gi, /File not formatted/gi],
    });

    this.formatters.set('rust', {
      checkCommand: 'cargo fmt -- --check',
      fixCommand: 'cargo fmt',
      patterns: [/Diff in/gi, /File not formatted/gi],
    });

    this.formatters.set('go', {
      checkCommand: 'gofmt -l',
      fixCommand: 'gofmt -w',
      patterns: [/.+\.go$/gm], // gofmt lists unformatted files
    });
  }

  shouldActivate(context: VerifierContext): boolean {
    // Activate for supported languages with code files
    if (!context.language || !context.filePath) {
      return false;
    }

    return this.formatters.has(context.language.toLowerCase());
  }

  async verify(
    input: string | Buffer,
    context: VerifierContext
  ): Promise<VerifierResult> {
    if (!context.language || !context.filePath) {
      return this.createResult(
        false,
        'Missing language or file path in context',
        'error'
      );
    }

    const formatter = this.formatters.get(context.language.toLowerCase());
    if (!formatter) {
      return this.createResult(
        true,
        `No formatter configured for ${context.language}`,
        'info'
      );
    }

    try {
      return await this.withTimeout(async () => {
        return await this.withRetry(
          () => this.runFormatter(formatter, context),
          context.filePath!
        );
      });
    } catch (error) {
      logger.error(
        'Formatter verification failed',
        error instanceof Error ? error : undefined
      );
      return this.createResult(
        false,
        `Formatter error: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    }
  }

  private async runFormatter(
    formatter: FormatterCommand,
    context: VerifierContext
  ): Promise<VerifierResult> {
    const command = `${formatter.checkCommand} "${context.filePath}"`;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.cwd(),
        timeout: this.config.timeout,
      });

      // Formatter passed
      return this.createResult(true, 'Code is properly formatted', 'info');
    } catch (error: any) {
      // Check if it's a formatting issue (exit code 1) vs actual error
      if (error.code === 1) {
        const output = error.stdout + error.stderr;
        const errors = this.extractRelevantErrors(output, formatter.patterns);

        return this.createResult(
          false,
          this.generateFeedback(errors, context),
          'warning',
          {
            code: output.substring(0, 500),
            suggestion: 'Run formatter to fix issues',
          },
          {
            command: `${formatter.fixCommand} "${context.filePath}"`,
            description: 'Auto-format the file',
            safe: true,
            confidence: 0.95,
          }
        );
      }

      // Actual error running formatter
      throw error;
    }
  }
}

interface FormatterCommand {
  checkCommand: string;
  fixCommand: string;
  patterns: RegExp[];
}
