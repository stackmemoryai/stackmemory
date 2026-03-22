/**
 * MCP Skill Handlers
 * Handlers for persistent agent learning and skill operations
 * Backed by SQLite via SkillRegistry (replaces Redis)
 */

import { logger } from '../../../core/monitoring/logger.js';
import {
  SkillRegistry,
  getSkillRegistry,
  matchPromptFromRegistry,
} from '../../../core/skills/index.js';
import type {
  Skill,
  SkillCategory,
  SkillPriority,
  JournalEntryType,
  SkillQuery,
  MatchResult,
} from '../../../core/skills/index.js';

export interface SkillHandlerContext {
  sessionId?: string;
  projectId?: string;
  userId?: string;
}

export class SkillHandlers {
  private registry: SkillRegistry | null = null;

  constructor(private dbPath?: string) {}

  private getRegistry(): SkillRegistry {
    if (!this.registry) {
      this.registry = getSkillRegistry(this.dbPath);
    }
    return this.registry;
  }

  isAvailable(): boolean {
    return !!(process.env['STACKMEMORY_SKILLS'] || process.env['SM_SKILLS']);
  }

  // ============================================================
  // SKILL OPERATIONS
  // ============================================================

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
      const registry = this.getRegistry();
      const skill = registry.createSkill({
        content: args.content,
        category: args.category as SkillCategory,
        priority: (args.priority || 'medium') as SkillPriority,
        tool: args.tool,
        tags: args.tags || [],
        source: (args.source || 'observation') as Skill['source'],
        sessionId: context.sessionId,
      });
      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to record skill', { error: message });
      return { success: false, error: message };
    }
  }

  async getRelevantSkills(args: {
    tool?: string;
    language?: string;
    framework?: string;
    tags?: string[];
    limit?: number;
  }): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const registry = this.getRegistry();
      const skills = registry.getRelevantSkills({
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
      const registry = this.getRegistry();
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
      const skills = registry.querySkills(query);
      return { success: true, skills, total: skills.length };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to query skills', { error: message });
      return { success: false, error: message };
    }
  }

  async validateSkill(args: {
    skill_id: string;
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const registry = this.getRegistry();
      const skill = registry.validateSkill(args.skill_id);
      if (!skill) return { success: false, error: 'Skill not found' };
      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to validate skill', { error: message });
      return { success: false, error: message };
    }
  }

  async updateSkill(args: {
    skill_id: string;
    content?: string;
    priority?: string;
    tags?: string[];
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const registry = this.getRegistry();
      const skill = registry.updateSkill({
        id: args.skill_id,
        content: args.content,
        priority: args.priority as SkillPriority,
        tags: args.tags,
      });
      if (!skill) return { success: false, error: 'Skill not found' };
      return { success: true, skill };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to update skill', { error: message });
      return { success: false, error: message };
    }
  }

  async deleteSkill(args: {
    skill_id: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const registry = this.getRegistry();
      const deleted = registry.deleteSkill(args.skill_id);
      if (!deleted) return { success: false, error: 'Skill not found' };
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to delete skill', { error: message });
      return { success: false, error: message };
    }
  }

  // ============================================================
  // MATCH PROMPT (NEW)
  // ============================================================

  async matchPrompt(args: {
    prompt: string;
  }): Promise<{ success: boolean; result?: MatchResult; error?: string }> {
    try {
      const result = matchPromptFromRegistry(args.prompt);
      return { success: true, result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to match prompt', { error: message });
      return { success: false, error: message };
    }
  }

  // ============================================================
  // SESSION JOURNAL OPERATIONS
  // ============================================================

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
      const registry = this.getRegistry();
      const sessionId = context.sessionId || 'default';
      const entry = registry.createJournalEntry(
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

  async getSessionJournal(
    args: { session_id?: string },
    context: SkillHandlerContext
  ): Promise<{ success: boolean; entries?: unknown[]; error?: string }> {
    try {
      const registry = this.getRegistry();
      const sessionId = args.session_id || context.sessionId || 'default';
      const entries = registry.getSessionJournal(sessionId);
      return { success: true, entries };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get session journal', { error: message });
      return { success: false, error: message };
    }
  }

  async promoteToSkill(args: {
    entry_id: string;
    category: string;
    priority?: string;
  }): Promise<{ success: boolean; skill?: Skill; error?: string }> {
    try {
      const registry = this.getRegistry();
      const skill = registry.promoteToSkill(
        args.entry_id,
        args.category as SkillCategory,
        (args.priority || 'medium') as SkillPriority
      );
      if (!skill) return { success: false, error: 'Journal entry not found' };
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

  async startSession(args: {
    session_id: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const registry = this.getRegistry();
      registry.startSession(args.session_id);
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to start session', { error: message });
      return { success: false, error: message };
    }
  }

  async endSession(args: {
    session_id: string;
  }): Promise<{ success: boolean; summary?: unknown; error?: string }> {
    try {
      const registry = this.getRegistry();
      const summary = registry.endSession(args.session_id);
      if (!summary) return { success: false, error: 'Session not found' };
      return { success: true, summary };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to end session', { error: message });
      return { success: false, error: message };
    }
  }

  // ============================================================
  // METRICS
  // ============================================================

  async getSkillMetrics(): Promise<{
    success: boolean;
    metrics?: unknown;
    error?: string;
  }> {
    try {
      const registry = this.getRegistry();
      const metrics = registry.getMetrics();
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
  {
    name: 'match_prompt',
    description:
      'Match a prompt against skill rules and return scored skill suggestions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'The prompt text to match against skill rules',
        },
      },
      required: ['prompt'],
    },
  },
];
