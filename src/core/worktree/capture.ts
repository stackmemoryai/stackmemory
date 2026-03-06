/**
 * Post-run context capture.
 * Automatically captures what changed, what was created, and decisions made
 * after a task completes. Stores structured context for future session pickup.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { formatDuration } from '../../utils/formatting.js';
import { logger } from '../monitoring/logger.js';
import {
  getCurrentBranch,
  detectBaseBranch,
  getDiffStats,
  getCommitsSince,
  type CommitInfo,
} from '../utils/git.js';
import { pruneOldFiles } from '../utils/fs.js';

export interface CaptureResult {
  id: string;
  task: string;
  branch: string;
  timestamp: string;
  filesChanged: string[];
  filesCreated: string[];
  filesDeleted: string[];
  commits: CommitInfo[];
  decisions: string[];
  duration?: string;
  baseBranch: string;
}

export type { CommitInfo } from '../utils/git.js';

const MAX_CAPTURES = 50;

export class ContextCapture {
  private repoPath: string;
  private capturesDir: string;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();

    // Store captures in project-local .stackmemory or global
    const localDir = join(this.repoPath, '.stackmemory', 'captures');
    const globalDir = join(homedir(), '.stackmemory', 'captures');

    this.capturesDir = existsSync(join(this.repoPath, '.stackmemory'))
      ? localDir
      : globalDir;

    if (!existsSync(this.capturesDir)) {
      mkdirSync(this.capturesDir, { recursive: true });
    }
  }

  /**
   * Capture current state after task completion.
   * Compares current branch against base (default: main).
   */
  capture(options?: {
    task?: string;
    baseBranch?: string;
    decisions?: string[];
  }): CaptureResult {
    const branch = getCurrentBranch(this.repoPath);
    const baseBranch = options?.baseBranch || detectBaseBranch(this.repoPath);
    const task = options?.task || branch;

    // Get diff stats against base
    const { changed, created, deleted } = getDiffStats(
      baseBranch,
      this.repoPath
    );

    // Get commits since branch point
    const commits = getCommitsSince(baseBranch, this.repoPath);

    // Extract decisions from commit messages
    const commitDecisions = this.extractDecisions(commits);
    const decisions = [...(options?.decisions || []), ...commitDecisions];

    // Estimate duration from first to last commit
    const duration = this.estimateDuration(commits);

    const result: CaptureResult = {
      id: `${Date.now()}-${branch.replace(/[^a-zA-Z0-9]/g, '-')}`,
      task,
      branch,
      timestamp: new Date().toISOString(),
      filesChanged: changed,
      filesCreated: created,
      filesDeleted: deleted,
      commits,
      decisions,
      duration,
      baseBranch,
    };

    // Save to disk
    this.save(result);

    logger.info('Context captured', {
      task,
      branch,
      filesChanged: changed.length,
      filesCreated: created.length,
      commits: commits.length,
    });

    return result;
  }

  /**
   * List all captures, newest first.
   */
  list(limit = 20): CaptureResult[] {
    if (!existsSync(this.capturesDir)) return [];

    const files = readdirSync(this.capturesDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);

    return files.map((f) => {
      const content = readFileSync(join(this.capturesDir, f), 'utf-8');
      return JSON.parse(content) as CaptureResult;
    });
  }

  /**
   * Get the most recent capture for a branch.
   */
  getLatest(branch?: string): CaptureResult | undefined {
    const captures = this.list();
    if (branch) {
      return captures.find((c) => c.branch === branch);
    }
    return captures[0];
  }

  /**
   * Format a capture as a human-readable summary for session restore.
   */
  format(capture: CaptureResult): string {
    const lines: string[] = [];

    lines.push(`# Capture: ${capture.task}`);
    lines.push(`Branch: ${capture.branch} (base: ${capture.baseBranch})`);
    lines.push(
      `Time: ${capture.timestamp}${capture.duration ? ` (${capture.duration})` : ''}`
    );
    lines.push('');

    if (capture.filesChanged.length > 0) {
      lines.push(`## Files Changed (${capture.filesChanged.length})`);
      capture.filesChanged.forEach((f) => lines.push(`  - ${f}`));
      lines.push('');
    }

    if (capture.filesCreated.length > 0) {
      lines.push(`## Files Created (${capture.filesCreated.length})`);
      capture.filesCreated.forEach((f) => lines.push(`  + ${f}`));
      lines.push('');
    }

    if (capture.filesDeleted.length > 0) {
      lines.push(`## Files Deleted (${capture.filesDeleted.length})`);
      capture.filesDeleted.forEach((f) => lines.push(`  - ${f}`));
      lines.push('');
    }

    if (capture.commits.length > 0) {
      lines.push(`## Commits (${capture.commits.length})`);
      capture.commits.forEach((c) =>
        lines.push(`  ${c.hash.slice(0, 7)} ${c.message}`)
      );
      lines.push('');
    }

    if (capture.decisions.length > 0) {
      lines.push('## Decisions');
      capture.decisions.forEach((d) => lines.push(`  - ${d}`));
      lines.push('');
    }

    return lines.join('\n');
  }

  // --- Private ---

  /**
   * Extract decision-like statements from commit messages.
   * Looks for patterns like "chose X over Y", "switched to", "decided", etc.
   */
  private extractDecisions(commits: CommitInfo[]): string[] {
    const decisionPatterns = [
      /chose\s+.+\s+over\s+/i,
      /switched\s+(to|from)\s+/i,
      /decided\s+/i,
      /replaced\s+.+\s+with\s+/i,
      /migrated?\s+(to|from)\s+/i,
      /refactor/i,
      /breaking\s+change/i,
    ];

    const decisions: string[] = [];

    for (const commit of commits) {
      for (const pattern of decisionPatterns) {
        if (pattern.test(commit.message)) {
          decisions.push(commit.message);
          break;
        }
      }
    }

    return decisions;
  }

  private estimateDuration(commits: CommitInfo[]): string | undefined {
    if (commits.length < 2) return undefined;

    const first = new Date(commits[commits.length - 1].date);
    const last = new Date(commits[0].date);
    const diffMs = last.getTime() - first.getTime();
    return formatDuration(diffMs);
  }

  private save(result: CaptureResult): void {
    const filename = `${result.timestamp.replace(/[:.]/g, '-')}-${result.branch.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30)}.json`;
    const filePath = join(this.capturesDir, filename);

    writeFileSync(filePath, JSON.stringify(result, null, 2));

    // Cleanup old captures
    pruneOldFiles(this.capturesDir, '.json', MAX_CAPTURES);
  }
}
