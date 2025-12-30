/**
 * CLI Command Trace Wrapper
 * Automatically wraps Commander.js commands with comprehensive tracing
 */

import { Command } from 'commander';
import { trace } from './debug-trace.js';
import { logger } from '../monitoring/logger.js';

export function wrapCommand(command: Command): Command {
  const originalAction = command.action.bind(command);
  
  command.action(async function(...args: any[]): Promise<void> {
    // Extract command path and options
    const commandPath = getCommandPath(command);
    const options = args[args.length - 1];
    const commandArgs = args.slice(0, -1);
    
    // Build comprehensive context
    const context = {
      command: commandPath,
      args: commandArgs,
      options: typeof options === 'object' ? options : {},
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env.NODE_ENV,
        DEBUG_TRACE: process.env.DEBUG_TRACE,
        LINEAR_API_KEY: process.env.LINEAR_API_KEY ? '[SET]' : '[NOT SET]',
      },
      timestamp: new Date().toISOString(),
    };
    
    // Log command start
    logger.info(`CLI Command: ${commandPath}`, context);
    
    // Wrap the actual action with tracing
    await trace.command(commandPath, context, async () => {
      try {
        // Call the original action with wrapped handler
        const result = await originalAction.apply(null, args as any);
        
        // Log successful completion
        logger.info(`CLI Command Completed: ${commandPath}`, {
          duration: trace.exportTraces().find(t => t.name === commandPath)?.duration,
        });
        
        // Show execution summary if verbose
        if (process.env.DEBUG_TRACE === 'true') {
          console.log(trace.getExecutionSummary());
        }
      } catch (error) {
        // Enhanced error logging for CLI commands
        logger.error(`CLI Command Failed: ${commandPath}`, error as Error, context);
        
        // Get the last error trace for debugging
        const lastError = trace.getLastError();
        if (lastError) {
          console.error('\n📍 Error occurred at:');
          console.error(`   ${lastError.name}`);
          if (lastError.params) {
            console.error('   With params:', JSON.stringify(lastError.params, null, 2));
          }
          console.error('   Error details:', lastError.error);
        }
        
        // Re-throw to maintain original error handling
        throw error;
      }
    });
  });
  
  // Recursively wrap subcommands
  command.commands.forEach(subcommand => {
    wrapCommand(subcommand);
  });
  
  return command;
}

function getCommandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  
  while (current) {
    if (current.name()) {
      parts.unshift(current.name());
    }
    current = current.parent as Command | null;
  }
  
  return parts.join(' ');
}

/**
 * Wrap the main program with comprehensive tracing
 */
export function wrapProgram(program: Command): Command {
  // Add global error handler with tracing
  program.exitOverride((err) => {
    if (err.code === 'commander.help' || err.code === 'commander.version') {
      // Normal help/version display, not an error
      process.exit(0);
    }
    
    // Log the error with full context
    logger.error('CLI Error', err, {
      code: err.code,
      exitCode: err.exitCode,
      command: process.argv.slice(2).join(' '),
    });
    
    // Show trace summary on error
    if (process.env.DEBUG_TRACE === 'true') {
      console.error('\n' + trace.getExecutionSummary());
    }
    
    process.exit(err.exitCode || 1);
  });
  
  // Add pre-action hook for setup
  program.hook('preAction', (thisCommand) => {
    // Initialize trace context for this command
    trace.reset();
    
    // Log command invocation
    const commandPath = getCommandPath(thisCommand);
    logger.debug(`Preparing to execute: ${commandPath}`, {
      args: thisCommand.args,
      opts: thisCommand.opts(),
    });
  });
  
  // Add post-action hook for cleanup
  program.hook('postAction', (thisCommand) => {
    // Log completion
    const commandPath = getCommandPath(thisCommand);
    logger.debug(`Completed execution: ${commandPath}`);
  });
  
  // Wrap all existing commands
  program.commands.forEach(command => {
    wrapCommand(command);
  });
  
  return program;
}

/**
 * Helper to wrap async functions with step tracing
 */
export function traceStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return trace.step(name, fn);
}

/**
 * Helper to wrap database queries
 */
export function traceQuery<T>(sql: string, params: any, fn: () => T): T {
  return trace.traceSync('query', sql.substring(0, 100), params, fn);
}

/**
 * Helper to wrap API calls
 */
export function traceAPI<T>(
  method: string,
  url: string,
  body: any,
  fn: () => Promise<T>
): Promise<T> {
  return trace.api(method, url, body, fn);
}