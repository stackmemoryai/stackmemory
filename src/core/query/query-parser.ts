/**
 * Query Parser for StackMemory
 * Handles both natural language and structured queries
 */

import { QueryTemplates, InlineModifierParser } from './query-templates.js';

export interface TimeFilter {
  last?: string; // "1d", "3h", "1w", "2m"
  since?: Date;
  until?: Date;
  between?: [Date, Date];
  specific?: Date;
}

export interface ContentFilter {
  topic?: string[];
  files?: string[];
  errors?: string[];
  tools?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
}

export interface FrameFilter {
  type?: FrameType[];
  status?: FrameStatus[];
  score?: {
    min?: number;
    max?: number;
  };
  depth?: {
    min?: number;
    max?: number;
  };
}

export interface PeopleFilter {
  owner?: string[];
  contributors?: string[];
  team?: string;
}

export interface OutputControl {
  limit?: number;
  sort?: 'time' | 'score' | 'relevance';
  include?: ('digests' | 'events' | 'anchors')[];
  format?: 'full' | 'summary' | 'ids';
  groupBy?: 'frame' | 'time' | 'owner' | 'topic';
}

export interface StackMemoryQuery {
  time?: TimeFilter;
  content?: ContentFilter;
  frame?: FrameFilter;
  people?: PeopleFilter;
  output?: OutputControl;
}

export interface QueryResponse {
  original: string;
  interpreted: StackMemoryQuery;
  expanded: StackMemoryQuery;
  suggestions?: string[];
  validationErrors?: string[];
}

export enum FrameType {
  TASK = 'task',
  DEBUG = 'debug',
  FEATURE = 'feature',
  ARCHITECTURE = 'architecture',
  BUG = 'bug',
  REFACTOR = 'refactor',
}

export enum FrameStatus {
  OPEN = 'open',
  CLOSED = 'closed',
  STALLED = 'stalled',
}

export class QueryParser {
  private templates = new QueryTemplates();
  private inlineParser = new InlineModifierParser();
  private shortcuts: Map<string, Partial<StackMemoryQuery>> = new Map([
    ['today', { time: { last: '24h' } }],
    [
      'yesterday',
      { time: { last: '48h', since: new Date(Date.now() - 48 * 3600000) } },
    ],
    ['this week', { time: { last: '7d' } }],
    ['last week', { time: { last: '1w' } }],
    ['this month', { time: { last: '30d' } }],
    ['bugs', { frame: { type: [FrameType.BUG, FrameType.DEBUG] } }],
    ['features', { frame: { type: [FrameType.FEATURE] } }],
    ['architecture', { frame: { type: [FrameType.ARCHITECTURE] } }],
    ['refactoring', { frame: { type: [FrameType.REFACTOR] } }],
    ['critical', { frame: { score: { min: 0.8 } } }],
    ['recent', { time: { last: '4h' } }],
    ['stalled', { frame: { status: [FrameStatus.STALLED] } }],
    ['my work', { people: { owner: ['$current_user'] } }],
    ['team work', { people: { team: '$current_team' } }],
  ]);

  /**
   * Parse natural language query into structured format
   */
  parseNaturalLanguage(query: string): StackMemoryQuery {
    // First check for query templates
    const templateResult = this.templates.matchTemplate(query);
    if (templateResult) {
      // Ensure template results have proper defaults
      const structured = templateResult as StackMemoryQuery;
      if (!structured.output) {
        structured.output = {
          limit: 50,
          sort: 'time',
          format: 'summary',
        };
      }
      return this.parseStructured(structured);
    }

    // Check for inline modifiers
    const { cleanQuery, modifiers } = this.inlineParser.parse(query);

    const result: StackMemoryQuery = {};
    const lowerQuery = cleanQuery.toLowerCase();

    // Time-based patterns
    this.parseTimePatterns(lowerQuery, result);

    // Topic-based patterns
    this.parseTopicPatterns(lowerQuery, result);

    // People-based patterns
    this.parsePeoplePatterns(lowerQuery, result);

    // Shortcut expansion
    this.expandShortcuts(lowerQuery, result);

    // Merge inline modifiers
    const merged = this.mergeQueries(result, modifiers);

    // Default output settings if not specified
    if (!merged.output) {
      merged.output = {
        limit: 50,
        sort: 'time',
        format: 'summary',
      };
    } else {
      // Ensure all output fields have defaults
      if (!merged.output.limit) merged.output.limit = 50;
      if (!merged.output.sort) merged.output.sort = 'time';
      if (!merged.output.format) merged.output.format = 'summary';
    }

    return merged;
  }

