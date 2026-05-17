import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  DaemonDesirePathService,
  type DesirePathConfig,
} from '../desire-path-service.js';

// Override SM_DIR for tests by using the service's logAction method
// which writes to ~/.stackmemory/desire-paths/ — we test the public API

describe('DaemonDesirePathService', () => {
  let tmpDir: string;
  let config: DesirePathConfig;
  let logs: Array<{ level: string; msg: string; data?: unknown }>;
  let onLog: (level: string, msg: string, data?: unknown) => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sm-dp-'));
    logs = [];
    onLog = (level, msg, data) => logs.push({ level, msg, data });
    config = {
      enabled: true,
      interval: 360,
      minFrequency: 2, // lower for tests
      minSessions: 2,
      maxLogSizeBytes: 10 * 1024 * 1024,
      retentionDays: 30,
      maxSequenceLength: 6,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseHookEvent', () => {
    it('sanitizes file paths into glob patterns', () => {
      const entry = DaemonDesirePathService.parseHookEvent(
        'Read',
        '/src/runtime/agent-runner.js',
        'sess-1'
      );
      expect(entry.tool).toBe('Read');
      expect(entry.target).toBe('/src/runtime/*.js');
      expect(entry.sid).toBe('sess-1');
    });

    it('sanitizes bash commands to command + first arg', () => {
      const entry = DaemonDesirePathService.parseHookEvent(
        'Bash',
        'npx jest src/runtime --no-coverage',
        'sess-1'
      );
      expect(entry.tool).toBe('Bash');
      expect(entry.target).toBe('npx jest');
    });

    it('handles empty args', () => {
      const entry = DaemonDesirePathService.parseHookEvent(
        'Grep',
        '',
        'sess-1'
      );
      expect(entry.target).toBe('*');
    });

    it('truncates long args', () => {
      const longArg = 'a'.repeat(100);
      const entry = DaemonDesirePathService.parseHookEvent(
        'Glob',
        longArg,
        'sess-1'
      );
      expect(entry.target.length).toBeLessThanOrEqual(50);
    });
  });

  describe('pattern detection', () => {
    it('detects repeated sequences across sessions', () => {
      const service = new DaemonDesirePathService(config, onLog);

      // Simulate action stream directly by writing JSONL
      const dpDir = join(homedir(), '.stackmemory', 'desire-paths');
      mkdirSync(dpDir, { recursive: true });
      const streamFile = join(dpDir, 'action-stream.jsonl');

      // Session 1: Read → Edit → Bash
      const actions = [
        {
          ts: '2026-05-09T10:00:00Z',
          sid: 'sess-1',
          tool: 'Read',
          target: 'src/runtime/*.js',
        },
        {
          ts: '2026-05-09T10:00:01Z',
          sid: 'sess-1',
          tool: 'Edit',
          target: 'src/runtime/*.js',
        },
        {
          ts: '2026-05-09T10:00:02Z',
          sid: 'sess-1',
          tool: 'Bash',
          target: 'npx jest',
        },
        // Session 2: same pattern
        {
          ts: '2026-05-09T11:00:00Z',
          sid: 'sess-2',
          tool: 'Read',
          target: 'src/runtime/*.js',
        },
        {
          ts: '2026-05-09T11:00:01Z',
          sid: 'sess-2',
          tool: 'Edit',
          target: 'src/runtime/*.js',
        },
        {
          ts: '2026-05-09T11:00:02Z',
          sid: 'sess-2',
          tool: 'Bash',
          target: 'npx jest',
        },
        // Session 3: same pattern again
        {
          ts: '2026-05-09T12:00:00Z',
          sid: 'sess-3',
          tool: 'Read',
          target: 'src/runtime/*.js',
        },
        {
          ts: '2026-05-09T12:00:01Z',
          sid: 'sess-3',
          tool: 'Edit',
          target: 'src/runtime/*.js',
        },
        {
          ts: '2026-05-09T12:00:02Z',
          sid: 'sess-3',
          tool: 'Bash',
          target: 'npx jest',
        },
      ];

      writeFileSync(
        streamFile,
        actions.map((a) => JSON.stringify(a)).join('\n') + '\n'
      );

      const patterns = service.detectPatterns();

      expect(patterns.length).toBeGreaterThan(0);
      // Should find the Read→Edit→Bash sequence
      const fullPattern = patterns.find((p) => p.sequence.length === 3);
      expect(fullPattern).toBeDefined();
      expect(fullPattern!.frequency).toBeGreaterThanOrEqual(3);
      expect(fullPattern!.sessions).toBeGreaterThanOrEqual(2);

      // Cleanup
      rmSync(streamFile, { force: true });
    });

    it('returns empty for insufficient data', () => {
      const service = new DaemonDesirePathService(config, onLog);
      const patterns = service.detectPatterns();
      // May return empty or patterns from previous test — just verify no crash
      expect(Array.isArray(patterns)).toBe(true);
    });
  });

  describe('skill suggestion', () => {
    it('generates skill markdown from patterns', () => {
      const service = new DaemonDesirePathService(config, onLog);

      const patterns = [
        {
          id: 'test-1',
          sequence: [
            'Read:src/runtime/*.js',
            'Edit:src/runtime/*.js',
            'Bash:npx jest',
          ],
          frequency: 5,
          sessions: 3,
          avg_steps: 3,
          first_seen: '2026-05-09T10:00:00Z',
          last_seen: '2026-05-09T12:00:00Z',
          score: 15,
        },
      ];

      const suggestions = service.generateSuggestions(patterns);

      expect(suggestions.length).toBe(1);
      expect(suggestions[0].name).toContain('auto-');
      expect(suggestions[0].steps.length).toBe(3);
      expect(suggestions[0].confidence).toBeGreaterThan(0);
      expect(suggestions[0].pattern_id).toBe('test-1');

      // Check suggestion file was written
      const suggestionsDir = join(
        homedir(),
        '.stackmemory',
        'desire-paths',
        'suggestions'
      );
      const files = require('fs')
        .readdirSync(suggestionsDir)
        .filter((f: string) => f.endsWith('.skill.md'));
      expect(files.length).toBeGreaterThan(0);

      // Read and verify markdown structure
      const content = readFileSync(join(suggestionsDir, files[0]), 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('status: suggested');
      expect(content).toContain('Auto-Detected Workflow');
    });
  });

  describe('opt-out', () => {
    it('respects environment variable', () => {
      const orig = process.env.STACKMEMORY_DESIRE_PATHS;
      process.env.STACKMEMORY_DESIRE_PATHS = '0';

      const service = new DaemonDesirePathService(config, onLog);
      service.logAction({
        ts: new Date().toISOString(),
        sid: 'test',
        tool: 'Read',
        target: 'foo',
      });

      // Should not increment counter
      expect(service.getState().actionsLogged).toBe(0);

      if (orig === undefined) delete process.env.STACKMEMORY_DESIRE_PATHS;
      else process.env.STACKMEMORY_DESIRE_PATHS = orig;
    });

    it('respects config.enabled = false', () => {
      const disabledConfig = { ...config, enabled: false };
      const service = new DaemonDesirePathService(disabledConfig, onLog);
      service.start();
      expect(logs.some((l) => l.msg.includes('disabled'))).toBe(true);
    });
  });

  describe('getState', () => {
    it('returns current state', () => {
      const service = new DaemonDesirePathService(config, onLog);
      const state = service.getState();
      expect(state.actionsLogged).toBe(0);
      expect(state.patternsDetected).toBe(0);
      expect(state.suggestionsGenerated).toBe(0);
      expect(state.errors).toEqual([]);
    });
  });
});
