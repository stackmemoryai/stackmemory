/**
 * Pattern Store
 *
 * SQLite CRUD for learned patterns.
 * Handles confidence scoring, decay, and pruning.
 */

import Database from 'better-sqlite3';
import type {
  Pattern,
  PatternRow,
  CreatePatternInput,
  PatternQuery,
  PatternStats,
} from './types.js';
import {
  computeConfidence,
  CONFIDENCE_DECAY_PER_WEEK,
  CONFIDENCE_BOOST_PER_OBSERVATION,
} from './types.js';

export class PatternStore {
  constructor(private readonly db: Database.Database) {}

  /** Create a new pattern */
  create(input: CreatePatternInput): Pattern {
    const now = Date.now();
    const confidence = input.confidence ?? computeConfidence(1);

    this.db
      .prepare(
        `
      INSERT INTO patterns (id, domain, trigger, action, evidence, confidence, observation_count, scope, project_id, status, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        input.id,
        input.domain,
        input.trigger,
        input.action,
        JSON.stringify(input.evidence ?? []),
        confidence,
        1,
        input.scope ?? 'project',
        input.projectId ?? null,
        'pending',
        input.source ?? 'manual',
        now,
        now
      );

    return this.get(input.id)!;
  }

  /** Get a pattern by ID */
  get(id: string): Pattern | undefined {
    const row = this.db
      .prepare('SELECT * FROM patterns WHERE id = ?')
      .get(id) as PatternRow | undefined;
    return row ? this.toPattern(row) : undefined;
  }

  /** List patterns with filtering */
  list(query: PatternQuery = {}): Pattern[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.domain) {
      conditions.push('domain = ?');
      params.push(query.domain);
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.scope) {
      conditions.push('scope = ?');
      params.push(query.scope);
    }
    if (query.projectId) {
      conditions.push("(project_id = ? OR scope = 'global')");
      params.push(query.projectId);
    }
    if (query.minConfidence !== undefined) {
      conditions.push('confidence >= ?');
      params.push(query.minConfidence);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 100;

    const rows = this.db
      .prepare(
        `SELECT * FROM patterns ${where} ORDER BY confidence DESC, updated_at DESC LIMIT ?`
      )
      .all(...params, limit) as PatternRow[];

    return rows.map((r) => this.toPattern(r));
  }

  /** Record an observation that reinforces a pattern */
  reinforce(id: string, evidence: string): void {
    const pattern = this.get(id);
    if (!pattern) return;

    const newCount = pattern.observationCount + 1;
    const baseConfidence = computeConfidence(newCount);
    const boosted = Math.min(
      1.0,
      baseConfidence + CONFIDENCE_BOOST_PER_OBSERVATION
    );
    const newEvidence = [...pattern.evidence, evidence].slice(-20); // keep last 20

    this.db
      .prepare(
        `
      UPDATE patterns
      SET observation_count = ?, confidence = ?, evidence = ?, updated_at = ?, status = CASE WHEN status = 'pending' AND ? >= 0.5 THEN 'active' ELSE status END
      WHERE id = ?
    `
      )
      .run(
        newCount,
        boosted,
        JSON.stringify(newEvidence),
        Date.now(),
        boosted,
        id
      );
  }

  /** Apply weekly confidence decay to all patterns */
  applyDecay(): number {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const result = this.db
      .prepare(
        `
      UPDATE patterns
      SET confidence = MAX(0.05, confidence - ?),
          updated_at = ?
      WHERE updated_at < ? AND status != 'archived'
    `
      )
      .run(CONFIDENCE_DECAY_PER_WEEK, Date.now(), oneWeekAgo);

    return result.changes;
  }

  /** Mark a pattern as matched during retrieval */
  recordMatch(id: string): void {
    this.db
      .prepare('UPDATE patterns SET last_matched_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  /** Activate a pending pattern */
  activate(id: string): void {
    this.db
      .prepare(
        "UPDATE patterns SET status = 'active', updated_at = ? WHERE id = ?"
      )
      .run(Date.now(), id);
  }

  /** Archive a pattern */
  archive(id: string, supersededBy?: string): void {
    this.db
      .prepare(
        "UPDATE patterns SET status = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?"
      )
      .run(supersededBy ?? null, Date.now(), id);
  }

  /** Prune old pending patterns that never got promoted */
  prune(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const result = this.db
      .prepare(
        "DELETE FROM patterns WHERE status = 'pending' AND created_at < ?"
      )
      .run(cutoff);

    return result.changes;
  }

  /** Get aggregate stats */
  stats(): PatternStats {
    const all = this.list({ limit: 1000 });

    const byDomain: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let totalConfidence = 0;

    for (const p of all) {
      byDomain[p.domain] = (byDomain[p.domain] ?? 0) + 1;
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      totalConfidence += p.confidence;
    }

    const topPatterns = all
      .filter((p) => p.status === 'active')
      .slice(0, 10)
      .map((p) => ({ id: p.id, confidence: p.confidence, trigger: p.trigger }));

    return {
      total: all.length,
      byDomain,
      byStatus,
      avgConfidence: all.length > 0 ? totalConfidence / all.length : 0,
      topPatterns,
    };
  }

  /** Promote a project-scoped pattern to global */
  promote(id: string): void {
    this.db
      .prepare(
        "UPDATE patterns SET scope = 'global', project_id = NULL, updated_at = ? WHERE id = ?"
      )
      .run(Date.now(), id);
  }

  /** List distinct project IDs with pattern counts */
  projects(): Array<{
    projectId: string;
    count: number;
    avgConfidence: number;
  }> {
    const rows = this.db
      .prepare(
        `
      SELECT project_id, COUNT(*) as count, AVG(confidence) as avg_confidence
      FROM patterns
      WHERE project_id IS NOT NULL AND status != 'archived'
      GROUP BY project_id
      ORDER BY count DESC
    `
      )
      .all() as Array<{
      project_id: string;
      count: number;
      avg_confidence: number;
    }>;

    return rows.map((r) => ({
      projectId: r.project_id,
      count: r.count,
      avgConfidence: r.avg_confidence,
    }));
  }

  /** Find patterns that appear in 2+ projects (promotion candidates) */
  promotionCandidates(minConfidence: number = 0.7): Pattern[] {
    // Find patterns with the same trigger+action across different projects
    const rows = this.db
      .prepare(
        `
      SELECT p1.* FROM patterns p1
      WHERE p1.scope = 'project'
        AND p1.confidence >= ?
        AND p1.status = 'active'
        AND EXISTS (
          SELECT 1 FROM patterns p2
          WHERE p2.trigger = p1.trigger
            AND p2.action = p1.action
            AND p2.project_id != p1.project_id
            AND p2.status = 'active'
        )
      ORDER BY p1.confidence DESC
    `
      )
      .all(minConfidence) as PatternRow[];

    return rows.map((r) => this.toPattern(r));
  }

  /** Find clusters of related patterns (for evolve) */
  findClusters(
    minSize: number = 2
  ): Array<{ domain: string; patterns: Pattern[] }> {
    const active = this.list({ status: 'active', limit: 500 });
    const byDomain: Map<string, Pattern[]> = new Map();

    for (const p of active) {
      const list = byDomain.get(p.domain) ?? [];
      list.push(p);
      byDomain.set(p.domain, list);
    }

    return Array.from(byDomain.entries())
      .filter(([, patterns]) => patterns.length >= minSize)
      .map(([domain, patterns]) => ({
        domain,
        patterns: patterns.sort((a, b) => b.confidence - a.confidence),
      }));
  }

  /** Find patterns relevant to a query string */
  search(query: string, projectId?: string): Pattern[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    // Get active patterns for this project + global
    const candidates = this.list({
      status: 'active',
      projectId,
      minConfidence: 0.3,
      limit: 200,
    });

    // Score by keyword overlap with trigger + action
    const scored = candidates.map((p) => {
      const text = `${p.trigger} ${p.action} ${p.domain}`.toLowerCase();
      const hits = words.filter((w) => text.includes(w)).length;
      const score = hits / words.length;
      return { pattern: p, score };
    });

    return scored
      .filter((s) => s.score > 0.2)
      .sort(
        (a, b) =>
          b.score * b.pattern.confidence - a.score * a.pattern.confidence
      )
      .slice(0, 10)
      .map((s) => s.pattern);
  }

  // ── Private ───────────────────────────────────────────

  private toPattern(row: PatternRow): Pattern {
    return {
      id: row.id,
      domain: row.domain as Pattern['domain'],
      trigger: row.trigger,
      action: row.action,
      evidence: JSON.parse(row.evidence || '[]'),
      confidence: row.confidence,
      observationCount: row.observation_count,
      scope: row.scope as Pattern['scope'],
      projectId: row.project_id,
      status: row.status as Pattern['status'],
      source: row.source as Pattern['source'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMatchedAt: row.last_matched_at,
      supersededBy: row.superseded_by,
    };
  }
}
