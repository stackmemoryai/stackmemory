/**
 * Adapter Factory
 *
 * Auto-detects the best adapter based on environment:
 *   1. tmux available + no desktop flag → TmuxAdapter (CLI)
 *   2. Claude desktop app running → DesktopAdapter (macOS)
 *   3. Playwright available → BrowserAdapter (web)
 *
 * Or use --mode to force a specific adapter.
 */

import { execSync } from 'child_process';
import type { AdapterMode, ScreenAdapter } from './types.js';
import { TmuxAdapter } from './screen-adapter.js';
import type { LLMDecisionConfig } from './llm-decision.js';

interface AdapterFactoryConfig {
  mode: AdapterMode;
  sessionName: string;
  cwd: string;
  appName?: string;
  llmConfig?: LLMDecisionConfig;
}

export function createAdapter(config: AdapterFactoryConfig): ScreenAdapter {
  const mode = config.mode === 'auto' ? detectMode(config) : config.mode;

  switch (mode) {
    case 'tmux':
      return new TmuxAdapter(config.sessionName, '0');

    case 'desktop': {
      if (!config.llmConfig?.apiKey) {
        throw new Error(
          'Desktop mode requires ANTHROPIC_API_KEY for screenshot interpretation.\n' +
            'Set it via: export ANTHROPIC_API_KEY=sk-ant-...'
        );
      }
      // Dynamic import to avoid hard dep on desktop-adapter
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DesktopAdapter } = require('./desktop-adapter.js');
      return new DesktopAdapter(config.appName ?? 'Claude', config.llmConfig);
    }

    case 'browser':
      throw new Error(
        'Browser mode requires a Playwright page instance.\n' +
          'Use BrowserAdapter directly with an initialized page,\n' +
          'or use: stackmemory operator start --mode browser --url https://claude.ai/code'
      );

    default:
      return new TmuxAdapter(config.sessionName, '0');
  }
}

function detectMode(config: AdapterFactoryConfig): AdapterMode {
  // 1. Check if tmux is available (fastest, most reliable)
  if (isTmuxAvailable()) {
    return 'tmux';
  }

  // 2. Check if Claude desktop app is running (macOS)
  if (process.platform === 'darwin' && isClaudeDesktopRunning(config.appName)) {
    return 'desktop';
  }

  // 3. Default to tmux with a helpful error
  process.stderr.write(
    '[operator] Warning: tmux not found and no desktop app detected.\n' +
      '  Install tmux: brew install tmux\n' +
      '  Or use --mode desktop/browser\n'
  );
  return 'tmux';
}

function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isClaudeDesktopRunning(appName: string = 'Claude'): boolean {
  try {
    const result = execSync(
      `osascript -e 'tell application "System Events" to (name of processes) contains "${appName}"'`,
      { encoding: 'utf-8', timeout: 5_000 }
    ).trim();
    return result === 'true';
  } catch {
    return false;
  }
}
