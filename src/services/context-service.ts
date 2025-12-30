import { Task } from '../types/task.js';
// TaskStatus and TaskPriority will be used in future implementations
// import { TaskStatus, TaskPriority } from '../types/task.js';
import { Logger } from '../utils/logger.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

export class ContextService {
  private logger: Logger;
  private db: Database.Database | null = null;
  private tasks: Map<string, Task> = new Map();

  constructor() {
    this.logger = new Logger('ContextService');
    this.initializeDatabase();
  }

  private initializeDatabase(): void {
    try {
      const dbPath = join(process.cwd(), '.stackmemory', 'context.db');
      if (existsSync(dbPath)) {
        this.db = new Database(dbPath);
        this.loadTasksFromDatabase();
      }
    } catch (error) {
      this.logger.warn(
        'Could not connect to database, using in-memory storage',
        error
      );
    }
  }

  private loadTasksFromDatabase(): void {
    if (!this.db) return;

    try {
      // Create tasks table if it doesn't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'todo',
          priority TEXT,
          tags TEXT,
          external_id TEXT,
          external_identifier TEXT,
          external_url TEXT,
          metadata TEXT,
          created_at INTEGER,
          updated_at INTEGER
        )
      `);

      // Load all tasks from database
      const stmt = this.db.prepare('SELECT * FROM tasks');
      const rows = stmt.all() as any[];

      for (const row of rows) {
        const task: Task = {
          id: row.id,
          title: row.title,
          description: row.description || '',
          status: row.status || 'todo',
          priority: row.priority || undefined,
          tags: row.tags ? JSON.parse(row.tags) : [],
          externalId: row.external_id || undefined,
          externalIdentifier: row.external_identifier || undefined,
          externalUrl: row.external_url || undefined,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };
        this.tasks.set(task.id, task);
      }

      this.logger.info(`Loaded ${rows.length} tasks from database`);
    } catch (error) {
      this.logger.error('Failed to load tasks from database', error);
    }
  }

  public async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) || null;
  }

  public async getTaskByExternalId(externalId: string): Promise<Task | null> {
    for (const task of this.tasks.values()) {
      if (task.externalId === externalId) {
        return task;
      }
    }
    return null;
  }

  public async getAllTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  public async createTask(taskData: Partial<Task>): Promise<Task> {
    const task: Task = {
      id: this.generateId(),
      title: taskData.title || 'Untitled Task',
      description: taskData.description || '',
      status: taskData.status || 'todo',
      priority: taskData.priority,
      tags: taskData.tags || [],
      externalId: taskData.externalId,
      externalIdentifier: taskData.externalIdentifier,
      externalUrl: taskData.externalUrl,
      metadata: taskData.metadata,
      createdAt: taskData.createdAt || new Date(),
      updatedAt: taskData.updatedAt || new Date(),
    };

    this.tasks.set(task.id, task);

    // Persist to database if available
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO tasks (id, title, description, status, priority, tags, 
                           external_id, external_identifier, external_url, 
                           metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          task.id,
          task.title,
          task.description,
          task.status,
          task.priority || null,
          JSON.stringify(task.tags),
          task.externalId || null,
          task.externalIdentifier || null,
          task.externalUrl || null,
          task.metadata ? JSON.stringify(task.metadata) : null,
          task.createdAt.getTime(),
          task.updatedAt.getTime()
        );
      } catch (error) {
        this.logger.error('Failed to persist task to database', error);
      }
    }

    this.logger.debug(`Created task: ${task.id} - ${task.title}`);
    return task;
  }

  public async updateTask(
    id: string,
    updates: Partial<Task>
  ): Promise<Task | null> {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }

    const updatedTask = {
      ...task,
      ...updates,
      updatedAt: new Date(),
    };

    this.tasks.set(id, updatedTask);

    // Update in database if available
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          UPDATE tasks SET title = ?, description = ?, status = ?, 
                          priority = ?, tags = ?, external_id = ?, 
                          external_identifier = ?, external_url = ?, 
                          metadata = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(
          updatedTask.title,
          updatedTask.description,
          updatedTask.status,
          updatedTask.priority || null,
          JSON.stringify(updatedTask.tags),
          updatedTask.externalId || null,
          updatedTask.externalIdentifier || null,
          updatedTask.externalUrl || null,
          updatedTask.metadata ? JSON.stringify(updatedTask.metadata) : null,
          updatedTask.updatedAt.getTime(),
          id
        );
      } catch (error) {
        this.logger.error('Failed to update task in database', error);
      }
    }

    this.logger.debug(`Updated task: ${id} - ${updatedTask.title}`);
    return updatedTask;
  }

  public async deleteTask(id: string): Promise<boolean> {
    const deleted = this.tasks.delete(id);

    if (deleted) {
      // Delete from database if available
      if (this.db) {
        try {
          const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
          stmt.run(id);
        } catch (error) {
          this.logger.error('Failed to delete task from database', error);
        }
      }
      this.logger.debug(`Deleted task: ${id}`);
    }
    return deleted;
  }

  private generateId(): string {
    return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
}
