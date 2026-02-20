/**
 * Tests for ParallelAgentSkill
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SkillContext } from '../claude-skills.js';

// Hoisted mock state
const mockFsMethods = vi.hoisted(() => ({
  mkdtempSync: vi.fn().mockReturnValue('/tmp/sm-test-abc'),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('# My Spec\nDo the thing'),
}));

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExecSync = vi.hoisted(() => vi.fn().mockReturnValue(''));

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    default: { ...original, ...mockFsMethods },
    ...mockFsMethods,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execSync: (...args: unknown[]) => mockExecSync(...args),
  };
});

vi.mock('../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockEmitHook = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../hooks/events.js', () => ({
  hookEmitter: {
    emitHook: (...args: unknown[]) => mockEmitHook(...args),
  },
}));

// Helper to create a mock child process
function createMockChild(
  opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: Error;
  } = {}
) {
  const stdoutListeners: Array<(d: Buffer) => void> = [];
  const stderrListeners: Array<(d: Buffer) => void> = [];
  let closeCallback: ((code: number | null) => void) | null = null;
  let errorCallback: ((err: Error) => void) | null = null;

  const child = {
    stdout: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data') stdoutListeners.push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (d: Buffer) => void) => {
        if (event === 'data') stderrListeners.push(cb);
      }),
    },
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close')
        closeCallback = cb as (code: number | null) => void;
      if (event === 'error') errorCallback = cb as (err: Error) => void;
    }),
    kill: vi.fn(),
  };

  // Schedule emission after setup
  setTimeout(() => {
    if (opts.error && errorCallback) {
      errorCallback(opts.error);
      return;
    }
    if (opts.stdout) {
      stdoutListeners.forEach((l) => l(Buffer.from(opts.stdout as string)));
    }
    if (opts.stderr) {
      stderrListeners.forEach((l) => l(Buffer.from(opts.stderr as string)));
    }
    if (closeCallback) {
      closeCallback(opts.exitCode ?? 0);
    }
  }, 10);

  return child;
}

describe('ParallelAgentSkill', () => {
  let context: SkillContext;
  let ParallelAgentSkill: typeof import('../parallel-agent-skill.js').ParallelAgentSkill;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset fs mocks to defaults
    mockFsMethods.mkdtempSync.mockReturnValue('/tmp/sm-test-abc');
    mockFsMethods.existsSync.mockReturnValue(true);
    mockFsMethods.readFileSync.mockReturnValue('# My Spec\nDo the thing');
    mockExecSync.mockReturnValue('');

    context = {
      projectId: 'test-project',
      userId: 'test-user',
      dualStackManager: {} as any,
      handoffManager: {} as any,
      contextRetriever: {} as any,
      database: {
        createFrame: vi.fn().mockResolvedValue('frame-123'),
        disconnect: vi.fn(),
      } as any,
    };

    const mod = await import('../parallel-agent-skill.js');
    ParallelAgentSkill = mod.ParallelAgentSkill;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('research', () => {
    it('should capture output and save frame', async () => {
      const child = createMockChild({
        stdout: '## Findings\nThe FTS5 module...',
      });
      mockSpawn.mockReturnValue(child);

      const skill = new ParallelAgentSkill(context);
      const result = await skill.research('How does FTS5 work?');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Research complete');
      expect(result.message).toContain('frame-123');
      expect(result.data?.findings).toContain('FTS5 module');
      expect(result.data?.frameId).toBe('frame-123');

      // Verify claude was spawned with --print
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['--print'],
        expect.objectContaining({ cwd: '/tmp/sm-test-abc' })
      );

      // Verify prompt was written to stdin
      expect(child.stdin.write).toHaveBeenCalled();
      const prompt = child.stdin.write.mock.calls[0][0];
      expect(prompt).toContain('How does FTS5 work?');
      expect(prompt).toContain('Do NOT modify any files');
    });

    it('should clean up workspace on success', async () => {
      mockSpawn.mockReturnValue(createMockChild({ stdout: 'findings' }));

      const skill = new ParallelAgentSkill(context);
      await skill.research('test question');

      expect(mockFsMethods.rmSync).toHaveBeenCalledWith(
        '/tmp/sm-test-abc',
        expect.objectContaining({ recursive: true })
      );
    });

    it('should return failure for empty question', async () => {
      const skill = new ParallelAgentSkill(context);
      const result = await skill.research('');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Question is required');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should handle spawn error (git clone fails)', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Command failed: git clone');
      });

      const skill = new ParallelAgentSkill(context);
      const result = await skill.research('test question');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Agent failed to start');
    });
  });

  describe('maintain', () => {
    it('should generate patch file on success', async () => {
      mockSpawn.mockReturnValue(createMockChild({ stdout: 'Fixed the issue' }));
      mockExecSync
        .mockReturnValueOnce('') // git clone
        .mockReturnValueOnce(
          'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n+new line\n-old line\n'
        ); // git diff

      const skill = new ParallelAgentSkill(context);
      const result = await skill.maintain('Fix the deprecation warning');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Patch saved');
      expect(result.data?.filesChanged).toBe(1);
      expect(result.data?.additions).toBe(1);
      expect(result.data?.deletions).toBe(1);
      expect(result.data?.patchPath).toBeDefined();
      expect(result.action).toContain('git apply');

      // Verify patch was written
      expect(mockFsMethods.writeFileSync).toHaveBeenCalled();
    });

    it('should report failure on empty diff', async () => {
      mockSpawn.mockReturnValue(
        createMockChild({ stdout: 'Nothing to change' })
      );
      mockExecSync
        .mockReturnValueOnce('') // git clone
        .mockReturnValueOnce(''); // empty diff

      const skill = new ParallelAgentSkill(context);
      const result = await skill.maintain('Fix something');

      expect(result.success).toBe(false);
      expect(result.message).toContain('no changes');
    });

    it('should return failure for empty task', async () => {
      const skill = new ParallelAgentSkill(context);
      const result = await skill.maintain('');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Task description is required');
    });
  });

  describe('specRun', () => {
    it('should read spec, create branch, and report results', async () => {
      mockSpawn.mockReturnValue(
        createMockChild({ stdout: 'Implemented spec' })
      );
      mockExecSync
        .mockReturnValueOnce('') // git clone
        .mockReturnValueOnce('') // git checkout -b
        .mockReturnValueOnce('') // npm run lint
        .mockReturnValueOnce('') // npm run test:run
        .mockReturnValueOnce('') // npm run build
        .mockReturnValueOnce(' 3 files changed, 50 insertions(+)'); // git diff --stat

      const skill = new ParallelAgentSkill(context);
      const result = await skill.specRun('docs/specs/my-feature.md');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Spec implemented on branch');
      expect(result.data?.branch).toMatch(/^agent\/spec-\d+$/);
      expect(result.data?.validation).toEqual({
        lint: true,
        test: true,
        build: true,
      });
    });

    it('should return failure when spec file not found', async () => {
      mockFsMethods.existsSync.mockReturnValue(false);

      const skill = new ParallelAgentSkill(context);
      const result = await skill.specRun('nonexistent.md');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Spec file not found');
    });

    it('should return failure for empty spec path', async () => {
      const skill = new ParallelAgentSkill(context);
      const result = await skill.specRun('');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Spec file path is required');
    });

    it('should report validation failures', async () => {
      mockSpawn.mockReturnValue(createMockChild({ stdout: 'Done' }));
      mockExecSync
        .mockReturnValueOnce('') // git clone
        .mockReturnValueOnce('') // git checkout -b
        .mockImplementationOnce(() => {
          throw new Error('lint failed');
        }) // npm run lint fails
        .mockReturnValueOnce('') // npm run test:run
        .mockReturnValueOnce('') // npm run build
        .mockReturnValueOnce('1 file changed'); // git diff --stat

      const skill = new ParallelAgentSkill(context);
      const result = await skill.specRun('docs/specs/feature.md');

      expect(result.success).toBe(false);
      expect(result.message).toContain('validation failed');
      expect(result.data?.validation?.lint).toBe(false);
      expect(result.data?.validation?.test).toBe(true);
      expect(result.data?.validation?.build).toBe(true);
    });
  });

  describe('hook emissions', () => {
    it('emits agent_start and agent_complete for research', async () => {
      mockSpawn.mockReturnValue(
        createMockChild({ stdout: '## Findings\nResult' })
      );

      const skill = new ParallelAgentSkill(context);
      await skill.research('How does search work?');

      const calls = mockEmitHook.mock.calls;
      const startCall = calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'agent_start'
      );
      const completeCall = calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'agent_complete'
      );

      expect(startCall).toBeDefined();
      expect(startCall![0].data.agentType).toBe('research');
      expect(completeCall).toBeDefined();
      expect(completeCall![0].data.agentType).toBe('research');
      expect(completeCall![0].data.timedOut).toBe(false);
    });

    it('emits agent_error on research spawn failure', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('clone failed');
      });

      const skill = new ParallelAgentSkill(context);
      await skill.research('test');

      const errorCall = mockEmitHook.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'agent_error'
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![0].data.agentType).toBe('research');
      expect(errorCall![0].data.error).toContain('clone failed');
    });

    it('emits agent_complete with validated flag for maintain', async () => {
      mockSpawn.mockReturnValue(createMockChild({ stdout: 'Fixed' }));
      mockExecSync
        .mockReturnValueOnce('') // git clone
        .mockReturnValueOnce('diff --git a/f.ts b/f.ts\n+new\n-old\n') // git diff
        .mockReturnValueOnce(''); // npm run lint (passes)

      const skill = new ParallelAgentSkill(context);
      const result = await skill.maintain('Fix deprecation');

      expect(result.data?.validated).toBe(true);

      const completeCall = mockEmitHook.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'agent_complete'
      );
      expect(completeCall).toBeDefined();
      expect(completeCall![0].data.validated).toBe(true);
      expect(completeCall![0].data.patchPath).toBeDefined();
    });
  });
});
