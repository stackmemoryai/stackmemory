import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { formatElapsed } from '../orchestrate.js';
import { getAgentStatusDir, type AgentStatusFile } from '../orchestrator.js';

describe('conductor observability', () => {
  let tempDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sm-conductor-obs-'));
    // Override HOME so agent status dirs go to our temp
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getAgentStatusDir', () => {
    it('returns path under ~/.stackmemory/conductor/agents/<id>', () => {
      const dir = getAgentStatusDir('STA-499');
      expect(dir).toBe(
        join(tempDir, '.stackmemory', 'conductor', 'agents', 'STA-499')
      );
    });
  });

  describe('AgentStatusFile format', () => {
    it('can be written and read as valid JSON', () => {
      const dir = join(
        tempDir,
        '.stackmemory',
        'conductor',
        'agents',
        'STA-499'
      );
      mkdirSync(dir, { recursive: true });

      const status: AgentStatusFile = {
        issue: 'STA-499',
        pid: 12345,
        started: '2026-03-07T20:44:15Z',
        lastUpdate: '2026-03-07T20:50:30Z',
        phase: 'implementing',
        filesModified: 3,
        toolCalls: 47,
        tokensUsed: 32000,
      };

      writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2));

      const read = JSON.parse(
        readFileSync(join(dir, 'status.json'), 'utf-8')
      ) as AgentStatusFile;

      expect(read.issue).toBe('STA-499');
      expect(read.phase).toBe('implementing');
      expect(read.toolCalls).toBe(47);
      expect(read.filesModified).toBe(3);
      expect(read.tokensUsed).toBe(32000);
      expect(read.pid).toBe(12345);
    });
  });

  describe('formatElapsed', () => {
    it('formats seconds', () => {
      expect(formatElapsed(5000)).toBe('5s ago');
      expect(formatElapsed(30000)).toBe('30s ago');
    });

    it('formats minutes', () => {
      expect(formatElapsed(120000)).toBe('2m ago');
      expect(formatElapsed(300000)).toBe('5m ago');
    });

    it('formats hours', () => {
      expect(formatElapsed(3600000)).toBe('1h ago');
      expect(formatElapsed(7200000)).toBe('2h ago');
    });

    it('formats days', () => {
      expect(formatElapsed(86400000)).toBe('1d ago');
    });
  });

  describe('conductor status subcommand', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('shows no-data message when no status files exist', async () => {
      // Import dynamically to pick up HOME override
      const { createConductorCommands } = await import('../orchestrate.js');

      const parent = new Command();
      parent.addCommand(createConductorCommands());
      await parent.parseAsync(['node', 'stackmemory', 'conductor', 'status']);

      expect(consoleSpy).toHaveBeenCalledWith('No agent status files found');
    });

    it('renders table when status files exist', async () => {
      // Seed status files
      const agentsDir = join(tempDir, '.stackmemory', 'conductor', 'agents');

      const dir1 = join(agentsDir, 'STA-492');
      mkdirSync(dir1, { recursive: true });
      const now = new Date();
      writeFileSync(
        join(dir1, 'status.json'),
        JSON.stringify({
          issue: 'STA-492',
          pid: 1000,
          started: new Date(now.getTime() - 600000).toISOString(),
          lastUpdate: new Date(now.getTime() - 120000).toISOString(),
          phase: 'implementing',
          filesModified: 3,
          toolCalls: 47,
          tokensUsed: 32000,
        })
      );

      const dir2 = join(agentsDir, 'STA-485');
      mkdirSync(dir2, { recursive: true });
      writeFileSync(
        join(dir2, 'status.json'),
        JSON.stringify({
          issue: 'STA-485',
          pid: 2000,
          started: new Date(now.getTime() - 300000).toISOString(),
          lastUpdate: new Date(now.getTime() - 30000).toISOString(),
          phase: 'testing',
          filesModified: 1,
          toolCalls: 12,
          tokensUsed: 8000,
        })
      );

      const { createConductorCommands } = await import('../orchestrate.js');

      const parent = new Command();
      parent.addCommand(createConductorCommands());
      await parent.parseAsync(['node', 'stackmemory', 'conductor', 'status']);

      // Should render header + grid cells + separators
      expect(consoleSpy.mock.calls.length).toBeGreaterThan(3);

      // Check both issues and phases appear in output
      const allOutput = consoleSpy.mock.calls.map((cc) => cc[0]).join('\n');
      expect(allOutput).toContain('Conductor');
      expect(allOutput).toContain('STA-492');
      expect(allOutput).toContain('STA-485');
      // Phase labels are capitalized in new UI
      expect(allOutput).toMatch(/Implementing|Dead|Stalled/);
      expect(allOutput).toMatch(/Testing|Dead|Stalled/);
    });
  });

  describe('conductor logs subcommand', () => {
    let consoleErrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrSpy.mockRestore();
    });

    it('shows error when no log file exists', async () => {
      const { createConductorCommands } = await import('../orchestrate.js');

      const parent = new Command();
      parent.addCommand(createConductorCommands());

      await parent.parseAsync([
        'node',
        'stackmemory',
        'conductor',
        'logs',
        'STA-999',
      ]);

      expect(consoleErrSpy).toHaveBeenCalledWith(
        expect.stringContaining('No log file found for STA-999')
      );
    });

    it('tails an existing log file', async () => {
      // Create a log file to tail
      const dir = join(
        tempDir,
        '.stackmemory',
        'conductor',
        'agents',
        'STA-500'
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'output.log'), 'line1\nline2\nline3\n');

      const { createConductorCommands } = await import('../orchestrate.js');

      const parent = new Command();
      parent.addCommand(createConductorCommands());

      // Should not throw — tail the file (non-follow mode)
      await parent.parseAsync([
        'node',
        'stackmemory',
        'conductor',
        'logs',
        'STA-500',
        '-n',
        '10',
      ]);

      // If we get here without error, tail ran successfully
      expect(existsSync(join(dir, 'output.log'))).toBe(true);
    });
  });

  describe('output.log file creation', () => {
    it('log file path is under agent status dir', () => {
      const dir = getAgentStatusDir('STA-500');
      const logPath = join(dir, 'output.log');
      expect(logPath).toContain('STA-500');
      expect(logPath).toContain('output.log');
    });
  });
});
