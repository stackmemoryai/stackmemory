/**
 * State Reconciler for Ralph-StackMemory Integration
 * Handles conflict resolution and state consistency across git, files, and memory
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '../../../core/monitoring/logger.js';
import {
  RalphLoopState,
  StateSource,
  Conflict,
  Resolution,
  ValidationResult,
  RalphStackMemoryConfig,
} from '../types.js';

export class StateReconciler {
  private config: RalphStackMemoryConfig['stateReconciliation'];
  private readonly ralphDir = '.ralph';
  private reconciliationLog: Resolution[] = [];

  constructor(config?: Partial<RalphStackMemoryConfig['stateReconciliation']>) {
    this.config = {
      precedence: config?.precedence || ['git', 'files', 'memory'],
      conflictResolution: config?.conflictResolution || 'automatic',
      syncInterval: config?.syncInterval || 5000,
      validateConsistency: config?.validateConsistency ?? true,
    };
  }

  /**
   * Reconcile state from multiple sources
   */
  async reconcile(sources: StateSource[]): Promise<RalphLoopState> {
    logger.info('Reconciling state from sources', {
      sources: sources.map((s) => ({ type: s.type, confidence: s.confidence })),
    });

    // Sort sources by precedence
    const sortedSources = this.sortByPrecedence(sources);

    // Detect conflicts
    const conflicts = this.detectConflicts(sortedSources);

    if (conflicts.length > 0) {
      logger.warn('State conflicts detected', {
        count: conflicts.length,
        fields: conflicts.map((c) => c.field),
      });

      // Resolve conflicts based on configuration
      const resolutions = await this.resolveConflicts(conflicts);
      return this.applyResolutions(
        sortedSources[0].state as RalphLoopState,
        resolutions
      );
    }

    // No conflicts, merge states
    return this.mergeStates(sortedSources);
  }

  /**
   * Detect conflicts between state sources
   */
  detectConflicts(sources: StateSource[]): Conflict[] {
    const conflicts: Conflict[] = [];
    const fields = new Set<string>();

    // Collect all fields across sources
    sources.forEach((source) => {
      Object.keys(source.state).forEach((field) => fields.add(field));
    });

    // Check each field for conflicts
    for (const field of fields) {
      const values = sources
        .filter((s) => s.state[field as keyof RalphLoopState] !== undefined)
        .map((s) => ({
          source: s,
          value: s.state[field as keyof RalphLoopState],
        }));

      if (values.length > 1 && !this.valuesMatch(values.map((v) => v.value))) {
        conflicts.push({
          field,
          sources: values.map((v) => v.source),
          severity: this.assessConflictSeverity(field),
          suggestedResolution: this.suggestResolution(
            field,
            values.map((v) => v.source)
          ),
        });
      }
    }

    return conflicts;
  }

  /**
   * Resolve a single conflict
   */
  async resolveConflict(conflict: Conflict): Promise<Resolution> {
    const resolution = await this.resolveConflictByStrategy(conflict);

    this.reconciliationLog.push(resolution);

    logger.debug('Conflict resolved', {
      field: conflict.field,
      resolution: resolution.source,
      rationale: resolution.rationale,
    });

    return resolution;
  }

  /**
   * Validate state consistency
   */
  async validateConsistency(state: RalphLoopState): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Validate file system state
      await this.validateFileSystemState(state, errors, warnings);

      // Validate git state
      this.validateGitState(state, errors, warnings);

      // Validate logical consistency
      this.validateLogicalConsistency(state, errors, warnings);

      return {
        testsPass: errors.length === 0,
        lintClean: true,
        buildSuccess: true,
        errors,
        warnings,
      };
    } catch (error: any) {
      errors.push(`Validation failed: ${error.message}`);
      return {
        testsPass: false,
        lintClean: false,
        buildSuccess: false,
        errors,
        warnings,
      };
    }
  }

  /**
   * Get state from git
   */
  async getGitState(): Promise<StateSource> {
    try {
      const currentCommit = execSync('git rev-parse HEAD', {
        encoding: 'utf8',
      }).trim();
      const _branch = execSync('git branch --show-current', {
        encoding: 'utf8',
      }).trim();
      const uncommittedChanges = execSync('git status --porcelain', {
        encoding: 'utf8',
      });

      // Check for Ralph commits
      const ralphCommits = execSync(
        'git log --oneline --grep="Ralph iteration"',
        {
          encoding: 'utf8',
        }
      )
        .split('\n')
        .filter(Boolean);

      const lastRalphCommit = ralphCommits[0]?.split(' ')[0];
      const iteration = ralphCommits.length;

      return {
        type: 'git',
        state: {
          currentCommit,
          startCommit: lastRalphCommit,
          iteration,
          status: uncommittedChanges ? 'running' : 'completed',
        },
        timestamp: Date.now(),
        confidence: 0.9,
      };
    } catch (error: any) {
      logger.error('Failed to get git state', { error: error.message });
      return {
        type: 'git',
        state: {},
        timestamp: Date.now(),
        confidence: 0.1,
      };
    }
  }

  /**
   * Get state from file system
   */
  async getFileState(): Promise<StateSource> {
    try {
      const statePath = path.join(this.ralphDir, 'state.json');
      const iterationPath = path.join(this.ralphDir, 'iteration.txt');
      const feedbackPath = path.join(this.ralphDir, 'feedback.txt');
      const taskPath = path.join(this.ralphDir, 'task.md');
      const criteriaPath = path.join(this.ralphDir, 'completion-criteria.md');

      const [stateData, iteration, feedback, task, criteria] =
        await Promise.all([
          fs.readFile(statePath, 'utf8').catch(() => '{}'),
          fs.readFile(iterationPath, 'utf8').catch(() => '0'),
          fs.readFile(feedbackPath, 'utf8').catch(() => ''),
          fs.readFile(taskPath, 'utf8').catch(() => ''),
          fs.readFile(criteriaPath, 'utf8').catch(() => ''),
        ]);

      const state = JSON.parse(stateData);

      return {
        type: 'files',
        state: {
          ...state,
          iteration: parseInt(iteration.trim()),
          feedback: feedback.trim() || undefined,
          task: task.trim(),
          criteria: criteria.trim(),
        },
        timestamp: Date.now(),
        confidence: 0.95,
      };
    } catch (error: any) {
      logger.error('Failed to get file state', { error: error.message });
      return {
        type: 'files',
        state: {},
        timestamp: Date.now(),
        confidence: 0.1,
      };
    }
  }

  /**
   * Get state from memory (StackMemory)
   */
  async getMemoryState(loopId: string): Promise<StateSource> {
    try {
      // This would integrate with StackMemory's frame system
      // For now, returning a placeholder
      return {
        type: 'memory',
        state: {
          loopId,
          lastUpdateTime: Date.now(),
        },
        timestamp: Date.now(),
        confidence: 0.8,
      };
    } catch (error: any) {
      logger.error('Failed to get memory state', { error: error.message });
      return {
        type: 'memory',
        state: {},
        timestamp: Date.now(),
        confidence: 0.1,
      };
    }
  }

  /**
   * Sort sources by configured precedence
   */
  private sortByPrecedence(sources: StateSource[]): StateSource[] {
    return sources.sort((a, b) => {
      const aIndex = this.config.precedence.indexOf(a.type);
      const bIndex = this.config.precedence.indexOf(b.type);

      if (aIndex === -1 && bIndex === -1) {
        return b.confidence - a.confidence;
      }
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;

      return aIndex - bIndex;
    });
  }

  /**
   * Check if values match
   */
  private valuesMatch(values: any[]): boolean {
    if (values.length === 0) return true;
    const first = JSON.stringify(values[0]);
    return values.every((v) => JSON.stringify(v) === first);
  }

  /**
   * Assess conflict severity
   */
  private assessConflictSeverity(field: string): 'low' | 'medium' | 'high' {
    const highSeverityFields = ['loopId', 'task', 'criteria', 'status'];
    const mediumSeverityFields = ['iteration', 'currentCommit', 'feedback'];

    if (highSeverityFields.includes(field)) return 'high';
    if (mediumSeverityFields.includes(field)) return 'medium';
    return 'low';
  }

  /**
   * Suggest resolution based on field and sources
   */
  private suggestResolution(field: string, sources: StateSource[]): any {
    // Sort by confidence and precedence
    const sorted = this.sortByPrecedence(sources);
    const highestConfidence = sorted.reduce((max, s) =>
      s.confidence > max.confidence ? s : max
    );

    return highestConfidence.state[field as keyof RalphLoopState];
  }

  /**
   * Resolve conflicts based on configured strategy
   */
  private async resolveConflicts(conflicts: Conflict[]): Promise<Resolution[]> {
    const resolutions: Resolution[] = [];

    for (const conflict of conflicts) {
      const resolution = await this.resolveConflictByStrategy(conflict);
      resolutions.push(resolution);
    }

    return resolutions;
  }

  /**
   * Resolve conflict based on strategy
   */
  private async resolveConflictByStrategy(
    conflict: Conflict
  ): Promise<Resolution> {
    switch (this.config.conflictResolution) {
      case 'automatic':
        return this.automaticResolution(conflict);

      case 'manual':
        return this.manualResolution(conflict);

      case 'interactive':
        return this.interactiveResolution(conflict);

      default:
        return this.automaticResolution(conflict);
    }
  }

  /**
   * Automatic resolution based on precedence and confidence
   */
  private automaticResolution(conflict: Conflict): Resolution {
    const sorted = this.sortByPrecedence(conflict.sources);
    const winner = sorted[0];

    return {
      field: conflict.field,
      value: winner.state[conflict.field as keyof RalphLoopState],
      source: winner.type,
      rationale: `Automatic resolution: ${winner.type} has highest precedence (confidence: ${winner.confidence})`,
    };
  }

  /**
   * Manual resolution (uses suggested resolution)
   */
  private manualResolution(conflict: Conflict): Resolution {
    return {
      field: conflict.field,
      value: conflict.suggestedResolution,
      source: 'manual',
      rationale: 'Manual resolution: using suggested value',
    };
  }

  /**
   * Interactive resolution (would prompt user in real implementation)
   */
  private async interactiveResolution(conflict: Conflict): Promise<Resolution> {
    // In real implementation, this would prompt the user
    logger.info('Interactive resolution required', {
      field: conflict.field,
      options: conflict.sources.map((s) => ({
        type: s.type,
        value: s.state[conflict.field as keyof RalphLoopState],
        confidence: s.confidence,
      })),
    });

    // For now, fallback to automatic
    return this.automaticResolution(conflict);
  }

  /**
   * Apply resolutions to base state
   */
  private applyResolutions(
    baseState: RalphLoopState,
    resolutions: Resolution[]
  ): RalphLoopState {
    const resolvedState = { ...baseState };

    for (const resolution of resolutions) {
      (resolvedState as Record<string, unknown>)[resolution.field] =
        resolution.value;
    }

    return resolvedState;
  }

  /**
   * Merge states without conflicts
   */
  private mergeStates(sources: StateSource[]): RalphLoopState {
    const merged: any = {};

    // Apply in precedence order
    for (const source of sources) {
      Object.assign(merged, source.state);
    }

    return merged as RalphLoopState;
  }

  /**
   * Validate file system state
   */
  private async validateFileSystemState(
    state: RalphLoopState,
    errors: string[],
    warnings: string[]
  ): Promise<void> {
    try {
      const ralphDirExists = await fs
        .stat(this.ralphDir)
        .then(() => true)
        .catch(() => false);

      if (!ralphDirExists) {
        warnings.push('Ralph directory does not exist');
        return;
      }

      const requiredFiles = ['task.md', 'state.json', 'iteration.txt'];
      for (const file of requiredFiles) {
        const filePath = path.join(this.ralphDir, file);
        const exists = await fs
          .stat(filePath)
          .then(() => true)
          .catch(() => false);

        if (!exists) {
          warnings.push(`Missing file: ${file}`);
        }
      }
    } catch (error: any) {
      errors.push(`File system validation failed: ${error.message}`);
    }
  }

  /**
   * Validate git state
   */
  private validateGitState(
    state: RalphLoopState,
    errors: string[],
    warnings: string[]
  ): void {
    try {
      const isGitRepo =
        execSync('git rev-parse --is-inside-work-tree', {
          encoding: 'utf8',
        }).trim() === 'true';

      if (!isGitRepo) {
        warnings.push('Not in a git repository');
      }

      if (state.currentCommit && state.startCommit) {
        try {
          execSync(`git rev-parse ${state.currentCommit}`, {
            encoding: 'utf8',
          });
        } catch {
          errors.push(`Invalid current commit: ${state.currentCommit}`);
        }

        try {
          execSync(`git rev-parse ${state.startCommit}`, { encoding: 'utf8' });
        } catch {
          warnings.push(`Invalid start commit: ${state.startCommit}`);
        }
      }
    } catch (error: any) {
      warnings.push(`Git validation failed: ${error.message}`);
    }
  }

  /**
   * Validate logical consistency
   */
  private validateLogicalConsistency(
    state: RalphLoopState,
    errors: string[],
    warnings: string[]
  ): void {
    // Check iteration number
    if (state.iteration < 0) {
      errors.push('Invalid iteration number: cannot be negative');
    }

    // Check status consistency
    if (state.status === 'completed' && !state.completionData) {
      warnings.push('Status is completed but no completion data');
    }

    // Check time consistency
    if (
      state.lastUpdateTime &&
      state.startTime &&
      state.lastUpdateTime < state.startTime
    ) {
      errors.push('Last update time is before start time');
    }

    // Check task and criteria
    if (!state.task) {
      errors.push('No task defined');
    }

    if (!state.criteria) {
      warnings.push('No completion criteria defined');
    }
  }
}
