/**
 * Cross-Project Search MCP Tool Handlers
 * Enables querying frames across multiple project databases
 */

import {
  CrossProjectSearch,
  type CrossSearchResult,
} from '../../../core/cross-search/cross-project-search.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface CrossSearchHandlerDependencies {
  crossSearch?: CrossProjectSearch;
}

export class CrossSearchHandlers {
  private crossSearch: CrossProjectSearch;

  constructor(deps: CrossSearchHandlerDependencies) {
    this.crossSearch = deps.crossSearch || new CrossProjectSearch();
  }

  /**
   * sm_cross_search: Search across all registered project databases.
   */
  async handleCrossSearch(args: any): Promise<any> {
    try {
      const { query, limit = 20, exclude_current = false } = args;

      if (!query) {
        throw new Error('query is required');
      }

      const projects = this.crossSearch.listProjects();
      if (projects.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No projects registered. Use sm_cross_discover to scan for project databases, or sm_cross_register to add one manually.',
            },
          ],
        };
      }

      const excludeProject = exclude_current
        ? this.getCurrentProjectName()
        : undefined;

      const start = Date.now();
      const results = await this.crossSearch.search({
        query,
        limit,
        excludeProject,
      });
      const elapsed = Date.now() - start;

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No results found for "${query}" across ${projects.length} project databases (${elapsed}ms).`,
            },
          ],
        };
      }

      const text = this.formatResults(results, query, projects.length, elapsed);

      return {
        content: [{ type: 'text', text }],
        metadata: {
          results: results.map((r) => ({
            project: r.projectName,
            frameId: r.frameId,
            name: r.name,
            score: r.score,
          })),
          total: results.length,
          projectsSearched: projects.length,
          elapsedMs: elapsed,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Cross-project search failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * sm_cross_discover: Auto-discover project databases.
   */
  async handleCrossDiscover(args: any): Promise<any> {
    try {
      const paths = args.paths as string[] | undefined;
      const discovered = this.crossSearch.discoverProjects(paths);
      const all = this.crossSearch.listProjects();

      return {
        content: [
          {
            type: 'text',
            text:
              `Discovered ${discovered.length} project database(s).\n` +
              `Total registered: ${all.length}\n\n` +
              all
                .map((p) => `  ${p.name}: ${p.path}\n    db: ${p.dbPath}`)
                .join('\n'),
          },
        ],
        metadata: { discovered: discovered.length, total: all.length },
      };
    } catch (error: unknown) {
      logger.error(
        'Cross-project discover failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * sm_cross_register: Register a project database manually.
   */
  async handleCrossRegister(args: any): Promise<any> {
    try {
      const { name, path, db_path } = args;

      if (!name || !path || !db_path) {
        throw new Error('name, path, and db_path are required');
      }

      this.crossSearch.registerProject({
        name,
        path,
        dbPath: db_path,
        lastAccessed: Date.now(),
      });

      return {
        content: [
          {
            type: 'text',
            text: `Registered project "${name}" at ${path} (db: ${db_path})`,
          },
        ],
      };
    } catch (error: unknown) {
      logger.error(
        'Cross-project register failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * sm_cross_list: List all registered project databases.
   */
  async handleCrossList(): Promise<any> {
    try {
      const projects = this.crossSearch.listProjects();

      if (projects.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No projects registered. Use sm_cross_discover to scan for project databases.',
            },
          ],
        };
      }

      const text =
        `Registered projects (${projects.length}):\n\n` +
        projects
          .map(
            (p) =>
              `  ${p.name}\n    path: ${p.path}\n    db: ${p.dbPath}\n    last: ${new Date(p.lastAccessed).toLocaleDateString()}`
          )
          .join('\n');

      return {
        content: [{ type: 'text', text }],
        metadata: { projects },
      };
    } catch (error: unknown) {
      logger.error(
        'Cross-project list failed',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  private formatResults(
    results: CrossSearchResult[],
    query: string,
    projectCount: number,
    elapsed: number
  ): string {
    const header = `Cross-project search: ${results.length} results for "${query}" across ${projectCount} databases (${elapsed}ms):\n\n`;

    const body = results
      .map(
        (r) =>
          `[${r.projectName}] ${r.name} (${r.type}, score: ${r.score.toFixed(3)})` +
          (r.digestText ? `\n  ${r.digestText.slice(0, 120)}` : '')
      )
      .join('\n');

    return header + body;
  }

  private getCurrentProjectName(): string | undefined {
    // Best-effort: derive from cwd
    const cwd = process.cwd();
    return cwd.split('/').pop();
  }
}