  /**
   * Parse structured query with validation
   */
  parseStructured(query: StackMemoryQuery): StackMemoryQuery {
    // Validate and normalize the query
    if (query.frame?.score) {
      if (query.frame.score.min !== undefined) {
        query.frame.score.min = Math.max(0, Math.min(1, query.frame.score.min));
      }
      if (query.frame.score.max !== undefined) {
        query.frame.score.max = Math.max(0, Math.min(1, query.frame.score.max));
      }
    }

    // Apply defaults
    if (!query.output) {
      query.output = {
        limit: 50,
        sort: 'time',
        format: 'full',
      };
    }

    return query;
  }

  /**
   * Parse hybrid query (natural language with structured modifiers)
   */
  parseHybrid(
    naturalQuery: string,
    modifiers?: Partial<StackMemoryQuery>
  ): StackMemoryQuery {
    const nlQuery = this.parseNaturalLanguage(naturalQuery);
    return this.mergeQueries(nlQuery, modifiers || {});
  }

  private parseTimePatterns(query: string, result: StackMemoryQuery): void {
    // "last day", "last week", "last month"
    const lastPattern = /last\s+(\d+)?\s*(day|hour|week|month)s?/i;
    const match = query.match(lastPattern);
    if (match) {
      const quantity = match[1] ? parseInt(match[1]) : 1;
      const unit = match[2].toLowerCase();
      const unitMap: Record<string, string> = {
        hour: 'h',
        day: 'd',
        week: 'w',
        month: 'm',
      };
      result.time = { last: `${quantity}${unitMap[unit]}` };
    }

    // "yesterday", "today", "this week"
    for (const [shortcut, value] of this.shortcuts) {
      if (query.includes(shortcut) && value.time) {
        result.time = { ...result.time, ...value.time };
      }
    }

    // Date patterns "December 15", "2024-12-20"
    const datePattern =
      /(\d{4}-\d{2}-\d{2})|((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2})/i;
    const dateMatch = query.match(datePattern);
    if (dateMatch) {
      try {
        const date = new Date(dateMatch[0]);
        if (!isNaN(date.getTime())) {
          result.time = { ...result.time, specific: date };
        }
      } catch {
        // Invalid date, ignore
      }
    }
  }

  private parseTopicPatterns(query: string, result: StackMemoryQuery): void {
    // Common topics - match word boundaries for most, but be flexible for compound words
    const topics = [
      'auth',
      'authentication',
      'login',
      'oauth',
      'database',
      'migration',
      'cache',
      'api',
      'bug',
      'bugs',
      'error',
      'fix',
      'feature',
      'features',
      'test',
      'security',
      'performance',
    ];

    const foundTopics: string[] = [];
    for (const topic of topics) {
      // Always use word boundaries to avoid false positives like "test" in "latest"
      const regex = new RegExp(`\\b${topic}\\b`, 'i');
      if (regex.test(query)) {
        // Normalize plurals
        const normalized =
          topic === 'bugs' ? 'bug' : topic === 'features' ? 'feature' : topic;
        if (!foundTopics.includes(normalized)) {
          foundTopics.push(normalized);
        }
      }
    }

    if (foundTopics.length > 0) {
      result.content = { ...result.content, topic: foundTopics };
    }

    // File patterns
    const filePattern = /(\w+\.\w+)|(\*\.\w+)/g;
    const files = query.match(filePattern);
    if (files) {
      result.content = { ...result.content, files };
    }
  }

