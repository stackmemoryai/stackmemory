import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

describe('theory-capture hook', () => {
  let tmpDir: string;
  let theoryPath: string;
  let hookScript: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theory-capture-test-'));
    theoryPath = path.join(tmpDir, 'THEORY.MD');
    // Copy hook script to tmpDir so it runs outside ESM project scope
    // (project has "type": "module" which breaks require() in .js files)
    const srcScript = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'templates',
      'claude-hooks',
      'theory-capture.js'
    );
    hookScript = path.join(tmpDir, 'theory-capture.js');
    fs.copyFileSync(srcScript, hookScript);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHook(input: Record<string, unknown>): string {
    try {
      return execFileSync('node', [hookScript], {
        input: JSON.stringify(input),
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, PATH: process.env['PATH'] },
      });
    } catch (e: unknown) {
      // Hook should never throw, but capture output if it does
      return (e as { stdout?: string }).stdout || '';
    }
  }

  it('writes theory-cache.json on Edit to THEORY.MD', () => {
    fs.writeFileSync(theoryPath, '# My Theory\n\nSome content\n');

    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: theoryPath },
    });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(true);

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(cache.path).toBe(theoryPath);
    expect(cache.lineCount).toBe(4);
    expect(cache.hash).toBeTruthy();
    expect(cache.timestamp).toBeTruthy();
  });

  it('writes theory-cache.json on Write to THEORY.MD', () => {
    fs.writeFileSync(theoryPath, 'line1\nline2\n');

    runHook({
      tool_name: 'Write',
      tool_input: { file_path: theoryPath },
    });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it('ignores Edit to non-THEORY.MD files', () => {
    const otherFile = path.join(tmpDir, 'README.md');
    fs.writeFileSync(otherFile, 'hello');

    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: otherFile },
    });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('ignores Read tool even for THEORY.MD', () => {
    fs.writeFileSync(theoryPath, 'content');

    runHook({
      tool_name: 'Read',
      tool_input: { file_path: theoryPath },
    });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('handles case-insensitive THEORY.MD path', () => {
    // Create lowercase variant
    const lowerPath = path.join(tmpDir, 'theory.md');
    fs.writeFileSync(lowerPath, 'content\n');

    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: lowerPath },
    });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    // isTheoryPath checks lowercase so this should match
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it('handles missing file gracefully', () => {
    // Don't create the file — hook should not crash
    const missingPath = path.join(tmpDir, 'THEORY.MD');

    runHook({
      tool_name: 'Edit',
      tool_input: { file_path: missingPath },
    });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it('handles missing tool_input gracefully', () => {
    // Should not crash
    runHook({ tool_name: 'Edit' });

    const cachePath = path.join(tmpDir, '.stackmemory', 'theory-cache.json');
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});
