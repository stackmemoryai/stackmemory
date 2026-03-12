/**
 * MCP Skill Handlers
 * Handlers for persistent agent learning and skill operations
 */

import { logger } from '../../../core/monitoring/logger.js';

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
  SkillStorageService,
  getSkillStorage,
  getDefaultUserId,
  Skill,
  SkillCategory,
  SkillPriority,
  JournalEntryType,
  SkillQuery,
} from '../../../core/skills/index.js';

export interface SkillHandlerContext {
  sessionId?: string;
  projectId?: string;
  userId?: string;
}

export class SkillHandlers {
  private skillStorage: SkillStorageService | null = null;
  private userId: string;

  constructor(
    private redisUrl?: string,
    userId?: string
  ) {
    this.userId = userId || getDefaultUserId();
  }

  /**
   * Lazy initialization of skill storage
   */
  private getStorage(): SkillStorageService {
    if (!this.skillStorage) {
      const url = this.redisUrl || process.env['REDIS_URL'];
      if (!url) {
        throw new Error('REDIS_URL not configured for skill storage');
      }
      this.skillStorage = getSkillStorage({
        redisUrl: url,
        userId: this.userId,
      });
    }
    return this.skillStorage;
  }

  /**
   * Get current user ID
   */
  getUserId(): string {
    return this.userId;
  }

  /**
   * Check if skill storage is available
   */
  isAvailable(): boolean {
    return !!(this.redisUrl || process.env['REDIS_URL']);
  }

  // ============================================================
  // SKILL OPERATIONS
  // ============================================================

  /**
   * Record a new skill/learning
   */
  async recordSkill(
    args: {
      content: string;
      category: string;
      priority?: string;
      tool?: string;
      tags?: string[];
      source?: string;
    },
    context: SkillHandlerContext
  ): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const storage = this.getStorage();

      const skill = await storage.createSkill({
        content: args.content,
        category: args.category as SkillCategory,
        priority: (args.priority || 'medium') as SkillPriority,
        tool: args.tool,
        tags: args.tags || [],
        source: (args.source || 'observation') as Skill['source'],
        sessionId: context.sessionId,
      });

      logger.info('Recorded skill via MCP', {
        skillId: skill.id,
        category: skill.category,
      });

      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to record skill', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Get relevant skills for current context
   */
  async getRelevantSkills(args: {
    tool?: string;
    language?: string;
    framework?: string;
    tags?: string[];
    limit?: number;
  }): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const storage = this.getStorage();

      const skills = await storage.getRelevantSkills({
        tool: args.tool,
        language: args.language,
        framework: args.framework,
        tags: args.tags,
      });

      const limited = args.limit ? skills.slice(0, args.limit) : skills;