  private parsePeoplePatterns(query: string, result: StackMemoryQuery): void {
    // "@alice", "@bob" mentions
    const mentionPattern = /@(\w+)/g;
    const mentions = [...query.matchAll(mentionPattern)].map((m) => m[1]);
    if (mentions.length > 0) {
      result.people = { owner: mentions };
    }

    // "alice's work", "bob's changes"
    const possessivePattern = /(\w+)'s\s+(work|changes|commits|frames)/i;
    const possMatch = query.match(possessivePattern);
    if (possMatch) {
      const person = possMatch[1].toLowerCase();
      if (!result.people) result.people = {};
      result.people = { ...result.people, owner: [person] };
    }

    // "team work" - use word boundaries to avoid false positives
    if (/\bteam\b/.test(query)) {
      if (!result.people) result.people = {};
      result.people = { ...result.people, team: '$current_team' };
    }
  }

  private expandShortcuts(query: string, result: StackMemoryQuery): void {
    // Priority shortcuts
    if (query.includes('critical')) {
      result.frame = {
        ...result.frame,
        score: { min: 0.8 },
      };
    } else if (query.includes('high')) {
      result.frame = {
        ...result.frame,
        score: { min: 0.7 },
      };
    }

    if (query.includes('low priority')) {
      result.frame = {
        ...result.frame,
        score: { max: 0.3 },
      };
    }

    // Status shortcuts
    if (query.includes('open') || query.includes('active')) {
      result.frame = {
        ...result.frame,
        status: [FrameStatus.OPEN],
      };
    }

    if (query.includes('closed') || query.includes('done')) {
      result.frame = {
        ...result.frame,
        status: [FrameStatus.CLOSED],
      };
    }
  }

  private mergeQueries(
    base: StackMemoryQuery,
    overlay: Partial<StackMemoryQuery>
  ): StackMemoryQuery {
    const merged: StackMemoryQuery = {};

    // Only add properties if they have values
    if (base.time || overlay.time) {
      merged.time = { ...base.time, ...overlay.time };
    }
    if (base.content || overlay.content) {
      merged.content = { ...base.content, ...overlay.content };
    }
    if (base.frame || overlay.frame) {
      merged.frame = { ...base.frame, ...overlay.frame };
    }
    if (base.people || overlay.people) {
      merged.people = { ...base.people, ...overlay.people };
    }
    if (base.output || overlay.output) {
      merged.output = { ...base.output, ...overlay.output };
    }

    return merged;
  }

  /**
   * Expand query with synonyms and related terms
   */
  expandQuery(query: StackMemoryQuery): StackMemoryQuery {
    const synonyms: Record<string, string[]> = {
      auth: ['authentication', 'oauth', 'login', 'session', 'jwt'],
      authentication: ['auth', 'oauth', 'login', 'session', 'jwt'],
      bug: ['error', 'issue', 'problem', 'fix', 'defect'],
      database: ['db', 'sql', 'postgres', 'migration', 'schema'],
      test: ['testing', 'spec', 'unit', 'integration', 'e2e'],
    };

    if (query.content?.topic) {
      const expandedTopics = new Set(query.content.topic);
      for (const topic of query.content.topic) {
        const syns = synonyms[topic.toLowerCase()];
        if (syns) {
          syns.forEach((s) => expandedTopics.add(s));
        }
      }
      query.content.topic = Array.from(expandedTopics);
    }

    return query;
  }

