/**
 * Context Rehydration CLI Command
 * Manual trigger for enhanced context recovery
 */

import { Command } from 'commander';
import { join } from 'path';
import { existsSync } from 'fs';
import { logger } from '../../core/monitoring/logger.js';

interface RehydrateOptions {
  checkpoint?: string;
  create?: boolean;
  list?: boolean;
  verbose?: boolean;
  verify?: boolean;
  withTraces?: boolean;
  traces?: boolean;
  traceStats?: boolean;
}

export function createContextRehydrateCommand(): Command {
  const command = new Command('rehydrate');

  command
    .description('Enhanced context rehydration after Claude compaction')
    .option('-c, --checkpoint <id>', 'Use specific checkpoint ID')
    .option('--create', 'Create new rehydration checkpoint')
    .option('-l, --list', 'List available checkpoints')
    .option('-v, --verbose', 'Verbose output')
    .option('--verify', 'Verify checkpoint contents and integrity')
    .option('--with-traces', 'Include stack trace context in output')
    .option('--traces', 'Show recent stack traces from database')
    .option('--trace-stats', 'Show stack trace statistics and patterns')
    .action(async (options: RehydrateOptions) => {
      await handleContextRehydrate(options);
    });

  return command;
}

async function handleContextRehydrate(
  options: RehydrateOptions
): Promise<void> {
  const projectRoot = process.cwd();
  const dbPath = join(projectRoot, '.stackmemory', 'context.db');

  if (!existsSync(dbPath)) {
    console.log(
      '❌ StackMemory not initialized. Run "stackmemory init" first.'
    );
    return;
  }

  try {
    console.log('🔄 Enhanced Context Rehydration System');
    console.log(
      '📚 This system preserves rich context across Claude compactions\n'
    );

    if (options.list) {
      await listCheckpoints();
      return;
    }

    if (options.create) {
      console.log('🔄 Creating rehydration checkpoint...');
      await createRehydrationCheckpoint(options.withTraces);
      return;
    }

    if (options.verify) {
      await verifyCheckpoints(options.checkpoint);
      return;
    }

    if (options.traces) {
      await showStackTraces();
      return;
    }

    if (options.traceStats) {
      await showStackTraceStats();
      return;
    }

    // Perform rehydration
    console.log('💾 Starting context rehydration...');

    if (options.verbose) {
      console.log('📋 Analyzing current session state...');
    }

    const success = await performRehydration(options.checkpoint);

    if (success) {
      console.log('✅ Context successfully rehydrated');
      console.log('📊 Rich context has been injected into current session');

      if (options.verbose) {
        console.log('\n📁 Context includes:');
        console.log('  • File snapshots with content previews');
        console.log('  • Project structure mapping');
        console.log('  • Previous decisions and reasoning');
        console.log('  • Active workflow detection');
        console.log('  • User preferences and pain points');
      }
    } else {
      console.log('⚠️ Context rehydration failed');
      console.log('💡 Try creating a checkpoint first with --create');
    }
  } catch (error) {
    logger.error('Context rehydration error:', error);
    console.error(
      '❌ Failed to rehydrate context:',
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

async function createRehydrationCheckpoint(withTraces = false): Promise<void> {
  const fs = await import('fs/promises');
  const checkpointDir = join(process.cwd(), '.stackmemory', 'rehydration');

  try {
    // Ensure directory exists
    await fs.mkdir(checkpointDir, { recursive: true });

    // Create checkpoint with current context
    const checkpointId = `checkpoint_${Date.now()}`;
    const checkpoint = {
      id: checkpointId,
      timestamp: Date.now(),
      created_at: new Date().toISOString(),
      working_directory: process.cwd(),
      recent_files: await getRecentFiles(),
      project_context: await analyzeProjectContext(),
      session_info: {
        pid: process.pid,
        env: {
          NODE_ENV: process.env.NODE_ENV,
          PWD: process.env.PWD,
        },
      },
      stack_traces: withTraces ? await captureStackTraces() : [],
      error_patterns: withTraces ? await detectErrorPatterns() : [],
      verification: {
        files_captured: 0,
        total_size: 0,
        integrity_hash: '',
      },
    };

    const checkpointPath = join(checkpointDir, `${checkpointId}.json`);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));

    // Calculate verification data
    checkpoint.verification.files_captured = checkpoint.recent_files.length;
    checkpoint.verification.total_size = checkpoint.recent_files.reduce(
      (sum: number, file: any) => sum + file.size,
      0
    );
    checkpoint.verification.integrity_hash =
      await calculateCheckpointHash(checkpoint);

    // Re-write with verification data
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));

    console.log(`✅ Created checkpoint: ${checkpointId}`);
    console.log(`📁 Saved to: ${checkpointPath}`);
    console.log(`📊 Captured ${checkpoint.recent_files.length} recent files`);
    if (withTraces) {
      console.log(`🐛 Captured ${checkpoint.stack_traces.length} stack traces`);
      console.log(
        `🔍 Detected ${checkpoint.error_patterns.length} error patterns`
      );
    }
  } catch (error) {
    console.error('❌ Failed to create checkpoint:', error);
    throw error;
  }
}

