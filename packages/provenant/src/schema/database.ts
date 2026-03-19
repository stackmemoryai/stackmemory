import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  Node,
  Edge,
  Source,
  SourceEdge,
  RejectionLogEntry,
  ReviewQueueItem,
  Contradiction,
  StaleFlag,
  DependencyIndexEntry,
} from './types.js';

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      actor TEXT,
      confidence REAL NOT NULL DEFAULT 0.0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      from_node TEXT NOT NULL REFERENCES nodes(id),
      to_node TEXT NOT NULL REFERENCES nodes(id),
      rel_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      external_id TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      hash TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_edges (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id),
      source_id TEXT NOT NULL REFERENCES sources(id),
      system TEXT NOT NULL,
      external_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejection_log (
      id TEXT PRIMARY KEY,
      suggestion_node TEXT NOT NULL REFERENCES nodes(id),
      override_node TEXT REFERENCES nodes(id),
      reasoning TEXT,
      reasoning_resolved INTEGER NOT NULL DEFAULT 0,
      actor TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      candidate_content TEXT NOT NULL,
      confidence REAL NOT NULL,
      queue_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS contradictions (
      id TEXT PRIMARY KEY,
      node_a TEXT NOT NULL REFERENCES nodes(id),
      node_b TEXT NOT NULL REFERENCES nodes(id),
      conflict_score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by TEXT,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS stale_flags (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id),
      triggered_by_source TEXT NOT NULL,
      flagged_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS dependency_index (
      id TEXT PRIMARY KEY,
      ancestor_node TEXT NOT NULL REFERENCES nodes(id),
      descendant_node TEXT NOT NULL REFERENCES nodes(id),
      path_length INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_actor ON nodes(actor);
    CREATE INDEX IF NOT EXISTS idx_nodes_confidence ON nodes(confidence);
    CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel_type);

    CREATE INDEX IF NOT EXISTS idx_sources_system ON sources(system, external_id);
    CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(hash);

    CREATE INDEX IF NOT EXISTS idx_source_edges_node ON source_edges(node_id);
    CREATE INDEX IF NOT EXISTS idx_source_edges_source ON source_edges(source_id);

    CREATE INDEX IF NOT EXISTS idx_rejection_suggestion ON rejection_log(suggestion_node);
    CREATE INDEX IF NOT EXISTS idx_rejection_unresolved ON rejection_log(reasoning_resolved) WHERE reasoning_resolved = 0;

    CREATE INDEX IF NOT EXISTS idx_review_queue_pending ON review_queue(resolved_at) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_review_queue_expires ON review_queue(expires_at);

    CREATE INDEX IF NOT EXISTS idx_contradictions_status ON contradictions(status);
    CREATE INDEX IF NOT EXISTS idx_contradictions_nodes ON contradictions(node_a, node_b);

    CREATE INDEX IF NOT EXISTS idx_stale_unresolved ON stale_flags(resolved_at) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_stale_node ON stale_flags(node_id);

    CREATE INDEX IF NOT EXISTS idx_dep_ancestor ON dependency_index(ancestor_node);
    CREATE INDEX IF NOT EXISTS idx_dep_descendant ON dependency_index(descendant_node);

    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    INSERT INTO schema_version (version, applied_at) VALUES (1, unixepoch() * 1000);
  `,
};

export class Database {
  readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const currentVersion = this.getCurrentVersion();
    for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (migration) {
        this.db.exec(migration);
      }
    }
  }

  private getCurrentVersion(): number {
    try {
      const row = this.db
        .prepare('SELECT MAX(version) as version FROM schema_version')
        .get() as { version: number | null } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  // --- Nodes ---

  insertNode(
    params: Omit<Node, 'id' | 'version' | 'created_at' | 'updated_at'> & {
      id?: string;
    }
  ): Node {
    const now = Date.now();
    const node: Node = {
      id: params.id ?? randomUUID(),
      type: params.type,
      content: params.content,
      embedding: params.embedding ?? null,
      actor: params.actor ?? null,
      confidence: params.confidence,
      version: 1,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO nodes (id, type, content, embedding, actor, confidence, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.id,
        node.type,
        node.content,
        node.embedding,
        node.actor,
        node.confidence,
        node.version,
        node.created_at,
        node.updated_at
      );
    return node;
  }

  getNode(id: string): Node | undefined {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | Node
      | undefined;
  }

  // --- Edges ---

  insertEdge(
    params: Omit<Edge, 'id' | 'version' | 'created_at'> & { id?: string }
  ): Edge {
    const edge: Edge = {
      id: params.id ?? randomUUID(),
      from_node: params.from_node,
      to_node: params.to_node,
      rel_type: params.rel_type,
      confidence: params.confidence,
      version: 1,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO edges (id, from_node, to_node, rel_type, confidence, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        edge.id,
        edge.from_node,
        edge.to_node,
        edge.rel_type,
        edge.confidence,
        edge.version,
        edge.created_at
      );
    return edge;
  }

  getEdgesFrom(nodeId: string): Edge[] {
    return this.db
      .prepare('SELECT * FROM edges WHERE from_node = ?')
      .all(nodeId) as Edge[];
  }

  getEdgesTo(nodeId: string): Edge[] {
    return this.db
      .prepare('SELECT * FROM edges WHERE to_node = ?')
      .all(nodeId) as Edge[];
  }

  // --- Sources ---

  insertSource(
    params: Omit<Source, 'id' | 'fetched_at'> & { id?: string }
  ): Source {
    const source: Source = {
      id: params.id ?? randomUUID(),
      system: params.system,
      external_id: params.external_id,
      raw_payload: params.raw_payload,
      hash: params.hash,
      fetched_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO sources (id, system, external_id, raw_payload, hash, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        source.id,
        source.system,
        source.external_id,
        source.raw_payload,
        source.hash,
        source.fetched_at
      );
    return source;
  }

  getSourceByHash(hash: string): Source | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE hash = ?').get(hash) as
      | Source
      | undefined;
  }

  getSourceByExternalId(
    system: string,
    externalId: string
  ): Source | undefined {
    return this.db
      .prepare('SELECT * FROM sources WHERE system = ? AND external_id = ?')
      .get(system, externalId) as Source | undefined;
  }

  // --- Source Edges ---

  linkNodeToSource(
    nodeId: string,
    sourceId: string,
    system: string,
    externalId: string
  ): SourceEdge {
    const se: SourceEdge = {
      id: randomUUID(),
      node_id: nodeId,
      source_id: sourceId,
      system,
      external_id: externalId,
    };
    this.db
      .prepare(
        `INSERT INTO source_edges (id, node_id, source_id, system, external_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(se.id, se.node_id, se.source_id, se.system, se.external_id);
    return se;
  }

  getSourcesForNode(nodeId: string): Source[] {
    return this.db
      .prepare(
        `SELECT s.* FROM sources s
         JOIN source_edges se ON se.source_id = s.id
         WHERE se.node_id = ?`
      )
      .all(nodeId) as Source[];
  }

  // --- Rejection Log ---

  insertRejection(params: {
    suggestion_node: string;
    override_node?: string;
    reasoning?: string;
    actor?: string;
  }): RejectionLogEntry {
    const entry: RejectionLogEntry = {
      id: randomUUID(),
      suggestion_node: params.suggestion_node,
      override_node: params.override_node ?? null,
      reasoning: params.reasoning ?? null,
      reasoning_resolved: params.reasoning != null,
      actor: params.actor ?? null,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO rejection_log (id, suggestion_node, override_node, reasoning, reasoning_resolved, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.suggestion_node,
        entry.override_node,
        entry.reasoning,
        entry.reasoning_resolved ? 1 : 0,
        entry.actor,
        entry.created_at
      );
    return entry;
  }

  getUnresolvedRejections(): RejectionLogEntry[] {
    return this.db
      .prepare('SELECT * FROM rejection_log WHERE reasoning_resolved = 0')
      .all() as RejectionLogEntry[];
  }

  resolveRejectionReasoning(id: string, reasoning: string): void {
    this.db
      .prepare(
        'UPDATE rejection_log SET reasoning = ?, reasoning_resolved = 1 WHERE id = ?'
      )
      .run(reasoning, id);
  }

  // --- Review Queue ---

  enqueue(params: {
    source_id: string;
    candidate_content: string;
    confidence: number;
    queue_reason: string;
    ttl_days?: number;
  }): ReviewQueueItem {
    const now = Date.now();
    const ttl = (params.ttl_days ?? 14) * 86_400_000;
    const item: ReviewQueueItem = {
      id: randomUUID(),
      source_id: params.source_id,
      candidate_content: params.candidate_content,
      confidence: params.confidence,
      queue_reason: params.queue_reason as ReviewQueueItem['queue_reason'],
      created_at: now,
      expires_at: now + ttl,
      resolved_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO review_queue (id, source_id, candidate_content, confidence, queue_reason, created_at, expires_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.source_id,
        item.candidate_content,
        item.confidence,
        item.queue_reason,
        item.created_at,
        item.expires_at,
        item.resolved_at
      );
    return item;
  }

  getPendingQueue(): ReviewQueueItem[] {
    return this.db
      .prepare(
        'SELECT * FROM review_queue WHERE resolved_at IS NULL ORDER BY created_at ASC'
      )
      .all() as ReviewQueueItem[];
  }

  // --- Contradictions ---

  insertContradiction(params: {
    node_a: string;
    node_b: string;
    conflict_score: number;
  }): Contradiction {
    const c: Contradiction = {
      id: randomUUID(),
      node_a: params.node_a,
      node_b: params.node_b,
      conflict_score: params.conflict_score,
      status: 'pending',
      resolved_by: null,
      resolved_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO contradictions (id, node_a, node_b, conflict_score, status, resolved_by, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.id,
        c.node_a,
        c.node_b,
        c.conflict_score,
        c.status,
        c.resolved_by,
        c.resolved_at
      );
    return c;
  }

  resolveContradiction(
    id: string,
    resolvedBy: string,
    status: 'resolved' | 'dismissed'
  ): void {
    this.db
      .prepare(
        'UPDATE contradictions SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?'
      )
      .run(status, resolvedBy, Date.now(), id);
  }

  getPendingContradictions(): Contradiction[] {
    return this.db
      .prepare('SELECT * FROM contradictions WHERE status = ?')
      .all('pending') as Contradiction[];
  }

  findContradiction(
    nodeAPrefix: string,
    nodeBPrefix: string
  ): Contradiction | undefined {
    // Match by prefix (short IDs)
    const all = this.getPendingContradictions();
    return all.find(
      (c) =>
        (c.node_a.startsWith(nodeAPrefix) &&
          c.node_b.startsWith(nodeBPrefix)) ||
        (c.node_a.startsWith(nodeBPrefix) && c.node_b.startsWith(nodeAPrefix))
    );
  }

  // --- Review Queue helpers ---

  findQueueItem(idPrefix: string): ReviewQueueItem | undefined {
    const pending = this.getPendingQueue();
    return pending.find((i) => i.id.startsWith(idPrefix));
  }

  resolveQueueItem(id: string): void {
    this.db
      .prepare('UPDATE review_queue SET resolved_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  // --- Stale Flags ---

  flagStale(nodeId: string, triggeredBySource: string): StaleFlag {
    const flag: StaleFlag = {
      id: randomUUID(),
      node_id: nodeId,
      triggered_by_source: triggeredBySource,
      flagged_at: Date.now(),
      resolved_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO stale_flags (id, node_id, triggered_by_source, flagged_at, resolved_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        flag.id,
        flag.node_id,
        flag.triggered_by_source,
        flag.flagged_at,
        flag.resolved_at
      );
    return flag;
  }

  getUnresolvedStaleFlags(): StaleFlag[] {
    return this.db
      .prepare('SELECT * FROM stale_flags WHERE resolved_at IS NULL')
      .all() as StaleFlag[];
  }

  resolveStaleFlag(id: string): void {
    this.db
      .prepare('UPDATE stale_flags SET resolved_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  // --- Dependency Index ---

  rebuildDependencyIndex(): void {
    this.db.exec('DELETE FROM dependency_index');
    const now = Date.now();

    // BFS from each node to compute transitive closure
    const edges = this.db
      .prepare('SELECT from_node, to_node FROM edges')
      .all() as { from_node: string; to_node: string }[];
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      const existing = adj.get(e.from_node);
      if (existing) {
        existing.push(e.to_node);
      } else {
        adj.set(e.from_node, [e.to_node]);
      }
    }

    const insert = this.db.prepare(
      `INSERT INTO dependency_index (id, ancestor_node, descendant_node, path_length, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    const insertAll = this.db.transaction(() => {
      for (const [startNode] of adj) {
        const visited = new Map<string, number>();
        const queue: Array<{ node: string; depth: number }> = [
          { node: startNode, depth: 0 },
        ];
        while (queue.length > 0) {
          const current = queue.shift()!;
          const neighbors = adj.get(current.node);
          if (!neighbors) continue;
          for (const neighbor of neighbors) {
            const newDepth = current.depth + 1;
            if (!visited.has(neighbor)) {
              visited.set(neighbor, newDepth);
              queue.push({ node: neighbor, depth: newDepth });
              insert.run(randomUUID(), startNode, neighbor, newDepth, now);
            }
          }
        }
      }
    });

    insertAll();
  }

  getDescendants(ancestorId: string): DependencyIndexEntry[] {
    return this.db
      .prepare(
        'SELECT * FROM dependency_index WHERE ancestor_node = ? ORDER BY path_length ASC'
      )
      .all(ancestorId) as DependencyIndexEntry[];
  }

  getAncestors(descendantId: string): DependencyIndexEntry[] {
    return this.db
      .prepare(
        'SELECT * FROM dependency_index WHERE descendant_node = ? ORDER BY path_length ASC'
      )
      .all(descendantId) as DependencyIndexEntry[];
  }

  // --- Sync Tracking ---

  getLastSync(system: string): number | undefined {
    const row = this.db
      .prepare(
        'SELECT MAX(fetched_at) as last_sync FROM sources WHERE system = ?'
      )
      .get(system) as { last_sync: number | null } | undefined;
    return row?.last_sync ?? undefined;
  }

  setLastSync(system: string, timestamp: number): void {
    // last_sync is derived from MAX(fetched_at) — no separate table needed
    // This is a no-op; the timestamp is implicit from source records.
    // Kept as an interface point if we add a dedicated sync_state table later.
    void system;
    void timestamp;
  }

  // --- Source Updates ---

  updateSourceHash(id: string, hash: string, rawPayload: string): Source {
    this.db
      .prepare(
        'UPDATE sources SET hash = ?, raw_payload = ?, fetched_at = ? WHERE id = ?'
      )
      .run(hash, rawPayload, Date.now(), id);
    return this.db
      .prepare('SELECT * FROM sources WHERE id = ?')
      .get(id) as Source;
  }

  // --- Node Queries for Dedup ---

  getRecentNodesWithEmbeddings(
    sinceMs: number
  ): Array<{ id: string; embedding: Buffer | null }> {
    return this.db
      .prepare(
        'SELECT id, embedding FROM nodes WHERE embedding IS NOT NULL AND created_at >= ?'
      )
      .all(sinceMs) as Array<{ id: string; embedding: Buffer | null }>;
  }

  getNodeIdsForSource(sourceId: string): string[] {
    const rows = this.db
      .prepare('SELECT node_id FROM source_edges WHERE source_id = ?')
      .all(sourceId) as Array<{ node_id: string }>;
    return rows.map((r) => r.node_id);
  }

  // --- Query helpers ---

  getNodesWithEmbeddings(actorFilter?: string, since?: number): Node[] {
    let sql = 'SELECT * FROM nodes WHERE embedding IS NOT NULL';
    const params: unknown[] = [];
    if (actorFilter) {
      sql += ' AND actor = ?';
      params.push(actorFilter);
    }
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since);
    }
    return this.db.prepare(sql).all(...params) as Node[];
  }

  searchNodesByKeywords(
    keywords: string[],
    limit: number,
    actorFilter?: string,
    since?: number
  ): Node[] {
    if (keywords.length === 0) {
      let sql = 'SELECT * FROM nodes';
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (actorFilter) {
        conditions.push('actor = ?');
        params.push(actorFilter);
      }
      if (since) {
        conditions.push('created_at >= ?');
        params.push(since);
      }
      if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      return this.db.prepare(sql).all(...params) as Node[];
    }

    // Score nodes by keyword match count
    const conditions: string[] = [];
    const params: unknown[] = [];
    const scoreParts: string[] = [];

    const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&');

    for (const kw of keywords) {
      scoreParts.push(
        "(CASE WHEN LOWER(content) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)"
      );
      params.push(`%${escapeLike(kw)}%`);
    }

    let sql = `SELECT *, (${scoreParts.join(' + ')}) as match_score FROM nodes WHERE (${scoreParts.join(' + ')}) > 0`;
    // Duplicate params for the WHERE clause
    for (const kw of keywords) {
      params.push(`%${escapeLike(kw)}%`);
    }

    if (actorFilter) {
      sql += ' AND actor = ?';
      params.push(actorFilter);
    }
    if (since) {
      sql += ' AND created_at >= ?';
      params.push(since);
    }
    sql += ' ORDER BY match_score DESC, created_at DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as Node[];
  }

  getStaleForNode(nodeId: string): StaleFlag[] {
    return this.db
      .prepare(
        'SELECT * FROM stale_flags WHERE node_id = ? AND resolved_at IS NULL'
      )
      .all(nodeId) as StaleFlag[];
  }

  getContradictionsForNode(nodeId: string): Contradiction[] {
    return this.db
      .prepare(
        "SELECT * FROM contradictions WHERE (node_a = ? OR node_b = ?) AND status = 'pending'"
      )
      .all(nodeId, nodeId) as Contradiction[];
  }

  // --- Status ---

  getStatus(): {
    nodeCount: number;
    edgeCount: number;
    pendingQueue: number;
    unresolvedContradictions: number;
    unresolvedStaleFlags: number;
    unresolvedRejections: number;
  } {
    const countNodes = () =>
      (
        this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as {
          c: number;
        }
      ).c;
    const countEdges = () =>
      (
        this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as {
          c: number;
        }
      ).c;

    return {
      nodeCount: countNodes(),
      edgeCount: countEdges(),
      pendingQueue: (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM review_queue WHERE resolved_at IS NULL'
          )
          .get() as { c: number }
      ).c,
      unresolvedContradictions: (
        this.db
          .prepare(
            "SELECT COUNT(*) as c FROM contradictions WHERE status = 'pending'"
          )
          .get() as { c: number }
      ).c,
      unresolvedStaleFlags: (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM stale_flags WHERE resolved_at IS NULL'
          )
          .get() as { c: number }
      ).c,
      unresolvedRejections: (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM rejection_log WHERE reasoning_resolved = 0'
          )
          .get() as { c: number }
      ).c,
    };
  }

  close(): void {
    this.db.close();
  }
}
