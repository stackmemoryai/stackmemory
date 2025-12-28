/**
 * Auto-detection utilities for Claude-SM
 * Automatically detects when worktree isolation is needed
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface DetectionResult {
  shouldUseWorktree: boolean;
  reasons: string[];
  confidence: 'high' | 'medium' | 'low';
  suggestions: string[];
}

export class ClaudeAutoDetect {
  private projectRoot: string;

  constructor(projectRoot: string = process.cwd()) {
    this.projectRoot = projectRoot;
  }

  /**
   * Main detection logic
   */
  public detect(): DetectionResult {
    const result: DetectionResult = {
      shouldUseWorktree: false,
      reasons: [],
      confidence: 'low',
      suggestions: [],
    };

    // Check various conditions
    const checks = [
      this.checkUncommittedChanges(),
      this.checkActiveInstances(),
      this.checkBranchProtection(),
      this.checkFileConflicts(),
      this.checkResourceUsage(),
      this.checkTaskComplexity(),
    ];

    // Aggregate results
    let score = 0;
    for (const check of checks) {
      if (check.detected) {
        score += check.weight;
        result.reasons.push(check.reason);
        if (check.suggestion) {
          result.suggestions.push(check.suggestion);
        }
      }
    }

    // Determine recommendation
    if (score >= 7) {
      result.shouldUseWorktree = true;
      result.confidence = 'high';
    } else if (score >= 4) {
      result.shouldUseWorktree = true;
      result.confidence = 'medium';
    } else if (score >= 2) {
      result.shouldUseWorktree = false;
      result.confidence = 'medium';
      result.suggestions.push(
        'Consider using --worktree if making significant changes'
      );
    }

    return result;
  }

  /**
   * Check for uncommitted changes
   */
  private checkUncommittedChanges(): {
    detected: boolean;
    weight: number;
    reason: string;
    suggestion?: string;
  } {
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      });

      if (status.trim().length > 0) {
        const lines = status.trim().split('\n').length;
        return {
          detected: true,
          weight: lines > 10 ? 3 : 2,
          reason: `${lines} uncommitted changes in working directory`,
          suggestion:
            'Commit or stash changes before proceeding, or use worktree',
        };
      }
    } catch {}

    return { detected: false, weight: 0, reason: '' };
  }

  /**
   * Check for other active Claude instances
   */
  private checkActiveInstances(): {
    detected: boolean;
    weight: number;
    reason: string;
    suggestion?: string;
  } {
    const lockDir = path.join(this.projectRoot, '.claude-worktree-locks');

    if (fs.existsSync(lockDir)) {
      try {
        const locks = fs
          .readdirSync(lockDir)
          .filter((f) => f.endsWith('.lock'));
        const activeLocks = locks.filter((lockFile) => {
          const lockPath = path.join(lockDir, lockFile);
          const stats = fs.statSync(lockPath);
          const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
          return ageHours < 24;
        });

        if (activeLocks.length > 0) {
          return {
            detected: true,
            weight: activeLocks.length >= 2 ? 4 : 3,
            reason: `${activeLocks.length} other Claude instance(s) active`,
            suggestion: 'Use worktree to avoid conflicts with other instances',
          };
        }
      } catch {}
    }

    return { detected: false, weight: 0, reason: '' };
  }

  /**
   * Check if on protected branch
   */
  private checkBranchProtection(): {
    detected: boolean;
    weight: number;
    reason: string;
    suggestion?: string;
  } {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      }).trim();

      const protectedBranches = [
        'main',
        'master',
        'production',
        'staging',
        'develop',
      ];

      if (protectedBranches.includes(branch)) {
        return {
          detected: true,
          weight: 4,
          reason: `Working on protected branch: ${branch}`,
          suggestion: 'Create a feature branch or use worktree',
        };
      }
    } catch {}

    return { detected: false, weight: 0, reason: '' };
  }

  /**
   * Check for potential file conflicts
   */
  private checkFileConflicts(): {
    detected: boolean;
    weight: number;
    reason: string;
    suggestion?: string;
  } {
    // Check if multiple editors/IDEs are open
    const ideFiles = [
      '.vscode/settings.json',
      '.idea/workspace.xml',
      '.sublime-workspace',
    ];

    let openIDEs = 0;
    for (const ideFile of ideFiles) {
      const filePath = path.join(this.projectRoot, ideFile);
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          const ageMinutes = (Date.now() - stats.mtimeMs) / (1000 * 60);
          if (ageMinutes < 5) {
            openIDEs++;
          }
        } catch {}
      }
    }

    if (openIDEs > 1) {
      return {
        detected: true,
        weight: 2,
        reason: 'Multiple IDEs/editors detected',
        suggestion: 'Use worktree to avoid file lock conflicts',
      };
    }

    return { detected: false, weight: 0, reason: '' };
  }

  /**
   * Check system resource usage
   */
  private checkResourceUsage(): {
    detected: boolean;
    weight: number;
    reason: string;
    suggestion?: string;
  } {
    try {
      // Check number of git worktrees
      const worktrees = execSync('git worktree list', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      })
        .trim()
        .split('\n').length;

      if (worktrees > 3) {
        return {
          detected: true,
          weight: 1,
          reason: `${worktrees} worktrees already exist`,
          suggestion: 'Consider cleaning up old worktrees',
        };
      }
    } catch {}

    return { detected: false, weight: 0, reason: '' };
  }

  /**
   * Detect task complexity from user input or context
   */
  private checkTaskComplexity(): {
    detected: boolean;
    weight: number;
    reason: string;
    suggestion?: string;
  } {
    // Check for complex task indicators in recent commits
    try {
      const recentCommit = execSync('git log -1 --pretty=%B', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      }).toLowerCase();

      const complexIndicators = [
        'refactor',
        'breaking change',
        'major',
        'experiment',
        'prototype',
        'redesign',
        'migration',
      ];

      for (const indicator of complexIndicators) {
        if (recentCommit.includes(indicator)) {
          return {
            detected: true,
            weight: 2,
            reason: 'Recent complex changes detected',
            suggestion: 'Use worktree for experimental or major changes',
          };
        }
      }
    } catch {}

    return { detected: false, weight: 0, reason: '' };
  }

  /**
   * Get current environment status
   */
  public getStatus(): {
    git: boolean;
    worktrees: number;
    instances: number;
    branch: string;
    uncommittedChanges: number;
  } {
    const status = {
      git: false,
      worktrees: 0,
      instances: 0,
      branch: 'unknown',
      uncommittedChanges: 0,
    };

    // Check Git
    try {
      execSync('git rev-parse --git-dir', {
        cwd: this.projectRoot,
        stdio: 'ignore',
      });
      status.git = true;

      // Get branch
      status.branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      }).trim();

      // Count worktrees
      const worktreeList = execSync('git worktree list', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      });
      status.worktrees = worktreeList.trim().split('\n').length;

      // Count changes
      const changes = execSync('git status --porcelain', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      });
      status.uncommittedChanges = changes.trim()
        ? changes.trim().split('\n').length
        : 0;
    } catch {}

    // Count instances
    const lockDir = path.join(this.projectRoot, '.claude-worktree-locks');
    if (fs.existsSync(lockDir)) {
      try {
        const locks = fs
          .readdirSync(lockDir)
          .filter((f) => f.endsWith('.lock'));
        status.instances = locks.filter((lockFile) => {
          const lockPath = path.join(lockDir, lockFile);
          const stats = fs.statSync(lockPath);
          const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
          return ageHours < 24;
        }).length;
      } catch {}
    }

    return status;
  }

  /**
   * Smart recommendation based on context
   */
  public recommend(taskDescription?: string): {
    mode: 'normal' | 'worktree' | 'sandbox' | 'chrome';
    reason: string;
    flags: string[];
  } {
    const detection = this.detect();
    const status = this.getStatus();

    // Analyze task description if provided
    let taskType = 'general';
    if (taskDescription) {
      const lower = taskDescription.toLowerCase();
      if (
        lower.includes('ui') ||
        lower.includes('frontend') ||
        lower.includes('component')
      ) {
        taskType = 'frontend';
      } else if (
        lower.includes('api') ||
        lower.includes('backend') ||
        lower.includes('database')
      ) {
        taskType = 'backend';
      } else if (
        lower.includes('test') ||
        lower.includes('debug') ||
        lower.includes('fix')
      ) {
        taskType = 'debugging';
      } else if (lower.includes('refactor') || lower.includes('clean')) {
        taskType = 'refactoring';
      }
    }

    // Determine mode and flags
    let mode: 'normal' | 'worktree' | 'sandbox' | 'chrome' = 'normal';
    const flags: string[] = [];
    let reason = '';

    if (detection.shouldUseWorktree) {
      mode = 'worktree';
      flags.push('--worktree');
      reason = detection.reasons[0] || 'Isolation recommended';
    }

    // Add task-specific flags
    switch (taskType) {
      case 'frontend':
        if (mode === 'worktree') {
          mode = 'chrome' as any;
          flags.push('--chrome');
          reason += '; Chrome automation for UI work';
        }
        break;
      case 'backend':
        if (mode === 'worktree') {
          mode = 'sandbox' as any;
          flags.push('--sandbox');
          reason += '; Sandboxed for API development';
        }
        break;
      case 'refactoring':
        if (mode === 'normal' && status.uncommittedChanges === 0) {
          // Refactoring on clean working directory is OK
          reason = 'Clean working directory, safe to proceed';
        }
        break;
    }

    return { mode, reason, flags };
  }
}
