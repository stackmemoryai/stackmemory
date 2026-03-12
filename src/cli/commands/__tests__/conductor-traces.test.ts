import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  openTracesDb,
  TraceCollector,
  listSessions,
  getSessionTurns,
  getPhaseBreakdown,
  getToolFrequencies,
  getFailureTurns,
  getTraceStats,
  classifyErrorText,
  stringifyEventTruncated,
  type TurnData,
} from '../conductor-traces.js';

describe('conductor-traces', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sm-traces-'));
    dbPath = join(tempDir, 'traces.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('openTracesDb', () => {
    it('creates database and tables', () => {
      const db = openTracesDb(dbPath);
      expect(existsSync(dbPath)).toBe(true);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='conductor_traces'"
        )
        .all();
      expect(tables).toHaveLength(1);
      db.close();
    });

    it('is idempotent — opening twice works', () => {
      const db1 = openTracesDb(dbPath);
      db1.close();
      const db2 = openTracesDb(dbPath);
      const tables = db2
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='conductor_traces'"
        )
        .all();
      expect(tables).toHaveLength(1);
      db2.close();
    });
  });

  describe('TraceCollector', () => {
    it('records turns with pre-extracted TurnData', () => {
      const db = openTracesDb(dbPath);
      const collector = new TraceCollector({
        issueId: 'STA-100',
        attempt: 1,
        db,
      });

      const turnData: TurnData = {
        toolNames: ['Read'],
        toolCount: 1,
        filesModified: 0,
        textPreview: 'Reading the file...',
        inputTokens: 1500,
        outputTokens: 200,
        cacheCreationTokens: 50,
        cacheReadTokens: 300,
      };

      const eventJson = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
            { type: 'text', text: 'Reading the file...' },
          ],
        },
      });

      collector.recordTurn(turnData, 'reading', eventJson);

      const rows = db.prepare('SELECT * FROM conductor_traces').all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.issue_id).toBe('STA-100');
      expect(row.attempt).toBe(1);
      expect(row.turn_number).toBe(0);
      expect(row.phase).toBe('reading');
      expect(row.tool_count).toBe(1);
      expect(row.input_tokens).toBe(1500);
      expect(row.output_tokens).toBe(200);
      expect(row.cache_creation_tokens).toBe(50);
      expect(row.cache_read_tokens).toBe(300);
      expect(row.message_preview).toBe('Reading the file...');

      const toolNames = JSON.parse(row.tool_names as string);
      expect(toolNames).toEqual(['Read']);

      db.close();
    });

    it('tracks files_modified from TurnData', () => {
      const db = openTracesDb(dbPath);
      const collector = new TraceCollector({
        issueId: 'STA-101',
        attempt: 1,
        db,
      });

      const turnData: TurnData = {
        toolNames: ['Edit', 'Write', 'Bash'],
        toolCount: 3,
        filesModified: 2,
        textPreview: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };

      collector.recordTurn(turnData, 'implementing', '{}');

      const row = db.prepare('SELECT * FROM conductor_traces').get() as Record<
        string,
        unknown
      >;
      expect(row.files_modified).toBe(2);
      expect(row.tool_count).toBe(3);
      db.close();
    });

    it('increments turn_number across calls', () => {
      const db = openTracesDb(dbPath);
      const collector = new TraceCollector({
        issueId: 'STA-102',
        attempt: 1,
        db,
      });

      for (let i = 0; i < 3; i++) {
        const turnData: TurnData = {
          toolNames: [],
          toolCount: 0,
          filesModified: 0,
          textPreview: `Turn ${i}`,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
        collector.recordTurn(turnData, null, '{}');
      }

      const rows = db
        .prepare(
          'SELECT turn_number FROM conductor_traces ORDER BY turn_number'
        )
        .all() as Array<{ turn_number: number }>;
      expect(rows.map((r) => r.turn_number)).toEqual([0, 1, 2]);
      db.close();
    });

    it('records result events', () => {
      const db = openTracesDb(dbPath);
      const collector = new TraceCollector({
        issueId: 'STA-103',
        attempt: 1,
        db,
      });

      collector.recordResult({
        type: 'result',
        result: 'All tasks completed successfully.',
      });

      const row = db.prepare('SELECT * FROM conductor_traces').get() as Record<
        string,
        unknown
      >;
      expect(row.phase).toBe('result');
      expect(row.message_preview).toBe('All tasks completed successfully.');
      db.close();
    });

    it('stores event_json as provided', () => {
      const db = openTracesDb(dbPath);
      const collector = new TraceCollector({
        issueId: 'STA-104',
        attempt: 1,
        db,
      });

      const turnData: TurnData = {
        toolNames: ['Write'],
        toolCount: 1,
        filesModified: 1,
        textPreview: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };

      const event = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { content: 'x'.repeat(5000) },
            },
          ],
        },
      };
      const eventJson = stringifyEventTruncated(event);
      collector.recordTurn(turnData, 'implementing', eventJson);

      const row = db
        .prepare('SELECT event_json FROM conductor_traces')
        .get() as { event_json: string };
      const parsed = JSON.parse(row.event_json);
      const block = parsed.message.content[0];
      expect(block.input._truncated).toBe(true);
      expect(block.input.length).toBeGreaterThan(2000);
      db.close();
    });
  });

  describe('classifyErrorText', () => {
    it('classifies lint failures', () => {
      expect(classifyErrorText('ESLint found 3 errors')).toBe('lint_failure');
      expect(classifyErrorText('prettier check failed')).toBe('lint_failure');
    });

    it('classifies test failures', () => {
      expect(classifyErrorText('test suite failed with 2 errors')).toBe(
        'test_failure'
      );
    });

    it('classifies timeouts', () => {
      expect(classifyErrorText('operation timed out after 60s')).toBe(
        'timeout'
      );
    });

    it('classifies rate limits', () => {
      expect(classifyErrorText('HTTP 429 Too Many Requests')).toBe(
        'rate_limit'
      );
    });

    it('returns null for unrecognized text', () => {
      expect(classifyErrorText('everything is fine')).toBeNull();
    });
  });

  describe('stringifyEventTruncated', () => {
    it('truncates large tool_use inputs', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { data: 'x'.repeat(5000) },
            },
          ],
        },
      };
      const result = JSON.parse(stringifyEventTruncated(event));
      expect(result.message.content[0].input._truncated).toBe(true);
    });

    it('truncates large tool_result content', () => {
      const event = {
        type: 'tool_result',
        content: 'y'.repeat(5000),
      };
      const result = JSON.parse(stringifyEventTruncated(event));
      expect(result.content).toMatch(/\[truncated:/);
    });

    it('preserves small inputs', () => {
      const event = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { path: '/a.ts' } },
          ],
        },
      };
      const result = JSON.parse(stringifyEventTruncated(event));
      expect(result.message.content[0].input.path).toBe('/a.ts');
    });
  });

  describe('query functions', () => {
    function seedData(db: ReturnType<typeof openTracesDb>) {
      const c1 = new TraceCollector({
        issueId: 'STA-200',
        attempt: 1,
        db,
      });

      c1.recordTurn(
        {
          toolNames: ['Read'],
          toolCount: 1,
          filesModified: 0,
          textPreview: null,
          inputTokens: 1000,
          outputTokens: 100,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        'reading',
        '{}'
      );
      c1.recordTurn(
        {
          toolNames: ['Edit'],
          toolCount: 1,
          filesModified: 1,
          textPreview: 'Editing file',
          inputTokens: 2000,
          outputTokens: 500,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        'implementing',
        '{}'
      );
      c1.recordTurn(
        {
          toolNames: ['Bash'],
          toolCount: 1,
          filesModified: 0,
          textPreview: null,
          inputTokens: 1500,
          outputTokens: 300,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        'testing',
        '{}'
      );

      return c1.session;
    }

    it('listSessions returns session summaries', () => {
      const db = openTracesDb(dbPath);
      const _sessionId = seedData(db);

      const sessions = listSessions('STA-200', db);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].total_turns).toBe(3);
      expect(sessions[0].total_tool_calls).toBe(3);
      expect(sessions[0].total_files_modified).toBe(1);
      expect(sessions[0].total_input_tokens).toBe(4500);
      expect(sessions[0].total_output_tokens).toBe(900);
      expect(sessions[0].phases).toContain('reading');
      expect(sessions[0].phases).toContain('implementing');
      expect(sessions[0].phases).toContain('testing');
      db.close();
    });

    it('getSessionTurns returns all turns ordered', () => {
      const db = openTracesDb(dbPath);
      const sessionId = seedData(db);

      const turns = getSessionTurns(sessionId, db);
      expect(turns).toHaveLength(3);
      expect(turns[0].turn_number).toBe(0);
      expect(turns[1].turn_number).toBe(1);
      expect(turns[2].turn_number).toBe(2);
      db.close();
    });

    it('getPhaseBreakdown groups by phase', () => {
      const db = openTracesDb(dbPath);
      const sessionId = seedData(db);

      const phases = getPhaseBreakdown(sessionId, db);
      expect(phases.length).toBe(3);
      const reading = phases.find((p) => p.phase === 'reading');
      expect(reading?.turns).toBe(1);
      expect(reading?.tool_calls).toBe(1);
      db.close();
    });

    it('getToolFrequencies counts tool usage', () => {
      const db = openTracesDb(dbPath);
      seedData(db);

      const freq = getToolFrequencies('STA-200', db);
      expect(freq.length).toBe(3);
      expect(freq[0].count).toBe(1);
      db.close();
    });

    it('getFailureTurns returns last N turns', () => {
      const db = openTracesDb(dbPath);
      seedData(db);

      const turns = getFailureTurns('STA-200', 2, db);
      expect(turns.length).toBe(2);
      expect(turns[0].turn_number).toBe(1);
      expect(turns[1].turn_number).toBe(2);
      db.close();
    });

    it('getTraceStats returns aggregate counts', () => {
      const db = openTracesDb(dbPath);
      seedData(db);

      const stats = getTraceStats(db);
      expect(stats.total_sessions).toBe(1);
      expect(stats.total_turns).toBe(3);
      expect(stats.issues_traced).toBe(1);
      expect(stats.total_input_tokens).toBe(4500);
      expect(stats.total_output_tokens).toBe(900);
      db.close();
    });

    it('listSessions returns empty for unknown issue', () => {
      const db = openTracesDb(dbPath);
      const sessions = listSessions('STA-999', db);
      expect(sessions).toHaveLength(0);
      db.close();
    });
  });
});
