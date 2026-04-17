/**
 * Sweep PTY Wrapper
 *
 * Wraps Claude Code in a pseudo-terminal to add a Sweep prediction
 * status bar at the bottom of the terminal. Predictions from the
 * PostToolUse hook are displayed via the status bar. Tab to accept,
 * Esc to dismiss.
 */

import { join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { SweepStateWatcher, type PredictionEvent } from './state-watcher.js';
import { StatusBar } from './status-bar.js';
import { TabInterceptor } from './tab-interceptor.js';

const HOME = process.env['HOME'] || '/tmp';

function getSweepDir(): string {
  return process.env['SWEEP_STATE_DIR'] || join(HOME, '.stackmemory');
}

function getSweepPath(filename: string): string {
  return join(getSweepDir(), filename);
}

// Alt screen buffer detection
const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_EXIT = '\x1b[?1049l';

export interface PtyWrapperConfig {
  claudeBin?: string;
  claudeArgs?: string[];
  stateFile?: string;
  initialInput?: string;
  onExit?: (exitCode: number) => Promise<void> | void;
  onSignal?: (signal: 'SIGINT' | 'SIGTERM') => Promise<void> | void;
}

// Minimal interface for node-pty process to avoid compile-time dep
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  kill(): void;
}

export class PtyWrapper {
  private config: Required<PtyWrapperConfig>;
  private stateWatcher: SweepStateWatcher;
  private statusBar: StatusBar;
  private tabInterceptor: TabInterceptor;
  private currentPrediction: PredictionEvent | null = null;
  private inAltScreen = false;
  private ptyProcess: PtyProcess | null = null;

  constructor(config: PtyWrapperConfig = {}) {
    this.config = {
      claudeBin: config.claudeBin || this.findClaude(),
      claudeArgs: config.claudeArgs || [],
      stateFile: config.stateFile || getSweepPath('sweep-state.json'),
      initialInput: config.initialInput || '',
      onExit: config.onExit || (() => undefined),
      onSignal: config.onSignal || (() => undefined),
    };

    this.stateWatcher = new SweepStateWatcher(this.config.stateFile);
    this.statusBar = new StatusBar();
    this.tabInterceptor = new TabInterceptor({
      onAccept: () => this.acceptPrediction(),
      onDismiss: () => this.dismissPrediction(),
      onPassthrough: (data) => this.ptyProcess?.write(data.toString('utf-8')),
    });
  }

  async start(): Promise<void> {
    // Ensure the sweep state directory exists
    const sweepDir = getSweepDir();
    if (!existsSync(sweepDir)) {
      mkdirSync(sweepDir, { recursive: true });
    }

    // Dynamic import for optional dependency
    let pty: typeof import('node-pty');
    try {
      pty = await import('node-pty');
    } catch {
      throw new Error(
        'node-pty is required for the PTY wrapper.\n' +
          'Install with: npm install node-pty'
      );
    }

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // Filter undefined values from env
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }

    // Spawn Claude Code in a PTY with 1 row reserved for status bar
    this.ptyProcess = pty.spawn(this.config.claudeBin, this.config.claudeArgs, {
      name: process.env['TERM'] || 'xterm-256color',
      cols,
      rows: rows - 1,
      cwd: process.cwd(),
      env,
    }) as PtyProcess;

    // Set raw mode on stdin
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // PTY stdout -> parent stdout (transparent passthrough)
    let inputInjected = false;
    const initialInput = this.config.initialInput;
    const ptyRef = this.ptyProcess;

    this.ptyProcess.onData((data: string) => {
      // Detect alt screen buffer transitions
      if (data.includes(ALT_SCREEN_ENTER)) {
        this.inAltScreen = true;
        this.statusBar.hide();

        // Inject initial input as bracketed paste after Claude UI enters alt screen
        if (!inputInjected && initialInput && ptyRef) {
          inputInjected = true;
          setTimeout(() => {
            // Bracketed paste mode: text appears in input area without auto-sending
            ptyRef.write('\x1b[200~' + initialInput + '\x1b[201~');
          }, 800);
        }
      }
      if (data.includes(ALT_SCREEN_EXIT)) {
        this.inAltScreen = false;
      }

      process.stdout.write(data);
    });

