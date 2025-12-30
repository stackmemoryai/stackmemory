/**
 * Query Templates for StackMemory
 * Provides pre-built query patterns for common use cases
 */

import { StackMemoryQuery, FrameType, FrameStatus } from './query-parser.js';

export interface QueryTemplate {
  name: string;
  description: string;
  pattern: RegExp;
  builder: (match: RegExpMatchArray) => Partial<StackMemoryQuery>;
}

export class QueryTemplates {
  private templates: QueryTemplate[] = [
    {
      name: 'daily-standup',
      description: 'Get work done by a person today for standup',
      pattern: /^standup for @?(\w+)$/i,
      builder: (match) => ({
        time: { last: '24h' },
        people: { owner: [match[1]] },
        output: {
          format: 'summary',
          sort: 'time',
          groupBy: 'frame',
        },
      }),
    },
    {
      name: 'error-investigation',
      description: 'Investigate errors in a specific component',
      pattern: /^investigate errors? in (.+)$/i,
      builder: (match) => ({
        content: {
          topic: ['error', 'bug'],
          keywords: [match[1]],
        },
        frame: {
          type: [FrameType.BUG, FrameType.DEBUG],
        },
        time: { last: '48h' },
        output: {
          format: 'full',
          sort: 'time',
          include: ['events', 'digests'],
        },
      }),
    },
    {
      name: 'feature-progress',
      description: 'Check progress on a specific feature',
      pattern: /^progress on (.+) feature$/i,
      builder: (match) => ({
        content: {
          topic: ['feature'],
          keywords: [match[1]],
        },
        frame: {
          type: [FrameType.FEATURE],
          status: [FrameStatus.OPEN],
        },
        output: {
          format: 'summary',
          sort: 'score',
        },
      }),
    },
    {
      name: 'code-review',
      description: 'Find recent changes for code review',
      pattern: /^code review for (.+)$/i,
      builder: (match) => {
        const target = match[1];
        const isFile = target.includes('.');
        return {
          content: isFile ? { files: [target] } : { topic: [target] },
          time: { last: '24h' },
          output: {
            format: 'full',
            include: ['events', 'digests'],
            sort: 'time',
          },
        };
      },
    },
    {
      name: 'team-retrospective',
      description: 'Gather team work for retrospective',
      pattern: /^retrospective for (last|this) (week|sprint|month)$/i,
      builder: (match) => {
        const timeMap: Record<string, string> = {
          week: '7d',
          sprint: '14d',
          month: '30d',
        };
        return {
          people: { team: '$current_team' },
          time: { last: timeMap[match[2]] || '7d' },
          output: {
            format: 'summary',
            groupBy: 'owner',
            sort: 'score',
          },
        };
      },
    },
    {
      name: 'performance-analysis',
      description: 'Analyze performance issues',
      pattern: /^performance (issues?|problems?|analysis) for (.+)$/i,
      builder: (match) => ({
        content: {
          topic: ['performance', 'optimization', 'slow', 'latency'],
          keywords: [match[2]],
        },
        time: { last: '7d' },
        output: {
          format: 'full',
          sort: 'score',
        },
      }),
    },
    {
      name: 'security-audit',
      description: 'Security-related frames',
      pattern: /^security audit( for (.+))?$/i,
      builder: (match) => ({
        content: {
          topic: ['security', 'vulnerability', 'auth', 'authorization'],
          keywords: match[2] ? [match[2]] : undefined,
        },
        frame: {
          score: { min: 0.7 }, // High priority for security
        },
        output: {
          format: 'full',
          sort: 'score',
        },
      }),
    },
    {
      name: 'deployment-readiness',
      description: 'Check deployment readiness',
      pattern: /^deployment readiness( for (.+))?$/i,
      builder: (match) => ({
        content: {
          topic: ['deployment', 'release', 'production'],
          keywords: match[2] ? [match[2]] : undefined,
        },
        frame: {
          status: [FrameStatus.OPEN],
        },
        time: { last: '48h' },
        output: {
          format: 'summary',
          sort: 'score',
        },
      }),
    },
  ];

  /**
   * Match query against templates
   */
  matchTemplate(query: string): Partial<StackMemoryQuery> | null {
    for (const template of this.templates) {
      const match = query.match(template.pattern);
      if (match) {
        return template.builder(match);
      }
    }
    return null;
  }

  /**
   * Get all template names and descriptions
   */
  getTemplateInfo(): Array<{ name: string; description: string }> {
    return this.templates.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * Add custom template
   */
  addTemplate(template: QueryTemplate): void {
    this.templates.push(template);
  }
}

/**
 * Inline modifier parser for queries like:
 * "auth work +last:3d +owner:alice +sort:score"
 */
export class InlineModifierParser {
  private modifierPatterns = {
    time: /\+last:(\d+[hdwm])/gi,
    since: /\+since:(\S+)/gi,
    until: /\+until:(\S+)/gi,
    owner: /\+owner:@?(\w+)/gi,
    team: /\+team:(\w+)/gi,
    topic: /\+topic:(\w+)/gi,
    file: /\+file:(\S+)/gi,
    sort: /\+sort:(time|score|relevance)/gi,
    limit: /\+limit:(\d+)/gi,
    format: /\+format:(full|summary|ids)/gi,
    group: /\+group:(frame|time|owner|topic)/gi,
    status: /\+status:(open|closed|stalled)/gi,
    priority: /\+priority:(critical|high|medium|low)/gi,
  };

