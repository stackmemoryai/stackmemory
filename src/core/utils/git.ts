/**
 * Shared git utilities.
 * Consolidates git operations used across capture, handoff, preflight, and CLI wrappers.
 */

import { execFileSync } from 'child_process';

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface DiffStats {
  changed: string[];
  created: string[];
  deleted: string[];
}

export function getCurrentBranch(cwd?: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function detectBaseBranch(cwd?: string): string {
  const dir = cwd || process.cwd();
  for (const base of ['main', 'master', 'develop']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', base], {
        cwd: dir,
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

export function getDiffStats(baseBranch: string, cwd?: string): DiffStats {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-status', `${baseBranch}...HEAD`],
      { cwd: cwd || process.cwd(), encoding: 'utf-8', timeout: 10000 }
    );

    const changed: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];

    for (const line of output.split('\n').filter((l) => l.trim())) {
      const [status, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
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
    return { changed: [], created: [], deleted: [] };
  }
}

export function getCommitsSince(
  baseBranch: string,
  cwd?: string
): CommitInfo[] {
  try {
    const output = execFileSync(
      'git',
      [
        'log',
        `${baseBranch}..HEAD`,
        '--pretty=format:%H%x00%s%x00%an%x00%aI',
        '--no-merges',
      ],
      { cwd: cwd || process.cwd(), encoding: 'utf-8', timeout: 10000 }
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
