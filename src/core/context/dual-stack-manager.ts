/**
 * Dual Stack Manager - STA-99
 * Manages both individual and shared team stacks for collaboration
 */

import type { Frame, Event, Anchor } from './frame-types.js';
import { FrameManager } from './index.js';
import type { DatabaseAdapter } from '../database/database-adapter.js';
import { SQLiteAdapter } from '../database/sqlite-adapter.js';
import { logger } from '../monitoring/logger.js';
import { ValidationError, DatabaseError, ErrorCode } from '../errors/index.js';
import {
  validateInput,
  CreateSharedStackSchema,
  SwitchStackSchema,
  type CreateSharedStackInput,
  type SwitchStackInput,
} from './validation.js';
import { PermissionManager } from './permission-manager.js';

export interface StackContext {
  stackId: string;
  type: 'individual' | 'shared';
  projectId: string;
  ownerId?: string; // For individual stacks
  teamId?: string; // For shared stacks
  permissions: StackPermissions;
  metadata: Record<string, any>;
  createdAt: Date;
  lastActive: Date;
}

export interface StackPermissions {
  canRead: boolean;
  canWrite: boolean;
  canHandoff: boolean;
  canMerge: boolean;
  canAdminister: boolean;
}

export interface HandoffRequest {
  requestId: string;
  sourceStackId: string;
  targetStackId: string;
  frameIds: string[];
  requesterId: string;
  targetUserId?: string;
  message?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: Date;
  expiresAt: Date;
}

export interface StackSyncResult {
  success: boolean;
  conflictFrames: string[];
  mergedFrames: string[];
  errors: Array<{
    frameId: string;
    error: string;
    resolution?: 'skipped' | 'merged' | 'manual';
  }>;
}

export class DualStackManager {
  private adapter: DatabaseAdapter;
  private individualStack: FrameManager;
  private sharedStacks: Map<string, FrameManager> = new Map();
  private activeContext: StackContext;
  private handoffRequests: Map<string, HandoffRequest> = new Map();
  private permissionManager: PermissionManager;

  constructor(
    adapter: DatabaseAdapter,
    projectId: string,
    userId: string,
    defaultTeamId?: string
  ) {
    this.adapter = adapter;
    this.permissionManager = new PermissionManager();

    // Initialize individual stack
    // Extract raw database for FrameManager which expects SQLite directly
    const rawDb =
      adapter instanceof SQLiteAdapter ? adapter.getRawDatabase() : null;
    if (!rawDb) {
      throw new DatabaseError(
        'DualStackManager requires SQLiteAdapter with connected database',
        ErrorCode.DB_CONNECTION_FAILED,
        { adapter: adapter.constructor.name }
      );
    }

    this.individualStack = new FrameManager(rawDb, projectId, userId);

    // Set default active context to individual stack
    this.activeContext = {
      stackId: `individual-${userId}`,
      type: 'individual',
      projectId,
      ownerId: userId,
      permissions: this.getDefaultIndividualPermissions(),
      metadata: {},
      createdAt: new Date(),
      lastActive: new Date(),
    };

    // Set up initial permissions for the user's individual stack
    this.permissionManager.setStackPermissions(
      userId,
      `individual-${userId}`,
      this.getDefaultIndividualPermissions()
    );

    this.initializeSchema();
  }

