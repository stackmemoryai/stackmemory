import { describe, it, expect, beforeEach } from 'vitest';
import {
  QueryParser,
  FrameType,
  FrameStatus,
  QueryResponse,
} from '../query-parser';

describe('QueryParser', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('parseNaturalLanguage', () => {
    it('should parse time-based queries', () => {
      const query1 = parser.parseNaturalLanguage(
        'provide context from the last day'
      );
      expect(query1.time?.last).toBe('1d');

      const query2 = parser.parseNaturalLanguage(
        'show me what happened yesterday'
      );
      expect(query2.time?.last).toBe('48h');

      const query3 = parser.parseNaturalLanguage(
        'get all work from last 3 weeks'
      );
      expect(query3.time?.last).toBe('3w');

      const query4 = parser.parseNaturalLanguage('what happened today');
      expect(query4.time?.last).toBe('24h');
    });

    it('should parse topic-based queries', () => {
      const query1 = parser.parseNaturalLanguage(
        'find all authentication work'
      );
      expect(query1.content?.topic).toContain('authentication');

      const query2 = parser.parseNaturalLanguage(
        'show database migration frames'
      );
      expect(query2.content?.topic).toContain('database');
      expect(query2.content?.topic).toContain('migration');

      const query3 = parser.parseNaturalLanguage(
        'get frames about the login bug'
      );
      expect(query3.content?.topic).toContain('login');
      expect(query3.content?.topic).toContain('bug');
    });

    it('should parse people-based queries', () => {
      const query1 = parser.parseNaturalLanguage("show @alice's recent work");
      expect(query1.people?.owner).toContain('alice');

      const query2 = parser.parseNaturalLanguage(
        "what did bob's changes include"
      );
      expect(query2.people?.owner).toContain('bob');

      const query3 = parser.parseNaturalLanguage('get team work from today');
      expect(query3.people?.team).toBe('$current_team');
    });

    it('should parse combined queries', () => {
      const query = parser.parseNaturalLanguage(
        "show @alice's auth work from last week"
      );
      expect(query.time?.last).toBe('1w');
      expect(query.people?.owner).toContain('alice');
      expect(query.content?.topic).toContain('auth');
    });

    it('should parse priority shortcuts', () => {
      const query1 = parser.parseNaturalLanguage('get critical bugs');
      expect(query1.frame?.score?.min).toBe(0.8);
      expect(query1.content?.topic).toContain('bug');

      const query2 = parser.parseNaturalLanguage('show high priority features');
      expect(query2.frame?.score?.min).toBe(0.7);
      expect(query2.content?.topic).toContain('feature');

      const query3 = parser.parseNaturalLanguage('find low priority tasks');
      expect(query3.frame?.score?.max).toBe(0.3);
    });

    it('should parse status shortcuts', () => {
      const query1 = parser.parseNaturalLanguage('show open frames');
      expect(query1.frame?.status).toContain(FrameStatus.OPEN);

      const query2 = parser.parseNaturalLanguage('get closed bugs');
      expect(query2.frame?.status).toContain(FrameStatus.CLOSED);

      const query3 = parser.parseNaturalLanguage('find active work');
      expect(query3.frame?.status).toContain(FrameStatus.OPEN);
    });

    it('should set default output settings', () => {
      const query = parser.parseNaturalLanguage('show recent work');
      expect(query.output).toEqual({
        limit: 50,
        sort: 'time',
        format: 'summary',
      });
    });
  });

  describe('parseStructured', () => {
    it('should validate score ranges', () => {
      const query = parser.parseStructured({
        frame: {
          score: {
            min: -0.5,
            max: 1.5,
          },
        },
      });
      expect(query.frame?.score?.min).toBe(0);
      expect(query.frame?.score?.max).toBe(1);
    });

    it('should apply default output settings', () => {
      const query = parser.parseStructured({
        time: { last: '1d' },
      });
      expect(query.output).toEqual({
        limit: 50,
        sort: 'time',
        format: 'full',
      });
    });

    it('should preserve provided settings', () => {
      const input = {
        time: { last: '2h' },
        content: { topic: ['auth'] },
        output: {
          limit: 100,
          sort: 'score' as const,
          format: 'ids' as const,
        },
      };
      const query = parser.parseStructured(input);
      expect(query).toEqual(input);
    });
  });

  describe('parseHybrid', () => {
    it('should merge natural language with structured modifiers', () => {
      const query = parser.parseHybrid('show auth work', {
        time: { last: '3d' },
        output: { limit: 20 },
      });

      expect(query.content?.topic).toContain('auth');
      expect(query.time?.last).toBe('3d');
      expect(query.output?.limit).toBe(20);
      expect(query.output?.format).toBe('summary');
    });

    it('should override natural language with modifiers', () => {
      const query = parser.parseHybrid('show work from last week', {
        time: { last: '1d' },
      });

      expect(query.time?.last).toBe('1d');
    });
  });

  describe('expandQuery', () => {
    it('should expand topics with synonyms', () => {
      const query = parser.expandQuery({
        content: { topic: ['auth'] },
      });

      expect(query.content?.topic).toContain('auth');
      expect(query.content?.topic).toContain('authentication');
      expect(query.content?.topic).toContain('oauth');
      expect(query.content?.topic).toContain('login');
      expect(query.content?.topic).toContain('jwt');
    });

    it('should expand multiple topics', () => {
      const query = parser.expandQuery({
        content: { topic: ['bug', 'database'] },
      });

      expect(query.content?.topic).toContain('bug');
      expect(query.content?.topic).toContain('error');
      expect(query.content?.topic).toContain('issue');
      expect(query.content?.topic).toContain('database');
      expect(query.content?.topic).toContain('db');
      expect(query.content?.topic).toContain('sql');
    });

    it('should preserve non-expandable topics', () => {
      const query = parser.expandQuery({
        content: { topic: ['custom-topic'] },
      });

      expect(query.content?.topic).toContain('custom-topic');
      expect(query.content?.topic?.length).toBe(1);
    });
  });

  describe('parse (QueryResponse)', () => {
    it('should return complete QueryResponse for natural language query', () => {
      const response = parser.parse('find authentication bugs from last week');

      expect(response.original).toBe('find authentication bugs from last week');
      expect(response.interpreted).toBeDefined();
      expect(response.interpreted.time?.last).toBe('1w');
      expect(response.interpreted.content?.topic).toContain('authentication');
      expect(response.interpreted.content?.topic).toContain('bug');

      expect(response.expanded).toBeDefined();
      expect(response.expanded.content?.topic).toContain('authentication');
      expect(response.expanded.content?.topic).toContain('auth');
      expect(response.expanded.content?.topic).toContain('oauth');
      expect(response.expanded.content?.topic).toContain('login');

      expect(response.suggestions).toBeDefined();
      expect(response.validationErrors).toBeUndefined();
    });

    it('should return QueryResponse for structured query', () => {
      const structuredQuery = {
        time: { last: '24h' },
        content: { topic: ['database'] },
        output: { limit: 10 },
      };

      const response = parser.parse(structuredQuery);

      expect(response.original).toBe(JSON.stringify(structuredQuery));
      expect(response.interpreted).toMatchObject(structuredQuery);
      expect(response.expanded.content?.topic).toContain('database');
      expect(response.expanded.content?.topic).toContain('db');
      expect(response.expanded.content?.topic).toContain('sql');

      expect(response.suggestions).toBeDefined();
      expect(response.suggestions?.length).toBeGreaterThan(0);
    });

    it('should detect and return validation errors', () => {
      const invalidQuery = {
        time: {
          since: new Date('2024-12-25'),
          until: new Date('2024-12-20'),
        },
        frame: {
          score: { min: 0.9, max: 0.5 },
        },
        output: { limit: 5000 },
      };

      const response = parser.parse(invalidQuery);

      expect(response.validationErrors).toBeDefined();
      expect(response.validationErrors).toContain(
        'Time filter: "since" date is after "until" date'
      );
      expect(response.validationErrors).toContain(
        'Frame filter: Minimum score is greater than maximum score'
      );
      expect(response.validationErrors).toContain(
        'Output limit must be between 1 and 1000'
      );

      expect(response.suggestions).toContain(
        'Please correct the validation errors before running the query'
      );
    });

    it('should provide helpful suggestions for broad queries', () => {
      const response = parser.parse('show me everything');

      expect(response.suggestions).toBeDefined();
      expect(response.suggestions).toContain(
        'Try adding a time filter like "last 24h" or "today"'
      );
      expect(response.suggestions).toContain(
        'Consider filtering by topic, frame type, or people to narrow results'
      );
    });

    it('should suggest shortcuts when applicable', () => {
      const response1 = parser.parse({ time: { last: '24h' } });
      expect(response1.suggestions).toContain(
        'You can use "today" as a shortcut for last 24 hours'
      );

      const response2 = parser.parse({
        frame: { type: [FrameType.BUG, FrameType.DEBUG] },
      });
      expect(response2.suggestions).toContain(
        'You can use "bugs" as a shortcut for bug and debug frames'
      );
    });

    it('should handle complex natural language queries', () => {
      const response = parser.parse(
        "@alice's critical authentication work from yesterday"
      );

      expect(response.interpreted.people?.owner).toContain('alice');
      expect(response.interpreted.frame?.score?.min).toBe(0.8);
      expect(response.interpreted.content?.topic).toContain('authentication');
      expect(response.interpreted.time?.last).toBe('48h');

      expect(response.expanded.content?.topic).toContain('auth');
      expect(response.expanded.content?.topic).toContain('oauth');
      expect(response.expanded.content?.topic).toContain('login');
    });

    it('should preserve original query in response', () => {
      const nlQuery = 'find all bugs today';
      const response1 = parser.parse(nlQuery);
      expect(response1.original).toBe(nlQuery);

      const structQuery = {
        time: { last: '1d' },
        frame: { type: [FrameType.BUG] },
      };
      const response2 = parser.parse(structQuery);
      // Original should be the input as provided, before any processing
      expect(response2.original).toBe(JSON.stringify(structQuery));
      // Interpreted should have defaults added
      expect(response2.interpreted.output).toBeDefined();
      expect(response2.interpreted.output?.limit).toBe(50);
    });

    it('should handle queries with file patterns', () => {
      const response = parser.parse(
        'show changes to *.ts and auth.js files today'
      );

      expect(response.interpreted.content?.files).toContain('*.ts');
      expect(response.interpreted.content?.files).toContain('auth.js');
      expect(response.interpreted.time?.last).toBe('24h');
    });

    it('should suggest time filter for bug searches without time limit', () => {
      const response = parser.parse({ frame: { type: [FrameType.BUG] } });

      expect(response.suggestions).toContain(
        'Add a time filter to focus on recent bugs'
      );
    });

    it('should suggest frame type with high score threshold', () => {
      const response = parser.parse({ frame: { score: { min: 0.85 } } });

      expect(response.suggestions).toContain(
        'Consider adding frame type filter with high score threshold'
      );
    });
  });
});
