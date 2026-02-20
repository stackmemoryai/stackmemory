/**
 * Session Summary Generator
 * Generates intelligent suggestions for what to do next after a Claude session
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pickNextLinearTask, TaskSuggestion } from './linear-task-picker.js';

export interface SessionContext {
  instanceId: string;
  exitCode: number | null;
  sessionStartTime: number;
  worktreePath?: string;
  branch?: string;
  task?: string;
}

export interface Suggestion {
  key: string;
  label: string;
  action: string;
  priority: number;
}

export interface SessionSummary {
  duration: string;
  exitCode: number | null;
  branch: string;
  status: 'success' | 'error' | 'interrupted';
  suggestions: Suggestion[];
  linearTask?: TaskSuggestion;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}min`;
  }
  if (minutes > 0) {
    return `${minutes}min`;
  }
  return `${seconds}s`;
}

/**
 * Get current git branch
 */
function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Check for uncommitted changes
 */
function hasUncommittedChanges(): { changed: boolean; count: number } {
  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = status.trim().split('\n').filter(Boolean);
    return { changed: lines.length > 0, count: lines.length };
  } catch {
    return { changed: false, count: 0 };
  }
}

/**
 * Check if we're in a worktree
 */
function isInWorktree(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Check if it's a worktree (not the main repo)
    const gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return gitDir.includes('.git/worktrees/');
  } catch {
    return false;
  }
}

/**
 * Check if tests exist and might need running
 */
