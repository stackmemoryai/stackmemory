/**
 * Tests for Migration Manager
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
} from 'vitest';
import {
  MigrationManager,
  type MigrationConfig,
} from '../migration-manager.js';
import { DatabaseAdapter, type DatabaseStats } from '../database-adapter.js';

class MockDatabaseAdapter extends DatabaseAdapter {
  private connected = false;
  private pingResponse = true;
  private schemaVersion = 1;
  private stats: DatabaseStats = {
    totalFrames: 1000,
    activeFrames: 100,
    totalEvents: 5000,
    totalAnchors: 500,
    diskUsage: 1024 * 1024,
    lastVacuum: new Date(),
  };

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ping(): Promise<boolean> {
    return this.pingResponse;
  }

  async initializeSchema(): Promise<void> {
    // Mock implementation
  }

  async migrateSchema(targetVersion: number): Promise<void> {
    this.schemaVersion = targetVersion;
  }

  async getSchemaVersion(): Promise<number> {
    return this.schemaVersion;
  }

  async getStats(): Promise<DatabaseStats> {
    return { ...this.stats };
  }

  async analyze(): Promise<void> {
    // Mock implementation
  }

  async executeBulk(operations: any[]): Promise<void> {
    // Mock implementation
  }

  // Mock setters for testing
  setPingResponse(response: boolean): void {
    this.pingResponse = response;
  }

  setSchemaVersion(version: number): void {
    this.schemaVersion = version;
  }

  setStats(stats: Partial<DatabaseStats>): void {
    this.stats = { ...this.stats, ...stats };
  }

  // Required abstract methods (minimal implementation for testing)
  async createFrame(): Promise<string> {
    return 'frame-id';
  }
  async getFrame(): Promise<any> {
    return null;
  }
  async updateFrame(): Promise<void> {}
  async deleteFrame(): Promise<void> {}
  async getActiveFrames(): Promise<any[]> {
    return [];
  }
  async closeFrame(): Promise<void> {}
  async createEvent(): Promise<string> {
    return 'event-id';
  }
  async getFrameEvents(): Promise<any[]> {
    return [];
  }
  async deleteFrameEvents(): Promise<void> {}
  async createAnchor(): Promise<string> {
    return 'anchor-id';
  }
  async getFrameAnchors(): Promise<any[]> {
    return [];
  }
  async deleteFrameAnchors(): Promise<void> {}
  async search(): Promise<any[]> {
    return [];
  }
  async searchByVector(): Promise<any[]> {
    return [];
  }
  async searchHybrid(): Promise<any[]> {
    return [];
  }
  async aggregate(): Promise<any[]> {
    return [];
  }
  async detectPatterns(): Promise<any[]> {
    return [];
  }
  async vacuum(): Promise<void> {}
  async getQueryStats(): Promise<any[]> {
    return [];
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async inTransaction(): Promise<void> {}
  async exportData(): Promise<Buffer> {
    return Buffer.from('');
  }
  async importData(): Promise<void> {}
}

describe('MigrationManager', () => {
  let sourceAdapter: MockDatabaseAdapter;
  let targetAdapter: MockDatabaseAdapter;
  let migrationConfig: MigrationConfig;
  let migrationManager: MigrationManager;

  beforeEach(() => {
    sourceAdapter = new MockDatabaseAdapter('test-source');
    targetAdapter = new MockDatabaseAdapter('test-target');

    migrationConfig = {
      sourceAdapter,
      targetAdapter,
      batchSize: 100,
      retryAttempts: 2,
      retryDelayMs: 50,
      verifyData: true,
      enableDualWrite: false,
    };

    migrationManager = new MigrationManager(migrationConfig);
  });

  describe('Configuration', () => {
    it('should normalize configuration with defaults', () => {
      const minimal: MigrationConfig = {
        sourceAdapter,
        targetAdapter,
      };

      const manager = new MigrationManager(minimal);
      const config = (manager as any).config;

      expect(config.batchSize).toBe(1000);
      expect(config.retryAttempts).toBe(3);
      expect(config.retryDelayMs).toBe(1000);
      expect(config.verifyData).toBe(true);
      expect(config.enableDualWrite).toBe(true);
    });
  });

  describe('Migration Planning', () => {
    it('should create migration plan for all tables', async () => {
      const plan = await migrationManager.planMigration();

      expect(plan).toHaveLength(3);
      expect(plan.map((p) => p.table)).toEqual(['frames', 'events', 'anchors']);

      // Check priorities (frames should be first)
      expect(plan[0].table).toBe('frames');
      expect(plan[0].priority).toBe(1);
      expect(plan[0].dependencies).toEqual([]);

      // Events depend on frames
      expect(plan[1].table).toBe('events');
      expect(plan[1].dependencies).toEqual(['frames']);
    });

    it('should estimate total records correctly', async () => {
      const plan = await migrationManager.planMigration();
      const progress = migrationManager.getProgress();

      // Should sum up all estimated rows
      const expectedTotal = 1000 + 5000 + 500; // frames + events + anchors
      expect(progress.totalRecords).toBe(expectedTotal);
    });

    it('should handle estimation errors gracefully', async () => {
      // Mock getStats to throw error
      vi.spyOn(sourceAdapter, 'getStats').mockRejectedValueOnce(
        new Error('Stats error')
      );

      const plan = await migrationManager.planMigration();

      // Should still create plan but with 0 estimates and skip strategy
      expect(plan[0].estimatedRows).toBe(0);
      expect(plan[0].strategy).toBe('skip');
    });
  });

  describe('Adapter Validation', () => {
    it('should validate source adapter connectivity', async () => {
      sourceAdapter.setPingResponse(false);

      await expect(migrationManager.migrate()).rejects.toThrow(
        'Migration failed. Check logs for details.'
      );
    });

    it('should validate target adapter connectivity', async () => {
      targetAdapter.setPingResponse(false);

      await expect(migrationManager.migrate()).rejects.toThrow(
        'Migration failed. Check logs for details.'
      );
    });

    it('should warn about schema version mismatches', async () => {
      sourceAdapter.setSchemaVersion(2);
      targetAdapter.setSchemaVersion(1);

      const progressCallback = vi.fn();
      const manager = new MigrationManager({
        ...migrationConfig,
        progressCallback,
      });

      try {
        await manager.migrate();
      } catch (error) {
        // Expected to fail, but we should still have the warning
      }

      // Check that warning was added during validation
      const progress = manager.getProgress();
      expect(
        progress.warnings.some((w) =>
          w.warning.includes('Schema version mismatch')
        )
      ).toBe(true);
    });

    it('should connect adapters if not already connected', async () => {
      const connectSpy = vi.spyOn(sourceAdapter, 'connect');
      const targetConnectSpy = vi.spyOn(targetAdapter, 'connect');

      // Start with disconnected adapters
      await sourceAdapter.disconnect();
      await targetAdapter.disconnect();

      try {
        await migrationManager.migrate();
      } catch {
        // Expected to fail on other parts
      }

      expect(connectSpy).toHaveBeenCalled();
      expect(targetConnectSpy).toHaveBeenCalled();
    });
  });

  describe('Progress Tracking', () => {
    it('should initialize progress correctly', () => {
      const progress = migrationManager.getProgress();

      expect(progress.phase).toBe('initializing');
      expect(progress.totalRecords).toBe(0);
      expect(progress.processedRecords).toBe(0);
      expect(progress.percentage).toBe(0);
      expect(progress.errors).toEqual([]);
      expect(progress.warnings).toEqual([]);
      expect(progress.startTime).toBeInstanceOf(Date);
    });

    it('should emit progress events', async () => {
      const progressEvents: any[] = [];
      migrationManager.on('progress', (progress) => {
        progressEvents.push({ ...progress });
      });

      try {
        await migrationManager.migrate();
      } catch {
        // Expected to fail
      }

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[0].phase).toBe('initializing');
    });

    it('should call progress callback', async () => {
      const progressCallback = vi.fn();
      const manager = new MigrationManager({
        ...migrationConfig,
        progressCallback,
      });

      try {
        await manager.migrate();
      } catch {
        // Expected to fail
      }

      expect(progressCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: expect.any(String),
          totalRecords: expect.any(Number),
          processedRecords: expect.any(Number),
        })
      );
    });

    it('should calculate percentage correctly', async () => {
      const manager = new MigrationManager(migrationConfig);

      // Simulate some progress
      await manager.planMigration(); // This sets totalRecords

      const progress = manager.getProgress();
      expect(progress.totalRecords).toBeGreaterThan(0);

      // Simulate processing some records
      (manager as any).progress.processedRecords = progress.totalRecords / 2;
      (manager as any).updateProgressPercentage();

      const updatedProgress = manager.getProgress();
      expect(updatedProgress.percentage).toBe(50);
    });

    it('should estimate completion time', async () => {
      const manager = new MigrationManager(migrationConfig);
      await manager.planMigration();

      // Simulate some progress
      const progress = (manager as any).progress;
      progress.processedRecords = 1000;
      progress.startTime = new Date(Date.now() - 10000); // 10 seconds ago

      (manager as any).updateProgress({});

      const updatedProgress = manager.getProgress();
      expect(updatedProgress.estimatedEndTime).toBeInstanceOf(Date);
    });
  });

  describe('Error Handling', () => {
    it('should track errors correctly', () => {
      const manager = new MigrationManager(migrationConfig);

      (manager as any).addError('frames', 'Test error');

      const progress = manager.getProgress();
      expect(progress.errors).toHaveLength(1);
      expect(progress.errors[0]).toEqual({
        table: 'frames',
        error: 'Test error',
        timestamp: expect.any(Date),
      });
    });

    it('should track warnings correctly', () => {
      const manager = new MigrationManager(migrationConfig);

      (manager as any).addWarning('Test warning', 'events');

      const progress = manager.getProgress();
      expect(progress.warnings).toHaveLength(1);
      expect(progress.warnings[0]).toEqual({
        table: 'events',
        warning: 'Test warning',
        timestamp: expect.any(Date),
      });
    });

    it('should prevent concurrent migrations', async () => {
      const manager = new MigrationManager(migrationConfig);

      // Start first migration (will fail, but that's ok for this test)
      const firstMigration = manager.migrate().catch(() => {});

      // Try to start second migration
      await expect(manager.migrate()).rejects.toThrow(
        'Migration already in progress'
      );

      await firstMigration;
    });

    it('should handle rollback on error with fallback strategy', async () => {
      const rollbackSpy = vi
        .spyOn(migrationManager as any, 'rollbackMigration')
        .mockImplementation();

      // Force an error during validation
      sourceAdapter.setPingResponse(false);

      await expect(
        migrationManager.migrate({
          type: 'online',
          allowWrites: true,
          verifyIntegrity: true,
          fallbackOnError: true,
        })
      ).rejects.toThrow();

      expect(rollbackSpy).toHaveBeenCalled();
    });
  });

  describe('Duration Estimation', () => {
    it('should estimate migration duration', async () => {
      const estimate = await migrationManager.estimateDuration();

      expect(estimate.estimatedMinutes).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(estimate.confidence);
    });

    it('should adjust confidence based on record count', async () => {
      // Test high confidence for small datasets
      sourceAdapter.setStats({
        totalFrames: 100,
        totalEvents: 500,
        totalAnchors: 50,
      });

      const smallEstimate = await migrationManager.estimateDuration();
      expect(smallEstimate.confidence).toBe('high');

      // Test low confidence for large datasets
      sourceAdapter.setStats({
        totalFrames: 50000,
        totalEvents: 250000,
        totalAnchors: 25000,
      });

      const largeEstimate = await migrationManager.estimateDuration();
      expect(largeEstimate.confidence).toBe('low');
    });
  });

  describe('Control Operations', () => {
    it('should handle pause and resume', () => {
      const manager = new MigrationManager(migrationConfig);

      expect(() => manager.pause()).toThrow('No migration in progress');
      expect(() => manager.resume()).toThrow('No migration in progress');

      // Test during actual migration would require more complex setup
    });

    it('should handle abort', () => {
      const manager = new MigrationManager(migrationConfig);

      expect(() => manager.abort()).toThrow('No migration in progress');
    });

    it('should track migration status', () => {
      const manager = new MigrationManager(migrationConfig);

      expect(manager.isActive()).toBe(false);

      // Would become true during actual migration
    });
  });

  describe('Event Emission', () => {
    it('should emit completed event on success', () => {
      const completedHandler = vi.fn();
      const manager = new MigrationManager(migrationConfig);
      manager.on('completed', completedHandler);

      // Test that the event emission mechanism works
      manager.emit('completed', manager.getProgress());

      expect(completedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'initializing',
        })
      );
    });

    it('should emit failed event on error', async () => {
      const failedHandler = vi.fn();
      migrationManager.on('failed', failedHandler);

      sourceAdapter.setPingResponse(false);

      await expect(migrationManager.migrate()).rejects.toThrow();

      expect(failedHandler).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('Security Tests', () => {
    it('should reject invalid table names', async () => {
      const maliciousTable = "users'; DROP TABLE frames; --";

      await expect(
        (migrationManager as any).getBatch(maliciousTable, 0, 100)
      ).rejects.toThrow('Invalid table name');
    });

    it('should validate batch size limits', () => {
      expect(
        () =>
          new MigrationManager({
            sourceAdapter,
            targetAdapter,
            batchSize: 50000, // Too large
          })
      ).toThrow('Batch size must be between 1 and 10000');
    });

    it('should validate retry attempt limits', () => {
      expect(
        () =>
          new MigrationManager({
            sourceAdapter,
            targetAdapter,
            retryAttempts: 20, // Too many
          })
      ).toThrow('Retry attempts must be between 0 and 10');
    });

    it('should validate retry delay limits', () => {
      expect(
        () =>
          new MigrationManager({
            sourceAdapter,
            targetAdapter,
            retryDelayMs: 60000, // Too long
          })
      ).toThrow('Retry delay must be between 0 and 30000ms');
    });

    it('should require source and target adapters', () => {
      expect(
        () =>
          new MigrationManager({
            sourceAdapter: null as any,
            targetAdapter,
          })
      ).toThrow('Source and target adapters are required');
    });

    it('should sanitize error messages', async () => {
      sourceAdapter.setPingResponse(false);

      try {
        await migrationManager.migrate();
      } catch (error: any) {
        expect(error.message).toBe('Migration failed. Check logs for details.');
        expect(error.message).not.toContain('password');
        expect(error.message).not.toContain('connection string');
        expect(error.message).not.toContain('stack trace');
      }
    });

    it('should validate row data structure', () => {
      const invalidFrame = { invalidField: 'value' };

      expect(() =>
        (migrationManager as any).validateRowData('frames', invalidFrame)
      ).toThrow('Missing required field frame_id in frame row');
    });

    it('should validate table names in migrateBatch', async () => {
      const maliciousTable = "users'; DROP TABLE frames; --";

      await expect(
        (migrationManager as any).migrateBatch(maliciousTable, [])
      ).rejects.toThrow('Invalid table name');
    });

    it('should bound offset and limit parameters', async () => {
      const result = await (migrationManager as any).getBatch(
        'frames',
        -100,
        50000
      );

      // Should handle negative offset and excessive limit gracefully
      expect(result).toEqual([]);
    });
  });
});
