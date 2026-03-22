/**
 * Skill Storage Types
 * Types for persistent agent learning and skill memory
 */

import { z } from 'zod';

// ============================================================
// SKILL SCHEMAS
// ============================================================

/**
 * Skill category for organization
 */
export const SkillCategorySchema = z.enum([
  'tool', // Tool-specific patterns
  'workflow', // Process/workflow improvements
  'correction', // User corrections to remember
  'pattern', // Code/architecture patterns
  'preference', // User preferences
  'pitfall', // Things to avoid
  'optimization', // Performance/efficiency tips
]);

export type SkillCategory = z.infer<typeof SkillCategorySchema>;

/**
 * Skill priority for retrieval ordering
 */
export const SkillPrioritySchema = z.enum([
  'critical', // Always include in context
  'high', // Include when relevant
  'medium', // Include if space permits
  'low', // Archive/reference only
]);

export type SkillPriority = z.infer<typeof SkillPrioritySchema>;

/**
 * Individual skill/learning entry
 */
export const SkillSchema = z.object({
  id: z.string().uuid(),

  // Content
  content: z.string().min(1).max(5000),
  summary: z.string().max(500).optional(),

  // Classification
  category: SkillCategorySchema,
  priority: SkillPrioritySchema.default('medium'),
  tags: z.array(z.string()).default([]),

  // Context
  tool: z.string().optional(), // Related tool name
  project: z.string().optional(), // Project context
  language: z.string().optional(), // Programming language
  framework: z.string().optional(), // Framework context

  // Validation tracking
  validatedCount: z.number().int().min(0).default(0),
  lastValidated: z.string().datetime().optional(),

  // Lifecycle
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),

  // Source tracking
  source: z.enum(['correction', 'observation', 'explicit', 'inferred']),
  sessionId: z.string().optional(),
});

export type Skill = z.infer<typeof SkillSchema>;

/**
 * Skill creation input
 */
export const CreateSkillSchema = SkillSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  validatedCount: true,
});

export type CreateSkillInput = z.infer<typeof CreateSkillSchema>;

/**
 * Skill update input
 */
export const UpdateSkillSchema = SkillSchema.partial().extend({
  id: z.string().uuid(),
});

export type UpdateSkillInput = z.infer<typeof UpdateSkillSchema>;

// ============================================================
// SESSION JOURNAL SCHEMAS
// ============================================================

/**
 * Session journal entry type
 */
export const JournalEntryTypeSchema = z.enum([
  'decision', // Architectural/design decision
  'correction', // User corrected agent behavior
  'blocker', // Issue encountered
  'resolution', // How an issue was resolved
  'observation', // Noticed pattern or behavior
  'outcome', // Result of an action
]);

export type JournalEntryType = z.infer<typeof JournalEntryTypeSchema>;

/**
 * Session journal entry
 */
export const JournalEntrySchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  type: JournalEntryTypeSchema,

  // Content
  title: z.string().max(200),
  content: z.string().max(5000),

  // Context
  context: z
    .object({
      file: z.string().optional(),
      tool: z.string().optional(),
      command: z.string().optional(),
    })
    .optional(),

  // Outcome tracking
  outcome: z.enum(['success', 'failure', 'partial', 'pending']).optional(),

  // Timestamps
  createdAt: z.string().datetime(),

  // Link to promoted skill
  promotedToSkillId: z.string().uuid().optional(),
});

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/**
 * Session summary
 */
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),

  // Stats
  entriesCount: z.number().int().min(0),
  correctionsCount: z.number().int().min(0),
  decisionsCount: z.number().int().min(0),

  // Key learnings from this session
  keyLearnings: z.array(z.string()).default([]),

  // Skills promoted from this session
  promotedSkillIds: z.array(z.string().uuid()).default([]),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// ============================================================
// QUERY SCHEMAS
// ============================================================

/**
 * Skill query filters
 */
export const SkillQuerySchema = z.object({
  // Filter by classification
  categories: z.array(SkillCategorySchema).optional(),
  priorities: z.array(SkillPrioritySchema).optional(),
  tags: z.array(z.string()).optional(),

  // Filter by context
  tool: z.string().optional(),
  project: z.string().optional(),
  language: z.string().optional(),
  framework: z.string().optional(),

  // Filter by validation
  minValidatedCount: z.number().int().min(0).optional(),

  // Pagination
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),

  // Sorting
  sortBy: z
    .enum(['priority', 'validatedCount', 'createdAt', 'updatedAt'])
    .default('priority'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type SkillQuery = z.infer<typeof SkillQuerySchema>;

// ============================================================
// SKILL RULE / MATCHER TYPES
// ============================================================

/**
 * Trigger conditions for a skill rule
 */
export interface SkillTriggers {
  keywords?: string[];
  keywordPatterns?: string[];
  pathPatterns?: string[];
  intentPatterns?: string[];
  contentPatterns?: string[];
  contextPatterns?: string[];
}

/**
 * A single skill rule definition (from skill-rules.json)
 */
export interface SkillRule {
  description: string;
  priority: number;
  triggers: SkillTriggers;
  excludePatterns?: string[];
  relatedSkills?: string[];
  suggestion?: string;
}

/**
 * Result of matching a single skill against a prompt
 */
export interface SkillMatch {
  name: string;
  score: number;
  reasons: string[];
  priority: number;
}

/**
 * Full result of matching all rules against a prompt
 */
export interface MatchResult {
  matches: SkillMatch[];
  filePaths: string[];
  relatedSkills: string[];
}

/**
 * Global matcher configuration
 */
export interface MatcherConfig {
  minConfidenceScore: number;
  showMatchReasons: boolean;
  maxSkillsToShow: number;
}

/**
 * Scoring weights per match type
 */
export interface ScoringWeights {
  keyword: number;
  keywordPattern: number;
  pathPattern: number;
  directoryMatch: number;
  intentPattern: number;
  contentPattern: number;
  contextPattern: number;
}

/**
 * Directory path → skill name mapping
 */
export type DirectoryMapping = Record<string, string>;

/**
 * Confidence level label
 */
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Complete rules file structure (mirrors skill-rules.json)
 */
export interface SkillRulesFile {
  version: string;
  config: MatcherConfig;
  scoring: ScoringWeights;
  directoryMappings: DirectoryMapping;
  skills: Record<string, SkillRule>;
}
