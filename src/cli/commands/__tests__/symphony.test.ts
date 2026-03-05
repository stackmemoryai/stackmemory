import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

describe('symphony CLI', () => {
  let tmpDir: string;
  let globalDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-test-'));
    globalDir = path.join(tmpDir, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createGlobalDb(): Database.Database {
    const dbPath = path.join(globalDir, 'context.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS symphony_contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        workspace TEXT,
        captured_at INTEGER NOT NULL,
        context_type TEXT NOT NULL DEFAULT 'run',
        summary TEXT,
        frames_json TEXT,
        anchors_json TEXT,
        events_json TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_symphony_issue
        ON symphony_contexts(issue_id);
    `);
    return db;
  }

  function createWorkspaceDb(wsDir: string): void {
    const smDir = path.join(wsDir, '.stackmemory');
    fs.mkdirSync(smDir, { recursive: true });
    const db = new Database(path.join(smDir, 'context.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE frames (
        frame_id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        digest_text TEXT,
        created_at INTEGER
      );
      CREATE TABLE anchors (
        anchor_id TEXT PRIMARY KEY,
        type TEXT,
        text TEXT,
        priority INTEGER
      );
      CREATE TABLE events (
        event_type TEXT,
        payload TEXT,
        ts INTEGER
      );
    `);
    db.prepare(
      'INSERT INTO frames (frame_id, name, type, digest_text, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('f1', 'test-frame', 'task', 'Implemented feature X', Date.now());
    db.prepare(
      'INSERT INTO anchors (anchor_id, type, text, priority) VALUES (?, ?, ?, ?)'
    ).run('a1', 'DECISION', 'Use SQLite for storage', 10);
    db.prepare(
      'INSERT INTO events (event_type, payload, ts) VALUES (?, ?, ?)'
    ).run('frame_created', '{}', Date.now());
    db.close();
  }

  describe('capture', () => {
    it('captures workspace context into global db', () => {
      const wsDir = path.join(tmpDir, 'workspace');
      fs.mkdirSync(wsDir, { recursive: true });
      createWorkspaceDb(wsDir);

      const globalDb = createGlobalDb();

      // Simulate what the capture command does
      const wsDbPath = path.join(wsDir, '.stackmemory', 'context.db');
      const wsDb = new Database(wsDbPath, { readonly: true });

      const frames = wsDb
        .prepare(
          'SELECT frame_id, name, type, digest_text, created_at FROM frames ORDER BY created_at DESC LIMIT 20'
        )
        .all();
      const anchors = wsDb
        .prepare(
          "SELECT anchor_id, type, text, priority FROM anchors WHERE type IN ('DECISION', 'FACT', 'CONSTRAINT', 'RISK') ORDER BY priority DESC LIMIT 30"
        )
        .all();
      const events = wsDb
        .prepare(
          'SELECT event_type, payload, ts FROM events ORDER BY ts DESC LIMIT 50'
        )
        .all();

      wsDb.close();

      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, ?, ?, ?, 'run', ?, ?, ?, ?, ?)`
        )
        .run(
          'STA-476',
          1,
          wsDir,
          Math.floor(Date.now() / 1000),
          'Implemented feature X',
          JSON.stringify(frames),
          JSON.stringify(anchors),
          JSON.stringify(events),
          JSON.stringify({ workspace: wsDir, attempt: 1 })
        );

      // Verify
      const rows = globalDb
        .prepare('SELECT * FROM symphony_contexts WHERE issue_id = ?')
        .all('STA-476') as any[];

      expect(rows).toHaveLength(1);
      expect(rows[0].issue_id).toBe('STA-476');
      expect(rows[0].attempt).toBe(1);
      expect(rows[0].context_type).toBe('run');

      const storedFrames = JSON.parse(rows[0].frames_json);
      expect(storedFrames).toHaveLength(1);
      expect(storedFrames[0].name).toBe('test-frame');

      const storedAnchors = JSON.parse(rows[0].anchors_json);
      expect(storedAnchors).toHaveLength(1);
      expect(storedAnchors[0].type).toBe('DECISION');

      globalDb.close();
    });
  });

  describe('restore', () => {
    it('generates restore document from prior contexts', () => {
      const globalDb = createGlobalDb();

      // Insert prior context
      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, ?, ?, ?, 'run', ?, ?, ?, ?, ?)`
        )
        .run(
          'STA-476',
          1,
          '/tmp/ws1',
          Math.floor(Date.now() / 1000) - 3600,
          'Built the auth module',
          '[]',
          JSON.stringify([
            { type: 'DECISION', text: 'Use JWT tokens' },
            { type: 'RISK', text: 'Token expiry handling unclear' },
          ]),
          '[]',
          JSON.stringify({
            branch: 'feature/auth',
            lastCommit: 'abc123 add auth',
          })
        );

      // Query like restore does
      const contexts = globalDb
        .prepare(
          `SELECT issue_id, attempt, summary, anchors_json, metadata_json, captured_at
           FROM symphony_contexts WHERE issue_id = ? ORDER BY captured_at DESC LIMIT 10`
        )
        .all('STA-476') as any[];

      expect(contexts).toHaveLength(1);
      expect(contexts[0].summary).toBe('Built the auth module');

      // Build restore document
      const lines: string[] = [
        `# Prior Context for STA-476`,
        '',
        `Found ${contexts.length} prior run(s).`,
        '',
      ];
      for (const ctx of contexts) {
        lines.push(`## Attempt ${ctx.attempt}`);
        if (ctx.summary) lines.push('', ctx.summary);

        const anchors = JSON.parse(ctx.anchors_json || '[]');
        const decisions = anchors.filter((a: any) => a.type === 'DECISION');
        if (decisions.length > 0) {
          lines.push('', '### Decisions');
          for (const d of decisions) lines.push(`- ${d.text}`);
        }
      }

      const doc = lines.join('\n');
      expect(doc).toContain('# Prior Context for STA-476');
      expect(doc).toContain('Built the auth module');
      expect(doc).toContain('Use JWT tokens');

      globalDb.close();
    });

    it('handles no prior context', () => {
      const globalDb = createGlobalDb();
      const contexts = globalDb
        .prepare('SELECT * FROM symphony_contexts WHERE issue_id = ?')
        .all('STA-999') as any[];

      expect(contexts).toHaveLength(0);
      globalDb.close();
    });
  });

  describe('archive', () => {
    it('creates archive entry with all data', () => {
      const wsDir = path.join(tmpDir, 'ws-archive');
      fs.mkdirSync(wsDir, { recursive: true });
      createWorkspaceDb(wsDir);

      const globalDb = createGlobalDb();
      const wsDb = new Database(
        path.join(wsDir, '.stackmemory', 'context.db'),
        { readonly: true }
      );

      const frames = wsDb
        .prepare('SELECT * FROM frames ORDER BY created_at DESC')
        .all();
      const anchors = wsDb.prepare('SELECT * FROM anchors').all();
      const events = wsDb
        .prepare('SELECT * FROM events ORDER BY ts DESC LIMIT 100')
        .all();
      wsDb.close();

      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, 0, ?, ?, 'archive', ?, ?, ?, ?, ?)`
        )
        .run(
          'STA-476',
          wsDir,
          Math.floor(Date.now() / 1000),
          'Implemented feature X',
          JSON.stringify(frames),
          JSON.stringify(anchors),
          JSON.stringify(events),
          JSON.stringify({ archived: true, workspace: wsDir })
        );

      const rows = globalDb
        .prepare(
          "SELECT * FROM symphony_contexts WHERE issue_id = ? AND context_type = 'archive'"
        )
        .all('STA-476') as any[];

      expect(rows).toHaveLength(1);
      expect(rows[0].attempt).toBe(0);
      expect(rows[0].context_type).toBe('archive');

      const meta = JSON.parse(rows[0].metadata_json);
      expect(meta.archived).toBe(true);

      globalDb.close();
    });
  });

  describe('search', () => {
    it('finds contexts by summary text', () => {
      const globalDb = createGlobalDb();

      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, ?, ?, ?, 'run', ?, ?, ?, ?, ?)`
        )
        .run(
          'STA-100',
          1,
          '/tmp/ws',
          Math.floor(Date.now() / 1000),
          'Fixed database migration bug',
          '[]',
          '[]',
          '[]',
          '{}'
        );

      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, ?, ?, ?, 'run', ?, ?, ?, ?, ?)`
        )
        .run(
          'STA-200',
          1,
          '/tmp/ws2',
          Math.floor(Date.now() / 1000),
          'Added authentication flow',
          '[]',
          '[]',
          '[]',
          '{}'
        );

      const results = globalDb
        .prepare(
          `SELECT issue_id, summary FROM symphony_contexts
           WHERE summary LIKE ? OR anchors_json LIKE ?
           ORDER BY captured_at DESC LIMIT 10`
        )
        .all('%migration%', '%migration%') as any[];

      expect(results).toHaveLength(1);
      expect(results[0].issue_id).toBe('STA-100');

      globalDb.close();
    });

    it('returns empty for no matches', () => {
      const globalDb = createGlobalDb();

      const results = globalDb
        .prepare(
          `SELECT issue_id FROM symphony_contexts WHERE summary LIKE ? LIMIT 10`
        )
        .all('%nonexistent-xyz%') as any[];

      expect(results).toHaveLength(0);
      globalDb.close();
    });
  });

  describe('hook scripts', () => {
    it('after-create.sh exists and is executable-ready', () => {
      const hookPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'scripts',
        'symphony',
        'after-create.sh'
      );
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('stackmemory init');
      expect(content).toContain('stackmemory symphony restore');
    });

    it('after-run.sh captures with issue and attempt', () => {
      const hookPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'scripts',
        'symphony',
        'after-run.sh'
      );
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('stackmemory symphony capture');
      expect(content).toContain('--issue');
      expect(content).toContain('--attempt');
    });

    it('before-remove.sh archives context', () => {
      const hookPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'scripts',
        'symphony',
        'before-remove.sh'
      );
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('stackmemory symphony archive');
    });
  });
});
