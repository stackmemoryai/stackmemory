/**
 * Pre-flight file overlap check for parallel task execution.
 * Analyzes git history and imports to predict which files each task will touch,
 * then flags overlaps before spawning parallel work.
 */

import { execFileSync } from 'child_process';
import { extname } from 'path';
import { logger } from '../monitoring/logger.js';
import { extractKeywords as extractKeywordsShared } from '../utils/text.js';

export interface TaskDefinition {
  name: string;
  description: string;
  keywords?: string[];
  files?: string[]; // Explicitly specified files
}

export interface FileOverlap {
  file: string;
  tasks: string[];
  confidence: number; // 0-1
  source: 'explicit' | 'git-history' | 'import-graph' | 'keyword-match';
}

export interface PreflightResult {
  parallelSafe: TaskDefinition[][];
  sequential: {
    task: TaskDefinition;
    after: string;
    overlaps: FileOverlap[];
  }[];
  allOverlaps: FileOverlap[];
  summary: string;
}

export class PreflightChecker {
  private repoPath: string;
  private gitLogCache: Map<string, string[]> = new Map();

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();
  }

  /**
   * Run pre-flight check on a set of tasks.
   * Returns parallel-safe groupings and sequential recommendations.
   */
  check(tasks: TaskDefinition[]): PreflightResult {
    if (tasks.length < 2) {
      return {
        parallelSafe: [tasks],
        sequential: [],
        allOverlaps: [],
        summary: 'Single task - no overlap check needed.',
      };
    }

    // Predict files and cache keywords for each task
    const taskFiles = new Map<string, Set<string>>();
    const taskKeywords = new Map<string, string[]>();
    for (const task of tasks) {
      const files = this.predictFiles(task);
      taskFiles.set(task.name, files);
      taskKeywords.set(
        task.name,
        task.keywords || this.extractKeywords(task.description)
      );
    }

    // Find overlaps between all task pairs
    const allOverlaps: FileOverlap[] = [];
    const overlapPairs = new Map<string, Set<string>>(); // task -> overlapping tasks

    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i];
        const b = tasks[j];
        const filesA = taskFiles.get(a.name)!;
        const filesB = taskFiles.get(b.name)!;

        const shared = [...filesA].filter((f) => filesB.has(f));
        if (shared.length > 0) {
          for (const file of shared) {
            allOverlaps.push({
              file,
              tasks: [a.name, b.name],
              confidence: this.estimateConfidenceCached(
                file,
                taskKeywords.get(a.name)!,
                taskKeywords.get(b.name)!,
                a,
                b
              ),
              source: this.getSourceCached(
                file,
                taskKeywords.get(a.name)!,
                taskKeywords.get(b.name)!,
                a,
                b
              ),
            });
          }

          if (!overlapPairs.has(a.name)) overlapPairs.set(a.name, new Set());
          if (!overlapPairs.has(b.name)) overlapPairs.set(b.name, new Set());
          overlapPairs.get(a.name)!.add(b.name);
          overlapPairs.get(b.name)!.add(a.name);
        }
      }
    }

    // Build parallel-safe groups using greedy graph coloring
    const parallelSafe = this.buildParallelGroups(tasks, overlapPairs);

    // Build sequential recommendations for overlapping tasks
    const sequential: PreflightResult['sequential'] = [];
    for (const task of tasks) {
      const conflicts = overlapPairs.get(task.name);
      if (conflicts && conflicts.size > 0) {
        const overlaps = allOverlaps.filter((o) => o.tasks.includes(task.name));
        // The task with fewer predicted files should run after the larger one
        const largestConflict = [...conflicts].sort((a, b) => {
          return (taskFiles.get(b)?.size || 0) - (taskFiles.get(a)?.size || 0);
        })[0];

        sequential.push({
          task,
          after: largestConflict,
          overlaps,
        });
      }
    }

    // Deduplicate sequential (only keep the smaller task in each pair)
    const deduped = this.deduplicateSequential(sequential, taskFiles);

    const summary = this.formatSummary(parallelSafe, deduped, allOverlaps);

    return {
      parallelSafe,
      sequential: deduped,
      allOverlaps,
      summary,
    };
  }

  /**
   * Predict which files a task will touch based on multiple signals.
   */
  predictFiles(task: TaskDefinition): Set<string> {
    const files = new Set<string>();

    // 1. Explicit files
    if (task.files) {
      task.files.forEach((f) => files.add(f));
    }

    // 2. Git history - files frequently changed together with keywords
    const keywords = task.keywords || this.extractKeywords(task.description);
    for (const keyword of keywords) {
      const historyFiles = this.searchGitHistory(keyword);
      historyFiles.forEach((f) => files.add(f));
    }

    // 3. Import graph - if we have explicit files, find their dependents
    if (task.files && task.files.length > 0) {
      for (const file of task.files) {
        const dependents = this.findDependents(file);
        dependents.forEach((f) => files.add(f));
      }
    }

    // 4. Keyword match in file paths/content
    for (const keyword of keywords) {
      const matched = this.searchFilePaths(keyword);
      matched.forEach((f) => files.add(f));
    }

    return files;
  }

  /**
   * Search git log for files changed in commits matching a keyword.
   */
  private searchGitHistory(keyword: string, maxCommits = 50): string[] {
    const cacheKey = keyword.toLowerCase();
    if (this.gitLogCache.has(cacheKey)) {
      return this.gitLogCache.get(cacheKey)!;
    }

    try {
      const output = execFileSync(
        'git',
        [
          'log',
          `--max-count=${maxCommits}`,
          '--name-only',
          '--pretty=format:',
          '--grep',
          keyword,
          '-i',
        ],
        { cwd: this.repoPath, encoding: 'utf-8', timeout: 10000 }
      );

      const files = output
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      // Count frequency, return top files
      const freq = new Map<string, number>();
      for (const f of files) {
        freq.set(f, (freq.get(f) || 0) + 1);
      }

      const result = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([f]) => f);

      this.gitLogCache.set(cacheKey, result);
      return result;
    } catch {
      return [];
    }
  }

  /**
   * Find files that import/depend on a given file (shallow, grep-based).
   */
  private findDependents(filePath: string): string[] {
    const ext = extname(filePath);
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) return [];

    const baseName = filePath
      .replace(extname(filePath), '')
      .replace(/\/index$/, '');

    try {
      const output = execFileSync(
        'git',
        ['grep', '-l', baseName, '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
        { cwd: this.repoPath, encoding: 'utf-8', timeout: 10000 }
      );

      return output
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l !== filePath);
    } catch {
      return [];
    }
  }

  /**
   * Search file paths for keyword matches using git ls-files.
   */
  private searchFilePaths(keyword: string): string[] {
    try {
      const output = execFileSync('git', ['ls-files', `*${keyword}*`], {
        cwd: this.repoPath,
        encoding: 'utf-8',
        timeout: 5000,
      });

      return output
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  private extractKeywords(description: string): string[] {
    return extractKeywordsShared(description);
  }

  private isInHistory(keywords: string[], file: string): boolean {
    return keywords.some((k) =>
      (this.gitLogCache.get(k.toLowerCase()) || []).includes(file)
    );
  }

  private estimateConfidenceCached(
    file: string,
    keywordsA: string[],
    keywordsB: string[],
    taskA: TaskDefinition,
    taskB: TaskDefinition
  ): number {
    if (taskA.files?.includes(file) || taskB.files?.includes(file)) {
      return 0.9;
    }

    if (
      this.isInHistory(keywordsA, file) &&
      this.isInHistory(keywordsB, file)
    ) {
      return 0.7;
    }

    return 0.3;
  }

  private getSourceCached(
    file: string,
    keywordsA: string[],
    keywordsB: string[],
    taskA: TaskDefinition,
    taskB: TaskDefinition
  ): FileOverlap['source'] {
    if (taskA.files?.includes(file) || taskB.files?.includes(file)) {
      return 'explicit';
    }
    if (
      this.isInHistory(keywordsA, file) ||
      this.isInHistory(keywordsB, file)
    ) {
      return 'git-history';
    }
    return 'keyword-match';
  }

  /**
   * Build parallel-safe groups via greedy graph coloring.
   * Tasks that overlap go in different groups.
   */
  private buildParallelGroups(
    tasks: TaskDefinition[],
    overlapPairs: Map<string, Set<string>>
  ): TaskDefinition[][] {
    const groups: TaskDefinition[][] = [];
    const assigned = new Set<string>();

    // Sort tasks: those with fewest conflicts first (easier to group)
    const sorted = [...tasks].sort((a, b) => {
      const conflictsA = overlapPairs.get(a.name)?.size || 0;
      const conflictsB = overlapPairs.get(b.name)?.size || 0;
      return conflictsA - conflictsB;
    });

    for (const task of sorted) {
      if (assigned.has(task.name)) continue;

      // Try to fit into existing group
      let placed = false;
      for (const group of groups) {
        const conflicts = overlapPairs.get(task.name) || new Set();
        const groupHasConflict = group.some((t) => conflicts.has(t.name));
        if (!groupHasConflict) {
          group.push(task);
          assigned.add(task.name);
          placed = true;
          break;
        }
      }

      if (!placed) {
        groups.push([task]);
        assigned.add(task.name);
      }
    }

    return groups;
  }

  /**
   * Deduplicate sequential recommendations — keep only the smaller task.
   */
  private deduplicateSequential(
    sequential: PreflightResult['sequential'],
    taskFiles: Map<string, Set<string>>
  ): PreflightResult['sequential'] {
    const seen = new Set<string>();
    const result: PreflightResult['sequential'] = [];

    for (const entry of sequential) {
      const key = [entry.task.name, entry.after].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      // Keep the task with fewer files as the one that should wait
      const mySize = taskFiles.get(entry.task.name)?.size || 0;
      const otherSize = taskFiles.get(entry.after)?.size || 0;

      if (mySize <= otherSize) {
        result.push(entry);
      } else {
        // Swap: the other task should wait for this one
        const otherTask = sequential.find((s) => s.task.name === entry.after);
        if (otherTask) {
          result.push({
            task: otherTask.task,
            after: entry.task.name,
            overlaps: entry.overlaps,
          });
        }
      }
    }

    return result;
  }

  /**
   * Format human-readable summary.
   */
  private formatSummary(
    parallelSafe: TaskDefinition[][],
    sequential: PreflightResult['sequential'],
    overlaps: FileOverlap[]
  ): string {
    const lines: string[] = [];

    if (overlaps.length === 0) {
      lines.push('All tasks are parallel-safe. No file overlaps detected.');
      return lines.join('\n');
    }

    lines.push(`Found ${overlaps.length} file overlap(s).\n`);

    // Parallel groups
    if (parallelSafe.length === 1) {
      lines.push(
        'All tasks can run in parallel (overlaps are low-confidence).'
      );
    } else {
      lines.push(`Parallel groups (${parallelSafe.length}):`);
      parallelSafe.forEach((group, i) => {
        lines.push(`  Group ${i + 1}: ${group.map((t) => t.name).join(', ')}`);
      });
    }

    // Sequential
    if (sequential.length > 0) {
      lines.push('\nSequential recommendations:');
      for (const entry of sequential) {
        lines.push(`  "${entry.task.name}" should run after "${entry.after}"`);
        for (const overlap of entry.overlaps.slice(0, 5)) {
          lines.push(
            `    - ${overlap.file} (${overlap.source}, ${Math.round(overlap.confidence * 100)}%)`
          );
        }
      }
    }

    return lines.join('\n');
  }
}
