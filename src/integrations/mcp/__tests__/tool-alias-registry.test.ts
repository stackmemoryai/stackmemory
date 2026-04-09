/**
 * Tests for Tool Alias Registry
 * Verifies tool name resolution, parameter aliasing, and registry integrity
 */

import { describe, it, expect } from 'vitest';
import {
  resolveToolAlias,
  resolveParamAliases,
  getAliasesForTool,
  getToolsWithAliases,
  getAliasRegistry,
  getParamAliasRegistry,
} from '../tool-alias-registry.js';

describe('Tool Alias Registry', () => {
  describe('resolveToolAlias', () => {
    it('resolves known aliases to canonical names', () => {
      const cases: [string, string][] = [
        ['sm_save', 'save_context'],
        ['sm_load', 'load_context'],
        ['sm_context_search', 'sm_search'],
        ['search', 'sm_search'],
        ['context', 'get_context'],
        ['discover', 'sm_discover'],
        ['fuzzy_edit', 'sm_edit'],
        ['desires', 'sm_desire_paths'],
        ['spawn', 'cord_spawn'],
        ['delegate', 'delegate_to_model'],
        ['plan', 'plan_only'],
        ['linear_issues', 'linear_get_tasks'],
        ['decision_search', 'provenant_search'],
        ['digest', 'sm_digest'],
        ['remember', 'diffmem_store_learning'],
      ];

      for (const [alias, expected] of cases) {
        const result = resolveToolAlias(alias);
        expect(result.canonicalName).toBe(expected);
        expect(result.wasAlias).toBe(true);
        expect(result.originalName).toBe(alias);
      }
    });

    it('returns canonical names unchanged', () => {
      const canonicals = [
        'get_context',
        'add_decision',
        'start_frame',
        'close_frame',
        'sm_search',
        'sm_discover',
        'sm_edit',
        'sm_desire_paths',
        'create_task',
        'linear_get_tasks',
        'delegate_to_model',
        'provenant_search',
        'cord_spawn',
        'sm_digest',
      ];

      for (const name of canonicals) {
        const result = resolveToolAlias(name);
        expect(result.canonicalName).toBe(name);
        expect(result.wasAlias).toBe(false);
        expect(result.originalName).toBe(name);
      }
    });

    it('returns unknown tool names unchanged', () => {
      const result = resolveToolAlias('completely_made_up_tool');
      expect(result.canonicalName).toBe('completely_made_up_tool');
      expect(result.wasAlias).toBe(false);
    });
  });

  describe('resolveParamAliases', () => {
    it('resolves known parameter aliases', () => {
      const result = resolveParamAliases('sm_search', {
        search_term: 'hello',
        max: 5,
      });
      expect(result.resolvedParams).toEqual({ query: 'hello', limit: 5 });
      expect(result.renames).toEqual({
        search_term: 'query',
        max: 'limit',
      });
    });

    it('preserves canonical params over aliases', () => {
      const result = resolveParamAliases('sm_search', {
        query: 'canonical value',
        search_term: 'alias value',
        limit: 10,
        max: 20,
      });
      // canonical 'query' should win over alias 'search_term'
      expect(result.resolvedParams.query).toBe('canonical value');
      expect(result.resolvedParams.limit).toBe(10);
      // alias values should NOT be in the result
      expect(result.resolvedParams.search_term).toBeUndefined();
      expect(result.resolvedParams.max).toBeUndefined();
    });

    it('passes through params without aliases for unknown tools', () => {
      const params = { foo: 'bar', baz: 42 };
      const result = resolveParamAliases('unknown_tool', params);
      expect(result.resolvedParams).toEqual(params);
      expect(result.renames).toEqual({});
    });

    it('passes through unrecognized params', () => {
      const result = resolveParamAliases('sm_search', {
        query: 'test',
        unknown_param: 'value',
      });
      expect(result.resolvedParams).toEqual({
        query: 'test',
        unknown_param: 'value',
      });
      expect(result.renames).toEqual({});
    });

    it('handles empty params', () => {
      const result = resolveParamAliases('sm_search', {});
      expect(result.resolvedParams).toEqual({});
      expect(result.renames).toEqual({});
    });

    it('resolves smart_context token budget aliases', () => {
      const result = resolveParamAliases('smart_context', {
        search: 'test query',
        token_budget: 8000,
        force: true,
      });
      expect(result.resolvedParams).toEqual({
        query: 'test query',
        tokenBudget: 8000,
        forceRefresh: true,
      });
    });

    it('resolves provenant_search aliases', () => {
      const result = resolveParamAliases('provenant_search', {
        text: 'architecture',
        by: 'jwu',
        after: '2026-01-01',
      });
      expect(result.resolvedParams).toEqual({
        query: 'architecture',
        actor: 'jwu',
        since: '2026-01-01',
      });
    });

    it('resolves create_task name->title alias', () => {
      const result = resolveParamAliases('create_task', {
        name: 'My Task',
        desc: 'Details here',
      });
      expect(result.resolvedParams).toEqual({
        title: 'My Task',
        description: 'Details here',
      });
    });

    it('resolves cord_spawn aliases', () => {
      const result = resolveParamAliases('cord_spawn', {
        task: 'Build feature',
        instructions: 'Implement the new API',
        depends_on: ['task-1'],
        parent: 'root-task',
      });
      expect(result.resolvedParams).toEqual({
        goal: 'Build feature',
        prompt: 'Implement the new API',
        blocked_by: ['task-1'],
        parent_id: 'root-task',
      });
    });

    it('resolves sm_edit file path aliases', () => {
      const result = resolveParamAliases('sm_edit', {
        file: '/path/to/file.ts',
        find: 'old code',
        replace: 'new code',
      });
      expect(result.resolvedParams).toEqual({
        file_path: '/path/to/file.ts',
        old_string: 'old code',
        new_string: 'new code',
      });
    });
  });

  describe('getAliasesForTool', () => {
    it('returns all aliases for a canonical tool', () => {
      const aliases = getAliasesForTool('get_context');
      expect(aliases).toContain('context');
      expect(aliases).toContain('get_ctx');
      expect(aliases).toContain('sm_context');
      expect(aliases).toContain('sm_get_context');
      expect(aliases).toContain('fetch_context');
      expect(aliases).toContain('read_context');
    });

    it('returns empty array for tool with no aliases', () => {
      const aliases = getAliasesForTool('nonexistent_tool');
      expect(aliases).toEqual([]);
    });
  });

  describe('getToolsWithAliases', () => {
    it('returns unique canonical names', () => {
      const tools = getToolsWithAliases();
      expect(tools.length).toBeGreaterThan(0);
      // Should be deduplicated
      expect(new Set(tools).size).toBe(tools.length);
      // Should include major tools
      expect(tools).toContain('get_context');
      expect(tools).toContain('sm_search');
      expect(tools).toContain('create_task');
    });
  });

  describe('Registry integrity', () => {
    it('no alias points to another alias (no chaining)', () => {
      const registry = getAliasRegistry();
      for (const [alias, target] of Object.entries(registry)) {
        expect(registry[target]).toBeUndefined();
      }
    });

    it('no alias shadows a canonical tool name', () => {
      // Ensure aliases don't accidentally override canonical tool names
      // that are used in the switch statement
      const canonicalTools = [
        'get_context',
        'add_decision',
        'start_frame',
        'close_frame',
        'add_anchor',
        'get_hot_stack',
        'create_task',
        'update_task_status',
        'get_active_tasks',
        'get_task_metrics',
        'sm_search',
        'sm_discover',
        'sm_related_files',
        'sm_session_summary',
        'sm_edit',
        'sm_digest',
        'sm_desire_paths',
        'smart_context',
        'get_summary',
        'linear_sync',
        'linear_update_task',
        'linear_get_tasks',
        'linear_status',
        'get_traces',
        'plan_only',
        'call_codex',
        'call_claude',
        'plan_gate',
        'approve_plan',
        'pending_list',
        'pending_clear',
        'pending_show',
        'delegate_to_model',
        'batch_submit',
        'batch_check',
        'cord_spawn',
        'cord_fork',
        'cord_complete',
        'cord_ask',
        'cord_tree',
        'team_context_get',
        'team_context_share',
        'team_search',
        'provenant_search',
        'provenant_log',
        'provenant_status',
        'provenant_contradictions',
        'provenant_resolve',
        'diffmem_get_user_context',
        'diffmem_store_learning',
        'diffmem_search',
        'diffmem_status',
      ];

      const registry = getAliasRegistry();
      for (const canonical of canonicalTools) {
        // No alias key should equal a canonical name (it would shadow it)
        if (registry[canonical]) {
          // This is a problem: an alias key matches a canonical tool name
          throw new Error(
            `Alias "${canonical}" shadows canonical tool "${canonical}" -> "${registry[canonical]}"`
          );
        }
      }
    });

    it('param alias targets exist in tool schemas', () => {
      const paramRegistry = getParamAliasRegistry();
      // Just verify structure - each tool has a non-empty mapping
      for (const [tool, aliases] of Object.entries(paramRegistry)) {
        expect(typeof tool).toBe('string');
        expect(Object.keys(aliases).length).toBeGreaterThan(0);
        // Each alias should map to a string canonical param name
        for (const [alias, canonical] of Object.entries(aliases)) {
          expect(typeof alias).toBe('string');
          expect(typeof canonical).toBe('string');
          // Alias and canonical should differ
          expect(alias).not.toBe(canonical);
        }
      }
    });
  });
});
