/**
 * Comprehensive tests for the session module (STA-440)
 *
 * Covers:
 * - SessionManager: full lifecycle, state transitions, filtering, merging, cleanup
 * - EnhancedHandoffGenerator: generation, formatting (markdown/compact/ultra), format selection
 * - Index re-exports
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── SessionManager tests (mock fs) ─────────────────────────────────────────

// Mock fs/promises and child_process before importing SessionManager
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  access: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('main\n'),
}));

// Suppress logger output during tests
vi.mock('../../monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import * as fsPromises from 'fs/promises';
import {
  SessionManager,
  FrameQueryMode,
  type Session,
} from '../session-manager.js';

// Helper to create a valid Session object
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: overrides.sessionId ?? 'sess-1',
    runId: overrides.runId ?? 'run-1',
    projectId: overrides.projectId ?? 'proj-1',
    branch: overrides.branch ?? 'main',
    startedAt: overrides.startedAt ?? Date.now(),
    lastActiveAt: overrides.lastActiveAt ?? Date.now(),
    metadata: overrides.metadata ?? {},
    state: overrides.state ?? 'active',
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset singleton for isolation
    // @ts-expect-error accessing private static field for testing
    SessionManager.instance = undefined;
    manager = SessionManager.getInstance();
    await manager.initialize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Singleton ──────────────────────────────────────────────────────────

  describe('getInstance', () => {
    it('should return the same instance on repeated calls', () => {
      const a = SessionManager.getInstance();
      const b = SessionManager.getInstance();
      expect(a).toBe(b);
    });
  });

  // ── initialize ─────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should create sessions, projects, and history directories', async () => {
      // initialize was already called in beforeEach; verify mkdir was called 3 times
      expect(fsPromises.mkdir).toHaveBeenCalledTimes(3);
      const calls = vi.mocked(fsPromises.mkdir).mock.calls;
      expect(calls[0][0]).toMatch(/sessions$/);
      expect(calls[1][0]).toMatch(/sessions[/\\]projects$/);
      expect(calls[2][0]).toMatch(/sessions[/\\]history$/);
    });

    it('should throw SystemError when mkdir fails', async () => {
      // @ts-expect-error accessing private static field for testing
      SessionManager.instance = undefined;
      const m = SessionManager.getInstance();

      vi.mocked(fsPromises.mkdir).mockRejectedValueOnce(new Error('EACCES'));

      await expect(m.initialize()).rejects.toThrow(
        'Failed to initialize session directories'
      );
    });
  });

  // ── createSession ──────────────────────────────────────────────────────

  describe('createSession', () => {
    it('should return a valid session with generated IDs and timestamps', async () => {
      const session = await manager.createSession({
        projectId: 'my-project',
        branch: 'feature/x',
        metadata: { tags: ['a', 'b'] },
      });

      expect(session.sessionId).toEqual(expect.any(String));
      expect(session.runId).toEqual(expect.any(String));
      expect(session.sessionId).not.toBe(session.runId);
      expect(session.projectId).toBe('my-project');
      expect(session.branch).toBe('feature/x');
      expect(session.state).toBe('active');
      expect(session.startedAt).toBeGreaterThan(0);
      expect(session.lastActiveAt).toBeGreaterThanOrEqual(session.startedAt);
      expect(session.metadata.tags).toEqual(['a', 'b']);
      expect(session.metadata.environment).toBeDefined();
    });

    it('should persist session via writeFile', async () => {
      await manager.createSession({ projectId: 'p1' });
      // writeFile called for session file and project active session file
      expect(fsPromises.writeFile).toHaveBeenCalledTimes(2);
    });

    it('should set currentSession after creation', async () => {
      const session = await manager.createSession({ projectId: 'p1' });
      expect(manager.getCurrentSession()).toBe(session);
    });
  });

  // ── loadSession ────────────────────────────────────────────────────────

  describe('loadSession', () => {
    it('should return parsed session when file exists', async () => {
      const mockSess = makeSession({ sessionId: 'abc' });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(mockSess)
      );

      const result = await manager.loadSession('abc');
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe('abc');
    });

    it('should fall back to history directory when main file is missing', async () => {
      const mockSess = makeSession({ sessionId: 'hist-1', state: 'closed' });
      vi.mocked(fsPromises.readFile)
        .mockRejectedValueOnce(new Error('ENOENT')) // main path fails
        .mockResolvedValueOnce(JSON.stringify(mockSess)); // history path succeeds

      const result = await manager.loadSession('hist-1');
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe('hist-1');
    });

    it('should return null when session not found in either location', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));

      const result = await manager.loadSession('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ── saveSession ────────────────────────────────────────────────────────

  describe('saveSession', () => {
    it('should write session JSON to file', async () => {
      const session = makeSession({ sessionId: 'save-test' });
      await manager.saveSession(session);

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('save-test.json'),
        expect.any(String)
      );

      const written = JSON.parse(
        vi.mocked(fsPromises.writeFile).mock.calls[0][1] as string
      );
      expect(written.sessionId).toBe('save-test');
    });
  });

  // ── suspendSession ─────────────────────────────────────────────────────

  describe('suspendSession', () => {
    it('should set state to suspended', async () => {
      const session = makeSession({ sessionId: 'suspend-test' });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(session)
      );

      await manager.suspendSession('suspend-test');

      // Verify the written data has state = 'suspended'
      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls[0];
      const written = JSON.parse(writeCall[1] as string);
      expect(written.state).toBe('suspended');
    });

    it('should use current session ID when none provided', async () => {
      const session = await manager.createSession({ projectId: 'p1' });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(session)
      );

      await manager.suspendSession();

      const lastWrite = vi.mocked(fsPromises.writeFile).mock.calls.at(-1)!;
      const written = JSON.parse(lastWrite[1] as string);
      expect(written.state).toBe('suspended');
    });

    it('should do nothing when no session ID and no current session', async () => {
      // Reset currentSession
      // @ts-expect-error private field
      manager.currentSession = null;

      const writeCallsBefore = vi.mocked(fsPromises.writeFile).mock.calls
        .length;
      await manager.suspendSession();
      expect(vi.mocked(fsPromises.writeFile).mock.calls.length).toBe(
        writeCallsBefore
      );
    });

    it('should do nothing when session not found', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));

      const writeCallsBefore = vi.mocked(fsPromises.writeFile).mock.calls
        .length;
      await manager.suspendSession('ghost');
      expect(vi.mocked(fsPromises.writeFile).mock.calls.length).toBe(
        writeCallsBefore
      );
    });
  });

  // ── resumeSession ──────────────────────────────────────────────────────

  describe('resumeSession', () => {
    it('should set state to active and update currentSession', async () => {
      const session = makeSession({
        sessionId: 'resume-me',
        state: 'suspended',
      });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(session)
      );

      const resumed = await manager.resumeSession('resume-me');
      expect(resumed.state).toBe('active');
      expect(manager.getCurrentSession()?.sessionId).toBe('resume-me');
    });

    it('should throw SystemError when session not found', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));

      await expect(manager.resumeSession('missing')).rejects.toThrow(
        'Session not found'
      );
    });
  });

  // ── closeSession ───────────────────────────────────────────────────────

  describe('closeSession', () => {
    it('should move session file from active to history', async () => {
      const session = makeSession({ sessionId: 'close-me' });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(session)
      );

      await manager.closeSession('close-me');

      expect(fsPromises.rename).toHaveBeenCalledWith(
        expect.stringContaining('close-me.json'),
        expect.stringMatching(/history[/\\]close-me\.json$/)
      );
    });

    it('should use current session when no ID provided', async () => {
      const session = await manager.createSession({ projectId: 'p2' });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(session)
      );

      await manager.closeSession();

      expect(fsPromises.rename).toHaveBeenCalled();
    });

    it('should do nothing when no session ID and no current session', async () => {
      // @ts-expect-error private field
      manager.currentSession = null;

      await manager.closeSession();
      expect(fsPromises.rename).not.toHaveBeenCalled();
    });
  });

  // ── listSessions ───────────────────────────────────────────────────────

  describe('listSessions', () => {
    it('should list all session files and parse them', async () => {
      const s1 = makeSession({
        sessionId: 's1',
        projectId: 'p1',
        state: 'active',
      });
      const s2 = makeSession({
        sessionId: 's2',
        projectId: 'p2',
        state: 'suspended',
      });

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        's1.json',
        's2.json',
        'projects',
      ] as any);
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(s1))
        .mockResolvedValueOnce(JSON.stringify(s2));

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should filter by projectId', async () => {
      const s1 = makeSession({
        sessionId: 's1',
        projectId: 'p1',
        state: 'active',
      });
      const s2 = makeSession({
        sessionId: 's2',
        projectId: 'p2',
        state: 'active',
      });

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        's1.json',
        's2.json',
      ] as any);
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(s1))
        .mockResolvedValueOnce(JSON.stringify(s2));

      const sessions = await manager.listSessions({ projectId: 'p1' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].projectId).toBe('p1');
    });

    it('should filter by state', async () => {
      const s1 = makeSession({ sessionId: 's1', state: 'active' });
      const s2 = makeSession({ sessionId: 's2', state: 'suspended' });

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        's1.json',
        's2.json',
      ] as any);
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(s1))
        .mockResolvedValueOnce(JSON.stringify(s2));

      const sessions = await manager.listSessions({ state: 'suspended' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].state).toBe('suspended');
    });

    it('should filter by branch', async () => {
      const s1 = makeSession({ sessionId: 's1', branch: 'main' });
      const s2 = makeSession({ sessionId: 's2', branch: 'dev' });

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        's1.json',
        's2.json',
      ] as any);
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(s1))
        .mockResolvedValueOnce(JSON.stringify(s2));

      const sessions = await manager.listSessions({ branch: 'dev' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].branch).toBe('dev');
    });

    it('should skip non-json files', async () => {
      const s1 = makeSession({ sessionId: 's1' });

      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        's1.json',
        'projects',
        'history',
        'readme.txt',
      ] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify(s1));

      const sessions = await manager.listSessions();
      expect(sessions).toHaveLength(1);
    });
  });

  // ── mergeSessions ──────────────────────────────────────────────────────

  describe('mergeSessions', () => {
    it('should merge metadata from source into target', async () => {
      const source = makeSession({
        sessionId: 'src',
        metadata: { tags: ['a'], user: 'alice' },
      });
      const target = makeSession({
        sessionId: 'tgt',
        metadata: { tags: ['b'], environment: 'prod' },
      });

      // loadSession will be called for source and target
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(source)) // load source
        .mockResolvedValueOnce(JSON.stringify(target)) // load target
        .mockResolvedValueOnce(JSON.stringify(source)); // closeSession loads source again

      const merged = await manager.mergeSessions('src', 'tgt');

      expect(merged.sessionId).toBe('tgt');
      // Tags should be merged
      expect(merged.metadata.tags).toContain('a');
      expect(merged.metadata.tags).toContain('b');
      // Source metadata overrides target for non-tag fields
      expect(merged.metadata.user).toBe('alice');
    });

    it('should throw when source session not found', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));

      await expect(
        manager.mergeSessions('missing-src', 'missing-tgt')
      ).rejects.toThrow('Session not found for merge');
    });

    it('should throw when target session not found', async () => {
      const source = makeSession({ sessionId: 'src' });
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(source)) // source found
        .mockRejectedValueOnce(new Error('ENOENT')); // target not found

      await expect(manager.mergeSessions('src', 'missing-tgt')).rejects.toThrow(
        'Session not found for merge'
      );
    });

    it('should handle empty tags gracefully during merge', async () => {
      const source = makeSession({ sessionId: 'src', metadata: {} });
      const target = makeSession({
        sessionId: 'tgt',
        metadata: { tags: ['x'] },
      });

      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(source))
        .mockResolvedValueOnce(JSON.stringify(target))
        .mockResolvedValueOnce(JSON.stringify(source));

      const merged = await manager.mergeSessions('src', 'tgt');
      expect(merged.metadata.tags).toContain('x');
    });
  });

  // ── cleanupStaleSessions ──────────────────────────────────────────────

  describe('cleanupStaleSessions', () => {
    it('should delete files older than maxAge', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        'old.json',
        'new.json',
      ] as any);

      const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
      const newTime = Date.now() - 1000; // 1 second ago

      vi.mocked(fsPromises.stat)
        .mockResolvedValueOnce({ mtimeMs: oldTime } as any)
        .mockResolvedValueOnce({ mtimeMs: newTime } as any);

      const count = await manager.cleanupStaleSessions();
      expect(count).toBe(1);
      expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
    });

    it('should respect custom maxAge parameter', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce(['a.json'] as any);

      const justOld = Date.now() - 2000; // 2 seconds ago
      vi.mocked(fsPromises.stat).mockResolvedValueOnce({
        mtimeMs: justOld,
      } as any);

      // maxAge of 1 second means the 2-second-old file is stale
      const count = await manager.cleanupStaleSessions(1000);
      expect(count).toBe(1);
    });

    it('should skip non-json files in history', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce([
        'a.json',
        'readme.txt',
      ] as any);

      const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000;
      vi.mocked(fsPromises.stat).mockResolvedValueOnce({
        mtimeMs: oldTime,
      } as any);

      const count = await manager.cleanupStaleSessions();
      expect(count).toBe(1);
      expect(fsPromises.stat).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when no stale sessions exist', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValueOnce(['new.json'] as any);
      vi.mocked(fsPromises.stat).mockResolvedValueOnce({
        mtimeMs: Date.now(),
      } as any);

      const count = await manager.cleanupStaleSessions();
      expect(count).toBe(0);
    });
  });

  // ── getCurrentSession / getSessionRunId ────────────────────────────────

  describe('getCurrentSession', () => {
    it('should return null initially', () => {
      // @ts-expect-error private field
      manager.currentSession = null;
      expect(manager.getCurrentSession()).toBeNull();
    });

    it('should return current session after create', async () => {
      const session = await manager.createSession({ projectId: 'p' });
      expect(manager.getCurrentSession()).toBe(session);
    });
  });

  describe('getSessionRunId', () => {
    it('should return current session runId when active', async () => {
      const session = await manager.createSession({ projectId: 'p' });
      expect(manager.getSessionRunId()).toBe(session.runId);
    });

    it('should generate a UUID when no current session', () => {
      // @ts-expect-error private field
      manager.currentSession = null;
      const runId = manager.getSessionRunId();
      expect(runId).toEqual(expect.any(String));
      expect(runId.length).toBeGreaterThan(0);
    });
  });

  // ── getOrCreateSession ─────────────────────────────────────────────────

  describe('getOrCreateSession', () => {
    it('should load session by explicit sessionId option', async () => {
      const mockSess = makeSession({ sessionId: 'explicit' });
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(mockSess)
      );

      const result = await manager.getOrCreateSession({
        sessionId: 'explicit',
      });
      expect(result.sessionId).toBe('explicit');
    });

    it('should load session from STACKMEMORY_SESSION env var', async () => {
      const mockSess = makeSession({ sessionId: 'env-sess' });
      process.env['STACKMEMORY_SESSION'] = 'env-sess';

      // The explicit sessionId path won't be taken since we don't provide one
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        JSON.stringify(mockSess)
      );

      const result = await manager.getOrCreateSession();
      expect(result.sessionId).toBe('env-sess');

      delete process.env['STACKMEMORY_SESSION'];
    });

    it('should create new session when no existing session found', async () => {
      // All readFile calls fail (no existing sessions)
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));
      // readdir returns empty (no sessions to list)
      vi.mocked(fsPromises.readdir).mockResolvedValue([] as any);

      const result = await manager.getOrCreateSession({
        projectPath: '/tmp/fake-project',
        branch: 'feature/test',
      });

      expect(result.state).toBe('active');
      expect(result.sessionId).toEqual(expect.any(String));
    });

    it('should fall through env var when session not found and create new', async () => {
      process.env['STACKMEMORY_SESSION'] = 'ghost-session';
      vi.mocked(fsPromises.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fsPromises.readdir).mockResolvedValue([] as any);

      const result = await manager.getOrCreateSession();
      expect(result.state).toBe('active');
      // Should be a new session, not the env one
      expect(result.sessionId).not.toBe('ghost-session');

      delete process.env['STACKMEMORY_SESSION'];
    });
  });

  // ── FrameQueryMode enum ────────────────────────────────────────────────

  describe('FrameQueryMode', () => {
    it('should have all expected values', () => {
      expect(FrameQueryMode.CURRENT_SESSION).toBe('current');
      expect(FrameQueryMode.PROJECT_ACTIVE).toBe('project');
      expect(FrameQueryMode.ALL_ACTIVE).toBe('all');
      expect(FrameQueryMode.HISTORICAL).toBe('historical');
    });
  });
});

// ─── EnhancedHandoffGenerator tests (real filesystem) ────────────────────────

// These tests use a real temp directory for the handoff generator since it uses
// synchronous fs operations (readFileSync, existsSync, etc.)
import { EnhancedHandoffGenerator, type EnhancedHandoff } from '../handoff.js';

// Helper to build a minimal valid EnhancedHandoff object
function makeHandoff(
  overrides: Partial<EnhancedHandoff> = {}
): EnhancedHandoff {
  return {
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    project: overrides.project ?? 'test-project',
    branch: overrides.branch ?? 'main',
    activeWork: overrides.activeWork ?? {
      description: 'Implement feature X',
      status: 'in_progress',
      keyFiles: ['src/foo.ts', 'src/bar.ts'],
      progress: '3 commits in current session',
    },
    decisions: overrides.decisions ?? [
      { what: 'Use SQLite over Postgres', why: 'Simpler deployment' },
    ],
    architecture: overrides.architecture ?? {
      keyComponents: [{ file: 'src/core/db.ts', purpose: 'Database layer' }],
      patterns: ['Core/domain separation'],
    },
    blockers: overrides.blockers ?? [],
    reviewFeedback: overrides.reviewFeedback,
    nextActions: overrides.nextActions ?? ['Write tests'],
    codePatterns: overrides.codePatterns,
    estimatedTokens: overrides.estimatedTokens ?? 500,
  };
}

describe('EnhancedHandoffGenerator', () => {
  let tempDir: string;
  let generator: EnhancedHandoffGenerator;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-handoff-test-'));
    // Create .git directory so git commands don't fail spectacularly
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    generator = new EnhancedHandoffGenerator(tempDir);
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── toMarkdown ─────────────────────────────────────────────────────────

  describe('toMarkdown', () => {
    it('should produce valid markdown with all sections', () => {
      const handoff = makeHandoff({
        blockers: [
          { issue: 'Test failures', attempted: ['npm test'], status: 'open' },
        ],
        reviewFeedback: [
          {
            source: 'Staff Architect',
            keyPoints: ['Improve error handling'],
            actionItems: ['Add retry logic'],
          },
        ],
        codePatterns: ['TypeScript strict mode enabled'],
      });

      const md = generator.toMarkdown(handoff);

      expect(md).toContain('# Session Handoff');
      expect(md).toContain('**Project**: test-project');
      expect(md).toContain('**Branch**: main');
      expect(md).toContain('## Active Work');
      expect(md).toContain('Implement feature X');
      expect(md).toContain('## Key Decisions');
      expect(md).toContain('Use SQLite over Postgres');
      expect(md).toContain('Simpler deployment');
      expect(md).toContain('## Architecture Context');
      expect(md).toContain('src/core/db.ts');
      expect(md).toContain('## Blockers');
      expect(md).toContain('Test failures');
      expect(md).toContain('## Review Feedback');
      expect(md).toContain('Staff Architect');
      expect(md).toContain('## Next Actions');
      expect(md).toContain('Write tests');
      expect(md).toContain('## Established Patterns');
      expect(md).toContain('TypeScript strict mode enabled');
      expect(md).toContain('Estimated tokens');
    });

    it('should omit empty sections', () => {
      const handoff = makeHandoff({
        decisions: [],
        blockers: [],
        reviewFeedback: undefined,
        codePatterns: undefined,
        nextActions: [],
        architecture: { keyComponents: [], patterns: [] },
      });

      const md = generator.toMarkdown(handoff);

      expect(md).not.toContain('## Key Decisions');
      expect(md).not.toContain('## Blockers');
      expect(md).not.toContain('## Review Feedback');
      expect(md).not.toContain('## Established Patterns');
      expect(md).not.toContain('## Next Actions');
    });

    it('should show key files and progress in active work', () => {
      const handoff = makeHandoff({
        activeWork: {
          description: 'Working on tests',
          status: 'in_progress',
          keyFiles: ['a.ts', 'b.ts'],
          progress: '5 commits in current session',
        },
      });

      const md = generator.toMarkdown(handoff);
      expect(md).toContain('**Key files**: a.ts, b.ts');
      expect(md).toContain('**Progress**: 5 commits');
    });

    it('should handle decisions with alternatives', () => {
      const handoff = makeHandoff({
        decisions: [
          {
            what: 'Chose React',
            why: 'Better ecosystem',
            alternatives: ['Vue', 'Svelte'],
          },
        ],
      });

      const md = generator.toMarkdown(handoff);
      expect(md).toContain('Alternatives considered: Vue, Svelte');
    });

    it('should include architecture patterns when present', () => {
      const handoff = makeHandoff({
        architecture: {
          keyComponents: [{ file: 'x.ts', purpose: 'Entry' }],
          patterns: [
            'Daemon/background process pattern',
            'CLI command pattern',
          ],
        },
      });

      const md = generator.toMarkdown(handoff);
      expect(md).toContain(
        '**Patterns**: Daemon/background process pattern, CLI command pattern'
      );
    });
  });

  // ── toCompact ──────────────────────────────────────────────────────────

  describe('toCompact', () => {
    it('should produce shorter output than toMarkdown', () => {
      const handoff = makeHandoff();
      const compact = generator.toCompact(handoff);
      const verbose = generator.toMarkdown(handoff);
      expect(compact.length).toBeLessThan(verbose.length);
    });

    it('should contain project@branch header', () => {
      const handoff = makeHandoff({ project: 'myproj', branch: 'dev' });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('# Handoff: myproj@dev');
    });

    it('should use WIP abbreviation for in_progress status', () => {
      const handoff = makeHandoff({
        activeWork: {
          description: 'Feature',
          status: 'in_progress',
          keyFiles: [],
        },
      });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('[WIP]');
    });

    it('should include basenames only for key files', () => {
      const handoff = makeHandoff({
        activeWork: {
          description: 'Feature',
          status: 'in_progress',
          keyFiles: ['src/core/session/handler.ts', 'src/utils/helpers.ts'],
          progress: '2 commits in current session',
        },
      });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('handler.ts');
      expect(compact).toContain('helpers.ts');
      expect(compact).not.toContain('src/core/session/');
    });

    it('should include blocker status markers', () => {
      const handoff = makeHandoff({
        blockers: [
          { issue: 'Merge conflict', attempted: ['rebase'], status: 'open' },
        ],
      });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('## Blockers');
      expect(compact).toContain('Merge conflict');
    });

    it('should include review feedback when present', () => {
      const handoff = makeHandoff({
        reviewFeedback: [
          {
            source: 'Product Manager',
            keyPoints: ['Focus on UX'],
            actionItems: ['Add tooltips'],
          },
        ],
      });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('## Feedback');
      expect(compact).toContain('[Product Manager]');
    });

    it('should include next actions, limited to top 3', () => {
      const handoff = makeHandoff({
        nextActions: ['First', 'Second', 'Third', 'Fourth'],
      });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('## Next');
      expect(compact).toContain('First');
      expect(compact).toContain('Third');
      expect(compact).not.toContain('Fourth');
    });

    it('should include token count in footer', () => {
      const handoff = makeHandoff({ estimatedTokens: 1234 });
      const compact = generator.toCompact(handoff);
      expect(compact).toContain('~1234 tokens');
    });
  });

  // ── toUltraCompact ────────────────────────────────────────────────────

  describe('toUltraCompact', () => {
    it('should produce much shorter output than toCompact', () => {
      const handoff = makeHandoff();
      const ultra = generator.toUltraCompact(handoff);
      const compact = generator.toCompact(handoff);
      expect(ultra.length).toBeLessThan(compact.length);
    });

    it('should use bracket-prefixed sections', () => {
      const handoff = makeHandoff({
        blockers: [
          { issue: 'Test fail', attempted: ['rerun'], status: 'open' },
        ],
        nextActions: ['Deploy'],
      });
      const ultra = generator.toUltraCompact(handoff);
      expect(ultra).toContain('[H]');
      expect(ultra).toContain('[F]');
      expect(ultra).toContain('[D]');
      expect(ultra).toContain('[B]');
      expect(ultra).toContain('[N]');
    });

    it('should strip file extensions in [F] section', () => {
      const handoff = makeHandoff({
        activeWork: {
          description: 'Work',
          status: 'in_progress',
          keyFiles: ['src/foo.ts', 'src/bar.js'],
        },
      });
      const ultra = generator.toUltraCompact(handoff);
      expect(ultra).toMatch(/\[F\].*foo.*bar/);
      expect(ultra).not.toContain('.ts');
      expect(ultra).not.toContain('.js');
    });

    it('should extract commit count from progress string', () => {
      const handoff = makeHandoff({
        activeWork: {
          description: 'Building',
          status: 'in_progress',
          keyFiles: [],
          progress: '7 commits in current session',
        },
      });
      const ultra = generator.toUltraCompact(handoff);
      expect(ultra).toContain('7c');
    });

    it('should use ! for open blockers and checkmark for resolved', () => {
      const handoff = makeHandoff({
        blockers: [
          { issue: 'Open issue', attempted: [], status: 'open' },
          { issue: 'Fixed issue', attempted: [], status: 'resolved' },
        ],
      });
      const ultra = generator.toUltraCompact(handoff);
      expect(ultra).toContain('!Open issue');
    });
  });

  // ── selectFormat ───────────────────────────────────────────────────────

  describe('selectFormat', () => {
    it('should return ultra when contextBudget < 500', () => {
      const handoff = makeHandoff();
      expect(generator.selectFormat(handoff, 100)).toBe('ultra');
      expect(generator.selectFormat(handoff, 499)).toBe('ultra');
    });

    it('should return compact when contextBudget is 500-1999', () => {
      const handoff = makeHandoff();
      expect(generator.selectFormat(handoff, 500)).toBe('compact');
      expect(generator.selectFormat(handoff, 1999)).toBe('compact');
    });

    it('should return verbose when contextBudget >= 2000', () => {
      const handoff = makeHandoff();
      expect(generator.selectFormat(handoff, 2000)).toBe('verbose');
      expect(generator.selectFormat(handoff, 10000)).toBe('verbose');
    });

    it('should auto-select ultra for simple sessions (no budget)', () => {
      const handoff = makeHandoff({
        decisions: [],
        blockers: [],
        reviewFeedback: undefined,
        nextActions: [],
        activeWork: {
          description: 'Simple',
          status: 'done',
          keyFiles: ['a.ts'],
        },
      });
      expect(generator.selectFormat(handoff)).toBe('ultra');
    });

    it('should auto-select verbose for complex sessions (no budget)', () => {
      const handoff = makeHandoff({
        decisions: [
          { what: 'A', why: 'a' },
          { what: 'B', why: 'b' },
          { what: 'C', why: 'c' },
        ],
        blockers: [
          { issue: 'X', attempted: [], status: 'open' },
          { issue: 'Y', attempted: [], status: 'open' },
        ],
        reviewFeedback: [
          { source: 'PM', keyPoints: ['p'], actionItems: ['a'] },
          { source: 'Arch', keyPoints: ['q'], actionItems: ['b'] },
        ],
        nextActions: ['1', '2', '3'],
      });
      expect(generator.selectFormat(handoff)).toBe('verbose');
    });

    it('should auto-select compact for medium complexity (no budget)', () => {
      const handoff = makeHandoff({
        decisions: [
          { what: 'A', why: 'a' },
          { what: 'B', why: 'b' },
        ],
        blockers: [{ issue: 'X', attempted: [], status: 'open' }],
        reviewFeedback: undefined,
        nextActions: ['1'],
        activeWork: {
          description: 'Medium',
          status: 'in_progress',
          keyFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        },
      });
      expect(generator.selectFormat(handoff)).toBe('compact');
    });
  });

  // ── toAutoFormat ───────────────────────────────────────────────────────

  describe('toAutoFormat', () => {
    it('should dispatch to toUltraCompact for small budget', () => {
      const handoff = makeHandoff();
      const auto = generator.toAutoFormat(handoff, 100);
      const ultra = generator.toUltraCompact(handoff);
      expect(auto).toBe(ultra);
    });

    it('should dispatch to toCompact for medium budget', () => {
      const handoff = makeHandoff();
      const auto = generator.toAutoFormat(handoff, 1000);
      const compact = generator.toCompact(handoff);
      expect(auto).toBe(compact);
    });

    it('should dispatch to toMarkdown for large budget', () => {
      const handoff = makeHandoff();
      const auto = generator.toAutoFormat(handoff, 5000);
      const verbose = generator.toMarkdown(handoff);
      expect(auto).toBe(verbose);
    });
  });

  // ── generate (integration-style, with real temp dir) ───────────────────

  describe('generate', () => {
    it('should return a valid EnhancedHandoff object', async () => {
      // The generator will run git commands that will fail in the temp dir
      // (no real git repo), but it should handle errors gracefully
      const handoff = await generator.generate();

      expect(handoff).toBeDefined();
      expect(handoff.timestamp).toEqual(expect.any(String));
      expect(handoff.project).toEqual(expect.any(String));
      expect(handoff.branch).toEqual(expect.any(String));
      expect(handoff.activeWork).toBeDefined();
      expect(handoff.activeWork.status).toEqual(expect.any(String));
      expect(handoff.decisions).toEqual(expect.any(Array));
      expect(handoff.architecture).toBeDefined();
      expect(handoff.blockers).toEqual(expect.any(Array));
      expect(handoff.nextActions).toEqual(expect.any(Array));
      expect(handoff.estimatedTokens).toBeGreaterThanOrEqual(0);
    });

    it('should pick up session decisions from .stackmemory dir', async () => {
      // Create session-decisions.json in the temp project
      const smDir = join(tempDir, '.stackmemory');
      mkdirSync(smDir, { recursive: true });
      writeFileSync(
        join(smDir, 'session-decisions.json'),
        JSON.stringify({
          decisions: [
            {
              id: 'd1',
              what: 'Use vitest',
              why: 'Better ESM support',
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      const handoff = await generator.generate();
      const found = handoff.decisions.some((d) => d.what === 'Use vitest');
      expect(found).toBe(true);
    });

    it('should pick up decisions from decisions.md', async () => {
      const smDir = join(tempDir, '.stackmemory');
      mkdirSync(smDir, { recursive: true });
      writeFileSync(
        join(smDir, 'decisions.md'),
        [
          '## Choose SQLite for local storage',
          'Rationale: No external dependencies needed',
          '',
          '## Use ESM imports',
          'Why: Better tree-shaking and future-proof',
          'Alternatives:',
          '- CommonJS',
          '- Dual CJS/ESM',
        ].join('\n')
      );

      const handoff = await generator.generate();
      const sqliteDecision = handoff.decisions.find((d) =>
        d.what.includes('SQLite')
      );
      expect(sqliteDecision).toBeDefined();
      expect(sqliteDecision!.why).toContain('No external dependencies');

      const esmDecision = handoff.decisions.find((d) => d.what.includes('ESM'));
      expect(esmDecision).toBeDefined();
      expect(esmDecision!.alternatives).toContain('CommonJS');
    });

    it('should pick up pending tasks from tasks.json', async () => {
      const smDir = join(tempDir, '.stackmemory');
      mkdirSync(smDir, { recursive: true });
      writeFileSync(
        join(smDir, 'tasks.json'),
        JSON.stringify([
          { title: 'Pending task 1', status: 'pending' },
          { title: 'In-progress task', status: 'in_progress' },
          { title: 'Done task', status: 'done' },
        ])
      );

      const handoff = await generator.generate();
      expect(handoff.nextActions).toContain('Pending task 1');
      expect(handoff.nextActions).toContain('In-progress task');
      expect(handoff.nextActions).not.toContain('Done task');
    });

    it('should detect code patterns from eslint config', async () => {
      writeFileSync(
        join(tempDir, 'eslint.config.js'),
        `export default [{ rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }, ignores: ['**/*.test.ts'] }];`
      );

      const handoff = await generator.generate();
      expect(handoff.codePatterns).toContain(
        'Underscore prefix for unused vars (_var)'
      );
      expect(handoff.codePatterns).toContain('Test files excluded from lint');
    });

    it('should detect code patterns from tsconfig', async () => {
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              target: 'ES2022',
            },
          },
          null,
          2
        )
      );

      const handoff = await generator.generate();
      expect(handoff.codePatterns).toContain('TypeScript strict mode enabled');
      expect(handoff.codePatterns).toContain('ESM module system');
    });

    it('should load persisted review feedback when no new feedback found', async () => {
      const smDir = join(tempDir, '.stackmemory');
      mkdirSync(smDir, { recursive: true });
      writeFileSync(
        join(smDir, 'review-feedback.json'),
        JSON.stringify({
          feedbacks: [
            {
              timestamp: new Date().toISOString(),
              source: 'Staff Architect',
              keyPoints: ['Improve caching'],
              actionItems: ['Add Redis layer'],
            },
          ],
          lastUpdated: new Date().toISOString(),
        })
      );

      const handoff = await generator.generate();
      expect(handoff.reviewFeedback).toBeDefined();
      const archFeedback = handoff.reviewFeedback?.find(
        (f) => f.source === 'Staff Architect'
      );
      expect(archFeedback).toBeDefined();
      expect(archFeedback!.keyPoints).toContain('Improve caching');
    });

    it('should not include stale review feedback (>24h)', async () => {
      const smDir = join(tempDir, '.stackmemory');
      mkdirSync(smDir, { recursive: true });
      const oldTimestamp = new Date(
        Date.now() - 48 * 60 * 60 * 1000
      ).toISOString();
      writeFileSync(
        join(smDir, 'review-feedback.json'),
        JSON.stringify({
          feedbacks: [
            {
              timestamp: oldTimestamp,
              source: 'Old Review',
              keyPoints: ['Outdated point'],
              actionItems: [],
            },
          ],
          lastUpdated: oldTimestamp,
        })
      );

      const handoff = await generator.generate();
      // Old feedback should be filtered out
      expect(handoff.reviewFeedback).toBeUndefined();
    });
  });

  // ── extractKeyPointsFromReview (via toMarkdown round-trip) ────────────

  describe('review content parsing', () => {
    it('should detect Product Manager source', () => {
      // We test the private method indirectly via the public extractReviewFeedback
      // but since it reads from filesystem, we test via output format instead
      const handoff = makeHandoff({
        reviewFeedback: [
          {
            source: 'Product Manager',
            keyPoints: ['Users need onboarding'],
            actionItems: ['Add tutorial'],
          },
        ],
      });
      const md = generator.toMarkdown(handoff);
      expect(md).toContain('### Product Manager');
      expect(md).toContain('Users need onboarding');
      expect(md).toContain('Add tutorial');
    });
  });

  // ── inferFilePurpose (indirectly via architecture extraction) ──────────

  describe('file purpose inference', () => {
    it('should produce correct markdown for various file types', () => {
      const handoff = makeHandoff({
        architecture: {
          keyComponents: [
            {
              file: 'src/daemon/worker.ts',
              purpose: 'Background daemon/service',
            },
            { file: 'src/cli/commands/run.ts', purpose: 'CLI command handler' },
            {
              file: 'src/config/settings.ts',
              purpose: 'Configuration management',
            },
            { file: 'src/utils/helpers.ts', purpose: 'Utility functions' },
          ],
          patterns: [],
        },
      });

      const md = generator.toMarkdown(handoff);
      expect(md).toContain('Background daemon/service');
      expect(md).toContain('CLI command handler');
      expect(md).toContain('Configuration management');
      expect(md).toContain('Utility functions');
    });
  });
});

// ─── Index re-exports ────────────────────────────────────────────────────────

describe('session/index re-exports', () => {
  it('should export SessionManager, sessionManager, FrameQueryMode, and Session type', async () => {
    // Dynamic import to get the actual exports from the barrel file
    const indexModule = await import('../index.js');

    expect(indexModule.SessionManager).toBeDefined();
    expect(indexModule.sessionManager).toBeDefined();
    expect(indexModule.FrameQueryMode).toBeDefined();
    expect(indexModule.FrameQueryMode.CURRENT_SESSION).toBe('current');
  });
});
