/**
 * Cloud Sync MCP Tool Handlers
 * Exposes push/pull/status operations as MCP tools.
 */

import type { CloudSyncManager } from '../../../core/storage/cloud-sync-manager.js';
import type { SyncTable } from '../../../core/storage/cloud-sync-types.js';

const VALID_SYNC_TABLES = new Set<string>([
  'frames',
  'events',
  'anchors',
  'trace_events',
  'entity_states',
]);

export interface CloudSyncHandlerDependencies {
  syncManager: CloudSyncManager | null;
}

export class CloudSyncHandlers {
  private syncManager: CloudSyncManager | null;

  constructor(deps: CloudSyncHandlerDependencies) {
    this.syncManager = deps.syncManager;
  }

  private ensureManager(): CloudSyncManager {
    if (!this.syncManager) {
      throw new Error(
        'Cloud sync not configured. Run `stackmemory login` to connect to Provenant.'
      );
    }
    return this.syncManager;
  }

  async handlePush(args: {
    force?: boolean;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const manager = this.ensureManager();
    const result = await manager.performPush('manual', args.force);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: result.success,
              pushed: result.pushed,
              rejected: result.rejected,
              conflicts: result.conflicts,
              error: result.error,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async handlePull(args: {
    tables?: string[];
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const manager = this.ensureManager();
    const tables = args.tables?.filter((t) => VALID_SYNC_TABLES.has(t)) as
      | SyncTable[]
      | undefined;
    const result = await manager.performPull('manual', tables);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: result.success,
              pulled: result.pulled,
              applied: result.applied,
              conflicts: result.conflicts,
              error: result.error,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async handleStatus(): Promise<{
    content: Array<{ type: string; text: string }>;
  }> {
    if (!this.syncManager) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                connected: false,
                message:
                  'Cloud sync not configured. Run `stackmemory login` to connect.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const status = this.syncManager.getStatus();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }
}
