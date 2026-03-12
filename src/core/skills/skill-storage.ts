/**
 * Skill Storage Service
 * Redis-backed persistent storage for agent learnings and skills
 * All skills are namespaced by userId for multi-user support
 */

import 'dotenv/config';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../monitoring/logger.js';

// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

import {
  Skill,
  CreateSkillInput,
  UpdateSkillInput,
  SkillQuery,
  JournalEntry,
  JournalEntryType,
  SessionSummary,
  SkillCategory,
  SkillPriority,
  REDIS_KEYS,
  CACHE_TTL,
  calculateSkillTTL,
  SkillSchema,
  JournalEntrySchema,
} from './types.js';

export interface SkillStorageConfig {
  redisUrl: string;
  userId: string; // Required: user namespace for skills
  keyPrefix?: string;
  enableMetrics?: boolean;
}

export interface SkillStorageMetrics {
  userId: string;
  skillsTotal: number;
  skillsByCategory: Record<SkillCategory, number>;
  journalEntriesTotal: number;
  sessionsTracked: number;
  cacheHits: number;
  cacheMisses: number;
}

export class SkillStorageService {
  private redis: Redis;
  private userId: string;
  private keyPrefix: string;
  private enableMetrics: boolean;

  // Metrics tracking
  private metrics = {
    cacheHits: 0,
    cacheMisses: 0,
  };

  constructor(config: SkillStorageConfig) {
    this.redis = new Redis(config.redisUrl);
    this.userId = config.userId;
    this.keyPrefix = config.keyPrefix || 'sm:skills';
    this.enableMetrics = config.enableMetrics ?? true;

    this.redis.on('error', (err) => {
      logger.error('Redis connection error in SkillStorage', err);
    });

    this.redis.on('connect', () => {
      logger.info('SkillStorage connected to Redis');
    });

    logger.info('SkillStorageService initialized', {
      userId: this.userId,
      keyPrefix: this.keyPrefix,
      enableMetrics: this.enableMetrics,
    });
  }

  private key(pattern: string): string {
    return `${this.keyPrefix}:${pattern}`;
  }

  /**
   * Get the current user ID
   */
  getUserId(): string {
    return this.userId;
  }

  // ============================================================
  // SKILL CRUD OPERATIONS
  // ============================================================

  /**
   * Create a new skill
   */
  async createSkill(input: CreateSkillInput): Promise<Skill> {
    const now = new Date().toISOString();
    const skill: Skill = {
      ...input,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
      validatedCount: 0,
    };

    // Validate
    SkillSchema.parse(skill);

    const pipeline = this.redis.pipeline();
    const skillKey = this.key(REDIS_KEYS.skill(this.userId, skill.id));

    // Store skill
    pipeline.setex(
      skillKey,
      calculateSkillTTL(skill.validatedCount),
      JSON.stringify(skill)
    );

    // Index by tool
    if (skill.tool) {
      pipeline.zadd(
        this.key(REDIS_KEYS.skillsByTool(this.userId, skill.tool)),
        Date.now(),
        skill.id
      );
    }

    // Index by category
    pipeline.zadd(
      this.key(REDIS_KEYS.skillsByCategory(this.userId, skill.category)),
      this.priorityScore(skill.priority),
      skill.id
    );

    // Index by tags
    for (const tag of skill.tags) {
      pipeline.zadd(
        this.key(REDIS_KEYS.skillsByTag(this.userId, tag)),
        Date.now(),
        skill.id
      );
    }

    // Add to recent skills
    pipeline.zadd(
      this.key(REDIS_KEYS.skillsRecent(this.userId)),
      Date.now(),
      skill.id
    );
    pipeline.zremrangebyrank(
      this.key(REDIS_KEYS.skillsRecent(this.userId)),
      0,
      -1001
    ); // Keep last 1000

    await pipeline.exec();

    logger.info('Created skill', {
      userId: this.userId,
      id: skill.id,
      category: skill.category,
      tool: skill.tool,
    });

    return skill;
  }

