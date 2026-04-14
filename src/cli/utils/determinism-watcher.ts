import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { getDeterminismWatchTargets } from '../../orchestrators/multimodal/determinism.js';

export interface DeterminismWatcherOptions {
  stackmemoryBin: string;
  cwd: string;
  task?: string;
  instanceId?: string;
  sessionId?: string;
  tool: 'claude' | 'codex' | 'opencode';
}

export interface DeterminismWatcherHandle {
  child: ReturnType<typeof spawn>;
  mode: 'targeted' | 'repo-root';
  targets: string[];
}

export function shouldAutoStartDeterminismWatcher(cwd: string): boolean {
  if (process.env['STACKMEMORY_DETERMINISM_AUTO'] === '0') {
    return false;
  }

  return fs.existsSync(path.join(cwd, '.git'));
}

export function startDeterminismWatcher(
  options: DeterminismWatcherOptions
): DeterminismWatcherHandle | null {
  if (!shouldAutoStartDeterminismWatcher(options.cwd)) {
    return null;
  }

  const runs = process.env['STACKMEMORY_DETERMINISM_RUNS'] || '3';
  const task =
    options.task ||
    process.env['STACKMEMORY_DETERMINISM_TASK'] ||
    'Determinism probe';
  const targets = getDeterminismWatchTargets(options.cwd);
  const mode: 'targeted' | 'repo-root' =
    targets.length === 1 && targets[0] === '.' ? 'repo-root' : 'targeted';

  const child = spawn(
    options.stackmemoryBin,
    [
      'bench',
      'determinism',
      '--task',
      task,
      '--runs',
      runs,
      '--watch',
      '--json',
    ],
    {
      cwd: options.cwd,
      stdio: 'ignore',
      env: {
        ...process.env,
        STACKMEMORY_DETERMINISM_PARENT_TOOL: options.tool,
        STACKMEMORY_DETERMINISM_PARENT_INSTANCE: options.instanceId || '',
        STACKMEMORY_DETERMINISM_PARENT_SESSION: options.sessionId || '',
      },
    }
  );

  return {
    child,
    mode,
    targets,
  };
}

export function stopDeterminismWatcher(
  handle: DeterminismWatcherHandle | null
): void {
  const child = handle?.child ?? null;
  if (!child || child.killed) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Best-effort only.
  }
}