      return { success: true, skills: limited };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get relevant skills', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Query skills with filters
   */
  async querySkills(args: {
    categories?: string[];
    priorities?: string[];
    tool?: string;
    tags?: string[];
    minValidatedCount?: number;
    limit?: number;
    sortBy?: string;
  }): Promise<{
    success: boolean;
    skills?: Skill[];
    total?: number;
    error?: string;
  }> {
    try {
      const storage = this.getStorage();

      const query: SkillQuery = {
        categories: args.categories as SkillCategory[],
        priorities: args.priorities as SkillPriority[],
        tool: args.tool,
        tags: args.tags,
        minValidatedCount: args.minValidatedCount,
        limit: args.limit || 50,
        offset: 0,
        sortBy: (args.sortBy || 'priority') as SkillQuery['sortBy'],
        sortOrder: 'desc',
      };

      const skills = await storage.querySkills(query);

      return { success: true, skills, total: skills.length };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query skills', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Validate/reinforce a skill
   */
  async validateSkill(args: {
    skill_id: string;
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const storage = this.getStorage();

      const skill = await storage.validateSkill(args.skill_id);
      if (!skill) {
        return { success: false, error: 'Skill not found' };
      }

      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to validate skill', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Update a skill
   */
  async updateSkill(args: {
    skill_id: string;
    content?: string;
    priority?: string;
    tags?: string[];
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const storage = this.getStorage();

      const skill = await storage.updateSkill({
        id: args.skill_id,
        content: args.content,
        priority: args.priority as SkillPriority,
        tags: args.tags,
      });

      if (!skill) {
        return { success: false, error: 'Skill not found' };
      }

      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to update skill', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Delete a skill
   */
  async deleteSkill(args: {
    skill_id: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const storage = this.getStorage();

      const deleted = await storage.deleteSkill(args.skill_id);
      if (!deleted) {
        return { success: false, error: 'Skill not found' };
      }

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete skill', { error: message });
      return { success: false, error: message };
    }
  }

  // ============================================================
  // SESSION JOURNAL OPERATIONS
  // ============================================================

  /**
   * Record a journal entry
   */
  async recordJournalEntry(
    args: {
      type: string;
      title: string;
      content: string;
      tool?: string;
      file?: string;
    },
    context: SkillHandlerContext
  ): Promise<{ success: boolean; entryId?: string; error?: string }> {
    try {
      const storage = this.getStorage();
      const sessionId = context.sessionId || 'default';

      const entry = await storage.createJournalEntry(
        sessionId,
        args.type as JournalEntryType,
        args.title,
        args.content,
        { tool: args.tool, file: args.file }
      );

      return { success: true, entryId: entry.id };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to record journal entry', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Get session journal
   */
  async getSessionJournal(
    args: {
      session_id?: string;
    },
    context: SkillHandlerContext
  ): Promise<{ success: boolean; entries?: any[]; error?: string }> {
    try {
      const storage = this.getStorage();
      const sessionId = args.session_id || context.sessionId || 'default';

      const entries = await storage.getSessionJournal(sessionId);

      return { success: true, entries };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get session journal', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Promote a journal entry to a skill
   */
  async promoteToSkill(args: {
    entry_id: string;
    category: string;
    priority?: string;
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const storage = this.getStorage();

      const skill = await storage.promoteToSkill(
        args.entry_id,
        args.category as SkillCategory,
        (args.priority || 'medium') as SkillPriority
      );

      if (!skill) {
        return { success: false, error: 'Journal entry not found' };
      }

      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to promote journal entry', { error: message });
      return { success: false, error: message };
    }
  }

  // ============================================================
  // SESSION MANAGEMENT
  // ============================================================

  /**
   * Start session tracking
   */
  async startSession(args: {
    session_id: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const storage = this.getStorage();
      await storage.startSession(args.session_id);
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to start session', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * End session and get summary
   */
  async endSession(args: {
    session_id: string;
  }): Promise<{ success: boolean; summary?: any; error?: string }> {
    try {
      const storage = this.getStorage();
      const summary = await storage.endSession(args.session_id);

      if (!summary) {
        return { success: false, error: 'Session not found' };
      }

      return { success: true, summary };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to end session', { error: message });
      return { success: false, error: message };
    }
  }

  // ============================================================
  // KNOWLEDGE MANAGEMENT
  // ============================================================

  /**
   * Get promotion candidates
   */
  async getPromotionCandidates(): Promise<{
    success: boolean;
    skills?: Skill[];
    error?: string;
  }> {
    try {
      const storage = this.getStorage();
      const skills = await storage.getPromotionCandidates();
      return { success: true, skills };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get promotion candidates', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Promote skill priority
   */
  async promoteSkillPriority(args: {
    skill_id: string;
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const storage = this.getStorage();
      const skill = await storage.promoteSkill(args.skill_id);

      if (!skill) {
        return { success: false, error: 'Skill not found' };
      }

      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to promote skill priority', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Archive stale skills
   */
  async archiveStaleSkills(args: {
    days_threshold?: number;
  }): Promise<{ success: boolean; archivedCount?: number; error?: string }> {
    try {
      const storage = this.getStorage();
      const count = await storage.archiveStaleSkills(args.days_threshold || 90);
      return { success: true, archivedCount: count };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to archive stale skills', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Get skill storage metrics
   */
  async getSkillMetrics(): Promise<{
    success: boolean;
    metrics?: any;
    error?: string;
  }> {
    try {
      const storage = this.getStorage();
      const metrics = await storage.getMetrics();
      return { success: true, metrics };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get skill metrics', { error: message });
      return { success: false, error: message };
    }
  }
}

// ============================================================
// TOOL DEFINITIONS FOR SKILLS
// ============================================================

export const SKILL_TOOL_DEFINITIONS = [
  {
    name: 'record_skill',
    description:
      'Record a new learning, pattern, or skill to remember across sessions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The skill/learning content to remember',
        },
        category: {
          type: 'string',
          enum: [
            'tool',
            'workflow',
            'correction',
            'pattern',
            'preference',
            'pitfall',
            'optimization',
          ],
          description: 'Category of the skill',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          default: 'medium',
          description: 'How important this skill is',
        },
        tool: {
          type: 'string',
          description: 'Related tool name (if applicable)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
      },
      required: ['content', 'category'],
    },
  },
  {
    name: 'get_relevant_skills',
    description:
      'Get skills relevant to current context (tool, language, etc.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tool: {
          type: 'string',
          description: 'Filter by tool name',
        },
        language: {
          type: 'string',
          description: 'Filter by programming language',
        },
        framework: {
          type: 'string',
          description: 'Filter by framework',
        },
        limit: {
          type: 'number',
          default: 20,
          description: 'Maximum skills to return',
        },
      },
    },
  },
  {
    name: 'validate_skill',
    description:
      'Mark a skill as validated/reinforced (increases its importance)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_id: {
          type: 'string',
          description: 'ID of the skill to validate',
        },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'record_correction',
    description:
      'Record a user correction to remember and apply in future sessions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Brief title of the correction',
        },
        content: {
          type: 'string',
          description: 'What was corrected and how to do it correctly',
        },
        tool: {
          type: 'string',
          description: 'Related tool (if applicable)',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'record_decision',
    description: 'Record an important decision made during this session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Brief title of the decision',
        },
        content: {
          type: 'string',
          description: 'The decision and its reasoning',
        },
        file: {
          type: 'string',
          description: 'Related file path (if applicable)',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'get_session_learnings',
    description:
      'Get all learnings and corrections from current or specified session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID (defaults to current)',
        },
      },
    },
  },
  {
    name: 'promote_learning',
    description: 'Promote a session learning to a permanent skill',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entry_id: {
          type: 'string',
          description: 'Journal entry ID to promote',
        },
        category: {
          type: 'string',
          enum: [
            'tool',
            'workflow',
            'correction',
            'pattern',
            'preference',
            'pitfall',
            'optimization',
          ],
          description: 'Skill category',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          default: 'medium',
          description: 'Skill priority',
        },
      },
      required: ['entry_id', 'category'],
    },
  },
  {
    name: 'get_skill_metrics',
    description: 'Get metrics about stored skills and learnings',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];
