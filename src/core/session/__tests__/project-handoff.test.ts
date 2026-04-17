import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadProjectHandoff,
  parseBranchFromHandoffContent,
} from '../project-handoff.js';

describe('project handoff compatibility', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'stackmemory-handoff-'));
    mkdirSync(join(dir, '.stackmemory'), { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  it('parses branch from compact handoff content', () => {
    expect(
      parseBranchFromHandoffContent(
        '# Handoff: stackmemory@feature/test-branch\n## Work: test'
      )
    ).toBe('feature/test-branch');
  });

  it('loads a compatible handoff for the current branch', () => {
    const project = makeProject();
    writeFileSync(
      join(project, '.stackmemory', 'last-handoff.md'),
      '# Handoff: stackmemory@feature/test-branch\n## Work: test'
    );
    writeFileSync(
      join(project, '.stackmemory', 'last-handoff-meta.json'),
      JSON.stringify({ branch: 'feature/test-branch' }, null, 2)
    );

    const handoff = loadProjectHandoff(project, 'feature/test-branch');
    expect(handoff).not.toBeNull();
    expect(handoff?.compatible).toBe(true);
    expect(handoff?.branch).toBe('feature/test-branch');
  });

  it('rejects a stale handoff from another branch', () => {
    const project = makeProject();
    writeFileSync(
      join(project, '.stackmemory', 'last-handoff.md'),
      '# Handoff: stackmemory@feature/old-branch\n## Work: test'
    );

    const handoff = loadProjectHandoff(project, 'release/current');
    expect(handoff).not.toBeNull();
    expect(handoff?.compatible).toBe(false);
    expect(handoff?.mismatchReason).toContain('feature/old-branch');
    expect(handoff?.mismatchReason).toContain('release/current');
  });
});
