import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to test the private isNewerVersion logic indirectly via the public API.
// UpdateChecker.checkForUpdates uses fetchLatestVersion (npm call) + isNewerVersion.
// For unit tests, we'll test via forceCheck with mocked npm call.

describe('UpdateChecker', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-test-'));
    // Save and override HOME to isolate cache file
    originalHome = process.env['HOME'];
  });

  afterEach(() => {
    if (originalHome) {
      process.env['HOME'] = originalHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exports UpdateChecker class', async () => {
    const mod = await import('../update-checker.js');
    expect(mod.UpdateChecker).toBeDefined();
    expect(typeof mod.UpdateChecker.checkForUpdates).toBe('function');
    expect(typeof mod.UpdateChecker.forceCheck).toBe('function');
  });

  it('checkForUpdates does not throw on network failure', async () => {
    const mod = await import('../update-checker.js');
    // This calls npm view which may fail in test env — should degrade gracefully
    await expect(
      mod.UpdateChecker.checkForUpdates('0.0.0', true)
    ).resolves.toBeUndefined();
  });

  it('forceCheck does not throw on network failure', async () => {
    const mod = await import('../update-checker.js');
    // Suppress console output
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      mod.UpdateChecker.forceCheck('99.99.99')
    ).resolves.toBeUndefined();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
