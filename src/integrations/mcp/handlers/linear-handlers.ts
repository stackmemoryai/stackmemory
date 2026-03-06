/**
 * Linear integration MCP tool handlers
 * Handles Linear sync, task updates, and status queries
 */

import { LinearAuthManager } from '../../linear/auth.js';
import { LinearSyncEngine } from '../../linear/sync.js';
import { LinearClient } from '../../linear/client.js';
import { LinearTaskManager } from '../../../features/tasks/linear-task-manager.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface LinearHandlerDependencies {
  linearAuthManager: LinearAuthManager;
  linearSync: LinearSyncEngine;
  taskStore: LinearTaskManager;
}

export class LinearHandlers {
  constructor(private deps: LinearHandlerDependencies) {}

  /**
   * Create an authenticated LinearClient from the auth manager token
   */
  private async getClient(): Promise<LinearClient> {
    const token = await this.deps.linearAuthManager.getValidToken();
    return new LinearClient({ apiKey: token, useBearer: true });
  }

  /**
   * Sync tasks with Linear
   */
  async handleLinearSync(args: any): Promise<any> {
    try {
      const { direction = 'both', force = false } = args;

      // Check auth first
      try {
        await this.deps.linearAuthManager.getValidToken();
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: 'Linear auth required. Please run: stackmemory linear setup',
            },
          ],
          metadata: {
            authRequired: true,
          },
        };
      }

      logger.info('Starting Linear sync', { direction, force });

      const result = await this.deps.linearSync.sync();

      const syncText = `Linear Sync Complete:
- To Linear: ${result.synced.toLinear} tasks
- From Linear: ${result.synced.fromLinear} tasks  
- Updated: ${result.synced.updated} tasks
- Errors: ${result.errors.length}`;

      return {
        content: [
          {
            type: 'text',
            text: syncText,
          },
        ],
        metadata: result,
      };
    } catch (error: unknown) {
      logger.error(
        'Linear sync failed',
        error instanceof Error ? error : new Error(String(error))
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage?.includes('unauthorized') ||
        errorMessage?.includes('auth')
      ) {
        return {
          content: [
            {
              type: 'text',
              text: 'Linear authentication failed. Please run: stackmemory linear setup',
            },
          ],
          metadata: {
            authError: true,
          },
        };
      }

      throw error;
    }
  }

  /**
   * Update Linear issue directly via GraphQL API
   */
  async handleLinearUpdateTask(args: any): Promise<any> {
    try {
      const { linear_id, status, assignee_id, priority, labels } = args;

      if (!linear_id) {
        throw new Error('Linear ID is required');
      }

      const client = await this.getClient();

      const updateData: Record<string, unknown> = {};
      if (status) updateData.stateId = status;
      if (assignee_id) updateData.assigneeId = assignee_id;
      if (priority !== undefined) updateData.priority = priority;
      if (labels) {
        updateData.labelIds = Array.isArray(labels) ? labels : [labels];
      }

      const issue = await client.updateIssue(linear_id, updateData);

      return {
        content: [
          {
            type: 'text',
            text: `Updated ${issue.identifier}: ${issue.title}\nStatus: ${issue.state.name} | Priority: ${issue.priority}`,
          },
        ],
        metadata: {
          id: issue.id,
          identifier: issue.identifier,
          state: issue.state.name,
          url: issue.url,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error updating Linear task',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Get issues from Linear via GraphQL API
   */
  async handleLinearGetTasks(args: any): Promise<any> {
    try {
      const { team_id, assignee_id, state = 'active', limit = 20 } = args;

      const client = await this.getClient();

      // Map state filter to Linear stateType
      const stateTypeMap: Record<string, 'started' | 'completed' | undefined> =
        {
          active: 'started',
          closed: 'completed',
          all: undefined,
        };

      const issues = await client.getIssues({
        teamId: team_id,
        assigneeId: assignee_id,
        stateType: stateTypeMap[state],
        limit,
      });

      const issueLines = issues.map(
        (i) =>
          `${i.identifier} [${i.state.name}] ${i.title}${i.assignee ? ` (@${i.assignee.name})` : ''}`
      );

      const text =
        issues.length > 0
          ? `Found ${issues.length} issues:\n${issueLines.join('\n')}`
          : 'No issues found matching filters.';

      return {
        content: [{ type: 'text', text }],
        metadata: {
          count: issues.length,
          issues: issues.map((i) => ({
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            state: i.state.name,
            priority: i.priority,
            assignee: i.assignee?.name,
            url: i.url,
          })),
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error getting Linear tasks',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Get Linear integration status
   */
  async handleLinearStatus(args: any): Promise<any> {
    try {
      let authStatus = false;
      try {
        await this.deps.linearAuthManager.getValidToken();
        authStatus = true;
      } catch {
        authStatus = false;
      }

      if (!authStatus) {
        return {
          content: [
            {
              type: 'text',
              text: 'Linear: Not connected\nRun: stackmemory linear setup',
            },
          ],
          metadata: {
            connected: false,
            authRequired: true,
          },
        };
      }

      // Get basic Linear info
      const statusText =
        'Linear Integration Status:\n✓ Connected (authenticated)\n\nUse `stackmemory linear sync` for full sync details.';

      return {
        content: [
          {
            type: 'text',
            text: statusText,
          },
        ],
        metadata: {
          connected: true,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error getting Linear status',
        error instanceof Error ? error : new Error(String(error))
      );

      return {
        content: [
          {
            type: 'text',
            text: 'Linear: Connection error - please check auth',
          },
        ],
        metadata: {
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
