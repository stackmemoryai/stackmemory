/**
 * Skill Registry — SQLite backend (replaces Redis-based skill-storage)
 *
 * Standalone ~/.stackmemory/skills.db (not shared with frame DB).
 * Follows traces.db precedent for separate-concern databases.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../monitoring/logger.js';
import type {
  Skill,
  CreateSkillInput,
  UpdateSkillInput,
  SkillQuery,
  SkillCategory,
  SkillPriority,
  JournalEntry,
  JournalEntryType,
  SessionSummary,
  SkillRule,
  SkillRulesFile,
  MatcherConfig,
  ScoringWeights,
  DirectoryMapping,
} from './types.js';

// ============================================================
// SCHEMA
// ============================================================

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    summary TEXT,
    category TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    tags TEXT NOT NULL DEFAULT '[]',
    tool TEXT,
    project TEXT,
    language TEXT,
    framework TEXT,
    validated_count INTEGER NOT NULL DEFAULT 0,
    last_validated TEXT,
    source TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
  CREATE INDEX IF NOT EXISTS idx_skills_priority ON skills(priority);
  CREATE INDEX IF NOT EXISTS idx_skills_tool ON skills(tool);
  CREATE INDEX IF NOT EXISTS idx_skills_created ON skills(created_at);

  CREATE TABLE IF NOT EXISTS skill_rules (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    triggers TEXT NOT NULL DEFAULT '{}',
    exclude_patterns TEXT NOT NULL DEFAULT '[]',
    related_skills TEXT NOT NULL DEFAULT '[]',
    suggestion TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS directory_mappings (
    directory TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matcher_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    min_confidence_score INTEGER NOT NULL DEFAULT 3,
    show_match_reasons INTEGER NOT NULL DEFAULT 1,
    max_skills_to_show INTEGER NOT NULL DEFAULT 5,
    scoring TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    context_file TEXT,
    context_tool TEXT,
    context_command TEXT,
    outcome TEXT,
    promoted_to_skill_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_journal_session ON journal_entries(session_id);
  CREATE INDEX IF NOT EXISTS idx_journal_type ON journal_entries(type);

  CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    entries_count INTEGER NOT NULL DEFAULT 0,
    corrections_count INTEGER NOT NULL DEFAULT 0,
    decisions_count INTEGER NOT NULL DEFAULT 0,
    key_learnings TEXT NOT NULL DEFAULT '[]',
    promoted_skill_ids TEXT NOT NULL DEFAULT '[]'
  );
`;

// ============================================================
// HELPERS
// ============================================================

function getDefaultDbPath(): string {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '/tmp';
  return path.join(home, '.stackmemory', 'skills.db');
}

function priorityScore(priority: SkillPriority): number {
  const scores: Record<SkillPriority, number> = {
    critical: 1000,
    high: 100,
    medium: 10,
    low: 1,
  };
  return scores[priority] ?? 10;
}

function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    id: row['id'] as string,
    content: row['content'] as string,
    summary: (row['summary'] as string) || undefined,
    category: row['category'] as SkillCategory,
    priority: row['priority'] as SkillPriority,
    tags: JSON.parse((row['tags'] as string) || '[]') as string[],
    tool: (row['tool'] as string) || undefined,
    project: (row['project'] as string) || undefined,
    language: (row['language'] as string) || undefined,
    framework: (row['framework'] as string) || undefined,
    validatedCount: (row['validated_count'] as number) || 0,
    lastValidated: (row['last_validated'] as string) || undefined,
    source: row['source'] as Skill['source'],
    sessionId: (row['session_id'] as string) || undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    expiresAt: (row['expires_at'] as string) || undefined,
  };
}

function rowToJournalEntry(row: Record<string, unknown>): JournalEntry {
  const context: JournalEntry['context'] =
    row['context_file'] || row['context_tool'] || row['context_command']
      ? {
          file: (row['context_file'] as string) || undefined,
          tool: (row['context_tool'] as string) || undefined,
          command: (row['context_command'] as string) || undefined,
        }
      : undefined;

  return {
    id: row['id'] as string,
    sessionId: row['session_id'] as string,
    type: row['type'] as JournalEntryType,
    title: row['title'] as string,
    content: row['content'] as string,
    context,
    outcome: (row['outcome'] as JournalEntry['outcome']) || undefined,
    createdAt: row['created_at'] as string,
    promotedToSkillId: (row['promoted_to_skill_id'] as string) || undefined,
  };
}

// ============================================================
// SKILL REGISTRY
// ============================================================

export class SkillRegistry {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || getDefaultDbPath();

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
  }

  private initSchema(): void {
    const versionRow = (() => {
      try {
        return this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
          )
          .get() as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    })();

    if (!versionRow) {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(SCHEMA_VERSION);
      logger.debug('SkillRegistry: created schema v' + SCHEMA_VERSION);
    }
  }

  // ============================================================
  // SKILL CRUD
  // ============================================================

  createSkill(input: CreateSkillInput): Skill {
    const now = new Date().toISOString();
    const id = uuidv4();

    this.db
      .prepare(
        `INSERT INTO skills (id, content, summary, category, priority, tags, tool, project, language, framework,
         validated_count, source, session_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.content,
        input.summary ?? null,
        input.category,
        input.priority ?? 'medium',
        JSON.stringify(input.tags ?? []),
        input.tool ?? null,
        input.project ?? null,
        input.language ?? null,
        input.framework ?? null,
        input.source,
        input.sessionId ?? null,
        now,
        now,
        input.expiresAt ?? null
      );

    const skill = this.getSkill(id);
    if (!skill) throw new Error(`Skill not found after creation: ${id}`);
    return skill;
  }

  getSkill(id: string): Skill | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSkill(row) : undefined;
  }

  updateSkill(input: UpdateSkillInput): Skill | undefined {
    const existing = this.getSkill(input.id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.content !== undefined) {
      updates.push('content = ?');
      params.push(input.content);
    }
    if (input.summary !== undefined) {
      updates.push('summary = ?');
      params.push(input.summary);
    }
    if (input.category !== undefined) {
      updates.push('category = ?');
      params.push(input.category);
    }
    if (input.priority !== undefined) {
      updates.push('priority = ?');
      params.push(input.priority);
    }
    if (input.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (input.tool !== undefined) {
      updates.push('tool = ?');
      params.push(input.tool);
    }

    params.push(input.id);
    this.db
      .prepare(`UPDATE skills SET ${updates.join(', ')} WHERE id = ?`)
      .run(...params);

    return this.getSkill(input.id);
  }

  validateSkill(id: string): Skill | undefined {
    const skill = this.getSkill(id);
    if (!skill) return undefined;

    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE skills SET validated_count = validated_count + 1, last_validated = ?, updated_at = ? WHERE id = ?'
      )
      .run(now, now, id);

    return this.getSkill(id);
  }

  deleteSkill(id: string): boolean {
    const result = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
    return result.changes > 0;
  }

  querySkills(query: SkillQuery): Skill[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.categories?.length) {
      conditions.push(
        `category IN (${query.categories.map(() => '?').join(',')})`
      );
      params.push(...query.categories);
    }
    if (query.priorities?.length) {
      conditions.push(
        `priority IN (${query.priorities.map(() => '?').join(',')})`
      );
      params.push(...query.priorities);
    }
    if (query.tool) {
      conditions.push('tool = ?');
      params.push(query.tool);
    }
    if (query.language) {
      conditions.push('language = ?');
      params.push(query.language);
    }
    if (query.framework) {
      conditions.push('framework = ?');
      params.push(query.framework);
    }
    if (query.minValidatedCount !== undefined) {
      conditions.push('validated_count >= ?');
      params.push(query.minValidatedCount);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Map sortBy to column names
    const sortColMap: Record<string, string> = {
      priority: 'priority',
      validatedCount: 'validated_count',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };
    const sortCol = sortColMap[query.sortBy ?? 'priority'] ?? 'priority';
    const sortDir = query.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const sql = `SELECT * FROM skills ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
    params.push(query.limit ?? 50, query.offset ?? 0);

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];

    let skills = rows.map(rowToSkill);

    // In-memory sort for priority (text field needs numeric comparison)
    if (sortCol === 'priority') {
      skills.sort((a, b) => {
        const diff = priorityScore(b.priority) - priorityScore(a.priority);
        return sortDir === 'DESC' ? diff : -diff;
      });
    }

    // Tag filtering (in-memory since tags are JSON)
    if (query.tags?.length) {
      const tags = query.tags;
      skills = skills.filter((s) => tags.some((t) => s.tags.includes(t)));
    }

    return skills;
  }

  getRelevantSkills(context: {
    tool?: string;
    language?: string;
    framework?: string;
    tags?: string[];
  }): Skill[] {
    const skills: Skill[] = [];
    const seenIds = new Set<string>();

    // Critical skills always included
    const critical = this.db
      .prepare("SELECT * FROM skills WHERE priority = 'critical'")
      .all() as Record<string, unknown>[];
    for (const row of critical) {
      const skill = rowToSkill(row);
      if (!seenIds.has(skill.id)) {
        skills.push(skill);
        seenIds.add(skill.id);
      }
    }

    // Tool-specific
    if (context.tool) {
      const toolRows = this.db
        .prepare(
          'SELECT * FROM skills WHERE tool = ? ORDER BY validated_count DESC LIMIT 20'
        )
        .all(context.tool) as Record<string, unknown>[];
      for (const row of toolRows) {
        const skill = rowToSkill(row);
        if (!seenIds.has(skill.id)) {
          skills.push(skill);
          seenIds.add(skill.id);
        }
      }
    }

    // Highly validated
    const validated = this.db
      .prepare('SELECT * FROM skills ORDER BY validated_count DESC LIMIT 10')
      .all() as Record<string, unknown>[];
    for (const row of validated) {
      const skill = rowToSkill(row);
      if (!seenIds.has(skill.id)) {
        skills.push(skill);
        seenIds.add(skill.id);
      }
    }

    return skills.slice(0, 50);
  }

  // ============================================================
  // SKILL RULES CRUD
  // ============================================================

  upsertRule(name: string, rule: SkillRule): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skill_rules (name, description, priority, triggers, exclude_patterns, related_skills, suggestion, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           priority = excluded.priority,
           triggers = excluded.triggers,
           exclude_patterns = excluded.exclude_patterns,
           related_skills = excluded.related_skills,
           suggestion = excluded.suggestion,
           updated_at = excluded.updated_at`
      )
      .run(
        name,
        rule.description,
        rule.priority,
        JSON.stringify(rule.triggers),
        JSON.stringify(rule.excludePatterns ?? []),
        JSON.stringify(rule.relatedSkills ?? []),
        rule.suggestion ?? null,
        now,
        now
      );
  }

  getRule(name: string): SkillRule | undefined {
    const row = this.db
      .prepare('SELECT * FROM skill_rules WHERE name = ?')
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      description: row['description'] as string,
      priority: row['priority'] as number,
      triggers: JSON.parse(row['triggers'] as string),
      excludePatterns: JSON.parse(row['exclude_patterns'] as string),
      relatedSkills: JSON.parse(row['related_skills'] as string),
      suggestion: (row['suggestion'] as string) || undefined,
    };
  }

  getAllRules(): Record<string, SkillRule> {
    const rows = this.db.prepare('SELECT * FROM skill_rules').all() as Record<
      string,
      unknown
    >[];
    const result: Record<string, SkillRule> = {};
    for (const row of rows) {
      result[row['name'] as string] = {
        description: row['description'] as string,
        priority: row['priority'] as number,
        triggers: JSON.parse(row['triggers'] as string),
        excludePatterns: JSON.parse(row['exclude_patterns'] as string),
        relatedSkills: JSON.parse(row['related_skills'] as string),
        suggestion: (row['suggestion'] as string) || undefined,
      };
    }
    return result;
  }

  deleteRule(name: string): boolean {
    return (
      this.db.prepare('DELETE FROM skill_rules WHERE name = ?').run(name)
        .changes > 0
    );
  }

  // ============================================================
  // DIRECTORY MAPPINGS
  // ============================================================

  setDirectoryMapping(directory: string, skillName: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO directory_mappings (directory, skill_name) VALUES (?, ?)'
      )
      .run(directory, skillName);
  }

  getDirectoryMappings(): DirectoryMapping {
    const rows = this.db
      .prepare('SELECT * FROM directory_mappings')
      .all() as Record<string, unknown>[];
    const result: DirectoryMapping = {};
    for (const row of rows) {
      result[row['directory'] as string] = row['skill_name'] as string;
    }
    return result;
  }

  // ============================================================
  // MATCHER CONFIG
  // ============================================================

  getMatcherConfig(): { config: MatcherConfig; scoring: ScoringWeights } {
    const row = this.db
      .prepare('SELECT * FROM matcher_config WHERE id = 1')
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      // Return defaults
      return {
        config: {
          minConfidenceScore: 3,
          showMatchReasons: true,
          maxSkillsToShow: 5,
        },
        scoring: {
          keyword: 2,
          keywordPattern: 3,
          pathPattern: 4,
          directoryMatch: 5,
          intentPattern: 4,
          contentPattern: 3,
          contextPattern: 2,
        },
      };
    }

    return {
      config: {
        minConfidenceScore: row['min_confidence_score'] as number,
        showMatchReasons: !!(row['show_match_reasons'] as number),
        maxSkillsToShow: row['max_skills_to_show'] as number,
      },
      scoring: JSON.parse(row['scoring'] as string),
    };
  }

  setMatcherConfig(config: MatcherConfig, scoring: ScoringWeights): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO matcher_config (id, min_confidence_score, show_match_reasons, max_skills_to_show, scoring)
         VALUES (1, ?, ?, ?, ?)`
      )
      .run(
        config.minConfidenceScore,
        config.showMatchReasons ? 1 : 0,
        config.maxSkillsToShow,
        JSON.stringify(scoring)
      );
  }

  // ============================================================
  // JOURNAL
  // ============================================================

  createJournalEntry(
    sessionId: string,
    type: JournalEntryType,
    title: string,
    content: string,
    context?: JournalEntry['context']
  ): JournalEntry {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO journal_entries (id, session_id, type, title, content, context_file, context_tool, context_command, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        sessionId,
        type,
        title,
        content,
        context?.file ?? null,
        context?.tool ?? null,
        context?.command ?? null,
        now
      );

    return {
      id,
      sessionId,
      type,
      title,
      content,
      context,
      createdAt: now,
    };
  }

  getSessionJournal(sessionId: string): JournalEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM journal_entries WHERE session_id = ? ORDER BY created_at DESC'
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToJournalEntry);
  }

  promoteToSkill(
    entryId: string,
    category: SkillCategory,
    priority: SkillPriority = 'medium'
  ): Skill | undefined {
    const row = this.db
      .prepare('SELECT * FROM journal_entries WHERE id = ?')
      .get(entryId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const entry = rowToJournalEntry(row);
    const skill = this.createSkill({
      content: entry.content,
      summary: entry.title,
      category,
      priority,
      tags: [],
      tool: entry.context?.tool,
      source: 'observation',
      sessionId: entry.sessionId,
    });

    // Link entry to promoted skill
    this.db
      .prepare(
        'UPDATE journal_entries SET promoted_to_skill_id = ? WHERE id = ?'
      )
      .run(skill.id, entryId);

    return skill;
  }

  // ============================================================
  // SESSION MANAGEMENT
  // ============================================================

  startSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_summaries (session_id, started_at, entries_count, corrections_count, decisions_count)
         VALUES (?, ?, 0, 0, 0)`
      )
      .run(sessionId, now);
  }

  endSession(sessionId: string): SessionSummary | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_summaries WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const now = new Date().toISOString();
    const entries = this.getSessionJournal(sessionId);

    const corrections = entries.filter((e) => e.type === 'correction').length;
    const decisions = entries.filter((e) => e.type === 'decision').length;
    const keyLearnings = entries
      .filter((e) => e.type === 'correction' || e.type === 'resolution')
      .slice(0, 5)
      .map((e) => e.title);
    const promotedSkillIds = entries
      .filter((e) => e.promotedToSkillId != null)
      .map((e) => e.promotedToSkillId as string);

    this.db
      .prepare(
        `UPDATE session_summaries SET
         ended_at = ?, entries_count = ?, corrections_count = ?,
         decisions_count = ?, key_learnings = ?, promoted_skill_ids = ?
         WHERE session_id = ?`
      )
      .run(
        now,
        entries.length,
        corrections,
        decisions,
        JSON.stringify(keyLearnings),
        JSON.stringify(promotedSkillIds),
        sessionId
      );

    return {
      sessionId,
      startedAt: row['started_at'] as string,
      endedAt: now,
      entriesCount: entries.length,
      correctionsCount: corrections,
      decisionsCount: decisions,
      keyLearnings,
      promotedSkillIds,
    };
  }

  getSessionSummary(sessionId: string): SessionSummary | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_summaries WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    return {
      sessionId: row['session_id'] as string,
      startedAt: row['started_at'] as string,
      endedAt: (row['ended_at'] as string) || undefined,
      entriesCount: (row['entries_count'] as number) || 0,
      correctionsCount: (row['corrections_count'] as number) || 0,
      decisionsCount: (row['decisions_count'] as number) || 0,
      keyLearnings: JSON.parse((row['key_learnings'] as string) || '[]'),
      promotedSkillIds: JSON.parse(
        (row['promoted_skill_ids'] as string) || '[]'
      ),
    };
  }

  // ============================================================
  // METRICS
  // ============================================================

  getMetrics(): {
    skillsTotal: number;
    skillsByCategory: Record<string, number>;
    rulesTotal: number;
    journalEntriesTotal: number;
    sessionsTotal: number;
  } {
    const skillsTotal = (
      this.db.prepare('SELECT COUNT(*) as c FROM skills').get() as {
        c: number;
      }
    ).c;

    const catRows = this.db
      .prepare('SELECT category, COUNT(*) as c FROM skills GROUP BY category')
      .all() as { category: string; c: number }[];
    const skillsByCategory: Record<string, number> = {};
    for (const row of catRows) {
      skillsByCategory[row.category] = row.c;
    }

    const rulesTotal = (
      this.db.prepare('SELECT COUNT(*) as c FROM skill_rules').get() as {
        c: number;
      }
    ).c;

    const journalEntriesTotal = (
      this.db.prepare('SELECT COUNT(*) as c FROM journal_entries').get() as {
        c: number;
      }
    ).c;

    const sessionsTotal = (
      this.db.prepare('SELECT COUNT(*) as c FROM session_summaries').get() as {
        c: number;
      }
    ).c;

    return {
      skillsTotal,
      skillsByCategory,
      rulesTotal,
      journalEntriesTotal,
      sessionsTotal,
    };
  }

  // ============================================================
  // SEED FROM RULES JSON
  // ============================================================

  seedFromRulesJson(rulesFile: SkillRulesFile): void {
    const tx = this.db.transaction(() => {
      // Seed config
      this.setMatcherConfig(rulesFile.config, rulesFile.scoring);

      // Seed directory mappings
      for (const [dir, skill] of Object.entries(
        rulesFile.directoryMappings || {}
      )) {
        this.setDirectoryMapping(dir, skill);
      }

      // Seed rules
      for (const [name, rule] of Object.entries(rulesFile.skills)) {
        this.upsertRule(name, rule);
      }
    });
    tx();

    logger.info('SkillRegistry: seeded from rules JSON', {
      rules: Object.keys(rulesFile.skills).length,
      mappings: Object.keys(rulesFile.directoryMappings || {}).length,
    });
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  close(): void {
    this.db.close();
  }
}

// ============================================================
// SINGLETON
// ============================================================

let registryInstance: SkillRegistry | undefined;

export function getSkillRegistry(dbPath?: string): SkillRegistry {
  if (!registryInstance) {
    registryInstance = new SkillRegistry(dbPath);
  }
  return registryInstance;
}

export function resetSkillRegistry(): void {
  if (registryInstance) {
    registryInstance.close();
    registryInstance = undefined;
  }
}