  /**
   * Parse inline modifiers from query
   */
  parse(query: string): {
    cleanQuery: string;
    modifiers: Partial<StackMemoryQuery>;
  } {
    const modifiers: Partial<StackMemoryQuery> = {};
    let cleanQuery = query;

    // Parse time modifiers
    const lastMatch = [...query.matchAll(this.modifierPatterns.time)];
    if (lastMatch.length > 0) {
      modifiers.time = { last: lastMatch[0][1] };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.time, '');
    }

    const sinceMatch = [...query.matchAll(this.modifierPatterns.since)];
    if (sinceMatch.length > 0) {
      const date = new Date(sinceMatch[0][1]);
      if (!isNaN(date.getTime())) {
        modifiers.time = { ...modifiers.time, since: date };
      }
      cleanQuery = cleanQuery.replace(this.modifierPatterns.since, '');
    }

    const untilMatch = [...query.matchAll(this.modifierPatterns.until)];
    if (untilMatch.length > 0) {
      const date = new Date(untilMatch[0][1]);
      if (!isNaN(date.getTime())) {
        modifiers.time = { ...modifiers.time, until: date };
      }
      cleanQuery = cleanQuery.replace(this.modifierPatterns.until, '');
    }

    // Parse people modifiers
    const ownerMatches = [...query.matchAll(this.modifierPatterns.owner)];
    if (ownerMatches.length > 0) {
      modifiers.people = {
        owner: ownerMatches.map((m) => m[1]),
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.owner, '');
    }

    const teamMatch = [...query.matchAll(this.modifierPatterns.team)];
    if (teamMatch.length > 0) {
      modifiers.people = {
        ...modifiers.people,
        team: teamMatch[0][1],
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.team, '');
    }

    // Parse content modifiers
    const topicMatches = [...query.matchAll(this.modifierPatterns.topic)];
    if (topicMatches.length > 0) {
      modifiers.content = {
        topic: topicMatches.map((m) => m[1]),
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.topic, '');
    }

    const fileMatches = [...query.matchAll(this.modifierPatterns.file)];
    if (fileMatches.length > 0) {
      modifiers.content = {
        ...modifiers.content,
        files: fileMatches.map((m) => m[1]),
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.file, '');
    }

    // Parse output modifiers
    const sortMatch = [...query.matchAll(this.modifierPatterns.sort)];
    if (sortMatch.length > 0) {
      modifiers.output = {
        sort: sortMatch[0][1] as 'time' | 'score' | 'relevance',
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.sort, '');
    }

    const limitMatch = [...query.matchAll(this.modifierPatterns.limit)];
    if (limitMatch.length > 0) {
      modifiers.output = {
        ...modifiers.output,
        limit: parseInt(limitMatch[0][1]),
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.limit, '');
    }

    const formatMatch = [...query.matchAll(this.modifierPatterns.format)];
    if (formatMatch.length > 0) {
      modifiers.output = {
        ...modifiers.output,
        format: formatMatch[0][1] as 'full' | 'summary' | 'ids',
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.format, '');
    }

    const groupMatch = [...query.matchAll(this.modifierPatterns.group)];
    if (groupMatch.length > 0) {
      modifiers.output = {
        ...modifiers.output,
        groupBy: groupMatch[0][1] as 'frame' | 'time' | 'owner' | 'topic',
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.group, '');
    }

    // Parse frame modifiers
    const statusMatch = [...query.matchAll(this.modifierPatterns.status)];
    if (statusMatch.length > 0) {
      const statusMap: Record<string, FrameStatus> = {
        open: FrameStatus.OPEN,
        closed: FrameStatus.CLOSED,
        stalled: FrameStatus.STALLED,
      };
      modifiers.frame = {
        status: statusMatch.map((m) => statusMap[m[1]]),
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.status, '');
    }

    const priorityMatch = [...query.matchAll(this.modifierPatterns.priority)];
    if (priorityMatch.length > 0) {
      const priorityMap: Record<string, { min?: number; max?: number }> = {
        critical: { min: 0.8 },
        high: { min: 0.7, max: 0.8 },
        medium: { min: 0.4, max: 0.7 },
        low: { max: 0.4 },
      };
      modifiers.frame = {
        ...modifiers.frame,
        score: priorityMap[priorityMatch[0][1]],
      };
      cleanQuery = cleanQuery.replace(this.modifierPatterns.priority, '');
    }

    // Clean up extra whitespace
    cleanQuery = cleanQuery.replace(/\s+/g, ' ').trim();

    return { cleanQuery, modifiers };
  }
}