  /**
   * Main parse method that returns a complete QueryResponse
   */
  parse(query: string | StackMemoryQuery): QueryResponse {
    const original = typeof query === 'string' ? query : JSON.stringify(query);

    // Parse based on input type (clone to avoid mutation)
    const interpreted =
      typeof query === 'string'
        ? this.parseNaturalLanguage(query)
        : this.parseStructured(JSON.parse(JSON.stringify(query)));

    // Validate the query
    const validationErrors = this.validateQuery(interpreted);

    // Expand with synonyms
    const expanded = this.expandQuery(JSON.parse(JSON.stringify(interpreted)));

    // Generate suggestions
    const suggestions = this.generateSuggestions(interpreted, validationErrors);

    return {
      original,
      interpreted,
      expanded,
      suggestions,
      validationErrors:
        validationErrors.length > 0 ? validationErrors : undefined,
    };
  }

  /**
   * Validate query for errors and inconsistencies
   */
  private validateQuery(query: StackMemoryQuery): string[] {
    const errors: string[] = [];

    // Validate time filters
    if (query.time) {
      if (query.time.since && query.time.until) {
        if (query.time.since > query.time.until) {
          errors.push('Time filter: "since" date is after "until" date');
        }
      }
      if (query.time.between) {
        if (query.time.between[0] > query.time.between[1]) {
          errors.push('Time filter: Invalid date range in "between"');
        }
      }
    }

    // Validate score ranges
    if (query.frame?.score) {
      if (
        query.frame.score.min !== undefined &&
        query.frame.score.max !== undefined
      ) {
        if (query.frame.score.min > query.frame.score.max) {
          errors.push(
            'Frame filter: Minimum score is greater than maximum score'
          );
        }
      }
    }

    // Validate depth ranges
    if (query.frame?.depth) {
      if (
        query.frame.depth.min !== undefined &&
        query.frame.depth.max !== undefined
      ) {
        if (query.frame.depth.min > query.frame.depth.max) {
          errors.push(
            'Frame filter: Minimum depth is greater than maximum depth'
          );
        }
      }
    }

    // Validate output limit
    if (query.output?.limit !== undefined) {
      if (query.output.limit < 1 || query.output.limit > 1000) {
        errors.push('Output limit must be between 1 and 1000');
      }
    }

    return errors;
  }

  /**
   * Generate query suggestions based on the interpreted query
   */
  private generateSuggestions(
    query: StackMemoryQuery,
    errors: string[]
  ): string[] {
    const suggestions: string[] = [];

    // If no time filter, suggest adding one
    if (
      !query.time ||
      (!query.time.last &&
        !query.time.since &&
        !query.time.between &&
        !query.time.specific)
    ) {
      suggestions.push('Try adding a time filter like "last 24h" or "today"');
    }

    // If very broad query, suggest refinement
    if (
      !query.content?.topic &&
      !query.frame?.type &&
      !query.people &&
      !query.content?.keywords
    ) {
      suggestions.push(
        'Consider filtering by topic, frame type, or people to narrow results'
      );
    }

    // If searching for bugs/errors without time limit
    if (query.frame?.type?.includes(FrameType.BUG) && !query.time) {
      suggestions.push('Add a time filter to focus on recent bugs');
    }

    // If high score threshold without type filter
    if (
      query.frame?.score?.min &&
      query.frame.score.min >= 0.8 &&
      !query.frame?.type
    ) {
      suggestions.push(
        'Consider adding frame type filter with high score threshold'
      );
    }

    // Suggest shortcuts if applicable
    if (query.time?.last === '24h') {
      suggestions.push('You can use "today" as a shortcut for last 24 hours');
    }

    if (
      query.frame?.type?.includes(FrameType.BUG) &&
      query.frame?.type?.includes(FrameType.DEBUG)
    ) {
      suggestions.push(
        'You can use "bugs" as a shortcut for bug and debug frames'
      );
    }

    // If there are errors, suggest corrections
    if (errors.length > 0) {
      suggestions.push(
        'Please correct the validation errors before running the query'
      );
    }

    return suggestions;
  }
}
