import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('conductor lane mode', () => {
  let tempDir: string;
  let sigintBefore: Function[];
  let sigtermBefore: Function[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sm-conductor-lane-'));
    sigintBefore = process.listeners('SIGINT');
    sigtermBefore = process.listeners('SIGTERM');
    vi.resetModules();
  });

  afterEach(() => {
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintBefore.includes(listener)) {
        process.removeListener('SIGINT', listener);
      }
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermBefore.includes(listener)) {
        process.removeListener('SIGTERM', listener);
      }
    }
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips lane cleanup when worktree cleanliness cannot be verified', async () => {
    const execSync = vi.fn((cmd: string) => {
      if (cmd === 'git branch --show-current') return 'lane/main\n';
      if (cmd === `git branch --list 'worktree-agent-*'`) {
        return '  worktree-agent-123\n';
      }
      if (
        cmd === 'git merge-base --is-ancestor "worktree-agent-123" "lane/main"'
      ) {
        throw Object.assign(new Error('not ancestor'), { status: 1 });
      }
      if (cmd === 'git cherry "lane/main" "worktree-agent-123"') return '';
      if (cmd === 'git worktree list --porcelain') {
        return [
          'worktree /tmp/worktree-agent-123',
          'branch refs/heads/worktree-agent-123',
          '',
        ].join('\n');
      }
      if (cmd === 'git -C "/tmp/worktree-agent-123" status --short') {
        throw new Error('status unavailable');
      }
      throw new Error(`Unexpected execSync: ${cmd}`);
    });

    vi.doMock('child_process', async () => {
      const actual =
        await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, execSync };
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { createConductorCommands } = await import('../orchestrate.js');

    const program = new Command();
    program.exitOverride();
    program.addCommand(createConductorCommands());

    await program.parseAsync([
      'node',
      'stackmemory',
      'conductor',
      'lane',
      'cleanup',
      '--repo',
      tempDir,
    ]);

    const output = consoleLog.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(output).toContain('unknown');
    expect(output).toContain('could not verify clean state');
    expect(
      execSync.mock.calls.some(([cmd]) =>
        String(cmd).includes('git worktree remove')
      )
    ).toBe(false);
  });

  it('uses worktrees in auto mode when lane mode is enabled', async () => {
    const repoRoot = join(tempDir, 'repo');
    const workspaceRoot = join(tempDir, 'workspaces');
    const appServerPath = join(tempDir, 'claude-app-server.cjs');

    mkdirSync(join(repoRoot, '.git', 'gitbutler'), { recursive: true });
    writeFileSync(appServerPath, 'module.exports = {};');

    const execSync = vi.fn((cmd: string) => {
      if (cmd === 'but --version') return 'gitbutler 1.0.0\n';
      throw new Error(`Unexpected execSync: ${cmd}`);
    });

    vi.doMock('child_process', async () => {
      const actual =
        await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, execSync };
    });

    const { Conductor } = await import('../orchestrator.js');
    const conductor = new Conductor({
      activeStates: ['Todo'],
      terminalStates: ['Done', 'Cancelled'],
      inProgressState: 'In Progress',
      inReviewState: 'In Review',
      pollIntervalMs: 1,
      maxConcurrent: 1,
      workspaceRoot,
      repoRoot,
      baseBranch: 'main',
      appServerPath,
      turnTimeoutMs: 1,
      maxRetries: 0,
      hookTimeoutMs: 1,
      agentMode: 'cli',
      workspaceMode: 'auto',
      laneBranch: 'lane/main',
    });

    (conductor as unknown as Record<string, unknown>).createLinearClient = vi
      .fn()
      .mockResolvedValue(null);
    (conductor as unknown as Record<string, unknown>).cacheWorkflowStates = vi
      .fn()
      .mockResolvedValue(undefined);
    (conductor as unknown as Record<string, unknown>).writeStatusFile = vi.fn();
    (conductor as unknown as Record<string, unknown>).poll = vi
      .fn()
      .mockResolvedValue(undefined);
    (conductor as unknown as Record<string, unknown>).schedulePoll = vi
      .fn()
      .mockResolvedValue(undefined);

    await conductor.start();

    expect(
      execSync.mock.calls.some(([cmd]) => String(cmd) === 'but --version')
    ).toBe(false);
    expect(
      (conductor as unknown as { useGitButler: boolean }).useGitButler
    ).toBe(false);
  });

  it('rejects explicit gitbutler mode when lane mode is enabled', async () => {
    const repoRoot = join(tempDir, 'repo');
    const workspaceRoot = join(tempDir, 'workspaces');
    const appServerPath = join(tempDir, 'claude-app-server.cjs');

    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(appServerPath, 'module.exports = {};');

    const execSync = vi.fn();

    vi.doMock('child_process', async () => {
      const actual =
        await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, execSync };
    });

    const { Conductor } = await import('../orchestrator.js');
    const conductor = new Conductor({
      activeStates: ['Todo'],
      terminalStates: ['Done', 'Cancelled'],
      inProgressState: 'In Progress',
      inReviewState: 'In Review',
      pollIntervalMs: 1,
      maxConcurrent: 1,
      workspaceRoot,
      repoRoot,
      baseBranch: 'main',
      appServerPath,
      turnTimeoutMs: 1,
      maxRetries: 0,
      hookTimeoutMs: 1,
      agentMode: 'cli',
      workspaceMode: 'gitbutler',
      laneBranch: 'lane/main',
    });

    await expect(conductor.start()).rejects.toThrow(
      '--lane is only supported with git worktrees'
    );
  });
});
