/**
 * Linear integration MCP tool handlers
 * Handles Linear sync, task updates, and status queries
 */

import { LinearAuthManager } from '../../linear/auth.js';
import { LinearSyncEngine, DEFAULT_SYNC_CONFIG } from '../../linear/sync.js';
import { PebblesTaskStore } from '../../../features/tasks/pebbles-task-store.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface LinearHandlerDependencies {
  linearAuthManager: LinearAuthManager;
  linearSync: LinearSyncEngine;
  taskStore: PebblesTaskStore;
}

export class LinearHandlers {
  constructor(private deps: LinearHandlerDependencies) {}

  /**
   * Sync tasks with Linear
   */
  async handleLinearSync(args: any): Promise<any> {
    try {
      const { direction = 'both', force = false } = args;

      // Check auth first
      if (!this.deps.linearAuthManager.hasValidAuth()) {
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

      const result = await this.deps.linearSync.sync(direction === 'from_linear' ? 'pull' : 
                                                    direction === 'to_linear' ? 'push' : 'bidirectional');

      const syncText = `Linear Sync Complete:
- Created: ${result.created} tasks
- Updated: ${result.updated} tasks  
- Errors: ${result.errors}
- Duration: ${result.duration}ms`;

      return {
        content: [
          {
            type: 'text',
            text: syncText,
          },
        ],
        metadata: result,
      };
    } catch (error) {
      logger.error('Linear sync failed', error);
      
      if (error.message?.includes('unauthorized') || error.message?.includes('auth')) {
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
   * Update Linear task status
   */
  async handleLinearUpdateTask(args: any): Promise<any> {
    try {
      const { linear_id, status, assignee_id, priority, labels } = args;
      
      if (!linear_id) {
        throw new Error('Linear ID is required');
      }

      if (!this.deps.linearAuthManager.hasValidAuth()) {
        throw new Error('Linear authentication required');
      }

      const updateData: any = {};
      
      if (status) {
        updateData.status = status;
      }
      
      if (assignee_id) {
        updateData.assigneeId = assignee_id;
      }
      
      if (priority) {
        updateData.priority = priority;
      }
      
      if (labels) {
        updateData.labels = Array.isArray(labels) ? labels : [labels];
      }

      const result = await this.deps.linearSync.updateLinearIssue(linear_id, updateData);

      logger.info('Updated Linear task', { linearId: linear_id, updates: updateData });

      return {
        content: [
          {
            type: 'text',
            text: `Updated Linear issue ${linear_id}: ${Object.keys(updateData).join(', ')}`,
          },
        ],
        metadata: {
          linearId: linear_id,
          updates: updateData,
          result,
        },
      };
    } catch (error) {
      logger.error('Error updating Linear task', error);
      throw error;
    }
  }

  /**
   * Get tasks from Linear
   */
  async handleLinearGetTasks(args: any): Promise<any> {
    try {
      const { 
        team_id, 
        assignee_id, 
        state = 'active',
        limit = 20,
        search 
      } = args;

      if (!this.deps.linearAuthManager.hasValidAuth()) {
        throw new Error('Linear authentication required');
      }

      const filters: any = {
        limit,
      };
      
      if (team_id) {
        filters.teamId = team_id;
      }
      
      if (assignee_id) {
        filters.assigneeId = assignee_id;
      }
      
      if (state) {
        filters.state = state;
      }
      
      if (search) {
        filters.search = search;
      }

      const issues = await this.deps.linearSync.getLinearIssues(filters);

      const issuesSummary = issues.map(issue => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state?.name || 'Unknown',
        priority: issue.priority || 0,
        assignee: issue.assignee?.name || 'Unassigned',
        team: issue.team?.name || 'Unknown',
        url: issue.url,
      }));

      const summaryText = issuesSummary.length > 0
        ? issuesSummary.map(i => 
            `${i.identifier}: ${i.title} [${i.state}] (${i.assignee})`
          ).join('\n')
        : 'No Linear issues found';

      return {
        content: [
          {
            type: 'text',
            text: `Linear Issues (${issues.length}):\n${summaryText}`,
          },
        ],
        metadata: {
          issues: issuesSummary,
          totalCount: issues.length,
          filters,
        },
      };
    } catch (error) {
      logger.error('Error getting Linear tasks', error);
      throw error;
    }
  }

  /**
   * Get Linear integration status
   */
  async handleLinearStatus(args: any): Promise<any> {
    try {
      const authStatus = this.deps.linearAuthManager.hasValidAuth();
      
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
      const userInfo = await this.deps.linearAuthManager.getUserInfo();
      const teams = await this.deps.linearAuthManager.getTeams();
      
      // Get sync stats
      const syncStats = await this.deps.linearSync.getSyncStatistics();

      const statusText = `Linear Integration Status:
✓ Connected as: ${userInfo?.name || 'Unknown'}
✓ Teams: ${teams?.length || 0}
✓ Last sync: ${syncStats.lastSync || 'Never'}
✓ Synced tasks: ${syncStats.totalSynced || 0}
✓ Sync errors: ${syncStats.errors || 0}`;

      return {
        content: [
          {
            type: 'text',
            text: statusText,
          },
        ],
        metadata: {
          connected: true,
          user: userInfo,
          teams,
          syncStats,
        },
      };
    } catch (error) {
      logger.error('Error getting Linear status', error);
      
      return {
        content: [
          {
            type: 'text',
            text: 'Linear: Connection error - please check auth',
          },
        ],
        metadata: {
          connected: false,
          error: error.message,
        },
      };
    }
  }
}