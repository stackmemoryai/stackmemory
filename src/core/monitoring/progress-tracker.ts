/**
 * Progress Tracker for StackMemory
 * Maintains a JSON file with recent changes and progress
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface TaskProgress {
  task: string;
  completedAt?: string;
  startedAt?: string;
  status: 'completed' | 'in_progress' | 'pending';
  changes?: string[];
}

export interface Change {
  date: string;
  version: string;
  type: 'feature' | 'bugfix' | 'refactor' | 'docs';
  description: string;
  files?: string[];
}

export interface ProgressData {
  version: string;
  lastUpdated: string;
  currentSession?: {
    startTime: string;
    tasksCompleted: TaskProgress[];
    inProgress: string[];
  };
  recentChanges: Change[];
  linearIntegration?: {
    status: string;
    lastSync?: string;
    tasksSynced?: number;
    issues?: string[];
  };
  roadmap?: {
    immediate: string[];
    thisWeek: string[];
    nextSprint: string[];
  };
  metrics?: Record<string, any>;
  notes?: string[];
}

export class ProgressTracker {
  private progressFile: string;
  private data: ProgressData;

  constructor(projectRoot: string) {
    this.progressFile = join(projectRoot, '.stackmemory', 'progress.json');
    this.data = this.load();
  }

  /**
   * Load progress data from file
   */
  private load(): ProgressData {
    if (existsSync(this.progressFile)) {
      try {
        const content = readFileSync(this.progressFile, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Start with empty data if file is corrupted
      }
    }

    // Default structure
    return {
      version: process.env.npm_package_version || '0.2.3',
      lastUpdated: new Date().toISOString(),
      recentChanges: [],
    };
  }

  /**
   * Save progress data to file
   */
  private save(): void {
    this.data.lastUpdated = new Date().toISOString();
    writeFileSync(this.progressFile, JSON.stringify(this.data, null, 2));
  }

  /**
   * Start a new session
   */
  startSession(): void {
    this.data.currentSession = {
      startTime: new Date().toISOString(),
      tasksCompleted: [],
      inProgress: [],
    };
    this.save();
  }

  /**
   * Add a task as in progress
   */
  startTask(task: string): void {
    if (!this.data.currentSession) {
      this.startSession();
    }

    if (this.data.currentSession!.inProgress.indexOf(task) === -1) {
      this.data.currentSession!.inProgress.push(task);
    }
    this.save();
  }

  /**
   * Mark a task as completed
   */
  completeTask(task: string, changes?: string[]): void {
    if (!this.data.currentSession) {
      this.startSession();
    }

    // Remove from in progress
    const index = this.data.currentSession!.inProgress.indexOf(task);
    if (index > -1) {
      this.data.currentSession!.inProgress.splice(index, 1);
    }

    // Add to completed
    this.data.currentSession!.tasksCompleted.push({
      task,
      completedAt: new Date().toISOString(),
      status: 'completed',
      changes,
    });

    this.save();
  }

  /**
   * Add a recent change
   */
  addChange(change: Change): void {
    // Keep only last 20 changes
    this.data.recentChanges.unshift(change);
    if (this.data.recentChanges.length > 20) {
      this.data.recentChanges = this.data.recentChanges.slice(0, 20);
    }
    this.save();
  }

  /**
   * Update Linear integration status
   */
  updateLinearStatus(status: {
    lastSync?: string;
    tasksSynced?: number;
    issues?: string[];
  }): void {
    if (!this.data.linearIntegration) {
      this.data.linearIntegration = {
        status: 'active',
      };
    }

    Object.assign(this.data.linearIntegration, status);
    this.save();
  }

  /**
   * Add a note
   */
  addNote(note: string): void {
    if (!this.data.notes) {
      this.data.notes = [];
    }

    // Add to beginning and keep last 10
    this.data.notes.unshift(note);
    if (this.data.notes.length > 10) {
      this.data.notes = this.data.notes.slice(0, 10);
    }
    this.save();
  }

  /**
   * Get current progress
   */
  getProgress(): ProgressData {
    return this.data;
  }

  /**
   * Get summary for display
   */
  getSummary(): string {
    const lines: string[] = [];

    lines.push(`📊 StackMemory Progress (v${this.data.version})`);
    lines.push(`Last updated: ${this.data.lastUpdated}`);

    if (this.data.currentSession) {
      lines.push('\n📍 Current Session:');
      lines.push(`   Started: ${this.data.currentSession.startTime}`);
      lines.push(
        `   Completed: ${this.data.currentSession.tasksCompleted.length} tasks`
      );

      if (this.data.currentSession.inProgress.length > 0) {
        lines.push(`   In Progress:`);
        this.data.currentSession.inProgress.forEach((task) => {
          lines.push(`     - ${task}`);
        });
      }
    }

    if (this.data.recentChanges.length > 0) {
      lines.push('\n🔄 Recent Changes:');
      this.data.recentChanges.slice(0, 5).forEach((change) => {
        lines.push(`   [${change.date}] ${change.type}: ${change.description}`);
      });
    }

    if (this.data.linearIntegration) {
      lines.push('\n🔗 Linear Integration:');
      lines.push(`   Status: ${this.data.linearIntegration.status}`);
      if (this.data.linearIntegration.lastSync) {
        lines.push(`   Last sync: ${this.data.linearIntegration.lastSync}`);
      }
      if (this.data.linearIntegration.tasksSynced) {
        lines.push(
          `   Tasks synced: ${this.data.linearIntegration.tasksSynced}`
        );
      }
    }

    if (this.data.notes && this.data.notes.length > 0) {
      lines.push('\n📝 Recent Notes:');
      this.data.notes.slice(0, 3).forEach((note) => {
        lines.push(`   • ${note}`);
      });
    }

    return lines.join('\n');
  }

  /**
   * Clear current session
   */
  endSession(): void {
    delete this.data.currentSession;
    this.save();
  }
}