function hasTestScript(): boolean {
  try {
    const packageJson = execSync('cat package.json', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pkg = JSON.parse(packageJson);
    return !!(pkg.scripts?.test || pkg.scripts?.['test:run']);
  } catch {
    return false;
  }
}

/**
 * Generate suggestions based on session context
 */
async function generateSuggestions(
  context: SessionContext
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  let keyIndex = 1;

  const changes = hasUncommittedChanges();
  const inWorktree = isInWorktree();
  const hasTests = hasTestScript();

  // Error case - suggest reviewing logs
  if (context.exitCode !== 0 && context.exitCode !== null) {
    suggestions.push({
      key: String(keyIndex++),
      label: 'Review error logs',
      action: 'cat ~/.claude/logs/claude-*.log | tail -50',
      priority: 100,
    });
  }

  // Uncommitted changes - suggest commit or PR
  if (changes.changed) {
    suggestions.push({
      key: String(keyIndex++),
      label: `Commit changes (${changes.count} files)`,
      action: 'git add -A && git commit',
      priority: 90,
    });

    // If on feature branch, suggest PR
    const branch = getCurrentBranch();
    if (branch !== 'main' && branch !== 'master' && branch !== 'unknown') {
      suggestions.push({
        key: String(keyIndex++),
        label: 'Create PR',
        action: 'gh pr create --fill',
        priority: 80,
      });
    }
  }

  // If tests exist and changes were made, suggest running tests
  if (hasTests && changes.changed) {
    suggestions.push({
      key: String(keyIndex++),
      label: 'Run tests',
      action: 'npm run test:run',
      priority: 85,
    });
  }

  // Worktree-specific suggestions
  if (inWorktree) {
    suggestions.push({
      key: String(keyIndex++),
      label: 'Merge to main',
      action: 'cwm', // custom alias
      priority: 70,
    });
  }

  // Try to get next Linear task
  try {
    const linearTask = await pickNextLinearTask({ preferTestTasks: true });
    if (linearTask) {
      suggestions.push({
        key: String(keyIndex++),
        label: `Start: ${linearTask.identifier} - ${linearTask.title.substring(0, 40)}${linearTask.title.length > 40 ? '...' : ''}${linearTask.hasTestRequirements ? ' (has tests)' : ''}`,
        action: `stackmemory task start ${linearTask.id} --assign-me`,
        priority: 60,
      });
    }
  } catch {
    // Linear not available, skip
  }

  // Pending patches
  try {
    const patchDir = path.join(process.cwd(), '.stackmemory', 'patches');
    if (fs.existsSync(patchDir)) {
      const patches = fs
        .readdirSync(patchDir)
        .filter((f) => f.endsWith('.patch'));
      if (patches.length > 0) {
        suggestions.push({
          key: String(keyIndex++),
          label: `Review ${patches.length} pending patch${patches.length > 1 ? 'es' : ''}`,
          action: `ls -la .stackmemory/patches/`,
          priority: 75,
        });
      }
    }
  } catch {
    /* skip */
  }

  // Pending spec branches
  try {
    const tmpEntries = fs
      .readdirSync('/tmp')
      .filter((d) => d.startsWith('sm-spec-'));
    if (tmpEntries.length > 0) {
      const latest = path.join('/tmp', tmpEntries[tmpEntries.length - 1]);
      suggestions.push({
        key: String(keyIndex++),
        label: `Inspect spec branch (${tmpEntries.length} workspace${tmpEntries.length > 1 ? 's' : ''})`,
        action: `cd ${latest} && git log --oneline -5`,
        priority: 65,
      });
    }
  } catch {
    /* skip */
  }

  // Long session suggestion
  const durationMs = Date.now() - context.sessionStartTime;
  if (durationMs > 30 * 60 * 1000) {
    // > 30 minutes
    suggestions.push({
      key: String(keyIndex++),
      label: 'Take a break',
      action: 'echo "Great work! Time for a coffee break."',
      priority: 10,
    });
  }

  // Sort by priority (highest first) and re-key
  suggestions.sort((a, b) => b.priority - a.priority);

  // Ensure minimum 2 options always
  if (suggestions.length < 2) {
    // Add default options if not enough suggestions
    if (suggestions.length === 0) {
      suggestions.push({
        key: '1',
        label: 'Start new Claude session',
        action: 'claude-sm',
        priority: 50,
      });
    }
    if (suggestions.length < 2) {
      suggestions.push({
        key: '2',
        label: 'View session logs',
        action: 'cat ~/.claude/logs/claude-*.log | tail -30',
        priority: 40,
      });
    }
  }

  suggestions.forEach((s, i) => {
    s.key = String(i + 1);
  });

  return suggestions;
}

/**
 * Generate full session summary
 */
export async function generateSessionSummary(
  context: SessionContext
): Promise<SessionSummary> {
  const durationMs = Date.now() - context.sessionStartTime;
  const duration = formatDuration(durationMs);
  const branch = context.branch || getCurrentBranch();

  let status: 'success' | 'error' | 'interrupted' = 'success';
  if (context.exitCode !== 0 && context.exitCode !== null) {
    status = 'error';
  }

  const suggestions = await generateSuggestions(context);

  // Extract linear task if present
  let linearTask: TaskSuggestion | undefined;
  try {
    linearTask = await pickNextLinearTask({ preferTestTasks: true });
  } catch {
    // Linear not available
  }

  return {
    duration,
    exitCode: context.exitCode,
    branch,
    status,
    suggestions,
    linearTask,
  };
}

/**
 * Format session summary as a compact message
 */
export function formatSummaryMessage(
  summary: SessionSummary,
  sessionId?: string
): string {
  const statusEmoji = summary.status === 'success' ? '' : '';
  const exitInfo =
    summary.exitCode !== null ? ` | Exit: ${summary.exitCode}` : '';
  const sessionInfo = sessionId ? ` | Session: ${sessionId}` : '';

  let message = `Claude session complete ${statusEmoji}\n`;
  message += `Duration: ${summary.duration}${exitInfo}${sessionInfo}\n`;
  message += `Branch: ${summary.branch}\n`;

  // Add Claude Code session URL if session ID is available
  if (sessionId) {
    message += `View: https://claude.ai/chat/${sessionId}\n`;
  }

  message += '\n';

  if (summary.suggestions.length > 0) {
    message += `What to do next:\n`;
    for (const s of summary.suggestions.slice(0, 4)) {
      message += `${s.key}. ${s.label}\n`;
    }
    message += `\nReply with number or custom action`;
  } else {
    message += `No pending actions. Nice work!`;
  }

  return message;
}

/**
 * Get action for a suggestion key
 */
export function getActionForKey(
  suggestions: Suggestion[],
  key: string
): string | null {
  const suggestion = suggestions.find((s) => s.key === key);
  return suggestion?.action || null;
}
