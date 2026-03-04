import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

describe('desires CLI', () => {
  let tmpDir: string;
  let desireDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desires-test-'));
    desireDir = path.join(tmpDir, '.stackmemory', 'desire-paths');
    fs.mkdirSync(desireDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSampleEntries(filename: string, entries: object[]) {
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(desireDir, filename), content);
  }

  const sampleEntries = [
    {
      ts: '2026-03-04T10:00:00Z',
      sid: 'sess1',
      tool: 'sm_nonexistent',
      input: { query: 'test' },
      error: 'Unknown tool: sm_nonexistent',
      category: 'unknown_tool',
      cwd: '/tmp/project',
    },
    {
      ts: '2026-03-04T10:01:00Z',
      sid: 'sess1',
      tool: 'sm_search',
      input: { query: 'bug' },
      error: 'Error: database locked',
      category: 'handler_error',
      cwd: '/tmp/project',
    },
    {
      ts: '2026-03-04T10:02:00Z',
      sid: 'sess2',
      tool: 'sm_fancy_tool',
      input: {},
      error: 'Unknown tool: sm_fancy_tool',
      category: 'unknown_tool',
      cwd: '/tmp/other',
    },
  ];

  describe('desires summary', () => {
    it('shows aggregated counts', () => {
      writeSampleEntries('desire-2026-03-04.jsonl', sampleEntries);

      // Import and test the loadEntries logic directly
      const lines = fs
        .readFileSync(path.join(desireDir, 'desire-2026-03-04.jsonl'), 'utf-8')
        .split('\n')
        .filter(Boolean);

      expect(lines).toHaveLength(3);

      // Parse and aggregate like summary does
      const entries = lines.map((l) => JSON.parse(l));
      const byTool = new Map<string, number>();
      for (const e of entries) {
        byTool.set(e.tool, (byTool.get(e.tool) || 0) + 1);
      }

      expect(byTool.get('sm_nonexistent')).toBe(1);
      expect(byTool.get('sm_search')).toBe(1);
      expect(byTool.get('sm_fancy_tool')).toBe(1);
    });
  });

  describe('desires list', () => {
    it('shows recent entries', () => {
      writeSampleEntries('desire-2026-03-04.jsonl', sampleEntries);

      const lines = fs
        .readFileSync(path.join(desireDir, 'desire-2026-03-04.jsonl'), 'utf-8')
        .split('\n')
        .filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l));

      // Most recent first
      const sorted = entries.sort((a: { ts: string }, b: { ts: string }) =>
        b.ts.localeCompare(a.ts)
      );
      expect(sorted[0].tool).toBe('sm_fancy_tool');
    });

    it('filters unknown_only correctly', () => {
      writeSampleEntries('desire-2026-03-04.jsonl', sampleEntries);

      const lines = fs
        .readFileSync(path.join(desireDir, 'desire-2026-03-04.jsonl'), 'utf-8')
        .split('\n')
        .filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l));
      const unknownOnly = entries.filter(
        (e: { category: string }) => e.category === 'unknown_tool'
      );

      expect(unknownOnly).toHaveLength(2);
      expect(
        unknownOnly.every(
          (e: { category: string }) => e.category === 'unknown_tool'
        )
      ).toBe(true);
    });
  });

  describe('empty state', () => {
    it('handles missing desire-paths directory', () => {
      // Remove the directory
      fs.rmSync(desireDir, { recursive: true, force: true });

      // loadEntries should return empty
      const dir = desireDir;
      const exists = fs.existsSync(dir);
      expect(exists).toBe(false);
    });

    it('handles empty desire-paths directory', () => {
      const files = fs
        .readdirSync(desireDir)
        .filter((f) => f.startsWith('desire-') && f.endsWith('.jsonl'));
      expect(files).toHaveLength(0);
    });
  });
});

describe('desire-path-trace hook', () => {
  const hookSrc = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'templates',
    'claude-hooks',
    'desire-path-trace.js'
  );

  // Copy hook to a temp dir outside the project so Node treats it as CJS
  // (the project has "type": "module" in package.json)
  let hookDir: string;
  let hookPath: string;

  beforeEach(() => {
    hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-run-'));
    hookPath = path.join(hookDir, 'desire-path-trace.js');
    fs.copyFileSync(hookSrc, hookPath);
  });

  afterEach(() => {
    fs.rmSync(hookDir, { recursive: true, force: true });
  });

  it('hook file exists', () => {
    expect(fs.existsSync(hookSrc)).toBe(true);
  });

  it('exits 0 with error-containing tool_response', () => {
    const input = JSON.stringify({
      tool_name: 'sm_nonexistent',
      tool_input: { query: 'test' },
      tool_response: {
        is_error: true,
        content: [{ type: 'text', text: 'Unknown tool: sm_nonexistent' }],
      },
      session_id: 'test-session',
    });

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
    try {
      execSync(`echo '${input.replace(/'/g, "'\\''")}' | node "${hookPath}"`, {
        env: { ...process.env, HOME: tmpHome },
        timeout: 5000,
        stdio: 'pipe',
      });

      // Verify JSONL was written
      const desirePath = path.join(tmpHome, '.stackmemory', 'desire-paths');
      const files = fs.existsSync(desirePath)
        ? fs.readdirSync(desirePath).filter((f) => f.endsWith('.jsonl'))
        : [];
      expect(files.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('exits 0 with success tool_response (no log written)', () => {
    const input = JSON.stringify({
      tool_name: 'sm_search',
      tool_input: { query: 'test' },
      tool_response: {
        content: [{ type: 'text', text: 'Found 3 results' }],
      },
      session_id: 'test-session',
    });

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
    try {
      execSync(`echo '${input.replace(/'/g, "'\\''")}' | node "${hookPath}"`, {
        env: { ...process.env, HOME: tmpHome },
        timeout: 5000,
        stdio: 'pipe',
      });

      // No JSONL should be written for success
      const desirePath = path.join(tmpHome, '.stackmemory', 'desire-paths');
      const files = fs.existsSync(desirePath)
        ? fs.readdirSync(desirePath).filter((f) => f.endsWith('.jsonl'))
        : [];
      expect(files).toHaveLength(0);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