  private async initializeSchema(): Promise<void> {
    try {
      // Create stack_contexts table
      await this.adapter.beginTransaction();

      const createStackContextsTable = `
        CREATE TABLE IF NOT EXISTS stack_contexts (
          stack_id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('individual', 'shared')),
          project_id TEXT NOT NULL,
          owner_id TEXT,
          team_id TEXT,
          permissions TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL,
          last_active INTEGER NOT NULL,
          CONSTRAINT valid_ownership CHECK (
            (type = 'individual' AND owner_id IS NOT NULL AND team_id IS NULL) OR
            (type = 'shared' AND team_id IS NOT NULL)
          )
        )
      `;

      const createHandoffRequestsTable = `
        CREATE TABLE IF NOT EXISTS handoff_requests (
          request_id TEXT PRIMARY KEY,
          source_stack_id TEXT NOT NULL,
          target_stack_id TEXT NOT NULL,
          frame_ids TEXT NOT NULL,
          requester_id TEXT NOT NULL,
          target_user_id TEXT,
          message TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          FOREIGN KEY (source_stack_id) REFERENCES stack_contexts(stack_id),
          FOREIGN KEY (target_stack_id) REFERENCES stack_contexts(stack_id)
        )
      `;

      const createStackSyncLogTable = `
        CREATE TABLE IF NOT EXISTS stack_sync_log (
          sync_id TEXT PRIMARY KEY,
          source_stack_id TEXT NOT NULL,
          target_stack_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('handoff', 'merge', 'sync')),
          frame_count INTEGER NOT NULL,
          conflicts TEXT DEFAULT '[]',
          resolution TEXT,
          timestamp INTEGER NOT NULL,
          FOREIGN KEY (source_stack_id) REFERENCES stack_contexts(stack_id),
          FOREIGN KEY (target_stack_id) REFERENCES stack_contexts(stack_id)
        )
      `;

      // Execute schema creation using raw SQL
      if (this.adapter.isConnected()) {
        // Note: This is a temporary workaround - proper schema creation would use adapter methods
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const adapterAny = this.adapter as any;
        if (!(await adapterAny.execute?.(createStackContextsTable))) {
          this.executeSchemaQuery(createStackContextsTable);
        }
        if (!(await adapterAny.execute?.(createHandoffRequestsTable))) {
          this.executeSchemaQuery(createHandoffRequestsTable);
        }
        if (!(await adapterAny.execute?.(createStackSyncLogTable))) {
          this.executeSchemaQuery(createStackSyncLogTable);
        }
      }

      await this.adapter.commitTransaction();

      logger.info('Dual stack schema initialized successfully');
    } catch (error: unknown) {
      await this.adapter.rollbackTransaction();
      logger.error('Failed to initialize dual stack schema', error);
      throw new DatabaseError(
        'Schema initialization failed',
        ErrorCode.DB_SCHEMA_ERROR,
        { adapter: this.adapter.constructor.name },
        error instanceof Error ? error : undefined
      );
    }
  }

  private async executeSchemaQuery(sql: string): Promise<void> {
    // Fallback for adapters that don't have execute method
    logger.debug(
      'Using fallback schema creation - implement execute method in adapter'
    );

    // Execute using raw SQLite database
    const rawDb =
      this.adapter instanceof SQLiteAdapter
        ? this.adapter.getRawDatabase()
        : null;
    if (rawDb) {
      try {
        rawDb.exec(sql);
        logger.debug('Executed schema query successfully');
      } catch (error: unknown) {
        logger.error('Failed to execute schema query', { sql, error });
        throw error;
      }
    } else {
      throw new DatabaseError(
        'Cannot execute schema query: raw database not available',
        ErrorCode.DB_CONNECTION_FAILED,
        { operation: 'executeSchemaQuery' }
      );
    }
  }

  private getDefaultIndividualPermissions(): StackPermissions {
    return {
      canRead: true,
      canWrite: true,
      canHandoff: true,
      canMerge: true,
      canAdminister: true,
    };
  }

  private getSharedStackPermissions(
    role: 'member' | 'lead' | 'admin'
  ): StackPermissions {
    const basePermissions = {
      canRead: true,
      canWrite: true,
      canHandoff: true,
      canMerge: false,
      canAdminister: false,
    };

    switch (role) {
      case 'lead':
        return { ...basePermissions, canMerge: true };
      case 'admin':
        return { ...basePermissions, canMerge: true, canAdminister: true };
      default:
        return basePermissions;
    }
  }

