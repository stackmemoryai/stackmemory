/**
 * Team-related MCP tool handlers
 * Enables cross-agent memory sharing within the same project
 */

import { FrameManager } from '../../../core/context/index.js';
import { SQLiteAdapter } from '../../../core/database/sqlite-adapter.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface TeamHandlerDependencies {
  frameManager: FrameManager;
  dbAdapter: SQLiteAdapter;
}

export class TeamHandlers {
  constructor(private deps: TeamHandlerDependencies) {}

  /**
   * Get context from other agents working on the same project.
   * Returns recent frames and shared anchors from other sessions.
   */
  async handleTeamContextGet(args: any): Promise<any> {
    try {
      const limit = args.limit ?? 10;
      const types = args.types as string[] | undefined;
      const since = args.since as number | undefined;

      const projectId = this.getProjectId();
      const runId = this.getRunId();

      // Get frames from other sessions
      const frames = await this.deps.dbAdapter.getRecentFramesExcludingRun(
        projectId,
        runId,
        { limit, types, since }
      );

      // Also get explicitly shared anchors
      const sharedAnchors = await this.deps.dbAdapter.getSharedAnchors(
        projectId,
        { limit, since }
      );

      if (frames.length === 0 && sharedAnchors.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No context from other agents found in this project.',
            },
          ],
        };
      }

      const frameSummaries = frames.map((f) => ({
        frame_id: f.frame_id,
        run_id: f.run_id,
        name: f.name,
        type: f.type,
        state: f.state,
        created_at: f.created_at,
        digest_text: f.digest_text || null,
        anchors: f.anchors.map((a) => ({
          type: a.type,
          text: a.text,
          priority: a.priority,
        })),
      }));

      const sharedSummaries = sharedAnchors.map((a) => ({
        type: a.type,
        text: a.text,
        priority: a.priority,
        frame_name: a.frame_name,
        run_id: a.run_id,
        shared_by: a.metadata?.sharedBy,
      }));

      const text =
        `Team Context (${frames.length} frames, ${sharedAnchors.length} shared anchors):\n\n` +
        frameSummaries
          .map(
            (f) =>
              `[${f.run_id?.slice(0, 8)}] ${f.name} (${f.type}, ${f.state})` +
              (f.digest_text ? `\n  ${f.digest_text}` : '') +
              (f.anchors.length > 0
                ? '\n  Anchors: ' +
                  f.anchors.map((a) => `${a.type}: ${a.text}`).join('; ')
                : '')
          )
          .join('\n') +
        (sharedSummaries.length > 0
          ? '\n\nShared Anchors:\n' +
            sharedSummaries
              .map((a) => `  [${a.type}] ${a.text} (priority: ${a.priority})`)
              .join('\n')
          : '');

      return {
        content: [{ type: 'text', text }],
        metadata: { frames: frameSummaries, sharedAnchors: sharedSummaries },
      };
    } catch (error: unknown) {
      logger.error(
        'Error getting team context',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Share a piece of context with other agents.
   * Creates a high-priority anchor tagged with shared=true.
   */
  async handleTeamContextShare(args: any): Promise<any> {
    try {
      const { content, type = 'FACT', priority = 8 } = args;

      if (!content) {
        throw new Error('content is required');
      }

      const validTypes = [
        'FACT',
        'DECISION',
        'CONSTRAINT',
        'INTERFACE_CONTRACT',
        'TODO',
        'RISK',
      ];
      if (!validTypes.includes(type)) {
        throw new Error(
          `Invalid type. Must be one of: ${validTypes.join(', ')}`
        );
      }

      // Ensure there's an active frame; create a lightweight one if needed
      let frameId = this.deps.frameManager.getCurrentFrameId();
      if (!frameId) {
        frameId = this.deps.frameManager.createFrame({
          type: 'tool_scope',
          name: 'team_context_share',
        });
      }

      const runId = this.getRunId();

      // Add anchor with shared metadata
      this.deps.frameManager.addAnchor(type, content, priority, {
        shared: true,
        sharedBy: runId,
        sharedAt: Date.now(),
      });

      logger.info('Shared team context', { type, priority });

      return {
        content: [
          {
            type: 'text',
            text: `Shared ${type}: ${content}`,
          },
        ],
      };
    } catch (error: unknown) {
      logger.error(
        'Error sharing team context',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Search across all agents' context in the project.
   * Uses FTS5 search without run_id filtering.
   */
  async handleTeamSearch(args: any): Promise<any> {
    try {
      const { query, limit = 20, include_events = false } = args;

      if (!query) {
        throw new Error('query is required');
      }

      const projectId = this.getProjectId();

      // Search across all sessions using existing search (projectId filter only)
      const results = await this.deps.dbAdapter.search({
        query,
        projectId,
        limit,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No results found for "${query}" across team sessions.`,
            },
          ],
        };
      }

      // Optionally fetch events for each frame
      const frameResults = results.map((f) => ({
        frame_id: f.frame_id,
        run_id: f.run_id,
        name: f.name,
        type: f.type,
        state: f.state,
        score: f.score,
        digest_text: f.digest_text || null,
        created_at: f.created_at,
        events: [] as any[],
      }));

      if (include_events) {
        for (const fr of frameResults) {
          const events = await this.deps.dbAdapter.getFrameEvents(fr.frame_id, {
            limit: 5,
          });
          fr.events = events.map((e) => ({
            event_type: e.event_type,
            payload: e.payload,
            ts: e.ts,
          }));
        }
      }

      const text =
        `Team Search: ${results.length} results for "${query}":\n\n` +
        frameResults
          .map(
            (f) =>
              `[${f.run_id?.slice(0, 8)}] ${f.name} (score: ${f.score?.toFixed(3)})` +
              (f.digest_text ? `\n  ${f.digest_text}` : '')
          )
          .join('\n');

      return {
        content: [{ type: 'text', text }],
        metadata: { results: frameResults, total: results.length },
      };
    } catch (error: unknown) {
      logger.error(
        'Error in team search',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /** Extract projectId from the dbAdapter (protected field on DatabaseAdapter) */
  private getProjectId(): string {
    return (this.deps.dbAdapter as any).projectId;
  }

  /** Extract current runId from frameManager (private field) */
  private getRunId(): string {
    return (this.deps.frameManager as any).currentRunId;
  }
}
