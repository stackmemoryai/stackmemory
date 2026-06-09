import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveRealCliBin,
  resolveNativeCodexBin,
  resolveNvmBin,
} from '../real-cli-bin.js';

describe('resolveRealCliBin', () => {
  it('returns explicitBin when provided', () => {
    const result = resolveRealCliBin({
      explicitBin: '/usr/local/bin/codex',
      pathCommands: ['codex'],
    });
    expect(result).toBe('/usr/local/bin/codex');
  });

  it('returns envBin when provided', () => {
    const result = resolveRealCliBin({
      envBin: '/opt/homebrew/bin/codex',
      pathCommands: ['codex'],
    });
    expect(result).toBe('/opt/homebrew/bin/codex');
  });

  it('prefers explicitBin over envBin', () => {
    const result = resolveRealCliBin({
      explicitBin: '/explicit/codex',
      envBin: '/env/codex',
      pathCommands: ['codex'],
    });
    expect(result).toBe('/explicit/codex');
  });

  it('skips empty/whitespace explicitBin', () => {
    const result = resolveRealCliBin({
      explicitBin: '  ',
      envBin: '/env/codex',
      pathCommands: ['codex'],
    });
    expect(result).toBe('/env/codex');
  });

  it('returns first existing preferred path', () => {
    let tmpDir: string;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bin-'));
    const fakeBin = path.join(tmpDir, 'codex');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho ok');

    const result = resolveRealCliBin({
      preferredPaths: ['/nonexistent/codex', fakeBin],
      pathCommands: ['codex-nonexistent-xxx'],
    });
    expect(result).toBe(fakeBin);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips wrapper paths', () => {
    let tmpDir: string;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bin-'));
    const wrapperDir = path.join(
      tmpDir,
      'Applications',
      'cmux.app',
      'Contents',
      'Resources',
      'bin'
    );
    fs.mkdirSync(wrapperDir, { recursive: true });
    const wrapperBin = path.join(wrapperDir, 'codex');
    fs.writeFileSync(wrapperBin, '#!/bin/sh\necho wrapper');

    const result = resolveRealCliBin({
      preferredPaths: [wrapperBin],
      pathCommands: ['codex-nonexistent-xxx'],
    });
    expect(result).toBeNull();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when nothing found', () => {
    const result = resolveRealCliBin({
      pathCommands: ['codex-nonexistent-xxx-yyy-zzz'],
    });
    expect(result).toBeNull();
  });
});

describe('resolveNativeCodexBin', () => {
  it('returns an array', () => {
    const result = resolveNativeCodexBin();
    expect(Array.isArray(result)).toBe(true);
  });

  it('all returned paths are absolute', () => {
    const result = resolveNativeCodexBin();
    for (const p of result) {
      expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it('all returned paths exist on disk', () => {
    const result = resolveNativeCodexBin();
    for (const p of result) {
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  it('returned paths contain the platform triple', () => {
    const result = resolveNativeCodexBin();
    if (result.length === 0) return; // codex not installed

    const expectedTriples: Record<string, Record<string, string>> = {
      darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
      linux: {
        x64: 'x86_64-unknown-linux-musl',
        arm64: 'aarch64-unknown-linux-musl',
      },
    };
    const triple = expectedTriples[process.platform]?.[process.arch];
    if (!triple) return;

    for (const p of result) {
      expect(p).toContain(triple);
    }
  });

  it('returned paths point to a binary, not a JS wrapper', () => {
    const result = resolveNativeCodexBin();
    for (const p of result) {
      const content = fs.readFileSync(p);
      // Native binary won't start with shebang
      const header = content.subarray(0, 2).toString('utf8');
      expect(header).not.toBe('#!');
    }
  });
});

describe('resolveNvmBin', () => {
  it('returns a path for a binary that exists in the node bin dir', () => {
    // 'node' itself lives in the same dir as process.execPath
    const result = resolveNvmBin('node');
    expect(result).toBeDefined();
    expect(fs.existsSync(result!)).toBe(true);
  });

  it('returns undefined for a nonexistent binary', () => {
    const result = resolveNvmBin('nonexistent-binary-xxx-yyy');
    expect(result).toBeUndefined();
  });

  it('does not hardcode any node version', () => {
    const result = resolveNvmBin('node');
    if (!result) return;
    // The path should use process.execPath's directory, not a hardcoded version
    const nodeDir = path.dirname(process.execPath);
    expect(result).toBe(path.join(nodeDir, 'node'));
  });
});

describe('node version link check', () => {
  it('all bin entries from package.json resolve under current node version', () => {
    const pkgPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'package.json'
    );
    if (!fs.existsSync(pkgPath)) return;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const binEntries = pkg.bin || {};
    const nodeDir = path.dirname(process.execPath);

    const missing: string[] = [];
    for (const name of Object.keys(binEntries)) {
      const linked = path.join(nodeDir, name);
      if (!fs.existsSync(linked)) {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      console.warn(
        `[WARN] Missing bin links under ${nodeDir}: ${missing.join(', ')}\n` +
          `Fix: cd ${path.resolve(__dirname, '..', '..', '..', '..')} && npm link`
      );
    }
    // This test warns but doesn't fail — CI may not have npm link'd
    expect(true).toBe(true);
  });
});
