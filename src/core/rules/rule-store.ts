/**
 * SQLite-backed rule storage.
 */

import type Database from 'better-sqlite3';
import type { RuleRow, RuleTrigger } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL DEFAULT 'on-demand',
  severity TEXT NOT NULL DEFAULT 'warn',
  scope TEXT NOT NULL DEFAULT '**/*',
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export class RuleStore {
  constructor(private db: Database.Database) {
    this.db.exec(SCHEMA);
  }

  upsert(rule: Omit<RuleRow, 'created_at' | 'updated_at'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO rules (id, name, description, trigger_type, severity, scope, enabled, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           trigger_type = excluded.trigger_type,
           severity = excluded.severity,
           scope = excluded.scope,
           enabled = excluded.enabled,
           builtin = excluded.builtin,
           updated_at = excluded.updated_at`
      )
      .run(
        rule.id,
        rule.name,
        rule.description,
        rule.trigger_type,
        rule.severity,
        rule.scope,
        rule.enabled,
        rule.builtin,
        now,
        now
      );
  }

  getAll(): RuleRow[] {
    return this.db
      .prepare('SELECT * FROM rules ORDER BY id')
      .all() as RuleRow[];
  }

  getEnabled(): RuleRow[] {
    return this.db
      .prepare('SELECT * FROM rules WHERE enabled = 1 ORDER BY id')
      .all() as RuleRow[];
  }

  getByTrigger(trigger: RuleTrigger): RuleRow[] {
    return this.db
      .prepare(
        'SELECT * FROM rules WHERE enabled = 1 AND trigger_type = ? ORDER BY id'
      )
      .all(trigger) as RuleRow[];
  }

  getById(id: string): RuleRow | undefined {
    return this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as
      | RuleRow
      | undefined;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const result = this.db
      .prepare('UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  seedBuiltins(rules: Array<Omit<RuleRow, 'created_at' | 'updated_at'>>): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO rules (id, name, description, trigger_type, severity, scope, enabled, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      for (const rule of rules) {
        stmt.run(
          rule.id,
          rule.name,
          rule.description,
          rule.trigger_type,
          rule.severity,
          rule.scope,
          rule.enabled,
          rule.builtin,
          now,
          now
        );
      }
    });
    tx();
  }
}
