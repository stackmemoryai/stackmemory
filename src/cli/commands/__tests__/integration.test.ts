/**
 * Integration tests for new CLI features
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CLI Integration Tests', () => {
  let testDir: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `stackmemory-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Initialize StackMemory in test directory
    execSync('stackmemory init', { cwd: testDir });
  });

  afterEach(() => {
    // Clean up test directory
    process.chdir(os.tmpdir());
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Clear Survival Commands', () => {
    it('should show clear status', () => {
      const result = execSync('stackmemory clear --status', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('Context Status');
      expect(result).toContain('Tokens:');
    });

    it('should save continuity ledger', () => {
      const result = execSync('stackmemory clear --save', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('Continuity ledger saved');

      // Check that ledger file was created
      const ledgerPath = path.join(
        testDir,
        '.stackmemory',
        'continuity',
        'CONTINUITY_CLAUDE-latest.json'
      );
      expect(fs.existsSync(ledgerPath)).toBe(true);
    });

    it('should restore from ledger', () => {
      // First save a ledger
      execSync('stackmemory clear --save', { cwd: testDir });

      // Then restore
      const result = execSync('stackmemory clear --restore', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toMatch(/Context restored from ledger|No ledger found/);
    });
  });

  describe('Workflow Commands', () => {
    it('should list available workflows', () => {
      const result = execSync('stackmemory workflow --list', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('Available Workflow Templates');
      expect(result).toContain('tdd');
      expect(result).toContain('feature');
      expect(result).toContain('bugfix');
      expect(result).toContain('refactor');
    });

    it('should start TDD workflow', () => {
      const result = execSync('stackmemory workflow --start tdd', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('Started tdd workflow');
      expect(result).toContain('write-failing-tests');
    });

    it('should show workflow status', () => {
      // Start a workflow first
      execSync('stackmemory workflow --start feature', { cwd: testDir });

      const result = execSync('stackmemory workflow --status', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('Workflow Status');
      expect(result).toContain('feature');
    });
  });

  describe('Handoff Commands', () => {
    it('should generate handoff document', () => {
      const result = execSync('stackmemory handoff --generate', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('Handoff document generated');
      expect(result).toContain('Session:');
      expect(result).toContain('Duration:');

      // Check that handoff file was created
      const handoffDir = path.join(testDir, '.stackmemory', 'handoffs');
      expect(fs.existsSync(handoffDir)).toBe(true);
    });

    it('should load handoff document', () => {
      // First generate a handoff
      execSync('stackmemory handoff --generate', { cwd: testDir });

      // Then load it
      const result = execSync('stackmemory handoff --load', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toMatch(
        /Handoff document loaded|No handoff document found/
      );
    });

    it('should list handoff documents', () => {
      // Generate a handoff first
      execSync('stackmemory handoff --generate', { cwd: testDir });

      const result = execSync('stackmemory handoff --list', {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toMatch(/Handoff Documents|No handoff documents found/);
    });
  });

  describe('Feature Integration', () => {
    it('should handle full workflow: init -> workflow -> handoff -> clear', () => {
      // Start a workflow
      let result = execSync('stackmemory workflow --start feature', {
        cwd: testDir,
        encoding: 'utf8',
      });
      expect(result).toContain('Started feature workflow');

      // Generate handoff
      result = execSync('stackmemory handoff --generate', {
        cwd: testDir,
        encoding: 'utf8',
      });
      expect(result).toContain('Handoff document generated');

      // Save continuity ledger
      result = execSync('stackmemory clear --save', {
        cwd: testDir,
        encoding: 'utf8',
      });
      expect(result).toContain('Continuity ledger saved');

      // Verify all artifacts exist
      const ledgerPath = path.join(
        testDir,
        '.stackmemory',
        'continuity',
        'CONTINUITY_CLAUDE-latest.json'
      );
      const handoffDir = path.join(testDir, '.stackmemory', 'handoffs');

      expect(fs.existsSync(ledgerPath)).toBe(true);
      expect(fs.existsSync(handoffDir)).toBe(true);
    });
  });
});
