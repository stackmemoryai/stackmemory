/**
 * Provenant decision graph MCP tool handlers
 * Thin layer that talks directly to the Provenant SQLite database.
 * No dependency on the Provenant package — uses better-sqlite3 directly.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { logger } from '../../../core/monitoring/logger.js';

export interface ProvenantHandlerDependencies {
  projectDir: string;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
    embedding BLOB, actor TEXT, confidence REAL NOT NULL DEFAULT 0.0,
    version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY, from_node TEXT NOT NULL, to_node TEXT NOT NULL,
    rel_type TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
    version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, system TEXT NOT NULL, external_id TEXT NOT NULL,
    raw_payload TEXT NOT NULL, hash TEXT NOT NULL, fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_edges (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, source_id TEXT NOT NULL,
    system TEXT NOT NULL, external_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contradictions (
    id TEXT PRIMARY KEY, node_a TEXT NOT NULL, node_b TEXT NOT NULL,
    conflict_score REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    resolved_by TEXT, resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS stale_flags (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, triggered_by_source TEXT NOT NULL,
    flagged_at INTEGER NOT NULL, resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS rejection_log (
    id TEXT PRIMARY KEY, suggestion_node TEXT NOT NULL, override_node TEXT,
    reasoning TEXT, reasoning_resolved INTEGER NOT NULL DEFAULT 0,
    actor TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_queue (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, candidate_content TEXT NOT NULL,
    confidence REAL NOT NULL, queue_reason TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, resolved_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_contradictions_status ON contradictions(status);
  INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, unixepoch() * 1000);
`;

export class ProvenantHandlers {
  private dbPath: string;

  constructor(private deps: ProvenantHandlerDependencies) {
    this.dbPath = join(deps.projectDir, '.provenant', 'graph.db');
  }

  private openDb(): BetterSqlite3.Database {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new BetterSqlite3(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Auto-create schema if needed
    try {
      db.prepare('SELECT 1 FROM schema_version').get();
    } catch {
      db.exec(SCHEMA_SQL);
    }
    return db;
  }

  async handleSearch(args: any): Promise<any> {
    try {
      const { query, actor, since, limit = 10 } = args;
      if (!query) throw new Error('query is required');

      const db = this.openDb();
      try {
        const stopwords = new Set([
          'the',
          'a',
          'an',
          'is',
          'was',
          'were',
          'are',
          'we',
          'our',
          'this',
          'that',
          'it',
          'to',
          'of',
          'in',
          'for',
          'on',
          'with',
          'did',
          'do',
          'not',
          'why',
          'how',
          'what',
          'when',
          'and',
          'or',
          'but',
        ]);
        const keywords = (query as string)
          .toLowerCase()
          .replace(/[^\w\s]/g, '')
          .split(/\s+/)
          .filter((w: string) => w.length > 2 && !stopwords.has(w));

        let sql: string;
        const params: unknown[] = [];

        if (keywords.length === 0) {
          sql = 'SELECT * FROM nodes ORDER BY created_at DESC LIMIT ?';
          params.push(limit);
        } else {
          const scoreParts = keywords.map(
            () => '(CASE WHEN LOWER(content) LIKE ? THEN 1 ELSE 0 END)'
          );
          // Params for SELECT
          for (const kw of keywords) params.push(`%${kw}%`);
          sql = `SELECT *, (${scoreParts.join(' + ')}) as match_score FROM nodes WHERE (${scoreParts.join(' + ')}) > 0`;
          // Params for WHERE
          for (const kw of keywords) params.push(`%${kw}%`);
          if (actor) {
            sql += ' AND actor = ?';
            params.push(actor);
          }
          if (since) {
            sql += ' AND created_at >= ?';
            params.push(new Date(since as string).getTime());
          }
          sql += ' ORDER BY match_score DESC, created_at DESC LIMIT ?';
          params.push(limit);
        }

        const nodes = db.prepare(sql).all(...params) as any[];

        const results = nodes.map((n) => ({
          id: n.id.slice(0, 8),
          type: n.type,
          content: n.content.slice(0, 200),
          actor: n.actor,
          confidence: n.confidence,
          created: new Date(n.created_at).toISOString(),
        }));

        logger.info('Provenant search', { query, resultCount: results.length });

        return {
          content: [
            {
              type: 'text',
              text:
                results.length === 0
                  ? `No decisions found for: "${query}"`
                  : results
                      .map(
                        (r) =>
                          `[${r.id}] (${r.confidence.toFixed(2)}) ${r.content}${r.actor ? ` — ${r.actor}` : ''}`
                      )
                      .join('\n\n'),
            },
          ],
          metadata: { query, results },
        };
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      logger.error(
        'Provenant search error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async handleLog(args: any): Promise<any> {
    try {
      const { content, actor, reasoning } = args;
      if (!content) throw new Error('content is required');

      const db = this.openDb();
      try {
        const now = Date.now();
        const hash = createHash('sha256')
          .update(content as string)
          .digest('hex');
        const externalId = `manual-${now}`;

        // Base confidence for manual entries: 0.6 (human-authored) + 0.15 (reasoning) + 0.1 (actor)
        let confidence = 0.6;
        if (reasoning) confidence += 0.15;
        if (actor) confidence += 0.1;

        const sourceId = randomUUID();
        db.prepare(
          'INSERT INTO sources (id, system, external_id, raw_payload, hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(
          sourceId,
          'manual',
          externalId,
          JSON.stringify({ content, actor, reasoning }),
          hash,
          now
        );

        const nodeId = randomUUID();
        db.prepare(
          'INSERT INTO nodes (id, type, content, embedding, actor, confidence, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          nodeId,
          'decision',
          content,
          null,
          actor ?? null,
          confidence,
          1,
          now,
          now
        );

        db.prepare(
          'INSERT INTO source_edges (id, node_id, source_id, system, external_id) VALUES (?, ?, ?, ?, ?)'
        ).run(randomUUID(), nodeId, sourceId, 'manual', externalId);

        logger.info('Provenant decision logged', { nodeId, confidence });

        return {
          content: [
            {
              type: 'text',
              text: `Logged decision: ${nodeId.slice(0, 8)} (confidence: ${confidence.toFixed(2)})`,
            },
          ],
          metadata: { nodeId, confidence },
        };
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      logger.error(
        'Provenant log error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async handleStatus(_args: any): Promise<any> {
    try {
      if (!existsSync(this.dbPath)) {
        return {
          content: [
            {
              type: 'text',
              text: 'No Provenant database found. Use provenant_log to create one.',
            },
          ],
        };
      }

      const db = this.openDb();
      try {
        const count = (sql: string) =>
          (db.prepare(sql).get() as { c: number }).c;
        const s = {
          nodeCount: count('SELECT COUNT(*) as c FROM nodes'),
          edgeCount: count('SELECT COUNT(*) as c FROM edges'),
          pendingQueue: count(
            'SELECT COUNT(*) as c FROM review_queue WHERE resolved_at IS NULL'
          ),
          unresolvedContradictions: count(
            "SELECT COUNT(*) as c FROM contradictions WHERE status = 'pending'"
          ),
          unresolvedStaleFlags: count(
            'SELECT COUNT(*) as c FROM stale_flags WHERE resolved_at IS NULL'
          ),
          unresolvedRejections: count(
            'SELECT COUNT(*) as c FROM rejection_log WHERE reasoning_resolved = 0'
          ),
        };

        return {
          content: [
            {
              type: 'text',
              text: `Nodes: ${s.nodeCount}\nEdges: ${s.edgeCount}\nReview queue: ${s.pendingQueue}\nContradictions: ${s.unresolvedContradictions}\nStale flags: ${s.unresolvedStaleFlags}\nRejections needing reasoning: ${s.unresolvedRejections}`,
            },
          ],
          metadata: s,
        };
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      logger.error(
        'Provenant status error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async handleContradictions(_args: any): Promise<any> {
    try {
      if (!existsSync(this.dbPath)) {
        return { content: [{ type: 'text', text: 'No Provenant database.' }] };
      }

      const db = this.openDb();
      try {
        const contras = db
          .prepare("SELECT * FROM contradictions WHERE status = 'pending'")
          .all() as any[];
        if (contras.length === 0) {
          return {
            content: [{ type: 'text', text: 'No open contradictions.' }],
          };
        }

        const lines = contras.map((c) => {
          const a = db
            .prepare('SELECT content FROM nodes WHERE id = ?')
            .get(c.node_a) as any;
          const b = db
            .prepare('SELECT content FROM nodes WHERE id = ?')
            .get(c.node_b) as any;
          return `${c.node_a.slice(0, 8)} ↔ ${c.node_b.slice(0, 8)} (score: ${c.conflict_score.toFixed(2)})\n  A: ${a?.content?.slice(0, 100) ?? '?'}\n  B: ${b?.content?.slice(0, 100) ?? '?'}`;
        });

        return {
          content: [
            {
              type: 'text',
              text: `${contras.length} open contradictions:\n\n${lines.join('\n\n')}`,
            },
          ],
          metadata: { count: contras.length },
        };
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      logger.error(
        'Provenant contradictions error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async handleResolve(args: any): Promise<any> {
    try {
      const { node_a, node_b, winner, dismiss } = args;
      if (!node_a || !node_b) throw new Error('node_a and node_b are required');
      if (!winner && !dismiss) throw new Error('Specify winner or dismiss');

      const db = this.openDb();
      try {
        const contras = db
          .prepare("SELECT * FROM contradictions WHERE status = 'pending'")
          .all() as any[];
        const contradiction = contras.find(
          (c: any) =>
            (c.node_a.startsWith(node_a) && c.node_b.startsWith(node_b)) ||
            (c.node_a.startsWith(node_b) && c.node_b.startsWith(node_a))
        );

        if (!contradiction) {
          throw new Error(
            `No pending contradiction between ${node_a} and ${node_b}`
          );
        }

        if (dismiss) {
          db.prepare(
            'UPDATE contradictions SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?'
          ).run('dismissed', 'human', Date.now(), contradiction.id);
          return {
            content: [
              {
                type: 'text',
                text: `Dismissed contradiction ${contradiction.id.slice(0, 8)}`,
              },
            ],
          };
        }

        const winnerNode = [contradiction.node_a, contradiction.node_b].find(
          (id: string) => id.startsWith(winner)
        );
        if (!winnerNode) {
          throw new Error(
            `Winner must match one of: ${contradiction.node_a.slice(0, 8)}, ${contradiction.node_b.slice(0, 8)}`
          );
        }

        const loserNode =
          winnerNode === contradiction.node_a
            ? contradiction.node_b
            : contradiction.node_a;

        db.prepare(
          'UPDATE contradictions SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?'
        ).run('resolved', winnerNode, Date.now(), contradiction.id);

        db.prepare(
          'INSERT INTO edges (id, from_node, to_node, rel_type, confidence, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          randomUUID(),
          winnerNode,
          loserNode,
          'supersedes',
          1.0,
          1,
          Date.now()
        );

        return {
          content: [
            {
              type: 'text',
              text: `Resolved: ${winnerNode.slice(0, 8)} supersedes ${loserNode.slice(0, 8)}`,
            },
          ],
          metadata: { winner: winnerNode, loser: loserNode },
        };
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      logger.error(
        'Provenant resolve error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }
}