  /**
   * Switch between individual and shared stacks
   */
  async switchToStack(stackId: string): Promise<void> {
    // Validate input
    const input = validateInput(SwitchStackSchema, { stackId });

    try {
      if (input.stackId.startsWith('individual-')) {
        this.activeContext = {
          ...this.activeContext,
          stackId: input.stackId,
          type: 'individual',
        };
        return;
      }

      // Load shared stack context
      const stackContext = await this.loadStackContext(input.stackId);
      if (!stackContext) {
        throw new ValidationError(
          `Stack context not found: ${input.stackId}`,
          ErrorCode.STACK_CONTEXT_NOT_FOUND
        );
      }

      // Check permission to access the stack
      await this.permissionManager.enforcePermission(
        this.permissionManager.createContext(
          this.activeContext.ownerId || 'unknown',
          'read',
          'stack',
          input.stackId,
          stackContext
        )
      );

      this.activeContext = stackContext;

      // Initialize shared stack manager if not already loaded
      if (!this.sharedStacks.has(input.stackId)) {
        const rawDb =
          this.adapter instanceof SQLiteAdapter
            ? this.adapter.getRawDatabase()
            : null;
        if (!rawDb) {
          throw new DatabaseError(
            'Failed to get raw database for shared stack',
            ErrorCode.DB_CONNECTION_FAILED,
            { stackId: input.stackId, operation: 'switchToStack' }
          );
        }

        const sharedStack = new FrameManager(
          rawDb,
          stackContext.projectId,
          input.stackId
        );
        this.sharedStacks.set(input.stackId, sharedStack);
      }

      // Update last active timestamp
      await this.updateStackActivity(input.stackId);

      logger.info(`Switched to stack: ${input.stackId}`, {
        type: stackContext.type,
      });
    } catch (error: unknown) {
      throw new ValidationError(
        `Failed to switch to stack: ${input.stackId}`,
        ErrorCode.OPERATION_FAILED,
        { stackId: input.stackId },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the current active stack manager
   */
  getActiveStack(): FrameManager {
    if (this.activeContext.type === 'individual') {
      return this.individualStack;
    }

    const sharedStack = this.sharedStacks.get(this.activeContext.stackId);
    if (!sharedStack) {
      throw new DatabaseError(
        `Active shared stack not initialized: ${this.activeContext.stackId}`,
        ErrorCode.INVALID_STATE
      );
    }

    return sharedStack;
  }

  /**
   * Create a new shared stack for team collaboration
   */
  async createSharedStack(
    teamId: string,
    name: string,
    ownerId: string,
    permissions?: StackPermissions
  ): Promise<string> {
    // Validate input parameters
    const input = validateInput(CreateSharedStackSchema, {
      teamId,
      name,
      ownerId,
      permissions,
    });

    // Check permission to create shared stacks
    await this.permissionManager.enforcePermission(
      this.permissionManager.createContext(
        input.ownerId,
        'administer',
        'stack',
        `shared-${input.teamId}`,
        this.activeContext
      )
    );

    const stackId = `shared-${input.teamId}-${Date.now()}`;

    const stackContext: StackContext = {
      stackId,
      type: 'shared',
      projectId: this.activeContext.projectId,
      teamId: input.teamId,
      permissions: input.permissions || this.getSharedStackPermissions('admin'),
      metadata: { name: input.name, ownerId: input.ownerId },
      createdAt: new Date(),
      lastActive: new Date(),
    };

    try {
      await this.saveStackContext(stackContext);

      // Initialize the shared stack manager
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (!rawDb) {
        throw new DatabaseError(
          'Failed to get raw database for new shared stack',
          ErrorCode.DB_CONNECTION_FAILED,
          { teamId, operation: 'createSharedStack' }
        );
      }

      const sharedStack = new FrameManager(
        rawDb,
        stackContext.projectId,
        stackId
      );
      this.sharedStacks.set(stackId, sharedStack);

      // Set up permissions for the owner and team
      const stackPermissions = stackContext.permissions;
      this.permissionManager.setStackPermissions(
        input.ownerId,
        stackId,
        stackPermissions
      );

      logger.info(`Created shared stack: ${stackId}`, { teamId, name });
      return stackId;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to create shared stack`,
        ErrorCode.OPERATION_FAILED,
        { teamId, name },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Initiate handoff of frames between stacks
   */
  async initiateHandoff(
    targetStackId: string,
    frameIds: string[],
    targetUserId?: string,
    message?: string
  ): Promise<string> {
    // Check permission to perform handoff from current stack
    await this.permissionManager.enforcePermission(
      this.permissionManager.createContext(
        this.activeContext.ownerId || 'unknown',
        'handoff',
        'stack',
        this.activeContext.stackId,
        this.activeContext
      )
    );

    const requestId = `handoff-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const request: HandoffRequest = {
      requestId,
      sourceStackId: this.activeContext.stackId,
      targetStackId,
      frameIds,
      requesterId: this.activeContext.ownerId!,
      targetUserId,
      message,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    };

    try {
      await this.saveHandoffRequest(request);
      this.handoffRequests.set(requestId, request);

      logger.info(`Initiated handoff request: ${requestId}`, {
        sourceStack: this.activeContext.stackId,
        targetStack: targetStackId,
        frameCount: frameIds.length,
      });

      return requestId;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to initiate handoff`,
        ErrorCode.OPERATION_FAILED,
        { targetStackId, frameIds },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Accept a handoff request and move frames
   */
  async acceptHandoff(requestId: string): Promise<StackSyncResult> {
    logger.debug('acceptHandoff called', { requestId });
    const request = await this.loadHandoffRequest(requestId);
    logger.debug('loadHandoffRequest returned', {
      requestId,
      found: !!request,
    });
    if (!request) {
      logger.error('Handoff request not found', {
        requestId,
        availableRequests: Array.from(this.handoffRequests.keys()),
      });
      throw new DatabaseError(
        `Handoff request not found: ${requestId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    if (request.status !== 'pending') {
      throw new DatabaseError(
        `Handoff request is not pending: ${request.status}`,
        ErrorCode.INVALID_STATE
      );
    }

    if (request.expiresAt < new Date()) {
      throw new DatabaseError(
        `Handoff request has expired`,
        ErrorCode.OPERATION_EXPIRED
      );
    }

    try {
      // Perform the handoff operation
      logger.debug('Starting moveFramesBetweenStacks', { requestId });
      const syncResult = await this.moveFramesBetweenStacks(
        request.sourceStackId,
        request.targetStackId,
        request.frameIds
      );
      logger.debug('moveFramesBetweenStacks completed', {
        requestId,
        success: syncResult.success,
      });

      // Update request status
      logger.debug('Updating request status', { requestId });
      request.status = 'accepted';
      logger.debug('Calling saveHandoffRequest', { requestId });
      await this.saveHandoffRequest(request);
      logger.debug('saveHandoffRequest completed', { requestId });

      logger.info(`Accepted handoff request: ${requestId}`, {
        frameCount: request.frameIds.length,
        conflicts: syncResult.conflictFrames.length,
      });

      return syncResult;
    } catch (error: unknown) {
      logger.error('acceptHandoff caught error', {
        error: error instanceof Error ? error.message : error,
      });
      // Update request status to rejected on failure
      request.status = 'rejected';
      await this.saveHandoffRequest(request);

      throw new DatabaseError(
        `Failed to accept handoff`,
        ErrorCode.OPERATION_FAILED,
        { requestId },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Sync frames between individual and shared stacks
   */
  async syncStacks(
    sourceStackId: string,
    targetStackId: string,
    options: {
      frameIds?: string[];
      conflictResolution: 'skip' | 'merge' | 'overwrite';
      dryRun?: boolean;
    }
  ): Promise<StackSyncResult> {
    try {
      const sourceStack = this.getStackManager(sourceStackId);
      const targetStack = this.getStackManager(targetStackId);

      // Get frames to sync
      const framesToSync =
        options.frameIds ||
        (await sourceStack.getActiveFrames()).map((f) => f.frame_id);

      const result: StackSyncResult = {
        success: true,
        conflictFrames: [],
        mergedFrames: [],
        errors: [],
      };

      for (const frameId of framesToSync) {
        try {
          const sourceFrame = await sourceStack.getFrame(frameId);
          if (!sourceFrame) {
            result.errors.push({
              frameId,
              error: 'Source frame not found',
              resolution: 'skipped',
            });
            continue;
          }

          const existingFrame = await targetStack.getFrame(frameId);

          if (existingFrame) {
            // Handle conflict
            switch (options.conflictResolution) {
              case 'skip':
                result.conflictFrames.push(frameId);
                result.errors.push({
                  frameId,
                  error: 'Frame already exists',
                  resolution: 'skipped',
                });
                continue;

              case 'merge':
                if (!options.dryRun) {
                  await this.mergeFrames(
                    existingFrame,
                    sourceFrame,
                    targetStack
                  );
                }
                result.mergedFrames.push(frameId);
                break;

              case 'overwrite':
                if (!options.dryRun) {
                  await targetStack.deleteFrame(frameId);
                  await this.copyFrame(sourceFrame, targetStack);
                }
                result.mergedFrames.push(frameId);
                break;
            }
          } else {
            // Copy frame to target
            if (!options.dryRun) {
              await this.copyFrame(sourceFrame, targetStack);
            }
            result.mergedFrames.push(frameId);
          }
        } catch (error: unknown) {
          result.errors.push({
            frameId,
            error: error instanceof Error ? error.message : String(error),
            resolution: 'skipped',
          });
          result.success = false;
        }
      }

      logger.info(`Stack sync completed`, {
        source: sourceStackId,
        target: targetStackId,
        merged: result.mergedFrames.length,
        conflicts: result.conflictFrames.length,
        errors: result.errors.length,
      });

      return result;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Stack sync failed`,
        ErrorCode.OPERATION_FAILED,
        { sourceStackId, targetStackId },
        error instanceof Error ? error : undefined
      );
    }
  }

  getStackManager(stackId: string): FrameManager {
    logger.debug('getStackManager called', {
      stackId,
      availableStacks: Array.from(this.sharedStacks.keys()),
    });

    if (stackId.startsWith('individual-')) {
      logger.debug('Returning individual stack', { stackId });
      return this.individualStack;
    }

    const sharedStack = this.sharedStacks.get(stackId);
    if (!sharedStack) {
      logger.error('Stack manager not found', {
        stackId,
        availableSharedStacks: Array.from(this.sharedStacks.keys()),
        message: 'getStackManager could not find shared stack',
      });
      throw new DatabaseError(
        `Stack manager not found: ${stackId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    logger.debug('Returning shared stack', { stackId });
    return sharedStack;
  }

  private async moveFramesBetweenStacks(
    sourceStackId: string,
    targetStackId: string,
    frameIds: string[]
  ): Promise<StackSyncResult> {
    const syncResult = await this.syncStacks(sourceStackId, targetStackId, {
      frameIds,
      conflictResolution: 'merge',
    });

    // Remove frames from source stack after successful sync
    if (syncResult.success && syncResult.errors.length === 0) {
      const sourceStack = this.getStackManager(sourceStackId);
      for (const frameId of frameIds) {
        try {
          sourceStack.deleteFrame(frameId);
          logger.debug('Deleted frame from source stack', {
            frameId,
            sourceStackId,
          });
        } catch (error: unknown) {
          logger.warn('Failed to delete frame from source stack', {
            frameId,
            error,
          });
        }
      }
      logger.debug('Completed frame cleanup from source stack', {
        frameIds: frameIds.length,
      });
    }

    return syncResult;
  }

  private async copyFrame(
    frame: Frame,
    targetStack: FrameManager
  ): Promise<void> {
    // Create frame in target stack
    await targetStack.createFrame({
      type: frame.type,
      name: frame.name,
      inputs: frame.inputs,
    });

    // Copy events
    const events = await this.individualStack.getFrameEvents(frame.frame_id);
    for (const event of events) {
      await targetStack.addEvent(frame.frame_id, {
        type: event.type,
        text: event.text,
        metadata: event.metadata,
      } as any);
    }

    // Copy anchors
    const anchors = await this.individualStack.getFrameAnchors(frame.frame_id);
    for (const anchor of anchors) {
      await targetStack.addAnchor(frame.frame_id, {
        type: anchor.type,
        text: anchor.text,
        priority: anchor.priority,
        metadata: anchor.metadata,
      } as any);
    }
  }

  private async mergeFrames(
    existingFrame: Frame,
    sourceFrame: Frame,
    targetStack: FrameManager
  ): Promise<void> {
    // Simple merge strategy - append events and anchors
    const sourceEvents = await this.individualStack.getFrameEvents(
      sourceFrame.frame_id
    );
    for (const event of sourceEvents) {
      await targetStack.addEvent(existingFrame.frame_id, {
        type: event.type,
        text: event.text,
        metadata: { ...event.metadata, merged: true },
      } as any);
    }

    const sourceAnchors = await this.individualStack.getFrameAnchors(
      sourceFrame.frame_id
    );
    for (const anchor of sourceAnchors) {
      await targetStack.addAnchor(existingFrame.frame_id, {
        type: anchor.type,
        text: anchor.text,
        priority: anchor.priority,
        metadata: { ...anchor.metadata, merged: true },
      } as any);
    }
  }

  private async loadStackContext(
    stackId: string
  ): Promise<StackContext | null> {
    try {
      // Use raw database for direct query
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (!rawDb) {
        return null;
      }

      const query = rawDb.prepare(`
        SELECT stack_id, type, project_id, owner_id, team_id, permissions, metadata, created_at, last_active
        FROM stack_contexts 
        WHERE stack_id = ?
      `);

      const row = query.get(stackId) as
        | {
            stack_id: string;
            type: string;
            project_id: string;
            owner_id: string;
            team_id: string;
            permissions: string;
            metadata: string;
            created_at: string;
            last_active: string;
          }
        | undefined;
      if (!row) {
        return null;
      }

      return {
        stackId: row.stack_id,
        type: row.type as 'individual' | 'shared',
        projectId: row.project_id,
        ownerId: row.owner_id,
        teamId: row.team_id,
        permissions: JSON.parse(row.permissions),
        metadata: JSON.parse(row.metadata || '{}'),
        createdAt: new Date(row.created_at),
        lastActive: new Date(row.last_active),
      };
    } catch (error: unknown) {
      logger.error('Failed to load stack context', { stackId, error });
      return null;
    }
  }

  private async saveStackContext(context: StackContext): Promise<void> {
    try {
      // Use raw database for direct query
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (!rawDb) {
        throw new DatabaseError(
          'SQLite database not available for stack context save',
          ErrorCode.DB_CONNECTION_FAILED,
          { stackId: context.stackId, operation: 'saveStackContext' }
        );
      }

      const query = rawDb.prepare(`
        INSERT OR REPLACE INTO stack_contexts 
        (stack_id, type, project_id, owner_id, team_id, permissions, metadata, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      query.run(
        context.stackId,
        context.type,
        context.projectId,
        context.ownerId || null,
        context.teamId || null,
        JSON.stringify(context.permissions),
        JSON.stringify(context.metadata || {}),
        context.createdAt.getTime(),
        context.lastActive.getTime()
      );

      logger.debug('Saved stack context', { stackId: context.stackId });
    } catch (error: unknown) {
      logger.error('Failed to save stack context', {
        stackId: context.stackId,
        error,
      });
      throw error;
    }
  }

  private async updateStackActivity(stackId: string): Promise<void> {
    try {
      // Use raw database for direct query
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (!rawDb) {
        logger.warn('SQLite database not available for activity update');
        return;
      }

      const query = rawDb.prepare(`
        UPDATE stack_contexts 
        SET last_active = ?
        WHERE stack_id = ?
      `);

      query.run(Date.now(), stackId);
      logger.debug('Updated stack activity', { stackId });
    } catch (error: unknown) {
      logger.error('Failed to update stack activity', { stackId, error });
      // Don't throw - activity updates are not critical
    }
  }

  private async loadHandoffRequest(
    requestId: string
  ): Promise<HandoffRequest | null> {
    // Try in-memory first for fast access
    const memoryRequest = this.handoffRequests.get(requestId);
    if (memoryRequest) {
      return memoryRequest;
    }

    // Try loading from database
    try {
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (rawDb) {
        const query = rawDb.prepare(`
          SELECT * FROM handoff_requests WHERE request_id = ?
        `);

        const row = query.get(requestId) as
          | {
              request_id: string;
              source_stack_id: string;
              target_stack_id: string;
              frame_ids: string;
              status: string;
              created_at: string;
              expires_at: string;
              target_user_id: string;
              message: string;
            }
          | undefined;
        if (row) {
          const request: HandoffRequest = {
            requestId: row.request_id,
            sourceStackId: row.source_stack_id,
            targetStackId: row.target_stack_id,
            frameIds: JSON.parse(row.frame_ids),
            status: row.status,
            createdAt: new Date(row.created_at),
            expiresAt: new Date(row.expires_at),
            targetUserId: row.target_user_id,
            message: row.message,
          };

          // Cache in memory for future access
          this.handoffRequests.set(requestId, request);
          return request;
        }
      }
    } catch (error: unknown) {
      logger.error('Failed to load handoff request from database', {
        requestId,
        error,
      });
    }

    return null;
  }

  private async saveHandoffRequest(request: HandoffRequest): Promise<void> {
    try {
      // Use raw database for direct query
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (rawDb) {
        const query = rawDb.prepare(`
          INSERT OR REPLACE INTO handoff_requests 
          (request_id, source_stack_id, target_stack_id, frame_ids, status, created_at, expires_at, target_user_id, message)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        query.run(
          request.requestId,
          request.sourceStackId,
          request.targetStackId,
          JSON.stringify(request.frameIds),
          request.status,
          request.createdAt.getTime(),
          request.expiresAt.getTime(),
          request.targetUserId || null,
          request.message || null
        );

        logger.debug('Saved handoff request to database', {
          requestId: request.requestId,
        });
      }

      // Also keep in-memory for fast access
      this.handoffRequests.set(request.requestId, request);
    } catch (error: unknown) {
      logger.error('Failed to save handoff request', {
        requestId: request.requestId,
        error,
      });
      // Fallback to in-memory only
      this.handoffRequests.set(request.requestId, request);
    }
  }

  /**
   * Get list of available stacks for the current user
   */
  async getAvailableStacks(): Promise<StackContext[]> {
    try {
      const stacks: StackContext[] = [];

      // Always include current individual stack context
      stacks.push(this.activeContext);

      // Query database for all shared stacks the user has access to
      const rawDb =
        this.adapter instanceof SQLiteAdapter
          ? this.adapter.getRawDatabase()
          : null;
      if (rawDb) {
        const query = rawDb.prepare(`
          SELECT stack_id, type, project_id, owner_id, team_id, permissions, metadata, created_at, last_active
          FROM stack_contexts 
          WHERE type = 'shared' AND project_id = ?
        `);

        const rows = query.all(this.activeContext.projectId) as Array<{
          stack_id: string;
          type: string;
          project_id: string;
          owner_id: string;
          team_id: string;
          permissions: string;
          metadata: string;
          created_at: string;
          last_active: string;
        }>;

        for (const row of rows) {
          const context: StackContext = {
            stackId: row.stack_id,
            type: row.type as 'individual' | 'shared',
            projectId: row.project_id,
            ownerId: row.owner_id,
            teamId: row.team_id,
            permissions: JSON.parse(row.permissions),
            metadata: JSON.parse(row.metadata || '{}'),
            createdAt: new Date(row.created_at),
            lastActive: new Date(row.last_active),
          };

          // Check if user has permission to access this stack
          try {
            await this.permissionManager.enforcePermission(
              this.permissionManager.createContext(
                this.activeContext.ownerId || 'unknown',
                'read',
                'stack',
                context.stackId,
                context
              )
            );
            stacks.push(context);
          } catch (permissionError: unknown) {
            // Skip stacks user doesn't have access to
            logger.debug('User lacks access to stack', {
              stackId: context.stackId,
              userId: this.activeContext.ownerId,
            });
          }
        }
      }

      return stacks;
    } catch (error: unknown) {
      logger.error('Failed to get available stacks', error);
      // Return at least the current individual stack
      return [this.activeContext];
    }
  }

  /**
   * Get pending handoff requests for the current user
   */
  async getPendingHandoffRequests(): Promise<HandoffRequest[]> {
    return Array.from(this.handoffRequests.values()).filter(
      (request) =>
        request.status === 'pending' && request.expiresAt > new Date()
    );
  }

  /**
   * Get current stack context
   */
  getCurrentContext(): StackContext {
    return { ...this.activeContext };
  }

  /**
   * Get permission manager for external access
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * Add user to shared stack with specific permissions
   */
  async addUserToSharedStack(
    stackId: string,
    userId: string,
    permissions: StackPermissions,
    requesterId: string
  ): Promise<void> {
    // Check if requester has admin permissions on the stack
    await this.permissionManager.enforcePermission(
      this.permissionManager.createContext(
        requesterId,
        'administer',
        'stack',
        stackId
      )
    );

    // Grant permissions to the new user
    this.permissionManager.setStackPermissions(userId, stackId, permissions);

    logger.info(`Added user to shared stack`, {
      stackId,
      userId,
      permissions,
      requesterId,
    });
  }

  /**
   * Remove user from shared stack
   */
  async removeUserFromSharedStack(
    stackId: string,
    userId: string,
    requesterId: string
  ): Promise<void> {
    // Check if requester has admin permissions on the stack
    await this.permissionManager.enforcePermission(
      this.permissionManager.createContext(
        requesterId,
        'administer',
        'stack',
        stackId
      )
    );

    // Remove user's permissions
    const userPermissions = this.permissionManager.getUserPermissions(userId);
    userPermissions.delete(stackId);

    logger.info(`Removed user from shared stack`, {
      stackId,
      userId,
      requesterId,
    });
  }
}
