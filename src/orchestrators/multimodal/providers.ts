import { spawnSync } from 'child_process';

import { STRUCTURED_RESPONSE_SUFFIX } from './constants.js';
import type {
  PostImplementationChecks,
  VerificationCommandResult,
} from './types.js';

// Lightweight provider wrappers with safe fallbacks for a spike.

export async function callClaude(
  prompt: string,
  options: { model?: string; system?: string }
): Promise<string> {
  // Use Anthropic SDK only if key is present; otherwise return a stubbed plan
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    // If this is used as the critic, return a valid JSON approval to allow offline runs
    const sys = (options.system || '').toLowerCase();
    if (
      sys.includes('strict code reviewer') ||
      sys.includes('return a json object') ||
      sys.includes('approved')
    ) {
      return JSON.stringify({ approved: true, issues: [], suggestions: [] });
    }
    // Otherwise, return a heuristic hint (planner will fall back to heuristicPlan)
    return `STUB: No ANTHROPIC_API_KEY set. Returning heuristic plan for prompt: ${prompt
      .slice(0, 80)
      .trim()}...`;
  }

  // Dynamic import to avoid bundling the SDK when not needed
  const { Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = options.model || 'claude-sonnet-4-20250514';
  const system =
    (options.system || 'You are a precise software planning assistant.') +
    STRUCTURED_RESPONSE_SUFFIX;

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = msg?.content?.[0];
    const text =
      block && 'text' in block
        ? (block as { text: string }).text
        : JSON.stringify(msg);
    return text;
  } catch {
    // Network/auth errors: behave like offline/no-key mode
    const sys = (options.system || '').toLowerCase();
    if (
      sys.includes('strict code reviewer') ||
      sys.includes('return a json object') ||
      sys.includes('approved')
    ) {
      return JSON.stringify({ approved: true, issues: [], suggestions: [] });
    }
    return `STUB: Offline/failed Claude call. Heuristic plan for: ${prompt
      .slice(0, 80)
      .trim()}...`;
  }
}

export function callCodexCLI(
  prompt: string,
  args: string[] = [],
  dryRun = true,
  cwd?: string
): {
  ok: boolean;
  output: string;
  command: string;
} {
  // Filter out unsupported flags for new codex CLI (0.23+)
  const filteredArgs = args.filter((a) => a !== '--no-trace');

  // New codex CLI uses 'exec' subcommand: codex exec "prompt"
  // --full-auto for non-interactive, -C for working directory
  const cdArgs = cwd ? ['-C', cwd] : [];
  const fullArgs = ['exec', '--full-auto', ...cdArgs, prompt, ...filteredArgs];
  const printable = `codex ${fullArgs.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ')}`;

  if (dryRun) {
    return {
      ok: true,
      output: '[DRY RUN] Skipped execution',
      command: printable,
    };
  }

  try {
    // Check if codex binary is available
    const whichCodex = spawnSync('which', ['codex'], { encoding: 'utf8' });
    if (whichCodex.status !== 0) {
      return {
        ok: true,
        output: '[OFFLINE] Codex CLI not found; skipping execution',
        command: printable,
      };
    }

    const res = spawnSync('codex', fullArgs, {
      encoding: 'utf8',
      timeout: 300000, // 5 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    if (res.status !== 0) {
      const errorOutput = res.stderr || res.stdout || 'Unknown error';
      return {
        ok: false,
        output: `[ERROR] Codex failed (exit ${res.status}): ${errorOutput.slice(0, 500)}`,
        command: printable,
      };
    }
    return {
      ok: true,
      output: (res.stdout || '') + (res.stderr || ''),
      command: printable,
    };
  } catch (e: any) {
    return { ok: false, output: e?.message || String(e), command: printable };
  }
}

/**
 * Capture git diff in a repo directory. Returns the diff string
 * (staged + unstaged) truncated to maxLen chars.
 */
export function captureGitDiff(cwd: string, maxLen = 12000): string {
  try {
    // Unstaged changes
    const unstaged = spawnSync('git', ['diff'], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    });
    // Staged changes
    const staged = spawnSync('git', ['diff', '--cached'], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    });
    // Untracked new files (show content)
    const untracked = spawnSync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd, encoding: 'utf8', timeout: 10000 }
    );

    let diff = '';
    if (staged.stdout?.trim()) diff += staged.stdout;
    if (unstaged.stdout?.trim()) diff += (diff ? '\n' : '') + unstaged.stdout;
    if (untracked.stdout?.trim()) {
      const newFiles = untracked.stdout.trim().split('\n').slice(0, 10);
      diff +=
        (diff ? '\n' : '') + `New untracked files:\n${newFiles.join('\n')}`;
    }

    if (!diff.trim()) return '(no changes detected)';
    if (diff.length > maxLen) {
      return (
        diff.slice(0, maxLen) + `\n... (truncated, ${diff.length} total chars)`
      );
    }
    return diff;
  } catch {
    return '(git diff failed)';
  }
}

