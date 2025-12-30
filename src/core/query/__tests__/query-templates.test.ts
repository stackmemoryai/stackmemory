import { describe, it, expect, beforeEach } from 'vitest';
import {
  QueryTemplates,
  InlineModifierParser,
  QueryTemplate,
} from '../query-templates';
import { FrameType, FrameStatus } from '../query-parser';

describe('QueryTemplates', () => {
  let templates: QueryTemplates;

  beforeEach(() => {
    templates = new QueryTemplates();
  });

  describe('matchTemplate', () => {
    it('should match daily standup template', () => {
      const result = templates.matchTemplate('standup for alice');
      expect(result).toBeDefined();
      expect(result?.time?.last).toBe('24h');
      expect(result?.people?.owner).toContain('alice');
      expect(result?.output?.groupBy).toBe('frame');
    });

    it('should match error investigation template', () => {
      const result = templates.matchTemplate(
        'investigate error in authentication'
      );
      expect(result).toBeDefined();
      expect(result?.content?.topic).toContain('error');
      expect(result?.content?.topic).toContain('bug');
      expect(result?.content?.keywords).toContain('authentication');
      expect(result?.frame?.type).toContain(FrameType.BUG);
      expect(result?.time?.last).toBe('48h');
    });

    it('should match feature progress template', () => {
      const result = templates.matchTemplate('progress on payment feature');
      expect(result).toBeDefined();
      expect(result?.content?.keywords).toContain('payment');
      expect(result?.frame?.type).toContain(FrameType.FEATURE);
      expect(result?.frame?.status).toContain(FrameStatus.OPEN);
    });

    it('should match code review template for files', () => {
      const result = templates.matchTemplate('code review for auth.js');
      expect(result).toBeDefined();
      expect(result?.content?.files).toContain('auth.js');
      expect(result?.time?.last).toBe('24h');
      expect(result?.output?.format).toBe('full');
    });

    it('should match code review template for topics', () => {
      const result = templates.matchTemplate('code review for authentication');
      expect(result).toBeDefined();
      expect(result?.content?.topic).toContain('authentication');
      expect(result?.time?.last).toBe('24h');
    });

    it('should match team retrospective template', () => {
      const result = templates.matchTemplate('retrospective for last sprint');
      expect(result).toBeDefined();
      expect(result?.people?.team).toBe('$current_team');
      expect(result?.time?.last).toBe('14d');
      expect(result?.output?.groupBy).toBe('owner');
    });

    it('should match performance analysis template', () => {
      const result = templates.matchTemplate(
        'performance issues for dashboard'
      );
      expect(result).toBeDefined();
      expect(result?.content?.topic).toContain('performance');
      expect(result?.content?.keywords).toContain('dashboard');
      expect(result?.time?.last).toBe('7d');
    });

    it('should match security audit template', () => {
      const result = templates.matchTemplate('security audit');
      expect(result).toBeDefined();
      expect(result?.content?.topic).toContain('security');
      expect(result?.frame?.score?.min).toBe(0.7);
    });

    it('should match deployment readiness template', () => {
      const result = templates.matchTemplate('deployment readiness for v2.0');
      expect(result).toBeDefined();
      expect(result?.content?.topic).toContain('deployment');
      expect(result?.content?.keywords).toContain('v2.0');
      expect(result?.frame?.status).toContain(FrameStatus.OPEN);
    });

    it('should return null for non-matching queries', () => {
      const result = templates.matchTemplate(
        'random query that does not match'
      );
      expect(result).toBeNull();
    });
  });

  describe('addTemplate', () => {
    it('should allow adding custom templates', () => {
      const customTemplate: QueryTemplate = {
        name: 'custom-test',
        description: 'Custom test template',
        pattern: /^custom test (\w+)$/i,
        builder: (match) => ({
          content: { topic: [match[1]] },
        }),
      };

      templates.addTemplate(customTemplate);
      const result = templates.matchTemplate('custom test authentication');
      expect(result).toBeDefined();
      expect(result?.content?.topic).toContain('authentication');
    });
  });

  describe('getTemplateInfo', () => {
    it('should return all template information', () => {
      const info = templates.getTemplateInfo();
      expect(info).toBeDefined();
      expect(info.length).toBeGreaterThan(0);
      expect(info[0]).toHaveProperty('name');
      expect(info[0]).toHaveProperty('description');
    });
  });
});

describe('InlineModifierParser', () => {
  let parser: InlineModifierParser;

  beforeEach(() => {
    parser = new InlineModifierParser();
  });

  describe('parse', () => {
    it('should parse time modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse('auth work +last:3d');
      expect(cleanQuery).toBe('auth work');
      expect(modifiers.time?.last).toBe('3d');
    });

    it('should parse multiple time modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'database work +since:2024-12-20 +until:2024-12-25'
      );
      expect(cleanQuery).toBe('database work');
      expect(modifiers.time?.since).toBeDefined();
      expect(modifiers.time?.until).toBeDefined();
    });

    it('should parse owner modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'recent work +owner:alice +owner:bob'
      );
      expect(cleanQuery).toBe('recent work');
      expect(modifiers.people?.owner).toContain('alice');
      expect(modifiers.people?.owner).toContain('bob');
    });

    it('should parse team modifier', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'sprint work +team:backend'
      );
      expect(cleanQuery).toBe('sprint work');
      expect(modifiers.people?.team).toBe('backend');
    });

    it('should parse content modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'recent changes +topic:auth +file:*.js'
      );
      expect(cleanQuery).toBe('recent changes');
      expect(modifiers.content?.topic).toContain('auth');
      expect(modifiers.content?.files).toContain('*.js');
    });

    it('should parse output modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'all work +sort:score +limit:100 +format:full'
      );
      expect(cleanQuery).toBe('all work');
      expect(modifiers.output?.sort).toBe('score');
      expect(modifiers.output?.limit).toBe(100);
      expect(modifiers.output?.format).toBe('full');
    });

    it('should parse grouping modifier', () => {
      const { cleanQuery, modifiers } = parser.parse('team work +group:owner');
      expect(cleanQuery).toBe('team work');
      expect(modifiers.output?.groupBy).toBe('owner');
    });

    it('should parse frame status modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'current tasks +status:open +status:stalled'
      );
      expect(cleanQuery).toBe('current tasks');
      expect(modifiers.frame?.status).toContain(FrameStatus.OPEN);
      expect(modifiers.frame?.status).toContain(FrameStatus.STALLED);
    });

    it('should parse priority modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'issues +priority:critical'
      );
      expect(cleanQuery).toBe('issues');
      expect(modifiers.frame?.score?.min).toBe(0.8);
    });

    it('should handle complex queries with multiple modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'authentication bugs +last:7d +owner:alice +priority:high +sort:time +limit:20'
      );
      expect(cleanQuery).toBe('authentication bugs');
      expect(modifiers.time?.last).toBe('7d');
      expect(modifiers.people?.owner).toContain('alice');
      expect(modifiers.frame?.score?.min).toBe(0.7);
      expect(modifiers.output?.sort).toBe('time');
      expect(modifiers.output?.limit).toBe(20);
    });

    it('should handle queries without modifiers', () => {
      const { cleanQuery, modifiers } = parser.parse(
        'simple query without modifiers'
      );
      expect(cleanQuery).toBe('simple query without modifiers');
      expect(modifiers).toEqual({});
    });

    it('should clean up whitespace after removing modifiers', () => {
      const { cleanQuery } = parser.parse(
        '  auth    work  +last:3d   +owner:alice  '
      );
      expect(cleanQuery).toBe('auth work');
    });
  });
});
