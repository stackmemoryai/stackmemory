/**
 * Tests for Database Operations Trace Wrapper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTracedDatabase,
  wrapDatabase,
  getQueryStatistics,
} from '../db-trace-wrapper.js';

describe('db-trace-wrapper', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Ensure tracing is disabled so trace.traceSync is effectively pass-through
    delete process.env['DEBUG_TRACE'];
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT, value REAL)'
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('createTracedDatabase', () => {
    it('should create a database with tracing enabled by default', () => {
      const traced = createTracedDatabase(':memory:');
      expect(traced).toBeDefined();
      const stats = getQueryStatistics(traced);
      expect(stats).not.toBeNull();
      traced.close();
    });

    it('should create a database without tracing when disabled', () => {
      const untraced = createTracedDatabase(':memory:', {
        traceEnabled: false,
      });
      expect(untraced).toBeDefined();
      const stats = getQueryStatistics(untraced);
      expect(stats).toBeNull(); // No stats tracking
      untraced.close();
    });

    it('should accept slowQueryThreshold option', () => {
      const traced = createTracedDatabase(':memory:', {
        slowQueryThreshold: 50,
      });
      expect(traced).toBeDefined();
      traced.close();
    });
  });

  describe('wrapDatabase', () => {
    it('should wrap an existing database', () => {
      const wrapped = wrapDatabase(db);
      expect(wrapped).toBe(db); // Same instance, modified in-place
      expect(getQueryStatistics(wrapped)).not.toBeNull();
    });

    it('should initialize query stats to zero', () => {
      wrapDatabase(db);
      const stats = getQueryStatistics(db);
      expect(stats!.totalQueries).toBe(0);
      expect(stats!.slowQueries).toBe(0);
      expect(stats!.totalDuration).toBe(0);
      expect(stats!.averageDuration).toBe(0);
    });

    it('should wrap prepare method and track queries', () => {
      wrapDatabase(db);

      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'item1',
        1.0
      );
      db.prepare('SELECT * FROM test_items').all();

      const stats = getQueryStatistics(db);
      expect(stats!.totalQueries).toBe(2);
      expect(stats!.queryTypes['INSERT']).toBe(1);
      expect(stats!.queryTypes['SELECT']).toBe(1);
    });

    it('should track get method calls', () => {
      wrapDatabase(db);

      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'item1',
        1.0
      );
      const row = db
        .prepare('SELECT * FROM test_items WHERE id = ?')
        .get(1) as any;

      expect(row).toBeDefined();
      expect(row.name).toBe('item1');

      const stats = getQueryStatistics(db);
      expect(stats!.totalQueries).toBe(2); // INSERT + SELECT
    });

    it('should track all method calls', () => {
      wrapDatabase(db);

      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'a',
        1
      );
      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'b',
        2
      );
      const rows = db.prepare('SELECT * FROM test_items').all() as any[];

      expect(rows).toHaveLength(2);
      const stats = getQueryStatistics(db);
      expect(stats!.totalQueries).toBe(3);
    });

    it('should track run method calls and return RunResult', () => {
      wrapDatabase(db);

      const result = db
        .prepare('INSERT INTO test_items (name, value) VALUES (?, ?)')
        .run('test', 42);

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeDefined();
    });

    it('should wrap iterate method', () => {
      wrapDatabase(db);

      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'a',
        1
      );
      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'b',
        2
      );

      const items: any[] = [];
      for (const row of db.prepare('SELECT * FROM test_items').iterate()) {
        items.push(row);
      }

      expect(items).toHaveLength(2);
    });

    it('should wrap exec method', () => {
      wrapDatabase(db);

      // exec should work for DDL
      db.exec('CREATE TABLE IF NOT EXISTS another (id INTEGER PRIMARY KEY)');

      // Should not throw
      db.exec('INSERT INTO another (id) VALUES (1)');
    });

    it('should wrap transaction method', () => {
      wrapDatabase(db);

      const insert = db.prepare(
        'INSERT INTO test_items (name, value) VALUES (?, ?)'
      );
      const insertMany = db.transaction(
        (items: { name: string; value: number }[]) => {
          for (const item of items) {
            insert.run(item.name, item.value);
          }
        }
      );

      insertMany([
        { name: 'x', value: 1 },
        { name: 'y', value: 2 },
        { name: 'z', value: 3 },
      ]);

      const count = db
        .prepare('SELECT COUNT(*) as cnt FROM test_items')
        .get() as any;
      expect(count.cnt).toBe(3);
    });

    it('should calculate average duration', () => {
      wrapDatabase(db);

      for (let i = 0; i < 10; i++) {
        db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
          `item${i}`,
          i
        );
      }

      const stats = getQueryStatistics(db);
      expect(stats!.totalQueries).toBe(10);
      expect(stats!.averageDuration).toBe(stats!.totalDuration / 10);
    });
  });

  describe('getQueryStatistics', () => {
    it('should return null for unwrapped database', () => {
      expect(getQueryStatistics(db)).toBeNull();
    });

    it('should return stats object for wrapped database', () => {
      wrapDatabase(db);
      const stats = getQueryStatistics(db);
      expect(stats).toEqual({
        totalQueries: 0,
        slowQueries: 0,
        totalDuration: 0,
        averageDuration: 0,
        queryTypes: {},
      });
    });
  });

  describe('edge cases', () => {
    it('should handle queries that return no rows', () => {
      wrapDatabase(db);
      const result = db
        .prepare('SELECT * FROM test_items WHERE id = ?')
        .get(999);
      expect(result).toBeUndefined();
    });

    it('should handle empty all() results', () => {
      wrapDatabase(db);
      const rows = db.prepare('SELECT * FROM test_items').all();
      expect(rows).toEqual([]);
    });

    it('should handle queries with multiple parameters', () => {
      wrapDatabase(db);

      db.prepare('INSERT INTO test_items (name, value) VALUES (?, ?)').run(
        'test',
        42
      );
      const row = db
        .prepare('SELECT * FROM test_items WHERE name = ? AND value = ?')
        .get('test', 42) as any;

      expect(row).toBeDefined();
      expect(row.name).toBe('test');
    });
  });
});