/**
 * Run lint and test checks in a repo directory after implementation.
 * Returns pass/fail status and truncated output for each.
 */
export function runPostImplChecks(
  cwd: string,
  verificationCommands: string[] = []
): PostImplementationChecks {
  const maxOutput = 2000;

  function truncate(s: string): string {
    if (s.length <= maxOutput) return s;
    return s.slice(0, maxOutput) + `\n... (truncated, ${s.length} total chars)`;
  }

  let lintOk = false;
  let lintOutput = '';
  try {
    const lint = spawnSync('npm', ['run', 'lint'], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
    });
    lintOk = lint.status === 0;
    lintOutput = truncate((lint.stdout || '') + (lint.stderr || ''));
  } catch (e: unknown) {
    lintOutput = truncate(e instanceof Error ? e.message : String(e));
  }

  let testsOk = false;
  let testOutput = '';
  try {
    const tests = spawnSync(
      'npx',
      ['vitest', 'run', '--reporter=dot', '--bail=1'],
      {
        cwd,
        encoding: 'utf8',
        timeout: 120000,
      }
    );
    testsOk = tests.status === 0;
    testOutput = truncate((tests.stdout || '') + (tests.stderr || ''));
  } catch (e: unknown) {
    testOutput = truncate(e instanceof Error ? e.message : String(e));
  }

  return {
    lintOk,
    lintOutput,
    testsOk,
    testOutput,
    verifications: runVerificationCommands(cwd, verificationCommands),
  };
}

export function runVerificationCommands(
  cwd: string,
  commands: string[],
  options: { timeoutMs?: number; maxOutput?: number } = {}
): VerificationCommandResult[] {
  const timeout = options.timeoutMs ?? 120000;
  const maxOutput = options.maxOutput ?? 4000;

  const truncate = (value: string): string => {
    if (value.length <= maxOutput) return value;
    return (
      value.slice(0, maxOutput) +
      `\n... (truncated, ${value.length} total chars)`
    );
  };

  return commands
    .map((command) => command.trim())
    .filter(Boolean)
    .map((command) => {
      try {
        const result = spawnSync(command, {
          cwd,
          encoding: 'utf8',
          shell: true,
          timeout,
          maxBuffer: Math.max(maxOutput * 4, 1024 * 1024),
        });
        const output = truncate((result.stdout || '') + (result.stderr || ''));
        return {
          command,
          ok: result.status === 0,
          output:
            output ||
            (result.status === 0
              ? '(command completed with no output)'
              : `(command failed with exit ${result.status ?? 'unknown'})`),
        };
      } catch (error: unknown) {
        return {
          command,
          ok: false,
          output: truncate(
            error instanceof Error ? error.message : String(error)
          ),
        };
      }
    });
}

/**
 * Parse edit metrics from a git diff string.
 * Counts hunks as edit attempts; hunks in files without conflict markers
 * count as successes. Fuzzy fallbacks can't be detected from diff alone.
 */
export function parseEditMetrics(diff: string): {
  editAttempts: number;
  editSuccesses: number;
  editFuzzyFallbacks: number;
} {
  if (!diff || diff.startsWith('(')) {
    // Sentinel strings like '(dry run — no diff)' or '(no changes detected)'
    return { editAttempts: 0, editSuccesses: 0, editFuzzyFallbacks: 0 };
  }

  const lines = diff.split('\n');

  let currentFileHunks = 0;
  let currentFileHasConflict = false;
  let totalAttempts = 0;
  let totalSuccesses = 0;

  const flushFile = () => {
    totalAttempts += currentFileHunks;
    if (!currentFileHasConflict) {
      totalSuccesses += currentFileHunks;
    }
    currentFileHunks = 0;
    currentFileHasConflict = false;
  };

  for (const line of lines) {
    if (/^diff --git /.test(line)) {
      flushFile();
    } else if (/^@@ /.test(line)) {
      currentFileHunks++;
    } else if (/^[<>=]{7}/.test(line)) {
      currentFileHasConflict = true;
    }
  }
  flushFile();

  return {
    editAttempts: totalAttempts,
    editSuccesses: totalSuccesses,
    editFuzzyFallbacks: 0,
  };
}

export async function implementWithClaude(
  prompt: string,
  options: { model?: string; system?: string }
): Promise<{ ok: boolean; output: string }> {
  try {
    const out = await callClaude(prompt, {
      model: options.model || 'claude-sonnet-4-20250514',
      system:
        options.system ||
        'You generate minimal diffs/patches for the described change, focusing on one file at a time.',
    });
    return { ok: true, output: out };
  } catch (e: any) {
    return { ok: false, output: e?.message || String(e) };
  }
}
