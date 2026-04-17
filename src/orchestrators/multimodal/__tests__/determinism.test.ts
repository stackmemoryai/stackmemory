import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  persistDeterminismReport,
  readLatestDeterminismReport,
  runDeterminismSmoke,
} from '../determinism.js';
import { runSpike } from '../harness.js';

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stackmemory-determinism-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('multimodal determinism', () => {
  it('scores deterministic fixture runs at 100 out of 100', async () => {
    const repoPath = makeTempRepo();

    const report = await runDeterminismSmoke(
      {
        task: 'Add a small auth guard',
        repoPath,
      },
      {
        runs: 5,
        implementer: 'codex',
        maxIters: 2,
      }
    );

    expect(report.runs).toBe(5);
    expect(report.score).toBe(100);
    expect(
      report.dimensions.every((dimension) => dimension.score === 100)
    ).toBe(true);
    expect(report.recommendations).toEqual([]);
    expect(
      new Set(report.snapshots.map((snapshot) => snapshot.resultHash)).size
    ).toBe(1);
  });

  it('can skip audit persistence for deterministic or replay runs', async () => {
    const repoPath = makeTempRepo();

    await runSpike(
      {
        task: 'Add a small auth guard',
        repoPath,
      },
      {
        dryRun: true,
        deterministicFixture: true,
        persistAudit: false,
      }
    );

    expect(existsSync(join(repoPath, '.stackmemory', 'build'))).toBe(false);
  });

  it('persists and reloads the latest cached determinism report', async () => {
    const repoPath = makeTempRepo();
    const report = await runDeterminismSmoke(
      {
        task: 'Add a small auth guard',
        repoPath,
      },
      {
        runs: 3,
      }
    );

    const stored = persistDeterminismReport(repoPath, report, {
      task: 'Add a small auth guard',
      trigger: 'test',
      changedPaths: ['src/orchestrators/multimodal/harness.ts'],
    });
    const reloaded = readLatestDeterminismReport(repoPath);

    expect(reloaded).not.toBeNull();
    expect(reloaded?.task).toBe('Add a small auth guard');
    expect(reloaded?.trigger).toBe('test');
    expect(reloaded?.changedPaths).toEqual([
      'src/orchestrators/multimodal/harness.ts',
    ]);
    expect(reloaded?.report.score).toBe(100);
    expect(stored.report.score).toBe(100);
  });
});
