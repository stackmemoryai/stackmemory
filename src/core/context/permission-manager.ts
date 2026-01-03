/**
 * Permission Management for Collaboration Layer
 */

import { ValidationError, ErrorCode } from '../errors/index.js';
import type { StackPermissions, StackContext } from './dual-stack-manager.js';
import { logger } from '../monitoring/logger.js';

export type Operation = 'read' | 'write' | 'handoff' | 'merge' | 'administer';

export interface PermissionContext {
  userId: string;
  operation: Operation;
  resourceType: 'stack' | 'frame' | 'handoff' | 'merge';
  resourceId: string;
  stackContext?: StackContext;
}

export class PermissionManager {
  private userPermissions = new Map<string, Map<string, StackPermissions>>();
  private adminUsers = new Set<string>();

  constructor() {
    this.initializeDefaultPermissions();
  }

  /**
   * Check if user has permission for specific operation
   */
  async checkPermission(context: PermissionContext): Promise<boolean> {
    try {
      // Super admin always has access
      if (this.adminUsers.has(context.userId)) {
        return true;
      }

      // Get stack permissions for user
      const stackPermissions = this.getStackPermissions(
        context.userId,
        context.stackContext?.stackId || context.resourceId
      );

      if (!stackPermissions) {
        logger.warn('No permissions found for user', {
          userId: context.userId,
          stackId: context.stackContext?.stackId,
          operation: context.operation,
        });
        return false;
      }

      // Check operation-specific permissions
      switch (context.operation) {
        case 'read':
          return stackPermissions.canRead;

        case 'write':
          return stackPermissions.canWrite;

        case 'handoff':
          return stackPermissions.canHandoff;

        case 'merge':
          return stackPermissions.canMerge;

        case 'administer':
          return stackPermissions.canAdminister;

        default:
          logger.error('Unknown operation type', {
            operation: context.operation,
          });
          return false;
      }
    } catch (error) {
      logger.error('Permission check failed', error);
      return false;
    }
  }

  /**
   * Enforce permission check - throws if access denied
   */
  async enforcePermission(context: PermissionContext): Promise<void> {
    const hasPermission = await this.checkPermission(context);

    if (!hasPermission) {
      throw new ValidationError(
        `Access denied: User ${context.userId} lacks ${context.operation} permission for ${context.resourceType} ${context.resourceId}`,
        ErrorCode.PERMISSION_VIOLATION,
        {
          userId: context.userId,
          operation: context.operation,
          resourceType: context.resourceType,
          resourceId: context.resourceId,
        }
      );
    }

    logger.debug('Permission granted', {
      userId: context.userId,
      operation: context.operation,
      resourceType: context.resourceType,
      resourceId: context.resourceId,
    });
  }

  /**
   * Set permissions for user on specific stack
   */
  setStackPermissions(
    userId: string,
    stackId: string,
    permissions: StackPermissions
  ): void {
    if (!this.userPermissions.has(userId)) {
      this.userPermissions.set(userId, new Map());
    }

    this.userPermissions.get(userId)!.set(stackId, permissions);

    logger.info('Updated stack permissions', {
      userId,
      stackId,
      permissions,
    });
  }

  /**
   * Get permissions for user on specific stack
   */
  getStackPermissions(
    userId: string,
    stackId: string
  ): StackPermissions | null {
    const userPerms = this.userPermissions.get(userId);
    if (!userPerms) return null;

    return userPerms.get(stackId) || null;
  }

  /**
   * Grant admin privileges to user
   */
  grantAdminAccess(userId: string): void {
    this.adminUsers.add(userId);
    logger.info('Granted admin access', { userId });
  }

  /**
   * Revoke admin privileges from user
   */
  revokeAdminAccess(userId: string): void {
    this.adminUsers.delete(userId);
    logger.info('Revoked admin access', { userId });
  }

  /**
   * Check if user is admin
   */
  isAdmin(userId: string): boolean {
    return this.adminUsers.has(userId);
  }

  /**
   * Get all permissions for user
   */
  getUserPermissions(userId: string): Map<string, StackPermissions> {
    return this.userPermissions.get(userId) || new Map();
  }

  /**
   * Remove all permissions for user
   */
  removeUserPermissions(userId: string): void {
    this.userPermissions.delete(userId);
    this.adminUsers.delete(userId);
    logger.info('Removed all permissions for user', { userId });
  }

  /**
   * Initialize default permissions
   */
  private initializeDefaultPermissions(): void {
    // Set up default admin user if needed
    const defaultAdmin = process.env.STACKMEMORY_DEFAULT_ADMIN;
    if (defaultAdmin) {
      this.grantAdminAccess(defaultAdmin);
    }
  }

  /**
   * Create permission context helper
   */
  createContext(
    userId: string,
    operation: Operation,
    resourceType: PermissionContext['resourceType'],
    resourceId: string,
    stackContext?: StackContext
  ): PermissionContext {
    return {
      userId,
      operation,
      resourceType,
      resourceId,
      stackContext,
    };
  }

  /**
   * Bulk permission update for multiple stacks
   */
  setBulkStackPermissions(
    userId: string,
    stackPermissions: Record<string, StackPermissions>
  ): void {
    if (!this.userPermissions.has(userId)) {
      this.userPermissions.set(userId, new Map());
    }

    const userPerms = this.userPermissions.get(userId)!;

    Object.entries(stackPermissions).forEach(([stackId, permissions]) => {
      userPerms.set(stackId, permissions);
    });

    logger.info('Updated bulk stack permissions', {
      userId,
      stackCount: Object.keys(stackPermissions).length,
    });
  }

  /**
   * Get permission summary for debugging
   */
  getPermissionSummary(userId: string): {
    isAdmin: boolean;
    stackPermissions: Record<string, StackPermissions>;
  } {
    return {
      isAdmin: this.isAdmin(userId),
      stackPermissions: Object.fromEntries(this.getUserPermissions(userId)),
    };
  }
}
