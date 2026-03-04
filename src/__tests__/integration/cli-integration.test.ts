/**
 * Simplified CLI Integration Tests
 * Tests basic CLI functionality without complex mocking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use the built CLI
const projectRoot = path.join(__dirname, '..', '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'src', 'cli', 'index.js');

describe('CLI Integration', { timeout: 60_000 }, () => {
  let testDir: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `stackmemory-cli-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Basic Commands', () => {
    it('should show help', () => {
      const result = execSync(`node ${cliPath} --help`, {
        encoding: 'utf8',
        timeout: 15_000,
      });

      expect(result).toContain('stackmemory');
      expect(result).toContain('Commands:');
    });

    it('should show version', () => {
      const result = execSync(`node ${cliPath} --version`, {
        encoding: 'utf8',
        timeout: 15_000,
      });

      expect(result).toMatch(/\d+\.\d+\.\d+/);
    });

    it('should initialize project', () => {
      const result = execSync(`node ${cliPath} init`, {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 15_000,
      });

      expect(result).toContain('StackMemory initialized');

      // Check that .stackmemory directory was created
      const stackmemoryDir = path.join(testDir, '.stackmemory');
      expect(fs.existsSync(stackmemoryDir)).toBe(true);
    });
  });

  describe('Status Command', () => {
    it('should handle status when not initialized', () => {
      try {
        execSync(`node ${cliPath} status`, {
          cwd: testDir,
          encoding: 'utf8',
          timeout: 15_000,
        });
      } catch (error: any) {
        expect(error.stdout || error.message).toContain('not initialized');
      }
    });
  });
});
