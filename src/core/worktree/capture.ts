/**
 * Post-run context capture.
 * Automatically captures what changed, what was created, and decisions made
 * after a task completes. Stores structured context for future session pickup.
 */

import { execFileSync } from 'child_process';
import { formatDuration } from '../../utils/formatting.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { logger } from '../monitoring/logger.js';

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

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

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
    const branch = this.getCurrentBranch();
    const baseBranch = options?.baseBranch || this.detectBaseBranch();
    const task = options?.task || branch;

    // Get diff stats against base
    const { changed, created, deleted } = this.getDiffStats(baseBranch);

    // Get commits since branch point
    const commits = this.getCommitsSince(baseBranch);

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

  private getCurrentBranch(): string {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: this.repoPath,
        encoding: 'utf-8',
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  private detectBaseBranch(): string {
    // Try main, then master
    for (const base of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', base], {
          cwd: this.repoPath,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        return base;
      } catch {
        continue;
      }
    }
    return 'main';
  }

  private getDiffStats(baseBranch: string): {
    changed: string[];
    created: string[];
    deleted: string[];
  } {
    try {
      const output = execFileSync(
        'git',
        ['diff', '--name-status', `${baseBranch}...HEAD`],
        { cwd: this.repoPath, encoding: 'utf-8', timeout: 10000 }
      );

      const changed: string[] = [];
      const created: string[] = [];
      const deleted: string[] = [];

      for (const line of output.split('\n').filter((l) => l.trim())) {
        const [status, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t'); // handle paths with tabs
        if (!filePath) continue;

        switch (status.charAt(0)) {
          case 'A':
            created.push(filePath);
            break;
          case 'D':
            deleted.push(filePath);
            break;
          case 'M':
          case 'R':
          case 'C':
            changed.push(filePath);
            break;
        }
      }

      return { changed, created, deleted };
    } catch {
      // If diff against base fails (e.g., same branch), diff against HEAD~1
      return { changed: [], created: [], deleted: [] };
    }
  }

  private getCommitsSince(baseBranch: string): CommitInfo[] {
    try {
      const output = execFileSync(
        'git',
        [
          'log',
          `${baseBranch}..HEAD`,
          '--pretty=format:%H%x00%s%x00%an%x00%aI',
          '--no-merges',
        ],
        { cwd: this.repoPath, encoding: 'utf-8', timeout: 10000 }
      );

      return output
        .split('\n')
        .filter((l) => l.trim())
        .map((line) => {
          const [hash, message, author, date] = line.split('\0');
          return { hash, message, author, date };
        });
    } catch {
      return [];
    }
  }

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
    this.cleanup();
  }

  private cleanup(): void {
    try {
      const files = readdirSync(this.capturesDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

      for (const old of files.slice(MAX_CAPTURES)) {
        unlinkSync(join(this.capturesDir, old));
      }
    } catch {
      // Not critical
    }
  }
}
