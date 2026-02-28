/**
 * StackMemory Hook Daemon
 * Background process that manages hooks and events
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  watch,
  appendFileSync,
} from 'fs';
import { join, extname, relative } from 'path';
import { spawn } from 'child_process';
import { loadConfig, HooksConfig } from './config.js';
import {
  hookEmitter,
  HookEventData,
  FileChangeEvent,
  SuggestionReadyEvent,
} from './events.js';

interface DaemonState {
  running: boolean;
  startTime: number;
  eventsProcessed: number;
  lastEvent?: HookEventData;
  watchers: Map<string, ReturnType<typeof watch>>;
  pendingPrediction: boolean;
  lastPrediction?: number;
}

const state: DaemonState = {
  running: false,
  startTime: 0,
  eventsProcessed: 0,
  watchers: new Map(),
  pendingPrediction: false,
};

let config: HooksConfig;
let logStream: ((msg: string) => void) | null = null;

export function log(level: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`;

  if (logStream) {
    logStream(line);
  }

  const logLevels = ['debug', 'info', 'warn', 'error'];
  const configLevel = logLevels.indexOf(config?.daemon?.log_level || 'info');
  const msgLevel = logLevels.indexOf(level);

  if (msgLevel >= configLevel) {
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

export async function startDaemon(
  options: { foreground?: boolean } = {}
): Promise<void> {
  config = loadConfig();

  if (!config.daemon.enabled) {
    log('warn', 'Daemon is disabled in config');
    return;
  }

  const pidFile = config.daemon.pid_file;

  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      log('warn', 'Daemon already running', { pid });
      return;
    } catch {
      unlinkSync(pidFile);
    }
  }

  if (!options.foreground) {
    const child = spawn(
      process.argv[0],
      [...process.argv.slice(1), '--foreground'],
      {
        detached: true,
        stdio: 'ignore',
      }
    );
    child.unref();
    log('info', 'Daemon started in background', { pid: child.pid });
    return;
  }

  writeFileSync(pidFile, process.pid.toString());
  state.running = true;
  state.startTime = Date.now();

  log('info', 'Hook daemon starting', { pid: process.pid });

  setupLogStream();
  registerBuiltinHandlers();
  startFileWatchers();
  setupSignalHandlers();

  hookEmitter.emitHook({
    type: 'session_start',
    timestamp: Date.now(),
    data: { pid: process.pid },
  });

  log('info', 'Hook daemon ready', {
    events: hookEmitter.getRegisteredEvents(),
    watching: Array.from(state.watchers.keys()),
  });

  await new Promise(() => {});
}

export function stopDaemon(): void {
  const pidFile =
    config?.daemon?.pid_file ||
    join(process.env.HOME || '/tmp', '.stackmemory', 'hooks.pid');

  if (!existsSync(pidFile)) {
    log('info', 'Daemon not running');
    return;
  }

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    log('info', 'Daemon stopped', { pid });
  } catch {
    log('warn', 'Could not stop daemon', { pid });
  }

  try {
    unlinkSync(pidFile);
  } catch {
    // Ignore
  }
}

export function getDaemonStatus(): {
  running: boolean;
  pid?: number;
  uptime?: number;
  eventsProcessed?: number;
} {
  config = loadConfig();
  const pidFile = config.daemon.pid_file;

  if (!existsSync(pidFile)) {
    return { running: false };
  }

  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 0);
    return {
      running: true,
      pid,
      uptime: state.running ? Date.now() - state.startTime : undefined,
      eventsProcessed: state.eventsProcessed,
    };
  } catch {
    return { running: false };
  }
}

function setupLogStream(): void {
  const logFile = config.daemon.log_file;

  logStream = (msg: string) => {
    try {
      appendFileSync(logFile, msg + '\n');
    } catch {
      // Ignore
    }
  };
}

function registerBuiltinHandlers(): void {
  hookEmitter.registerHandler('file_change', handleFileChange);
  hookEmitter.registerHandler('suggestion_ready', handleSuggestionReady);
  hookEmitter.registerHandler('error', handleError);

  hookEmitter.on('*', () => {
    state.eventsProcessed++;
  });
}

async function handleFileChange(event: HookEventData): Promise<void> {
  const fileEvent = event as FileChangeEvent;
  const hookConfig = config.hooks.file_change;

  if (!hookConfig?.enabled) return;

  log('debug', 'File change detected', { path: fileEvent.data.path });

  if (hookConfig.handler === 'sweep-predict') {
    await runSweepPrediction(fileEvent);
  }
}

async function runSweepPrediction(event: FileChangeEvent): Promise<void> {
  const hookConfig = config.hooks.file_change;
  if (!hookConfig) return;

  if (state.pendingPrediction) {
    log('debug', 'Prediction already pending, skipping');
    return;
  }

  if (state.lastPrediction) {
    const cooldown = hookConfig.cooldown_ms || 10000;
    if (Date.now() - state.lastPrediction < cooldown) {
      log('debug', 'In cooldown period, skipping');
      return;
    }
  }

  state.pendingPrediction = true;

  const debounce = hookConfig.debounce_ms || 2000;
  await new Promise((r) => setTimeout(r, debounce));

  try {
    const sweepScript = findSweepScript();
    if (!sweepScript) {
      log('warn', 'Sweep script not found');
      state.pendingPrediction = false;
      return;
    }

    const filePath = event.data.path;
    const content =
      event.data.content ||
      (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '');

    const input = {
      file_path: filePath,
      current_content: content,
    };

    const result = await runPythonScript(sweepScript, input);

    if (result && result.success && result.predicted_content) {
      state.lastPrediction = Date.now();

      const suggestionEvent: SuggestionReadyEvent = {
        type: 'suggestion_ready',
        timestamp: Date.now(),
        data: {
          suggestion: result.predicted_content,
          source: 'sweep',
          confidence: result.confidence,
          preview: result.predicted_content.split('\n').slice(0, 3).join('\n'),
        },
      };

      await hookEmitter.emitHook(suggestionEvent);
    }
  } catch (error) {
    log('error', 'Sweep prediction failed', {
      error: (error as Error).message,
    });
  } finally {
    state.pendingPrediction = false;
  }
}

function findSweepScript(): string | null {
  const locations = [
    join(process.env.HOME || '', '.stackmemory', 'sweep', 'sweep_predict.py'),
    join(
      process.cwd(),
      'packages',
      'sweep-addon',
      'python',
      'sweep_predict.py'
    ),
  ];

  for (const loc of locations) {
    if (existsSync(loc)) {
      return loc;
    }
  }
  return null;
}

async function runPythonScript(
  scriptPath: string,
  input: Record<string, unknown>
): Promise<{
  success: boolean;
  predicted_content?: string;
  confidence?: number;
}> {
  return new Promise((resolve) => {
    const proc = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', () => {});

    proc.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ success: false });
      }
    });

    proc.on('error', () => resolve({ success: false }));

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function handleSuggestionReady(event: HookEventData): void {
  const suggestionEvent = event as SuggestionReadyEvent;
  const hookConfig = config.hooks.suggestion_ready;

  if (!hookConfig?.enabled) return;

  const output = hookConfig.output || 'overlay';

  switch (output) {
    case 'overlay':
      displayOverlay(suggestionEvent.data);
      break;
    case 'notification':
      displayNotification(suggestionEvent.data);
      break;
    case 'log':
      log('info', 'Suggestion ready', suggestionEvent.data);
      break;
  }
}

function displayOverlay(data: SuggestionReadyEvent['data']): void {
  const preview = data.preview || data.suggestion.slice(0, 200);
  console.log('\n' + '─'.repeat(50));
  console.log(`[${data.source}] Suggestion:`);
  console.log(preview);
  if (data.suggestion.length > 200) console.log('...');
  console.log('─'.repeat(50) + '\n');
}

function displayNotification(data: SuggestionReadyEvent['data']): void {
  const title = `StackMemory - ${data.source}`;
  const message = data.preview || data.suggestion.slice(0, 100);

  if (process.platform === 'darwin') {
    spawn('osascript', [
      '-e',
      `display notification "${message}" with title "${title}"`,
    ]);
  } else if (process.platform === 'linux') {
    spawn('notify-send', [title, message]);
  }
}

function handleError(event: HookEventData): void {
  log('error', 'Hook error', event.data);
}

function startFileWatchers(): void {
  if (!config.file_watch.enabled) return;

  const paths = config.file_watch.paths;
  const ignore = new Set(config.file_watch.ignore);
  const extensions = new Set(config.file_watch.extensions);

  for (const watchPath of paths) {
    const absPath = join(process.cwd(), watchPath);
    if (!existsSync(absPath)) continue;

    try {
      const watcher = watch(
        absPath,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;

          const relPath = relative(absPath, join(absPath, filename));
          const parts = relPath.split('/');

          if (parts.some((p) => ignore.has(p))) return;

          const ext = extname(filename);
          if (!extensions.has(ext)) return;

          const fullPath = join(absPath, filename);
          const changeType =
            eventType === 'rename'
              ? existsSync(fullPath)
                ? 'create'
                : 'delete'
              : 'modify';

          const fileEvent: FileChangeEvent = {
            type: 'file_change',
            timestamp: Date.now(),
            data: {
              path: fullPath,
              changeType,
              content:
                changeType !== 'delete' && existsSync(fullPath)
                  ? readFileSync(fullPath, 'utf-8')
                  : undefined,
            },
          };

          hookEmitter.emitHook(fileEvent);
        }
      );

      state.watchers.set(absPath, watcher);
      log('debug', 'Watching directory', { path: absPath });
    } catch (error) {
      log('warn', 'Failed to watch directory', {
        path: absPath,
        error: (error as Error).message,
      });
    }
  }
}

function setupSignalHandlers(): void {
  const cleanup = () => {
    log('info', 'Daemon shutting down');
    state.running = false;

    for (const [path, watcher] of state.watchers) {
      watcher.close();
      log('debug', 'Stopped watching', { path });
    }

    hookEmitter.emitHook({
      type: 'session_end',
      timestamp: Date.now(),
      data: { uptime: Date.now() - state.startTime },
    });

    try {
      unlinkSync(config.daemon.pid_file);
    } catch {
      // Ignore
    }

    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGHUP', cleanup);
}

export { config, state };
