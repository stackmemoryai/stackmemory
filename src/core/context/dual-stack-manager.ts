/**
 * Dual Stack Manager - STA-99
 * Manages both individual and shared team stacks for collaboration
 */

import type { Frame, Event, Anchor } from './frame-manager.js';
import { FrameManager } from './frame-manager.js';
import type { DatabaseAdapter } from '../database/database-adapter.js';
import { logger } from '../monitoring/logger.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
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
    this.individualStack = new FrameManager(
      adapter as any, // Will be properly typed when database integration is complete
      projectId,
      userId
    );

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
        (await (this.adapter as any).execute?.(createStackContextsTable)) ||
          this.executeSchemaQuery(createStackContextsTable);
        (await (this.adapter as any).execute?.(createHandoffRequestsTable)) ||
          this.executeSchemaQuery(createHandoffRequestsTable);
        (await (this.adapter as any).execute?.(createStackSyncLogTable)) ||
          this.executeSchemaQuery(createStackSyncLogTable);
      }

      await this.adapter.commitTransaction();

      logger.info('Dual stack schema initialized successfully');
    } catch (error) {
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
    logger.warn(
      'Using fallback schema creation - implement execute method in adapter'
    );
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
        const sharedStack = new FrameManager(
          this.adapter as any,
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
    } catch (error) {
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
      const sharedStack = new FrameManager(
        this.adapter as any,
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
    } catch (error) {
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
    } catch (error) {
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
    const request = await this.loadHandoffRequest(requestId);
    if (!request) {
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
      const syncResult = await this.moveFramesBetweenStacks(
        request.sourceStackId,
        request.targetStackId,
        request.frameIds
      );

      // Update request status
      request.status = 'accepted';
      await this.saveHandoffRequest(request);

      logger.info(`Accepted handoff request: ${requestId}`, {
        frameCount: request.frameIds.length,
        conflicts: syncResult.conflictFrames.length,
      });

      return syncResult;
    } catch (error) {
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
        } catch (error) {
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
    } catch (error) {
      throw new DatabaseError(
        `Stack sync failed`,
        ErrorCode.OPERATION_FAILED,
        { sourceStackId, targetStackId },
        error instanceof Error ? error : undefined
      );
    }
  }

  private getStackManager(stackId: string): FrameManager {
    if (stackId.startsWith('individual-')) {
      return this.individualStack;
    }

    const sharedStack = this.sharedStacks.get(stackId);
    if (!sharedStack) {
      throw new DatabaseError(
        `Stack manager not found: ${stackId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

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
        await sourceStack.deleteFrame(frameId);
      }
    }

    return syncResult;
  }

  private async copyFrame(
    frame: Frame,
    targetStack: FrameManager
  ): Promise<void> {
    // Create frame in target stack
    await targetStack.createFrame({
      type: frame.type as any,
      name: frame.name,
      inputs: frame.inputs,
    });

    // Copy events
    const events = await this.individualStack.getFrameEvents(frame.frame_id);
    for (const event of events) {
      await targetStack.addEvent(frame.frame_id, {
        type: event.type as any,
        text: event.text,
        metadata: event.metadata,
      });
    }

    // Copy anchors
    const anchors = await this.individualStack.getFrameAnchors(frame.frame_id);
    for (const anchor of anchors) {
      await targetStack.addAnchor(frame.frame_id, {
        type: anchor.type as any,
        text: anchor.text,
        priority: anchor.priority,
        metadata: anchor.metadata,
      });
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
        type: event.type as any,
        text: event.text,
        metadata: { ...event.metadata, merged: true },
      });
    }

    const sourceAnchors = await this.individualStack.getFrameAnchors(
      sourceFrame.frame_id
    );
    for (const anchor of sourceAnchors) {
      await targetStack.addAnchor(existingFrame.frame_id, {
        type: anchor.type as any,
        text: anchor.text,
        priority: anchor.priority,
        metadata: { ...anchor.metadata, merged: true },
      });
    }
  }

  private async loadStackContext(
    stackId: string
  ): Promise<StackContext | null> {
    // Implementation would load from database
    // For now, return null
    return null;
  }

  private async saveStackContext(context: StackContext): Promise<void> {
    // Implementation would save to database
  }

  private async updateStackActivity(stackId: string): Promise<void> {
    // Implementation would update last_active timestamp
  }

  private async loadHandoffRequest(
    requestId: string
  ): Promise<HandoffRequest | null> {
    return this.handoffRequests.get(requestId) || null;
  }

  private async saveHandoffRequest(request: HandoffRequest): Promise<void> {
    // Implementation would save to database
  }

  /**
   * Get list of available stacks for the current user
   */
  async getAvailableStacks(): Promise<StackContext[]> {
    const stacks: StackContext[] = [this.activeContext];

    // Add shared stacks the user has access to
    for (const [stackId, manager] of this.sharedStacks) {
      const context = await this.loadStackContext(stackId);
      if (context) {
        stacks.push(context);
      }
    }

    return stacks;
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