    // Parent stdin -> tab interceptor -> PTY
    process.stdin.on('data', (data: Buffer) => {
      this.tabInterceptor.process(data);
    });

    // State watcher -> status bar
    this.stateWatcher.on('loading', () => {
      if (!this.inAltScreen) {
        this.statusBar.showLoading();
      }
    });

    this.stateWatcher.on('prediction', (event: PredictionEvent) => {
      this.currentPrediction = event;
      this.tabInterceptor.setPredictionActive(true);
      if (!this.inAltScreen) {
        this.statusBar.show(
          event.prediction,
          event.file_path,
          event.latency_ms
        );
      }
    });

    this.stateWatcher.start();

    // Handle terminal resize
    process.stdout.on('resize', () => {
      const newCols = process.stdout.columns || 80;
      const newRows = process.stdout.rows || 24;
      this.ptyProcess?.resize(newCols, newRows - 1);
      this.statusBar.resize(newRows, newCols);
    });

    // Handle PTY exit
    this.ptyProcess.onExit(async ({ exitCode }) => {
      this.cleanup();
      await this.config.onExit(exitCode);
      // Sync Linear on exit if configured
      if (process.env['LINEAR_API_KEY']) {
        try {
          execSync('stackmemory linear sync', {
            stdio: 'ignore',
            timeout: 10000,
          });
        } catch {
          // Non-fatal: don't block exit
        }
      }
      process.exit(exitCode);
    });

    // Handle signals
    const onSignal = async (signal: 'SIGINT' | 'SIGTERM') => {
      this.cleanup();
      await this.config.onSignal(signal);
      process.exit(0);
    };
    process.on('SIGINT', () => {
      void onSignal('SIGINT');
    });
    process.on('SIGTERM', () => {
      void onSignal('SIGTERM');
    });
  }

  private acceptPrediction(): void {
    if (!this.currentPrediction || !this.ptyProcess) return;

    // Write prediction to pending file for Claude to read
    const dir = getSweepDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const pendingFile = getSweepPath('sweep-pending.json');
    writeFileSync(
      pendingFile,
      JSON.stringify(
        {
          file_path: this.currentPrediction.file_path,
          predicted_content: this.currentPrediction.prediction,
          timestamp: Date.now(),
        },
        null,
        2
      )
    );

    // Inject acceptance prompt into PTY stdin.
    // SAFETY: pendingFile is derived from env or a constant path, not
    // arbitrary user input. The prompt is written to Claude Code's input,
    // which interprets it as a user message, not as a shell command.
    const prompt = `Apply the Sweep prediction from ${pendingFile}\n`;
    this.ptyProcess.write(prompt);

    this.dismissPrediction();
  }

  private dismissPrediction(): void {
    this.currentPrediction = null;
    this.tabInterceptor.setPredictionActive(false);
    this.statusBar.hide();
  }

  private cleanup(): void {
    this.stateWatcher.stop();
    this.statusBar.hide();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  private findClaude(): string {
    // Check PATH first via which
    try {
      const resolved = execSync('which claude', { encoding: 'utf-8' }).trim();
      if (resolved) return resolved;
    } catch {
      // Not on PATH
    }

    // Check known locations
    const candidates = [
      join(HOME, '.bun', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];

    for (const c of candidates) {
      if (existsSync(c)) return c;
    }

    return 'claude';
  }
}

/**
 * Launch the PTY wrapper
 */
export async function launchWrapper(config?: PtyWrapperConfig): Promise<void> {
  const wrapper = new PtyWrapper(config);
  await wrapper.start();
}