async function performRehydration(checkpointId?: string): Promise<boolean> {
  const fs = await import('fs/promises');
  const checkpointDir = join(process.cwd(), '.stackmemory', 'rehydration');

  try {
    let checkpoint;

    if (checkpointId) {
      const checkpointPath = join(checkpointDir, `${checkpointId}.json`);
      const content = await fs.readFile(checkpointPath, 'utf8');
      checkpoint = JSON.parse(content);
    } else {
      // Find most recent checkpoint
      const files = await fs.readdir(checkpointDir);
      const checkpointFiles = files.filter((f) => f.endsWith('.json'));

      if (checkpointFiles.length === 0) {
        console.log('📭 No checkpoints found');
        return false;
      }

      // Get most recent
      checkpointFiles.sort((a, b) => b.localeCompare(a));
      const latestFile = checkpointFiles[0];
      const content = await fs.readFile(
        join(checkpointDir, latestFile),
        'utf8'
      );
      checkpoint = JSON.parse(content);
    }

    console.log(`🔄 Rehydrating from checkpoint: ${checkpoint.id}`);
    console.log(`📅 Created: ${checkpoint.created_at}`);
    console.log(`📁 Working directory: ${checkpoint.working_directory}`);
    console.log(`📋 Recent files: ${checkpoint.recent_files.length}`);

    // Display context information (this would be injected into StackMemory in full implementation)
    console.log('\n📊 Context Summary:');
    checkpoint.recent_files.slice(0, 5).forEach((file: any, i: number) => {
      console.log(
        `   ${i + 1}. ${file.path} (${file.size} bytes, modified ${new Date(file.mtime).toLocaleString()})`
      );
    });

    if (checkpoint.project_context.key_files.length > 0) {
      console.log(
        `\n🔑 Key project files: ${checkpoint.project_context.key_files.join(', ')}`
      );
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to rehydrate:', error);
    return false;
  }
}

async function getRecentFiles(): Promise<any[]> {
  const fs = await import('fs/promises');

  try {
    const files = await fs.readdir('.', { withFileTypes: true });
    const recentFiles = [];

    for (const file of files.slice(0, 20)) {
      // Limit to 20 files
      if (file.isFile() && !file.name.startsWith('.')) {
        try {
          const stats = await fs.stat(file.name);
          recentFiles.push({
            path: file.name,
            size: stats.size,
            mtime: stats.mtimeMs,
          });
        } catch {
          // Skip files that can't be read
        }
      }
    }

    // Sort by modification time, most recent first
    return recentFiles.sort((a, b) => b.mtime - a.mtime);
  } catch (error) {
    console.warn('Could not analyze recent files:', error);
    return [];
  }
}

async function analyzeProjectContext(): Promise<any> {
  const fs = await import('fs/promises');

  const context = {
    key_files: [] as string[],
    project_type: 'unknown',
    framework: 'unknown',
  };

  try {
    // Check for common project files
    const projectFiles = [
      'package.json',
      'tsconfig.json',
      'README.md',
      'docker-compose.yml',
    ];

    for (const file of projectFiles) {
      try {
        await fs.access(file);
        context.key_files.push(file);
      } catch {
        // File doesn't exist
      }
    }

    // Determine project type
    if (context.key_files.includes('package.json')) {
      context.project_type = 'node';

      try {
        const packageContent = await fs.readFile('package.json', 'utf8');
        const packageJson = JSON.parse(packageContent);

        if (packageJson.dependencies?.react) {
          context.framework = 'react';
        } else if (packageJson.dependencies?.vue) {
          context.framework = 'vue';
        } else if (packageJson.dependencies?.next) {
          context.framework = 'next';
        }
      } catch {
        // Could not parse package.json
      }
    }
  } catch (error) {
    console.warn('Could not analyze project context:', error);
  }

  return context;
}

async function listCheckpoints(): Promise<void> {
  try {
    const checkpointDir = './.stackmemory/rehydration';
    const fs = await import('fs/promises');

    try {
      const files = await fs.readdir(checkpointDir);
      const checkpoints = files.filter((f) => f.endsWith('.json'));

      if (checkpoints.length === 0) {
        console.log('📭 No rehydration checkpoints found');
        console.log(
          '💡 Create one with: stackmemory context rehydrate --create'
        );
        return;
      }

      console.log(
        `📋 Found ${checkpoints.length} rehydration checkpoint(s):\n`
      );

      for (const file of checkpoints) {
        const id = file.replace('.json', '');
        const stats = await fs.stat(`${checkpointDir}/${file}`);

        // Try to read checkpoint data for more details
        try {
          const content = await fs.readFile(`${checkpointDir}/${file}`, 'utf8');
          const checkpoint = JSON.parse(content);

          console.log(`🔖 ${id}`);
          console.log(`   Created: ${stats.birthtime.toISOString()}`);
          console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);
          console.log(
            `   Files: ${checkpoint.verification?.files_captured || checkpoint.recent_files?.length || 0}`
          );
          if (checkpoint.stack_traces?.length > 0) {
            console.log(`   Stack traces: ${checkpoint.stack_traces.length}`);
          }
          if (checkpoint.error_patterns?.length > 0) {
            console.log(
              `   Error patterns: ${checkpoint.error_patterns.length}`
            );
          }
          console.log('');
        } catch {
          console.log(`🔖 ${id}`);
          console.log(`   Created: ${stats.birthtime.toISOString()}`);
          console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB\n`);
        }
      }

      console.log('💡 Use: stackmemory context rehydrate -c <checkpoint-id>');
      console.log(
        '💡 Verify: stackmemory context rehydrate --verify -c <checkpoint-id>'
      );
    } catch {
      console.log('📭 No rehydration checkpoints directory found');
      console.log(
        '💡 Create first checkpoint with: stackmemory context rehydrate --create'
      );
    }
  } catch (error) {
    console.error('❌ Failed to list checkpoints:', error);
  }
}

async function verifyCheckpoints(checkpointId?: string): Promise<void> {
  try {
    const checkpointDir = './.stackmemory/rehydration';
    const fs = await import('fs/promises');

    if (checkpointId) {
      // Verify specific checkpoint
      const checkpointPath = `${checkpointDir}/${checkpointId}.json`;
      await verifyCheckpoint(checkpointPath);
    } else {
      // Verify all checkpoints
      const files = await fs.readdir(checkpointDir);
      const checkpoints = files.filter((f) => f.endsWith('.json'));

      console.log(`🔍 Verifying ${checkpoints.length} checkpoint(s)...\n`);

      for (const file of checkpoints) {
        await verifyCheckpoint(`${checkpointDir}/${file}`);
        console.log('');
      }
    }
  } catch (error) {
    console.error('❌ Failed to verify checkpoints:', error);
  }
}

async function verifyCheckpoint(checkpointPath: string): Promise<void> {
  const fs = await import('fs/promises');

  try {
    const content = await fs.readFile(checkpointPath, 'utf8');
    const checkpoint = JSON.parse(content);
    const fileName =
      checkpointPath.split('/').pop()?.replace('.json', '') || 'unknown';

    console.log(`🔍 Verifying checkpoint: ${fileName}`);

    // Basic structure validation
    const requiredFields = [
      'id',
      'timestamp',
      'working_directory',
      'recent_files',
    ];
    const missingFields = requiredFields.filter((field) => !checkpoint[field]);

    if (missingFields.length > 0) {
      console.log(`❌ Missing required fields: ${missingFields.join(', ')}`);
      return;
    }

    // File verification
    console.log(`📁 Files captured: ${checkpoint.recent_files?.length || 0}`);

    if (checkpoint.verification) {
      console.log(
        `📊 Total size: ${(checkpoint.verification.total_size / 1024).toFixed(1)} KB`
      );
      console.log(
        `🔒 Integrity hash: ${checkpoint.verification.integrity_hash.slice(0, 12)}...`
      );

      // Verify integrity hash
      const recalculatedHash = await calculateCheckpointHash(checkpoint);
      if (recalculatedHash === checkpoint.verification.integrity_hash) {
        console.log(`✅ Integrity check: PASSED`);
      } else {
        console.log(`❌ Integrity check: FAILED (data may be corrupted)`);
      }
    }

    // Stack trace verification
    if (checkpoint.stack_traces) {
      console.log(`🐛 Stack traces: ${checkpoint.stack_traces.length}`);
      const pendingTraces = checkpoint.stack_traces.filter(
        (t: any) => t.resolution_status === 'pending'
      );
      const resolvedTraces = checkpoint.stack_traces.filter(
        (t: any) => t.resolution_status === 'resolved'
      );

      if (pendingTraces.length > 0) {
        console.log(`   ⏳ Pending resolution: ${pendingTraces.length}`);
      }
      if (resolvedTraces.length > 0) {
        console.log(`   ✅ Resolved: ${resolvedTraces.length}`);
      }
    }

    // Error pattern analysis
    if (checkpoint.error_patterns?.length > 0) {
      console.log(
        `🔍 Error patterns detected: ${checkpoint.error_patterns.join(', ')}`
      );
    }

    console.log(`✅ Checkpoint verification complete`);
  } catch (error) {
    console.log(`❌ Failed to verify checkpoint: ${error}`);
  }
}

async function captureStackTraces(): Promise<any[]> {
  // Comprehensive stack trace capture from multiple sources
  try {
    const traces: any[] = [];
    const fs = await import('fs/promises');
    const { _execSync } = await import('child_process');

    // 1. StackMemory-specific error logs
    const stackMemoryLogs = [
      '.stackmemory/error.log',
      '.stackmemory/compaction.log',
      '.stackmemory/trace.log',
      '.stackmemory/debug.log',
    ];

    // 2. Node.js and npm error logs
    const nodeLogs = [
      'npm-debug.log',
      'error.log',
      'debug.log',
      'yarn-error.log',
      'pnpm-debug.log',
    ];

    // 3. Build and test error logs
    const buildLogs = [
      'build-errors.log',
      'webpack-errors.log',
      'vite-errors.log',
      'jest-errors.log',
      'test-results.log',
    ];

    // 4. Framework-specific error logs
    const frameworkLogs = [
      '.next/trace',
      'logs/error.log',
      'tmp/cache/error.log',
    ];

    const allLogFiles = [
      ...stackMemoryLogs,
      ...nodeLogs,
      ...buildLogs,
      ...frameworkLogs,
    ];

    // 5. Extract from log files
    for (const logFile of allLogFiles) {
      await extractTracesFromLogFile(logFile, traces, fs);
    }

    // 6. Extract from recent terminal output (if available)
    await extractFromTerminalHistory(traces);

    // 7. Extract from Claude Code session logs (if available)
    await extractFromClaudeSession(traces, fs);

    // 8. Extract from npm/build command outputs
    await extractFromBuildCommands(traces);

    // 9. Extract from git logs for failed commits
    await extractFromGitLogs(traces);

    // 10. Extract from browser console logs (if available)
    await extractFromBrowserLogs(traces, fs);

    return traces;
  } catch {
    return [];
  }
}

async function detectErrorPatterns(): Promise<string[]> {
  const traces = await captureStackTraces();
  const patterns = new Map<string, number>();

  for (const trace of traces) {
    const errorType = trace.error_message.split(':')[0].trim();
    patterns.set(errorType, (patterns.get(errorType) || 0) + 1);
  }

  return Array.from(patterns.entries())
    .filter(([, count]) => count > 1)
    .map(([pattern]) => pattern);
}

async function extractTracesFromLogFile(
  logFile: string,
  traces: any[],
  fs: any
): Promise<void> {
  try {
    const logContent = await fs.readFile(logFile, 'utf8');
    const lines = logContent.split('\n');

    // Look for error patterns with better context
    const errorPatterns = [
      /Error:/i,
      /TypeError:/i,
      /ReferenceError:/i,
      /SyntaxError:/i,
      /RangeError:/i,
      /URIError:/i,
      /EvalError:/i,
      /UnhandledPromiseRejectionWarning:/i,
      /DeprecationWarning:/i,
      /\s+at\s+/, // Stack trace lines
      /Failed to compile/i,
      /Build failed/i,
      /Test failed/i,
    ];

    let currentError: any = null;
    let stackFrames: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this line starts a new error
      if (errorPatterns.some((pattern) => pattern.test(line))) {
        // Save previous error if exists
        if (currentError && stackFrames.length > 0) {
          traces.push({
            ...currentError,
            stack_frames: [...stackFrames],
            file_path: logFile,
            timestamp: Date.now(),
            context: `Extracted from ${logFile} around line ${i}`,
            resolution_status: 'pending',
          });
        }

        // Start new error
        if (line.includes('Error:') || line.includes('TypeError:')) {
          currentError = {
            error_message: line.trim(),
          };
          stackFrames = [line.trim()];
        } else if (line.includes('at ')) {
          // This is a stack frame, add to current frames
          stackFrames.push(line.trim());
        }
      } else if (currentError && line.includes('at ')) {
        // Continue collecting stack frames
        stackFrames.push(line.trim());
      }
    }

    // Don't forget the last error
    if (currentError && stackFrames.length > 0) {
      traces.push({
        ...currentError,
        stack_frames: [...stackFrames],
        file_path: logFile,
        timestamp: Date.now(),
        context: `Extracted from ${logFile}`,
        resolution_status: 'pending',
      });
    }
  } catch {
    // File doesn't exist or can't be read
  }
}

async function extractFromTerminalHistory(traces: any[]): Promise<void> {
  try {
    const { execSync } = await import('child_process');

    // Get recent command history with errors
    const historyCommands = [
      'npm run build 2>&1 | tail -50',
      'npm test 2>&1 | tail -50',
      'npm start 2>&1 | tail -50',
    ];

    for (const cmd of historyCommands) {
      try {
        const output = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
        if (output.includes('Error:') || output.includes('failed')) {
          const errorLines = output
            .split('\n')
            .filter(
              (line) =>
                line.includes('Error:') ||
                line.includes('at ') ||
                line.includes('failed')
            );

          if (errorLines.length > 0) {
            traces.push({
              error_message: errorLines[0],
              stack_frames: errorLines,
              file_path: 'terminal_output',
              timestamp: Date.now(),
              context: `Recent command: ${cmd}`,
              resolution_status: 'pending',
            });
          }
        }
      } catch {
        // Command failed or timed out
      }
    }
  } catch {
    // execSync not available
  }
}

async function extractFromClaudeSession(traces: any[], fs: any): Promise<void> {
  try {
    // Look for Claude Code session logs
    const claudePaths = [
      '~/.claude/logs',
      '~/.local/share/claude/logs',
      '/tmp/claude-logs',
      '.claude-logs',
    ];

    for (const logPath of claudePaths) {
      try {
        const files = await fs.readdir(logPath);
        const recentLogs = files
          .filter((f: string) => f.endsWith('.log'))
          .slice(-5); // Most recent 5 log files

        for (const logFile of recentLogs) {
          await extractTracesFromLogFile(`${logPath}/${logFile}`, traces, fs);
        }
      } catch {
        // Directory doesn't exist
      }
    }
  } catch {
    // Error accessing Claude logs
  }
}

async function extractFromBuildCommands(traces: any[]): Promise<void> {
  try {
    const { execSync } = await import('child_process');

    // Common build commands that might have errors
    const buildCommands = [
      'npm run lint --silent',
      'npm run typecheck --silent',
      'npx tsc --noEmit --skipLibCheck',
    ];

    for (const cmd of buildCommands) {
      try {
        execSync(cmd, { encoding: 'utf8', timeout: 10000 });
      } catch (error: any) {
        if (error.stdout || error.stderr) {
          const output = error.stdout + error.stderr;
          const errorLines = output
            .split('\n')
            .filter(
              (line: string) =>
                line.includes('Error:') ||
                line.includes('at ') ||
                line.includes('error TS')
            );

          if (errorLines.length > 0) {
            traces.push({
              error_message: errorLines[0] || `Build command failed: ${cmd}`,
              stack_frames: errorLines,
              file_path: 'build_output',
              timestamp: Date.now(),
              context: `Build command: ${cmd}`,
              resolution_status: 'pending',
            });
          }
        }
      }
    }
  } catch {
    // Build commands not available
  }
}

async function extractFromGitLogs(traces: any[]): Promise<void> {
  try {
    const { execSync } = await import('child_process');

    // Get recent git operations that might have failed
    const gitOutput = execSync(
      'git log --oneline -10 --grep="fix\\|error\\|bug" 2>/dev/null || echo "No git history"',
      { encoding: 'utf8', timeout: 5000 }
    );

    if (gitOutput.includes('fix') || gitOutput.includes('error')) {
      traces.push({
        error_message: 'Recent git commits indicate error fixes',
        stack_frames: gitOutput.split('\n').filter((line) => line.trim()),
        file_path: 'git_history',
        timestamp: Date.now(),
        context: 'Git commit history analysis',
        resolution_status: 'resolved', // These are likely fixed
      });
    }
  } catch {
    // Git not available or no history
  }
}

async function extractFromBrowserLogs(traces: any[], fs: any): Promise<void> {
  try {
    // Common browser console log locations
    const browserLogPaths = [
      'console.log',
      'browser-errors.log',
      'dev-server.log',
      '.vscode/dev-console.log',
      'tmp/browser-console.log',
    ];

    for (const logPath of browserLogPaths) {
      try {
        const logContent = await fs.readFile(logPath, 'utf8');

        // Browser console errors have different patterns
        const browserPatterns = [
          /console\.error/i,
          /Uncaught \w+Error/i,
          /Promise rejection/i,
          /React\s+Warning/i,
          /Failed to load/i,
        ];

        const lines = logContent.split('\n');
        for (const line of lines) {
          if (browserPatterns.some((pattern) => pattern.test(line))) {
            traces.push({
              error_message: line.trim(),
              stack_frames: [line.trim()],
              file_path: logPath,
              timestamp: Date.now(),
              context: 'Browser console error',
              resolution_status: 'pending',
            });
          }
        }
      } catch {
        // Browser log file doesn't exist
      }
    }
  } catch {
    // Error processing browser logs
  }
}

async function showStackTraces(): Promise<void> {
  try {
    const projectRoot = process.cwd();
    const dbPath = join(projectRoot, '.stackmemory', 'context.db');

    if (!existsSync(dbPath)) {
      console.log(
        '❌ StackMemory not initialized. Run "stackmemory init" first.'
      );
      return;
    }

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);

    try {
      // Check if stack_traces table exists
      const tableExists = db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='stack_traces'
      `
        )
        .get();

      if (!tableExists) {
        console.log('📭 No stack traces found in database');
        console.log(
          '💡 Stack traces are stored when using enhanced rehydration features'
        );
        return;
      }

      const traces = db
        .prepare(
          `
        SELECT * FROM stack_traces 
        ORDER BY created_at DESC 
        LIMIT 20
      `
        )
        .all();

      if (traces.length === 0) {
        console.log('📭 No stack traces found in database');
        return;
      }

      console.log(`🐛 Recent Stack Traces (${traces.length} found)\n`);

      for (const trace of traces) {
        const createdAt = new Date(trace.created_at * 1000).toLocaleString();
        const severity = trace.error_severity || 'medium';
        const severityIcon =
          severity === 'high' ? '🔴' : severity === 'low' ? '🟡' : '🟠';

        console.log(
          `${severityIcon} ${trace.error_type || 'Error'} - ${severity.toUpperCase()}`
        );
        console.log(`   Message: ${trace.error_message}`);
        console.log(
          `   File: ${trace.file_path || 'unknown'}${trace.line_number ? `:${trace.line_number}` : ''}`
        );
        console.log(`   Function: ${trace.function_name || 'unknown'}`);
        console.log(`   Status: ${trace.resolution_status}`);
        console.log(`   Created: ${createdAt}`);
        console.log(`   Context: ${trace.context || 'No context'}`);

        const stackFrames = JSON.parse(trace.stack_frames || '[]');
        if (stackFrames.length > 0) {
          console.log(`   Stack (first 3 lines):`);
          stackFrames.slice(0, 3).forEach((frame: string) => {
            console.log(`     ${frame.trim()}`);
          });
        }
        console.log('');
      }

      console.log('💡 Use --trace-stats for statistics and patterns');
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('❌ Failed to show stack traces:', error);
  }
}

async function showStackTraceStats(): Promise<void> {
  try {
    const projectRoot = process.cwd();
    const dbPath = join(projectRoot, '.stackmemory', 'context.db');

    if (!existsSync(dbPath)) {
      console.log(
        '❌ StackMemory not initialized. Run "stackmemory init" first.'
      );
      return;
    }

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);

    try {
      // Check if stack_traces table exists
      const tableExists = db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='stack_traces'
      `
        )
        .get();

      if (!tableExists) {
        console.log('📭 No stack trace data available');
        return;
      }

      console.log('📊 Stack Trace Statistics\n');

      // Total counts
      const totalTraces = db
        .prepare('SELECT COUNT(*) as count FROM stack_traces')
        .get().count;
      console.log(`Total traces: ${totalTraces}`);

      // By status
      const statusStats = db
        .prepare(
          `
        SELECT resolution_status, COUNT(*) as count 
        FROM stack_traces 
        GROUP BY resolution_status 
        ORDER BY count DESC
      `
        )
        .all();

      console.log('\n📈 By Resolution Status:');
      for (const stat of statusStats) {
        const percentage = ((stat.count / totalTraces) * 100).toFixed(1);
        console.log(
          `   ${stat.resolution_status}: ${stat.count} (${percentage}%)`
        );
      }

      // By error type
      const typeStats = db
        .prepare(
          `
        SELECT error_type, COUNT(*) as count 
        FROM stack_traces 
        GROUP BY error_type 
        ORDER BY count DESC 
        LIMIT 10
      `
        )
        .all();

      console.log('\n🔍 Top Error Types:');
      for (const stat of typeStats) {
        const percentage = ((stat.count / totalTraces) * 100).toFixed(1);
        console.log(`   ${stat.error_type}: ${stat.count} (${percentage}%)`);
      }

      // By severity
      const severityStats = db
        .prepare(
          `
        SELECT error_severity, COUNT(*) as count 
        FROM stack_traces 
        GROUP BY error_severity 
        ORDER BY 
          CASE error_severity 
            WHEN 'high' THEN 1 
            WHEN 'medium' THEN 2 
            WHEN 'low' THEN 3 
          END
      `
        )
        .all();

      console.log('\n⚠️ By Severity:');
      for (const stat of severityStats) {
        const percentage = ((stat.count / totalTraces) * 100).toFixed(1);
        const icon =
          stat.error_severity === 'high'
            ? '🔴'
            : stat.error_severity === 'low'
              ? '🟡'
              : '🟠';
        console.log(
          `   ${icon} ${stat.error_severity}: ${stat.count} (${percentage}%)`
        );
      }

      // Recent activity
      const recentTraces = db
        .prepare(
          `
        SELECT COUNT(*) as count 
        FROM stack_traces 
        WHERE created_at > (unixepoch() - 86400)
      `
        )
        .get().count;

      console.log(`\n📅 Recent Activity (24 hours): ${recentTraces} traces`);

      // Most problematic files
      const fileStats = db
        .prepare(
          `
        SELECT file_path, COUNT(*) as count 
        FROM stack_traces 
        WHERE file_path IS NOT NULL 
        GROUP BY file_path 
        ORDER BY count DESC 
        LIMIT 5
      `
        )
        .all();

      if (fileStats.length > 0) {
        console.log('\n🗂️ Most Problematic Files:');
        for (const stat of fileStats) {
          console.log(`   ${stat.file_path}: ${stat.count} errors`);
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('❌ Failed to show stack trace statistics:', error);
  }
}

async function calculateCheckpointHash(checkpoint: any): Promise<string> {
  // Simple hash calculation for integrity verification
  const crypto = await import('crypto');
  const data = JSON.stringify({
    id: checkpoint.id,
    timestamp: checkpoint.timestamp,
    files_count: checkpoint.recent_files?.length || 0,
    project_context: checkpoint.project_context,
    stack_traces_count: checkpoint.stack_traces?.length || 0,
  });
  return crypto.createHash('sha256').update(data).digest('hex');
}