  /**
   * Get skill by ID
   */
  async getSkill(id: string): Promise<Skill | null> {
    const skillKey = this.key(REDIS_KEYS.skill(this.userId, id));
    const data = await this.redis.get(skillKey);

    if (!data) {
      this.metrics.cacheMisses++;
      return null;
    }

    this.metrics.cacheHits++;
    return JSON.parse(data) as Skill;
  }

  /**
   * Update an existing skill
   */
  async updateSkill(input: UpdateSkillInput): Promise<Skill | null> {
    const existing = await this.getSkill(input.id);
    if (!existing) {
      return null;
    }

    const updated: Skill = {
      ...existing,
      ...input,
      updatedAt: new Date().toISOString(),
    };

    // Validate
    SkillSchema.parse(updated);

    const skillKey = this.key(REDIS_KEYS.skill(this.userId, updated.id));
    await this.redis.setex(
      skillKey,
      calculateSkillTTL(updated.validatedCount),
      JSON.stringify(updated)
    );

    logger.info('Updated skill', { userId: this.userId, id: updated.id });

    return updated;
  }

  /**
   * Validate a skill (increment validation count)
   */
  async validateSkill(id: string): Promise<Skill | null> {
    const skill = await this.getSkill(id);
    if (!skill) {
      return null;
    }

    skill.validatedCount++;
    skill.lastValidated = new Date().toISOString();
    skill.updatedAt = new Date().toISOString();

    const skillKey = this.key(REDIS_KEYS.skill(this.userId, id));
    // TTL increases with validation count: 7 days base + 7 days per validation, max 90 days
    await this.redis.setex(
      skillKey,
      calculateSkillTTL(skill.validatedCount),
      JSON.stringify(skill)
    );

    // Update validated index
    await this.redis.zadd(
      this.key(REDIS_KEYS.skillsValidated(this.userId)),
      skill.validatedCount,
      id
    );

    // Check for promotion eligibility
    if (skill.validatedCount >= 3 && skill.priority !== 'critical') {
      await this.redis.sadd(
        this.key(REDIS_KEYS.promotionCandidates(this.userId)),
        id
      );
    }

    logger.info('Validated skill', {
      userId: this.userId,
      id,
      validatedCount: skill.validatedCount,
    });

    return skill;
  }

  /**
   * Delete a skill
   */
  async deleteSkill(id: string): Promise<boolean> {
    const skill = await this.getSkill(id);
    if (!skill) {
      return false;
    }

    const pipeline = this.redis.pipeline();
    const skillKey = this.key(REDIS_KEYS.skill(this.userId, id));

    // Remove skill
    pipeline.del(skillKey);

    // Remove from indexes
    if (skill.tool) {
      pipeline.zrem(
        this.key(REDIS_KEYS.skillsByTool(this.userId, skill.tool)),
        id
      );
    }

    pipeline.zrem(
      this.key(REDIS_KEYS.skillsByCategory(this.userId, skill.category)),
      id
    );

    for (const tag of skill.tags) {
      pipeline.zrem(this.key(REDIS_KEYS.skillsByTag(this.userId, tag)), id);
    }

    pipeline.zrem(this.key(REDIS_KEYS.skillsRecent(this.userId)), id);
    pipeline.zrem(this.key(REDIS_KEYS.skillsValidated(this.userId)), id);
    pipeline.srem(this.key(REDIS_KEYS.promotionCandidates(this.userId)), id);

    await pipeline.exec();

    logger.info('Deleted skill', { userId: this.userId, id });

    return true;
  }

  // ============================================================
  // SKILL QUERIES
  // ============================================================

