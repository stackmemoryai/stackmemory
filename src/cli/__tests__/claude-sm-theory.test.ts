import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Tests for getTheoryContent() logic extracted from claude-sm.ts.
 * We test the pure logic without spawning the full ClaudeSM class.
 */

function getTheoryContent(root: string): string | null {
  try {
    const theoryPath = path.join(root, 'THEORY.MD');
    if (fs.existsSync(theoryPath)) {
      const content = fs.readFileSync(theoryPath, 'utf8').trim();
      if (content.length > 0) {
        return content.length > 4000
          ? content.substring(0, 4000) + '\n\n[...truncated]'
          : content;
      }
    }
  } catch {
    // Silent
  }
  return null;
}

describe('getTheoryContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sm-theory-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns content when THEORY.MD exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'THEORY.MD'),
      '# Test Theory\n\nContent here.'
    );
    const result = getTheoryContent(tmpDir);
    expect(result).toBe('# Test Theory\n\nContent here.');
  });

  it('returns null when THEORY.MD is missing', () => {
    const result = getTheoryContent(tmpDir);
    expect(result).toBeNull();
  });

  it('returns null for empty THEORY.MD', () => {
    fs.writeFileSync(path.join(tmpDir, 'THEORY.MD'), '   \n  \n');
    const result = getTheoryContent(tmpDir);
    expect(result).toBeNull();
  });

  it('truncates content at 4000 chars', () => {
    const longContent = 'x'.repeat(5000);
    fs.writeFileSync(path.join(tmpDir, 'THEORY.MD'), longContent);
    const result = getTheoryContent(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(5000);
    expect(result!.endsWith('[...truncated]')).toBe(true);
    // 4000 chars + '\n\n[...truncated]' = 4016
    expect(result!.length).toBe(4000 + '\n\n[...truncated]'.length);
  });

  it('returns full content under 4000 chars without truncation', () => {
    const content = 'a'.repeat(3999);
    fs.writeFileSync(path.join(tmpDir, 'THEORY.MD'), content);
    const result = getTheoryContent(tmpDir);
    expect(result).toBe(content);
    expect(result!.includes('[...truncated]')).toBe(false);
  });

  it('trims whitespace from content', () => {
    fs.writeFileSync(path.join(tmpDir, 'THEORY.MD'), '\n  Hello world  \n\n');
    const result = getTheoryContent(tmpDir);
    expect(result).toBe('Hello world');
  });
});
