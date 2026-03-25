/**
 * Tests for PermissionManager — access control for frames/stacks
 * Covers: checkPermission, enforcePermission, admin access, bulk ops, edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionManager } from '../permission-manager.js';
import type { Operation, PermissionContext } from '../permission-manager.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function fullPermissions() {
  return {
    canRead: true,
    canWrite: true,
    canHandoff: true,
    canMerge: true,
    canAdminister: true,
  };
}

function readOnlyPermissions() {
  return {
    canRead: true,
    canWrite: false,
    canHandoff: false,
    canMerge: false,
    canAdminister: false,
  };
}

function noPermissions() {
  return {
    canRead: false,
    canWrite: false,
    canHandoff: false,
    canMerge: false,
    canAdminister: false,
  };
}

function makeCtx(
  userId: string,
  operation: Operation,
  resourceId: string = 'stack-1'
): PermissionContext {
  return {
    userId,
    operation,
    resourceType: 'stack',
    resourceId,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PermissionManager', () => {
  let pm: PermissionManager;

  beforeEach(() => {
    // Clear env to avoid default admin side effects
    delete process.env['STACKMEMORY_DEFAULT_ADMIN'];
    pm = new PermissionManager();
  });

  // ── setStackPermissions / getStackPermissions ────────────────────────

  describe('setStackPermissions / getStackPermissions', () => {
    it('should store and retrieve permissions', () => {
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      const perms = pm.getStackPermissions('user-1', 'stack-a');
      expect(perms).toEqual(fullPermissions());
    });

    it('should return null for unknown user', () => {
      expect(pm.getStackPermissions('unknown', 'stack-a')).toBeNull();
    });

    it('should return null for unknown stack', () => {
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      expect(pm.getStackPermissions('user-1', 'stack-b')).toBeNull();
    });

    it('should overwrite existing permissions', () => {
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      pm.setStackPermissions('user-1', 'stack-a', readOnlyPermissions());
      expect(pm.getStackPermissions('user-1', 'stack-a')).toEqual(
        readOnlyPermissions()
      );
    });

    it('should support multiple stacks per user', () => {
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      pm.setStackPermissions('user-1', 'stack-b', readOnlyPermissions());
      expect(pm.getStackPermissions('user-1', 'stack-a')).toEqual(
        fullPermissions()
      );
      expect(pm.getStackPermissions('user-1', 'stack-b')).toEqual(
        readOnlyPermissions()
      );
    });
  });

  // ── checkPermission ──────────────────────────────────────────────────

  describe('checkPermission', () => {
    it('should return true for permitted operation', async () => {
      pm.setStackPermissions('user-1', 'stack-1', fullPermissions());
      expect(await pm.checkPermission(makeCtx('user-1', 'read'))).toBe(true);
      expect(await pm.checkPermission(makeCtx('user-1', 'write'))).toBe(true);
      expect(await pm.checkPermission(makeCtx('user-1', 'handoff'))).toBe(true);
      expect(await pm.checkPermission(makeCtx('user-1', 'merge'))).toBe(true);
      expect(await pm.checkPermission(makeCtx('user-1', 'administer'))).toBe(
        true
      );
    });

    it('should return false for denied operation', async () => {
      pm.setStackPermissions('user-1', 'stack-1', readOnlyPermissions());
      expect(await pm.checkPermission(makeCtx('user-1', 'write'))).toBe(false);
      expect(await pm.checkPermission(makeCtx('user-1', 'handoff'))).toBe(
        false
      );
      expect(await pm.checkPermission(makeCtx('user-1', 'merge'))).toBe(false);
    });

    it('should return false for user with no permissions', async () => {
      expect(await pm.checkPermission(makeCtx('nobody', 'read'))).toBe(false);
    });

    it('should return false when all permissions are false', async () => {
      pm.setStackPermissions('user-1', 'stack-1', noPermissions());
      expect(await pm.checkPermission(makeCtx('user-1', 'read'))).toBe(false);
    });

    it('should use stackContext.stackId when available', async () => {
      pm.setStackPermissions('user-1', 'stack-ctx', fullPermissions());
      const ctx: PermissionContext = {
        userId: 'user-1',
        operation: 'read',
        resourceType: 'stack',
        resourceId: 'fallback-id',
        stackContext: {
          stackId: 'stack-ctx',
          type: 'individual',
          projectId: 'proj-1',
        },
      };
      expect(await pm.checkPermission(ctx)).toBe(true);
    });

    it('should fall back to resourceId when no stackContext', async () => {
      pm.setStackPermissions('user-1', 'res-id', fullPermissions());
      expect(
        await pm.checkPermission(makeCtx('user-1', 'read', 'res-id'))
      ).toBe(true);
    });
  });

  // ── Admin access ─────────────────────────────────────────────────────

  describe('admin access', () => {
    it('should grant admin full access to any operation', async () => {
      pm.grantAdminAccess('admin-1');
      // No stack permissions set, but admin bypasses
      expect(await pm.checkPermission(makeCtx('admin-1', 'read'))).toBe(true);
      expect(await pm.checkPermission(makeCtx('admin-1', 'administer'))).toBe(
        true
      );
    });

    it('should identify admin users', () => {
      pm.grantAdminAccess('admin-1');
      expect(pm.isAdmin('admin-1')).toBe(true);
      expect(pm.isAdmin('user-1')).toBe(false);
    });

    it('should revoke admin access', async () => {
      pm.grantAdminAccess('admin-1');
      pm.revokeAdminAccess('admin-1');
      expect(pm.isAdmin('admin-1')).toBe(false);
      expect(await pm.checkPermission(makeCtx('admin-1', 'read'))).toBe(false);
    });

    it('should initialize default admin from env', () => {
      process.env['STACKMEMORY_DEFAULT_ADMIN'] = 'env-admin';
      const pm2 = new PermissionManager();
      expect(pm2.isAdmin('env-admin')).toBe(true);
      delete process.env['STACKMEMORY_DEFAULT_ADMIN'];
    });
  });

  // ── enforcePermission ────────────────────────────────────────────────

  describe('enforcePermission', () => {
    it('should not throw for permitted operation', async () => {
      pm.setStackPermissions('user-1', 'stack-1', fullPermissions());
      await expect(
        pm.enforcePermission(makeCtx('user-1', 'read'))
      ).resolves.not.toThrow();
    });

    it('should throw ValidationError for denied operation', async () => {
      pm.setStackPermissions('user-1', 'stack-1', readOnlyPermissions());
      await expect(
        pm.enforcePermission(makeCtx('user-1', 'write'))
      ).rejects.toThrow(ValidationError);
    });

    it('should include context in thrown error', async () => {
      try {
        await pm.enforcePermission(makeCtx('user-1', 'write', 'stack-99'));
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const ve = error as ValidationError;
        expect(ve.code).toBe(ErrorCode.PERMISSION_VIOLATION);
        expect(ve.message).toContain('user-1');
        expect(ve.message).toContain('write');
        expect(ve.message).toContain('stack-99');
      }
    });

    it('should not throw for admin user', async () => {
      pm.grantAdminAccess('admin-1');
      await expect(
        pm.enforcePermission(makeCtx('admin-1', 'administer'))
      ).resolves.not.toThrow();
    });
  });

  // ── getUserPermissions ───────────────────────────────────────────────

  describe('getUserPermissions', () => {
    it('should return empty map for unknown user', () => {
      const perms = pm.getUserPermissions('unknown');
      expect(perms.size).toBe(0);
    });

    it('should return all stack permissions for user', () => {
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      pm.setStackPermissions('user-1', 'stack-b', readOnlyPermissions());
      const perms = pm.getUserPermissions('user-1');
      expect(perms.size).toBe(2);
      expect(perms.get('stack-a')).toEqual(fullPermissions());
    });
  });

  // ── removeUserPermissions ────────────────────────────────────────────

  describe('removeUserPermissions', () => {
    it('should remove all permissions and admin status', async () => {
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      pm.grantAdminAccess('user-1');
      pm.removeUserPermissions('user-1');
      expect(pm.isAdmin('user-1')).toBe(false);
      expect(pm.getStackPermissions('user-1', 'stack-a')).toBeNull();
      expect(await pm.checkPermission(makeCtx('user-1', 'read'))).toBe(false);
    });

    it('should be safe to call for unknown user', () => {
      expect(() => pm.removeUserPermissions('unknown')).not.toThrow();
    });
  });

  // ── createContext ────────────────────────────────────────────────────

  describe('createContext', () => {
    it('should create a valid PermissionContext', () => {
      const ctx = pm.createContext('user-1', 'write', 'frame', 'frame-1');
      expect(ctx.userId).toBe('user-1');
      expect(ctx.operation).toBe('write');
      expect(ctx.resourceType).toBe('frame');
      expect(ctx.resourceId).toBe('frame-1');
      expect(ctx.stackContext).toBeUndefined();
    });

    it('should include optional stackContext', () => {
      const stackCtx = {
        stackId: 'stack-1',
        type: 'shared' as const,
        projectId: 'proj-1',
      };
      const ctx = pm.createContext(
        'user-1',
        'read',
        'stack',
        'stack-1',
        stackCtx
      );
      expect(ctx.stackContext).toEqual(stackCtx);
    });
  });

  // ── setBulkStackPermissions ──────────────────────────────────────────

  describe('setBulkStackPermissions', () => {
    it('should set permissions for multiple stacks at once', () => {
      pm.setBulkStackPermissions('user-1', {
        'stack-a': fullPermissions(),
        'stack-b': readOnlyPermissions(),
      });
      expect(pm.getStackPermissions('user-1', 'stack-a')).toEqual(
        fullPermissions()
      );
      expect(pm.getStackPermissions('user-1', 'stack-b')).toEqual(
        readOnlyPermissions()
      );
    });

    it('should merge with existing permissions', () => {
      pm.setStackPermissions('user-1', 'stack-a', readOnlyPermissions());
      pm.setBulkStackPermissions('user-1', {
        'stack-b': fullPermissions(),
      });
      // Original should still be there
      expect(pm.getStackPermissions('user-1', 'stack-a')).toEqual(
        readOnlyPermissions()
      );
      expect(pm.getStackPermissions('user-1', 'stack-b')).toEqual(
        fullPermissions()
      );
    });

    it('should handle empty object', () => {
      pm.setBulkStackPermissions('user-1', {});
      expect(pm.getUserPermissions('user-1').size).toBe(0);
    });
  });

  // ── getPermissionSummary ─────────────────────────────────────────────

  describe('getPermissionSummary', () => {
    it('should return summary with admin status and permissions', () => {
      pm.grantAdminAccess('user-1');
      pm.setStackPermissions('user-1', 'stack-a', fullPermissions());
      const summary = pm.getPermissionSummary('user-1');
      expect(summary.isAdmin).toBe(true);
      expect(summary.stackPermissions['stack-a']).toEqual(fullPermissions());
    });

    it('should return empty summary for unknown user', () => {
      const summary = pm.getPermissionSummary('unknown');
      expect(summary.isAdmin).toBe(false);
      expect(Object.keys(summary.stackPermissions)).toHaveLength(0);
    });
  });
});