  /**
   * Query skills with filters
   */
  async querySkills(query: SkillQuery): Promise<Skill[]> {
    let skillIds: string[] = [];

    // Determine which index to use
    if (query.tool) {
      skillIds = await this.redis.zrevrange(
        this.key(REDIS_KEYS.skillsByTool(this.userId, query.tool)),
        0,
        -1
      );
    } else if (query.categories && query.categories.length === 1) {
      skillIds = await this.redis.zrevrange(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, query.categories[0])),
        0,
        -1
      );
    } else if (query.tags && query.tags.length === 1) {
      skillIds = await this.redis.zrevrange(
        this.key(REDIS_KEYS.skillsByTag(this.userId, query.tags[0])),
        0,
        -1
      );
    } else {
      // Default to recent skills
      skillIds = await this.redis.zrevrange(
        this.key(REDIS_KEYS.skillsRecent(this.userId)),
        0,
        query.limit + query.offset
      );
    }

    if (skillIds.length === 0) {
      return [];
    }

    // Fetch skills
    const pipeline = this.redis.pipeline();
    for (const id of skillIds) {
      pipeline.get(this.key(REDIS_KEYS.skill(this.userId, id)));
    }

    const results = await pipeline.exec();
    if (!results) {
      return [];
    }

    let skills: Skill[] = results
      .map(([err, data]) => {
        if (err || !data) return null;
        try {
          return JSON.parse(data as string) as Skill;
        } catch {
          return null;
        }
      })
      .filter((s): s is Skill => s !== null);

    // Apply additional filters
    if (query.categories && query.categories.length > 0) {
      skills = skills.filter((s) => query.categories!.includes(s.category));
    }

    if (query.priorities && query.priorities.length > 0) {
      skills = skills.filter((s) => query.priorities!.includes(s.priority));
    }

    if (query.minValidatedCount !== undefined) {
      skills = skills.filter(
        (s) => s.validatedCount >= query.minValidatedCount!
      );
    }

    if (query.language) {
      skills = skills.filter((s) => s.language === query.language);
    }

    if (query.framework) {
      skills = skills.filter((s) => s.framework === query.framework);
    }

    // Sort
    skills.sort((a, b) => {
      let aVal: number, bVal: number;

      switch (query.sortBy) {
        case 'priority':
          aVal = this.priorityScore(a.priority);
          bVal = this.priorityScore(b.priority);
          break;
        case 'validatedCount':
          aVal = a.validatedCount;
          bVal = b.validatedCount;
          break;
        case 'createdAt':
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
          break;
        case 'updatedAt':
          aVal = new Date(a.updatedAt).getTime();
          bVal = new Date(b.updatedAt).getTime();
          break;
        default:
          aVal = this.priorityScore(a.priority);
          bVal = this.priorityScore(b.priority);
      }

      return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });

    // Apply pagination
    return skills.slice(query.offset, query.offset + query.limit);
  }

  /**
   * Get skills relevant to current context
   */
  async getRelevantSkills(context: {
    tool?: string;
    language?: string;
    framework?: string;
    tags?: string[];
  }): Promise<Skill[]> {
    const skills: Skill[] = [];
    const seenIds = new Set<string>();

    // Always include critical skills
    const criticalIds = await this.redis.zrevrange(
      this.key(REDIS_KEYS.skillsByCategory(this.userId, 'correction')),
      0,
      -1
    );

    for (const id of criticalIds) {
      const skill = await this.getSkill(id);
      if (skill && skill.priority === 'critical' && !seenIds.has(id)) {
        skills.push(skill);
        seenIds.add(id);
      }
    }

    // Get tool-specific skills
    if (context.tool) {
      const toolSkills = await this.querySkills({
        tool: context.tool,
        limit: 20,
        offset: 0,
        sortBy: 'priority',
        sortOrder: 'desc',
      });

      for (const skill of toolSkills) {
        if (!seenIds.has(skill.id)) {
          skills.push(skill);
          seenIds.add(skill.id);
        }
      }
    }

    // Get highly validated skills
    const validatedIds = await this.redis.zrevrange(
      this.key(REDIS_KEYS.skillsValidated(this.userId)),
      0,
      10
    );

    for (const id of validatedIds) {
      if (!seenIds.has(id)) {
        const skill = await this.getSkill(id);
        if (skill) {
          skills.push(skill);
          seenIds.add(id);
        }
      }
    }

    return skills.slice(0, 50); // Cap at 50 skills
  }

  // ============================================================
  // SESSION JOURNAL
  // ============================================================

  /**
   * Create a journal entry
   */
  async createJournalEntry(
    sessionId: string,
    type: JournalEntryType,
    title: string,
    content: string,
    context?: JournalEntry['context']
  ): Promise<JournalEntry> {
    const entry: JournalEntry = {
      id: uuidv4(),
      sessionId,
      type,
      title,
      content,
      context,
      createdAt: new Date().toISOString(),
    };

    // Validate
    JournalEntrySchema.parse(entry);

    const pipeline = this.redis.pipeline();

    // Store entry
    pipeline.setex(
      this.key(REDIS_KEYS.journalEntry(this.userId, entry.id)),
      CACHE_TTL.journal,
      JSON.stringify(entry)
    );

    // Index by session
    pipeline.zadd(
      this.key(REDIS_KEYS.journalSession(this.userId, sessionId)),
      Date.now(),
      entry.id
    );

    // Add to recent journal
    pipeline.zadd(
      this.key(REDIS_KEYS.journalRecent(this.userId)),
      Date.now(),
      entry.id
    );
    pipeline.zremrangebyrank(
      this.key(REDIS_KEYS.journalRecent(this.userId)),
      0,
      -501
    ); // Keep last 500

    await pipeline.exec();

    logger.info('Created journal entry', {
      userId: this.userId,
      id: entry.id,
      sessionId,
      type,
      title,
    });

    return entry;
  }

  /**
   * Get journal entries for a session
   */
  async getSessionJournal(sessionId: string): Promise<JournalEntry[]> {
    const entryIds = await this.redis.zrevrange(
      this.key(REDIS_KEYS.journalSession(this.userId, sessionId)),
      0,
      -1
    );

    if (entryIds.length === 0) {
      return [];
    }

    const pipeline = this.redis.pipeline();
    for (const id of entryIds) {
      pipeline.get(this.key(REDIS_KEYS.journalEntry(this.userId, id)));
    }

    const results = await pipeline.exec();
    if (!results) {
      return [];
    }

    return results
      .map(([err, data]) => {
        if (err || !data) return null;
        try {
          return JSON.parse(data as string) as JournalEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is JournalEntry => e !== null);
  }

  /**
   * Promote a journal entry to a skill
   */
  async promoteToSkill(
    entryId: string,
    category: SkillCategory,
    priority: SkillPriority = 'medium'
  ): Promise<Skill | null> {
    const entryData = await this.redis.get(
      this.key(REDIS_KEYS.journalEntry(this.userId, entryId))
    );

    if (!entryData) {
      return null;
    }

    const entry = JSON.parse(entryData) as JournalEntry;

    const skill = await this.createSkill({
      content: entry.content,
      summary: entry.title,
      category,
      priority,
      tags: [],
      tool: entry.context?.tool,
      source: 'observation',
      sessionId: entry.sessionId,
    });

    // Update entry with promotion reference
    entry.promotedToSkillId = skill.id;
    await this.redis.setex(
      this.key(REDIS_KEYS.journalEntry(this.userId, entryId)),
      CACHE_TTL.journal,
      JSON.stringify(entry)
    );

    logger.info('Promoted journal entry to skill', {
      userId: this.userId,
      entryId,
      skillId: skill.id,
    });

    return skill;
  }

  // ============================================================
  // SESSION MANAGEMENT
  // ============================================================

  /**
   * Start tracking a new session
   */
  async startSession(sessionId: string): Promise<void> {
    const summary: SessionSummary = {
      sessionId,
      startedAt: new Date().toISOString(),
      entriesCount: 0,
      correctionsCount: 0,
      decisionsCount: 0,
      keyLearnings: [],
      promotedSkillIds: [],
    };

    await this.redis.setex(
      this.key(REDIS_KEYS.sessionSummary(this.userId, sessionId)),
      CACHE_TTL.session,
      JSON.stringify(summary)
    );

    await this.redis.sadd(
      this.key(REDIS_KEYS.sessionsActive(this.userId)),
      sessionId
    );

    logger.info('Started session tracking', { userId: this.userId, sessionId });
  }

  /**
   * End a session and generate summary
   */
  async endSession(sessionId: string): Promise<SessionSummary | null> {
    const summaryData = await this.redis.get(
      this.key(REDIS_KEYS.sessionSummary(this.userId, sessionId))
    );

    if (!summaryData) {
      return null;
    }

    const summary = JSON.parse(summaryData) as SessionSummary;
    summary.endedAt = new Date().toISOString();

    // Count entries by type
    const entries = await this.getSessionJournal(sessionId);
    summary.entriesCount = entries.length;
    summary.correctionsCount = entries.filter(
      (e) => e.type === 'correction'
    ).length;
    summary.decisionsCount = entries.filter(
      (e) => e.type === 'decision'
    ).length;

    // Extract key learnings
    summary.keyLearnings = entries
      .filter((e) => e.type === 'correction' || e.type === 'resolution')
      .slice(0, 5)
      .map((e) => e.title);

    // Get promoted skills
    summary.promotedSkillIds = entries
      .filter((e) => e.promotedToSkillId)
      .map((e) => e.promotedToSkillId!);

    await this.redis.setex(
      this.key(REDIS_KEYS.sessionSummary(this.userId, sessionId)),
      CACHE_TTL.session,
      JSON.stringify(summary)
    );

    await this.redis.srem(
      this.key(REDIS_KEYS.sessionsActive(this.userId)),
      sessionId
    );

    logger.info('Ended session', {
      userId: this.userId,
      sessionId,
      entriesCount: summary.entriesCount,
      keyLearnings: summary.keyLearnings.length,
    });

    return summary;
  }

  /**
   * Get session summary
   */
  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const data = await this.redis.get(
      this.key(REDIS_KEYS.sessionSummary(this.userId, sessionId))
    );

    if (!data) {
      return null;
    }

    return JSON.parse(data) as SessionSummary;
  }

  // ============================================================
  // KNOWLEDGE HYGIENE
  // ============================================================

  /**
   * Get skills eligible for promotion
   */
  async getPromotionCandidates(): Promise<Skill[]> {
    const ids = await this.redis.smembers(
      this.key(REDIS_KEYS.promotionCandidates(this.userId))
    );

    const skills: Skill[] = [];
    for (const id of ids) {
      const skill = await this.getSkill(id);
      if (skill && skill.validatedCount >= 3) {
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Promote a skill (increase priority)
   */
  async promoteSkill(id: string): Promise<Skill | null> {
    const skill = await this.getSkill(id);
    if (!skill) {
      return null;
    }

    const priorityOrder: SkillPriority[] = [
      'low',
      'medium',
      'high',
      'critical',
    ];
    const currentIndex = priorityOrder.indexOf(skill.priority);

    if (currentIndex < priorityOrder.length - 1) {
      skill.priority = priorityOrder[currentIndex + 1];
      skill.updatedAt = new Date().toISOString();

      await this.redis.setex(
        this.key(REDIS_KEYS.skill(this.userId, id)),
        calculateSkillTTL(skill.validatedCount),
        JSON.stringify(skill)
      );

      // Update category index with new score
      await this.redis.zadd(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, skill.category)),
        this.priorityScore(skill.priority),
        id
      );

      // Remove from promotion candidates if now critical
      if (skill.priority === 'critical') {
        await this.redis.srem(
          this.key(REDIS_KEYS.promotionCandidates(this.userId)),
          id
        );
      }

      logger.info('Promoted skill', {
        userId: this.userId,
        id,
        newPriority: skill.priority,
      });
    }

    return skill;
  }

  /**
   * Archive stale skills (not validated in 90 days)
   */
  async archiveStaleSkills(daysThreshold: number = 90): Promise<number> {
    const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
    let archivedCount = 0;

    // Get all recent skills
    const skillIds = await this.redis.zrangebyscore(
      this.key(REDIS_KEYS.skillsRecent(this.userId)),
      0,
      cutoff
    );

    for (const id of skillIds) {
      const skill = await this.getSkill(id);
      if (skill && skill.priority !== 'critical') {
        // Check if it was validated recently
        if (
          !skill.lastValidated ||
          new Date(skill.lastValidated).getTime() < cutoff
        ) {
          // Downgrade to low priority instead of deleting
          if (skill.priority !== 'low') {
            skill.priority = 'low';
            skill.updatedAt = new Date().toISOString();
            await this.redis.setex(
              this.key(REDIS_KEYS.skill(this.userId, id)),
              calculateSkillTTL(skill.validatedCount),
              JSON.stringify(skill)
            );
            archivedCount++;
          }
        }
      }
    }

    logger.info('Archived stale skills', {
      userId: this.userId,
      archivedCount,
      daysThreshold,
    });

    return archivedCount;
  }

  // ============================================================
  // METRICS & UTILITIES
  // ============================================================

  /**
   * Get storage metrics
   */
  async getMetrics(): Promise<SkillStorageMetrics> {
    const [
      skillsTotal,
      toolSkills,
      workflowSkills,
      correctionSkills,
      patternSkills,
      preferenceSkills,
      pitfallSkills,
      optimizationSkills,
      journalTotal,
      sessionsActive,
    ] = await Promise.all([
      this.redis.zcard(this.key(REDIS_KEYS.skillsRecent(this.userId))),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'tool'))
      ),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'workflow'))
      ),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'correction'))
      ),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'pattern'))
      ),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'preference'))
      ),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'pitfall'))
      ),
      this.redis.zcard(
        this.key(REDIS_KEYS.skillsByCategory(this.userId, 'optimization'))
      ),
      this.redis.zcard(this.key(REDIS_KEYS.journalRecent(this.userId))),
      this.redis.scard(this.key(REDIS_KEYS.sessionsActive(this.userId))),
    ]);

    return {
      userId: this.userId,
      skillsTotal,
      skillsByCategory: {
        tool: toolSkills,
        workflow: workflowSkills,
        correction: correctionSkills,
        pattern: patternSkills,
        preference: preferenceSkills,
        pitfall: pitfallSkills,
        optimization: optimizationSkills,
      },
      journalEntriesTotal: journalTotal,
      sessionsTracked: sessionsActive,
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
    };
  }

  /**
   * Priority to numeric score for sorting
   */
  private priorityScore(priority: SkillPriority): number {
    const scores: Record<SkillPriority, number> = {
      critical: 1000,
      high: 100,
      medium: 10,
      low: 1,
    };
    return scores[priority];
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
    logger.info('SkillStorageService closed');
  }
}

// ============================================================
// SINGLETON INSTANCES (per user)
// ============================================================

const userStorageInstances = new Map<string, SkillStorageService>();

/**
 * Get or create skill storage instance for a user
 */
export function getSkillStorage(
  config: SkillStorageConfig
): SkillStorageService {
  const existing = userStorageInstances.get(config.userId);
  if (existing) {
    return existing;
  }

  const instance = new SkillStorageService(config);
  userStorageInstances.set(config.userId, instance);
  return instance;
}

/**
 * Initialize skill storage with Redis URL from environment
 */
export function initializeSkillStorage(
  userId: string,
  redisUrl?: string
): SkillStorageService {
  const url = redisUrl || process.env['REDIS_URL'];

  if (!url) {
    throw new Error('REDIS_URL environment variable not set');
  }

  return getSkillStorage({ redisUrl: url, userId });
}

/**
 * Get default user ID from environment or generate one
 */
export function getDefaultUserId(): string {
  return (
    process.env['STACKMEMORY_USER_ID'] ||
    process.env['USER'] ||
    process.env['USERNAME'] ||
    'default'
  );
}
